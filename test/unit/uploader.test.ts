import assert from 'node:assert/strict'
import { test } from 'node:test'
import { S3Client } from '../../src/core/client.ts'
import { Semaphore } from '../../src/core/pool.ts'
import { NO_RETRY } from '../../src/core/retry.ts'
import { SigV4Signer } from '../../src/core/signer.ts'
import type {
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  HttpTransport,
} from '../../src/core/types.ts'
import { MIN_PART_SIZE, Uploader, type UploadProgress } from '../../src/core/uploader.ts'

const MiB = 1024 * 1024
const BUCKET = 'uploads'
const KEY = 'data/big.bin'

interface HandlerContext {
  method: string
  url: URL
  partNumber: number | null
  bodyLength: number
  signal: AbortSignal | undefined
}

type Handler = (ctx: HandlerContext) => Promise<HttpResponse> | HttpResponse

class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = []
  readonly #handler: Handler
  #inFlight = 0
  maxInFlight = 0

  constructor(handler: Handler) {
    this.#handler = handler
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    // 与 fetch 一致：信号已取消时立即失败，而不是下发一个永远收不到响应的请求。
    if (req.signal?.aborted) throw new DOMException('操作已取消', 'AbortError')
    this.requests.push(req)
    const url = new URL(req.url, 'http://s3.test')
    const partNumber = url.searchParams.get('partNumber')
    this.#inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight)
    try {
      return await this.#handler({
        method: req.method,
        url,
        partNumber: partNumber === null ? null : Number(partNumber),
        bodyLength: req.body instanceof Uint8Array ? req.body.length : 0,
        signal: req.signal,
      })
    } finally {
      this.#inFlight--
    }
  }

  async stream(_req: HttpRequest): Promise<HttpStreamResponse> {
    throw new Error('上传测试不应调用 stream')
  }

  methods(): string[] {
    return this.requests.map((req) => req.method)
  }
}

function response(status: number, body = '', headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: new Headers(headers), body: new TextEncoder().encode(body) }
}

const CREATE_XML =
  '<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>'
const COMPLETE_XML =
  '<CompleteMultipartUploadResult><ETag>&quot;final&quot;</ETag>' +
  '<ChecksumSHA256>composite-N</ChecksumSHA256>' +
  '<ChecksumType>COMPOSITE</ChecksumType></CompleteMultipartUploadResult>'

function createUploader(handler: Handler, concurrency = 4, pool = new Semaphore(4)) {
  const transport = new FakeTransport(handler)
  const client = new S3Client({
    transport,
    signer: new SigV4Signer(
      { accessKeyId: 'AKIATESTTEST1234', secretKey: 'test-secret-key-not-a-real-credential' },
      'us-east-1',
    ),
    host: 's3.test',
  })
  const uploader = new Uploader(client, {
    partSize: MIN_PART_SIZE,
    concurrency,
    retry: NO_RETRY,
    pool,
  })
  return { transport, uploader }
}

function completeBody(transport: FakeTransport): string {
  const req = transport.requests.filter((item) => item.method === 'POST').at(-1)
  assert.ok(req, '没有 Complete 请求')
  return new TextDecoder().decode(req.body as Uint8Array)
}

test('小文件走单 PUT，并报告"进度不可知"', async () => {
  const { transport, uploader } = createUploader(() =>
    response(200, '', { etag: '"single"', 'x-amz-checksum-sha256': 'single-sum' }),
  )
  const events: UploadProgress[] = []

  const result = await uploader.upload(new Blob([new Uint8Array(100)]), {
    bucket: BUCKET,
    key: 'small.bin',
    contentType: 'application/octet-stream',
    onProgress: (progress) => events.push(progress),
  })

  assert.equal(result.mode, 'single')
  assert.equal(result.bytes, 100)
  assert.equal(result.parts, 1)
  assert.equal(result.etag, 'single')
  assert.equal(result.checksumType, 'FULL_OBJECT')
  assert.equal(transport.requests.length, 1)
  assert.equal(transport.requests[0]!.method, 'PUT')
  assert.equal(transport.requests[0]!.url, `/${BUCKET}/small.bin`)
  assert.equal(transport.requests[0]!.headers['content-type'], 'application/octet-stream')
  assert.deepEqual(events, [
    {
      phase: 'uploading',
      uploadedBytes: 0,
      totalBytes: 100,
      completedParts: 0,
      totalParts: 1,
      determinate: false,
    },
  ])
})

