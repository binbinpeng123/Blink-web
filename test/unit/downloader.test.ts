import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ObjectInfo, S3Client } from '../../src/core/client.ts'
import {
  Downloader,
  type DownloadProgress,
  type DownloadSink,
} from '../../src/core/downloader.ts'
import { S3Error, TransportError } from '../../src/core/errors.ts'

const MiB = 1024 * 1024

interface RangeRequest {
  start: number
  end: number
  etag?: string
  signal?: AbortSignal
}

type Responder = (request: RangeRequest, call: number) => ReadableStream<Uint8Array> | Error

class FakeClient {
  readonly ranges: RangeRequest[] = []
  readonly #data: Uint8Array
  readonly #respond: Responder

  constructor(data: Uint8Array, respond?: Responder) {
    this.#data = data
    this.#respond = respond ?? ((request) => streamOf(this.#data.subarray(request.start, request.end + 1)))
  }

  get info(): ObjectInfo {
    return {
      key: 'a.bin',
      size: this.#data.byteLength,
      etag: 'etag-1',
      contentType: 'application/octet-stream',
      lastModified: null,
      metadata: {},
      checksumSha256: undefined,
      checksumType: undefined,
    }
  }

  async headObject(): Promise<ObjectInfo> {
    return this.info
  }

  async getObjectRange(
    _bucket: string,
    _key: string,
    options: RangeRequest,
  ): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> }> {
    this.ranges.push(options)
    const result = this.#respond(options, this.ranges.length)
    if (result instanceof Error) throw result
    return { status: 206, headers: new Headers(), body: result }
  }
}

class CollectingSink implements DownloadSink {
  readonly chunks: Uint8Array[] = []
  closed = false
  aborted = false

  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk.slice())
  }

  async close(): Promise<void> {
    this.closed = true
  }

  async abort(): Promise<void> {
    this.aborted = true
  }

  bytes(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }
}

function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index++) bytes[index] = index % 251
  return bytes
}

function streamOf(bytes: Uint8Array, pieceSize = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(offset + pieceSize, bytes.byteLength)
      controller.enqueue(bytes.subarray(offset, end))
      offset = end
    },
  })
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function downloader(client: FakeClient, chunkSize: number): Downloader {
  return new Downloader(client as unknown as S3Client, {
    chunkSize,
    // 测试只关心重试行为，不关心退避时长。
    retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  })
}

test('按 Range 顺序取块，带 If-Match，内容与进度一致', async () => {
  const data = pattern(10 * MiB)
  const client = new FakeClient(data)
  const sink = new CollectingSink()
  const progress: DownloadProgress[] = []

  const result = await downloader(client, 4 * MiB).download('photos', 'a.bin', sink, {
    onProgress: (event) => progress.push(event),
  })

  assert.deepEqual(
    client.ranges.map(({ start, end }) => [start, end]),
    [
      [0, 4 * MiB - 1],
      [4 * MiB, 8 * MiB - 1],
      [8 * MiB, 10 * MiB - 1],
    ],
  )
  // 每块都带同一个 ETag，防止分块之间对象被替换后拼出混合版本
  assert.ok(client.ranges.every((request) => request.etag === 'etag-1'))

  assert.equal(sink.closed, true)
  assert.equal(sink.aborted, false)
  assert.equal(sha256Hex(sink.bytes()), sha256Hex(data))

  assert.deepEqual(progress[0], { downloadedBytes: 0, totalBytes: 10 * MiB, chunks: 0, totalChunks: 3 })
  for (let index = 1; index < progress.length; index++) {
    assert.ok(progress[index]!.downloadedBytes >= progress[index - 1]!.downloadedBytes)
    assert.ok(progress[index]!.chunks >= progress[index - 1]!.chunks)
  }
  assert.deepEqual(progress.at(-1), {
    downloadedBytes: 10 * MiB,
    totalBytes: 10 * MiB,
    chunks: 3,
    totalChunks: 3,
  })

  assert.equal(result.bytes, data.byteLength)
  assert.equal(result.etag, 'etag-1')
  assert.equal(result.chunks, 3)
  assert.equal(result.contentType, 'application/octet-stream')
})

