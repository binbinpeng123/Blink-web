import assert from 'node:assert/strict'
import { createHash, randomFillSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { S3Client } from '../../src/core/client.ts'
import { Downloader, type DownloadSink } from '../../src/core/downloader.ts'
import { S3Error } from '../../src/core/errors.ts'
import { SigV4Signer } from '../../src/core/signer.ts'
import { FetchTransport } from '../../src/core/transport.ts'
import { Uploader } from '../../src/core/uploader.ts'
import { createS3Proxy } from '../../server/proxy.ts'
import {
  BLINK_BIN,
  TEST_ACCESS_KEY,
  TEST_REGION,
  TEST_SECRET_KEY,
  blinkAvailable,
  startBlink,
  type BlinkInstance,
} from './harness.ts'

const MiB = 1024 * 1024
const BUCKET = 'it-download'
const skip = blinkAvailable ? false : `找不到 Blink 二进制（${BLINK_BIN}）：先在 Blink 仓库 make build，或设置 BLINK_BIN`

function uniqueBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  randomFillSync(bytes)
  return bytes
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

class CollectingSink implements DownloadSink {
  readonly chunks: Uint8Array[] = []
  closed = false
  aborted = false
  /** 在第一次写入完成后执行，用来制造"分块之间对象被替换"的时间窗。 */
  onFirstWrite: (() => Promise<void>) | undefined

  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk.slice())
    if (this.chunks.length === 1 && this.onFirstWrite) await this.onFirstWrite()
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

describe('真实 Blink 集成：下载', { skip }, () => {
  let blink: BlinkInstance
  let proxy: Server
  let client: S3Client

  before(async () => {
    blink = await startBlink()
    const handler = createS3Proxy({ endpoint: blink.endpoint })
    proxy = createServer((req, res) => {
      handler(req, res, () => {
        res.writeHead(404)
        res.end()
      })
    })
    await new Promise<void>((resolveListen) => proxy.listen(0, '127.0.0.1', resolveListen))
    const port = (proxy.address() as AddressInfo).port

    client = new S3Client({
      transport: new FetchTransport(`http://127.0.0.1:${port}/s3`),
      signer: new SigV4Signer(
        { accessKeyId: TEST_ACCESS_KEY, secretKey: TEST_SECRET_KEY },
        TEST_REGION,
      ),
      host: `127.0.0.1:${port}`,
    })
    await client.createBucket(BUCKET)
  })

  after(async () => {
    proxy?.closeAllConnections()
    if (proxy) await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await blink?.stop()
  })

  test('12 MiB 分片上传后用 4 MiB Range 下载：SHA-256 与源数据一致', async () => {
    const data = uniqueBytes(12 * MiB)
    const uploader = new Uploader(client, { partSize: 5 * MiB, concurrency: 4 })
    await uploader.upload(new Blob([data]), {
      bucket: BUCKET,
      key: 'data/roundtrip.bin',
      contentType: 'application/octet-stream',
    })

    const sink = new CollectingSink()
    const progress: number[] = []
    const result = await new Downloader(client, { chunkSize: 4 * MiB }).download(
      BUCKET,
      'data/roundtrip.bin',
      sink,
      { onProgress: (event) => progress.push(event.downloadedBytes) },
    )

    assert.equal(result.bytes, data.byteLength)
    assert.equal(result.chunks, 3)
    assert.equal(sink.closed, true)
    assert.equal(sink.aborted, false)
    assert.equal(sha256Hex(sink.bytes()), sha256Hex(data))

    const info = await client.headObject(BUCKET, 'data/roundtrip.bin')
    assert.equal(result.etag, info.etag, '下载用的 ETag 应来自 HEAD')
    // 进度从 0 开始、以总量结束，且单调不减
    assert.equal(progress[0], 0)
    assert.equal(progress.at(-1), data.byteLength)
    for (let index = 1; index < progress.length; index++) {
      assert.ok(progress[index]! >= progress[index - 1]!)
    }

    await client.deleteObject(BUCKET, 'data/roundtrip.bin')
  })

  test('分块之间对象被替换：If-Match 使下载失败，不拼出混合版本', async () => {
    const original = uniqueBytes(3 * MiB)
    const replacement = uniqueBytes(3 * MiB)
    await client.putObject(BUCKET, 'data/replaced.bin', original, 'application/octet-stream')

    const sink = new CollectingSink()
    // 首块写入后替换对象：下一次 Range 的 If-Match 应与新 ETag 不符。
    sink.onFirstWrite = async () => {
      await client.putObject(BUCKET, 'data/replaced.bin', replacement, 'application/octet-stream')
    }

    await assert.rejects(
      new Downloader(client, { chunkSize: 1 * MiB }).download(
        BUCKET,
        'data/replaced.bin',
        sink,
      ),
      (error: unknown) => {
        assert.ok(error instanceof S3Error)
        assert.equal(error.status, 412)
        assert.equal(error.code, 'PreconditionFailed')
        return true
      },
    )
    assert.equal(sink.aborted, true)
    assert.equal(sink.closed, false)
    assert.equal(sink.chunks.length, 1, '失败前只应写入第一块')

    await client.deleteObject(BUCKET, 'data/replaced.bin')
  })
})