test('12 MiB 走分片：并发上传后按序提交，校验和类型为 COMPOSITE', async () => {
  const partSizes = new Map<number, number>()
  const { transport, uploader } = createUploader(async (ctx) => {
    if (ctx.method === 'POST' && ctx.url.searchParams.has('uploads')) {
      return response(200, CREATE_XML)
    }
    if (ctx.method === 'PUT' && ctx.partNumber !== null) {
      partSizes.set(ctx.partNumber, ctx.bodyLength)
      // 让靠前的分片更慢，验证完成顺序不等于提交顺序
      await new Promise((resolve) => setTimeout(resolve, (4 - ctx.partNumber!) * 5))
      return response(200, '', {
        etag: `"etag-${ctx.partNumber}"`,
        'x-amz-checksum-sha256': `cs-${ctx.partNumber}`,
      })
    }
    if (ctx.method === 'POST' && ctx.url.searchParams.has('uploadId')) {
      return response(200, COMPLETE_XML)
    }
    return response(204)
  })

  const events: UploadProgress[] = []
  const total = 12 * MiB
  const result = await uploader.upload(new Blob([new Uint8Array(total)]), {
    bucket: BUCKET,
    key: KEY,
    onProgress: (progress) => events.push(progress),
  })

  assert.equal(result.mode, 'multipart')
  assert.equal(result.bytes, total)
  assert.equal(result.parts, 3)
  assert.equal(result.etag, 'final')
  assert.equal(result.checksumSha256, 'composite-N')
  assert.equal(result.checksumType, 'COMPOSITE')
  // 按分片号记录：并发下到达顺序不确定，切片大小必须按编号核对。
  assert.deepEqual([1, 2, 3].map((part) => partSizes.get(part)), [5 * MiB, 5 * MiB, 2 * MiB])

  // 提交顺序严格升序，与完成先后无关
  const body = completeBody(transport)
  assert.deepEqual(
    [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match) => Number(match[1])),
    [1, 2, 3],
  )
  assert.ok(body.includes('<ETag>&quot;etag-3&quot;</ETag>'))
  assert.ok(body.includes('<ChecksumSHA256>cs-3</ChecksumSHA256>'))

  const last = events.at(-1)
  assert.equal(last?.phase, 'completing')
  assert.equal(last?.uploadedBytes, total)
  assert.equal(last?.determinate, true)
  assert.equal(Math.max(...events.map((event) => event.completedParts)), 3)
})

test('分片失败按策略重试，成功后仍完成上传', async () => {
  const attempts = new Map<number, number>()
  const { transport } = createUploader((ctx) => {
    if (ctx.method === 'POST' && ctx.url.searchParams.has('uploads')) {
      return response(200, CREATE_XML)
    }
    if (ctx.method === 'PUT' && ctx.partNumber !== null) {
      const count = (attempts.get(ctx.partNumber) ?? 0) + 1
      attempts.set(ctx.partNumber, count)
      if (ctx.partNumber === 2 && count < 3) {
        return response(500, '<Error><Code>InternalError</Code><Message>flaky</Message></Error>')
      }
      return response(200, '', { etag: `"etag-${ctx.partNumber}"` })
    }
    return response(200, COMPLETE_XML)
  })

  // 重试延迟设为 0，避免单测真的等待
  const uploaderWithRetry = new Uploader(
    new S3Client({
      transport,
      signer: new SigV4Signer(
        { accessKeyId: 'AKIATESTTEST1234', secretKey: 'test-secret-key-not-a-real-credential' },
        'us-east-1',
      ),
      host: 's3.test',
    }),
    {
      partSize: MIN_PART_SIZE,
      concurrency: 2,
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      pool: new Semaphore(2),
    },
  )

  const result = await uploaderWithRetry.upload(new Blob([new Uint8Array(6 * MiB)]), {
    bucket: BUCKET,
    key: KEY,
  })

  assert.equal(result.mode, 'multipart')
  assert.equal(result.parts, 2)
  assert.equal(attempts.get(2), 3)
  assert.equal(attempts.get(1), 1)
  // 1 次 Create + 1 次第 1 片 + 3 次第 2 片 + 1 次 Complete
  assert.equal(transport.requests.length, 1 + 1 + 3 + 1)
})