test('短读视为传输错误：重试后整块替换，不会重复写入', async () => {
  const data = pattern(5 * MiB)
  const client = new FakeClient(data, (request, call) => {
    const slice = data.subarray(request.start, request.end + 1)
    // 第一次只返回半块并提前关闭流，模拟连接中断
    return call === 1 ? streamOf(slice.subarray(0, Math.floor(slice.byteLength / 2))) : streamOf(slice)
  })
  const sink = new CollectingSink()

  const result = await downloader(client, 4 * MiB).download('photos', 'a.bin', sink)

  assert.equal(client.ranges.length, 3, '应有一次重试：2 块 + 1 次重试')
  assert.equal(sink.chunks.length, 2, 'sink 只应收到两个完整块')
  assert.equal(sha256Hex(sink.bytes()), sha256Hex(data))
  assert.equal(result.chunks, 2)
  assert.equal(sink.closed, true)
})

test('重试耗尽后以 TransportError 结束，并中止 sink', async () => {
  const data = pattern(MiB)
  const client = new FakeClient(data, () => streamOf(new Uint8Array(0)))
  const sink = new CollectingSink()

  await assert.rejects(
    downloader(client, 4 * MiB).download('photos', 'a.bin', sink),
    (error: unknown) => error instanceof TransportError,
  )
  assert.equal(sink.aborted, true)
  assert.equal(sink.closed, false)
  assert.equal(client.ranges.length, 2, 'attempts=2 表示总共尝试两次')
})

test('Chunk 之间被取消：以 AbortError 结束，不再发后续 Range', async () => {
  const data = pattern(9 * MiB)
  const client = new FakeClient(data)
  const sink = new CollectingSink()
  const controller = new AbortController()

  await assert.rejects(
    downloader(client, 4 * MiB).download('photos', 'a.bin', sink, {
      signal: controller.signal,
      onProgress: (event) => {
        if (event.chunks === 1) controller.abort()
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )

  assert.equal(client.ranges.length, 1)
  assert.equal(sink.aborted, true)
  assert.equal(sink.closed, false)
  assert.equal(
    client.ranges[0]?.signal?.aborted,
    true,
    '在途请求应共享同一个取消信号',
  )
})

test('0 字节对象不发 Range，直接收尾', async () => {
  const client = new FakeClient(new Uint8Array(0))
  const sink = new CollectingSink()
  const progress: DownloadProgress[] = []

  const result = await downloader(client, 4 * MiB).download('photos', 'a.bin', sink, {
    onProgress: (event) => progress.push(event),
  })

  // Range bytes=0-0 对空对象会 416，必须跳过请求
  assert.deepEqual(client.ranges, [])
  assert.deepEqual(progress, [{ downloadedBytes: 0, totalBytes: 0, chunks: 0, totalChunks: 0 }])
  assert.equal(sink.closed, true)
  assert.equal(result.bytes, 0)
  assert.equal(result.chunks, 0)
})

test('HEAD 失败时不取 Range，sink 被中止且保留原始 S3Error', async () => {
  const client = new FakeClient(pattern(MiB))
  client.headObject = async () => {
    throw new S3Error('NotFound', '对象不存在', 404)
  }
  const sink = new CollectingSink()

  await assert.rejects(
    downloader(client, 4 * MiB).download('photos', 'a.bin', sink),
    (error: unknown) => error instanceof S3Error && error.code === 'NotFound',
  )
  assert.deepEqual(client.ranges, [])
  assert.equal(sink.aborted, true)
})

test('sink 写入失败：中止 sink 并抛出原始错误', async () => {
  const data = pattern(MiB)
  const client = new FakeClient(data)
  const sink = new CollectingSink()
  const failure = new Error('磁盘已满')
  sink.write = async () => {
    throw failure
  }

  await assert.rejects(
    downloader(client, 4 * MiB).download('photos', 'a.bin', sink),
    (error: unknown) => error === failure,
  )
  assert.equal(sink.aborted, true)
  assert.equal(sink.closed, false)
})

test('非法分块大小在构造时拒绝', () => {
  const client = new FakeClient(pattern(1))
  assert.throws(() => new Downloader(client as unknown as S3Client, { chunkSize: 0 }), RangeError)
  assert.throws(() => new Downloader(client as unknown as S3Client, { chunkSize: 1.5 }), RangeError)
})
