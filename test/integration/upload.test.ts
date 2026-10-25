import assert from 'node:assert/strict'
import { createHash, randomFillSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { S3Client } from '../../src/core/client.ts'
import { S3Error } from '../../src/core/errors.ts'
import {
  MIN_PART_SIZE,
  Uploader,
  type UploadProgress,
  type UploadSource,
} from '../../src/core/uploader.ts'
import { SigV4Signer } from '../../src/core/signer.ts'
import { FetchTransport } from '../../src/core/transport.ts'
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
const BUCKET = 'it-upload'
const skip = blinkAvailable ? false : `找不到 Blink 二进制（${BLINK_BIN}）：先在 Blink 仓库 make build，或设置 BLINK_BIN`

/** 每次运行写入不同内容：后端按内容去重，重复数据会让"真的写了 12 MiB"这个前提失真。 */
function uniqueBytes(size: number): Uint8Array<ArrayBuffer> {
  // 显式收窄到 ArrayBuffer：BlobPart 不接受可能由 SharedArrayBuffer 支撑的视图。

  const bytes = new Uint8Array(size)
  randomFillSync(bytes)
  return bytes
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 给末片的切片加延迟，制造"前几片已上传、最后一片还没发"的时间窗，
 * 让取消发生在真实传输中途，而不是请求还没开始的时候。
 */
class DelayedTailSource implements UploadSource {
  readonly size: number
  readonly #blob: Blob
  readonly #delayMs: number

  constructor(bytes: Uint8Array<ArrayBuffer>, delayMs: number) {
    this.#blob = new Blob([bytes])
    this.size = bytes.byteLength
    this.#delayMs = delayMs
  }

  slice(start = 0, end: number = this.size): Blob {
    const slice = this.#blob.slice(start, end)
    if (start === 0 || end !== this.size) return slice
    // 只需要 arrayBuffer()；延迟包一层即可，不影响类型契约。
    return {
      size: slice.size,
      arrayBuffer: async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, this.#delayMs))
        return slice.arrayBuffer()
      },
    } as unknown as Blob
  }
}

describe('真实 Blink 集成：上传', { skip }, () => {
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

    // 走浏览器真正使用的路径：同源代理 + 以代理 Host 签名。
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

  test('小文件单 PUT：内容原样读回，校验和类型为 FULL_OBJECT', async () => {
    const data = uniqueBytes(1024)
    const uploader = new Uploader(client)

    const result = await uploader.upload(new Blob([data]), {
      bucket: BUCKET,
      key: 'small/roundtrip.bin',
      contentType: 'application/octet-stream',
    })

    assert.equal(result.mode, 'single')
    assert.equal(result.bytes, data.byteLength)
    assert.equal(result.checksumType, 'FULL_OBJECT')

    const info = await client.headObject(BUCKET, 'small/roundtrip.bin')
    assert.equal(info.size, data.byteLength)
    assert.equal(info.checksumType, 'FULL_OBJECT')

    const readBack = await client.getObject(BUCKET, 'small/roundtrip.bin')
    assert.equal(sha256Hex(readBack.body), sha256Hex(data))

    await client.deleteObject(BUCKET, 'small/roundtrip.bin')
  })

  test('12 MiB 分片上传：往返 SHA-256 一致，校验和类型为 COMPOSITE', async () => {
    const data = uniqueBytes(12 * MiB)
    const uploader = new Uploader(client, { partSize: MIN_PART_SIZE, concurrency: 4 })
    const progress: UploadProgress[] = []

    const result = await uploader.upload(new Blob([data]), {
      bucket: BUCKET,
      key: 'data/big.bin',
      onProgress: (event) => progress.push(event),
    })

    assert.equal(result.mode, 'multipart')
    assert.equal(result.parts, 3)
    assert.equal(result.checksumType, 'COMPOSITE')
    // COMPOSITE 校验和＝"各分片校验和的校验和"，带 -N 后缀；它不是整文件 SHA-256。
    assert.match(result.checksumSha256 ?? '', /-[0-9]+$/)

    const info = await client.headObject(BUCKET, 'data/big.bin')
    assert.equal(info.size, data.byteLength)
    assert.equal(info.checksumType, 'COMPOSITE')

    const readBack = await client.getObject(BUCKET, 'data/big.bin')
    assert.equal(sha256Hex(readBack.body), sha256Hex(data))

    const listing = await client.listObjects({ bucket: BUCKET, prefix: 'data/' })
    assert.deepEqual(
      listing.objects.map((object) => [object.key, object.size]),
      [['data/big.bin', data.byteLength]],
    )

    // 进度单调不减，最后一条是"合并中"且字节数等于总量
    for (let index = 1; index < progress.length; index++) {
      assert.ok(
        progress[index]!.uploadedBytes >= progress[index - 1]!.uploadedBytes,
        '已完成字节数不得回退',
      )
    }
    const last = progress.at(-1)
    assert.equal(last?.phase, 'completing')
    assert.equal(last?.uploadedBytes, data.byteLength)

    await client.deleteObject(BUCKET, 'data/big.bin')
  })

  test('取消进行中的分片上传：以 AbortError 结束，不留对象', async () => {
    const data = uniqueBytes(12 * MiB)
    const uploader = new Uploader(client, { partSize: MIN_PART_SIZE, concurrency: 4 })
    const controller = new AbortController()

    let abortNow: (() => void) | undefined
    const firstPartDone = new Promise<void>((resolve) => {
      abortNow = resolve
    })

    const uploading = uploader.upload(new DelayedTailSource(data, 400), {
      bucket: BUCKET,
      key: 'data/canceled.bin',
      signal: controller.signal,
      onProgress: (event) => {
        if (event.completedParts >= 1) abortNow?.()
      },
    })

    await firstPartDone
    controller.abort()

    await assert.rejects(uploading, (error: unknown) => {
      assert.ok(error instanceof DOMException)
      assert.equal(error.name, 'AbortError')
      return true
    })

    await assert.rejects(client.headObject(BUCKET, 'data/canceled.bin'), (error: unknown) => {
      assert.ok(error instanceof S3Error)
      assert.equal(error.status, 404)
      return true
    })
    const listing = await client.listObjects({ bucket: BUCKET, prefix: 'data/' })
    assert.deepEqual(listing.objects, [])
  })
})