test('分片不可重试错误：中止其余分片并清理 uploadId', async () => {
  let completeCalled = false
  const { transport, uploader } = createUploader((ctx) => {
    if (ctx.method === 'POST' && ctx.url.searchParams.has('uploads')) {
      return response(200, CREATE_XML)
    }
    if (ctx.method === 'PUT' && ctx.partNumber !== null) {
      if (ctx.partNumber === 2) {
        return response(403, '<Error><Code>AccessDenied</Code><Message>denied</Message></Error>')
      }
      return response(200, '', { etag: `"etag-${ctx.partNumber}"` })
    }
    if (ctx.method === 'POST' && ctx.url.searchParams.has('uploadId')) {
      completeCalled = true
      return response(200, COMPLETE_XML)
    }
    return response(204)
  })

  await assert.rejects(
    uploader.upload(new Blob([new Uint8Array(12 * MiB)]), { bucket: BUCKET, key: KEY }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as { code?: string }).code, 'AccessDenied')
      return true
    },
  )

  assert.equal(completeCalled, false)
  const abort = transport.requests.find(
    (req) => req.method === 'DELETE' && req.url.includes('uploadId=up-1'),
  )
  assert.ok(abort, '失败后必须调用 AbortMultipartUpload')
})

test('并发上限来自注入的信号量', async () => {
  const pool = new Semaphore(2)
  const { transport, uploader } = createUploader(
    async (ctx) => {
      if (ctx.method === 'POST' && ctx.url.searchParams.has('uploads')) {
        return response(200, CREATE_XML)
      }
      if (ctx.method === 'PUT') {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return response(200, '', { etag: `"etag-${ctx.partNumber}"` })
      }
      return response(200, COMPLETE_XML)
    },
    4,
    pool,
  )

  await uploader.upload(new Blob([new Uint8Array(25 * MiB)]), { bucket: BUCKET, key: KEY })
  assert.equal(transport.maxInFlight, 2)
})

test('取消：以 AbortError 结束并尽力清理 uploadId', async () => {
  let notifyPartStarted: (() => void) | undefined
  const partStarted = new Promise<void>((resolve) => {
    notifyPartStarted = resolve
  })
  let completeCalled = false

  const { transport, uploader } = createUploader((ctx) => {
    if (ctx.method === 'POST' && ctx.url.searchParams.has('uploads')) {
      return response(200, CREATE_XML)
    }
    if (ctx.method === 'PUT' && ctx.partNumber !== null) {
      notifyPartStarted?.()
      return new Promise<HttpResponse>((_resolve, reject) => {
        ctx.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('操作已取消', 'AbortError')),
          { once: true },
        )
      })
    }
    if (ctx.method === 'POST' && ctx.url.searchParams.has('uploadId')) {
      completeCalled = true
      return response(200, COMPLETE_XML)
    }
    return response(204)
  })

  const controller = new AbortController()
  const uploading = uploader.upload(new Blob([new Uint8Array(12 * MiB)]), {
    bucket: BUCKET,
    key: KEY,
    signal: controller.signal,
  })

  await partStarted
  controller.abort()

  await assert.rejects(uploading, (error: unknown) => {
    assert.ok(error instanceof DOMException)
    assert.equal(error.name, 'AbortError')
    return true
  })
  assert.equal(completeCalled, false)
  assert.ok(
    transport.requests.some((req) => req.method === 'DELETE' && req.url.includes('uploadId=up-1')),
    '取消后必须调用 AbortMultipartUpload',
  )
})

test('分片小于 5 MiB 时在发请求前拒绝', async () => {
  const { transport } = createUploader(() => response(200, CREATE_XML))
  const client = new S3Client({
    transport,
    signer: new SigV4Signer(
      { accessKeyId: 'AKIATESTTEST1234', secretKey: 'test-secret-key-not-a-real-credential' },
      'us-east-1',
    ),
    host: 's3.test',
  })
  const uploader = new Uploader(client, { partSize: 1024 })

  await assert.rejects(
    uploader.upload(new Blob([new Uint8Array(2 * MiB)]), { bucket: BUCKET, key: KEY }),
    /分片大小/,
  )
  assert.equal(transport.requests.length, 0)
})
