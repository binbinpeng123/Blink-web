import assert from 'node:assert/strict'
import { test } from 'node:test'
import { S3Client } from '../../src/core/client.ts'
import { SHA256_OF_EMPTY } from '../../src/core/crypto.ts'
import { S3Error } from '../../src/core/errors.ts'
import { SigV4Signer } from '../../src/core/signer.ts'
import type { HttpRequest, HttpResponse, HttpStreamResponse, HttpTransport } from '../../src/core/types.ts'

const HOST = '127.0.0.1:8080'

class RecordingTransport implements HttpTransport {
  readonly requests: HttpRequest[] = []
  readonly #handler: (req: HttpRequest) => HttpResponse

  constructor(handler: (req: HttpRequest) => HttpResponse) {
    this.#handler = handler
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req)
    return this.#handler(req)
  }

  async stream(req: HttpRequest): Promise<HttpStreamResponse> {
    this.requests.push(req)
    const res = this.#handler(req)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(res.body)
        controller.close()
      },
    })
    return { status: res.status, headers: res.headers, body }
  }

  get last(): HttpRequest {
    const req = this.requests.at(-1)
    assert.ok(req, '没有记录到请求')
    return req
  }
}

function response(status: number, body = '', headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: new Headers(headers), body: new TextEncoder().encode(body) }
}

function createClient(handler: (req: HttpRequest) => HttpResponse) {
  const transport = new RecordingTransport(handler)
  const signer = new SigV4Signer(
    { accessKeyId: 'AKIATESTTEST1234', secretKey: 'test-secret-key-not-a-real-credential' },
    'us-east-1',
  )
  return { transport, client: new S3Client({ transport, signer, host: HOST }) }
}

test('listBuckets 使用空体哈希签名，路径为 /', async () => {
  const { client, transport } = createClient(() =>
    response(
      200,
      '<ListAllMyBucketsResult><Buckets>' +
        '<Bucket><Name>photos</Name><CreationDate>2026-10-01T00:00:00.000Z</CreationDate></Bucket>' +
        '</Buckets></ListAllMyBucketsResult>',
    ),
  )

  const buckets = await client.listBuckets()
  assert.deepEqual(buckets.map((b) => b.name), ['photos'])
  assert.equal(buckets[0]!.creationDate?.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(transport.last.method, 'GET')
  assert.equal(transport.last.url, '/')
  assert.equal(transport.last.headers['x-amz-content-sha256'], SHA256_OF_EMPTY)
  assert.equal(transport.last.body, undefined)
})

test('listObjects 带 list-type=2 与 encoding-type=url，并还原编码后的 Key/Prefix', async () => {
  const { client, transport } = createClient(() =>
    response(
      200,
      '<ListBucketResult>' +
        '<Name>photos</Name><Prefix>a/</Prefix><IsTruncated>true</IsTruncated>' +
        '<NextContinuationToken>tok%2F%2B%3D</NextContinuationToken>' +
        '<Contents><Key>a%2F%E4%B8%AD%E6%96%87%20x.txt</Key>' +
        '<LastModified>2026-10-25T01:02:03.000Z</LastModified>' +
        '<ETag>&quot;abc&quot;</ETag><Size>12</Size></Contents>' +
        '<Contents><Key>a/b.txt</Key><LastModified>2026-10-25T01:02:04.000Z</LastModified>' +
        '<ETag>&quot;def&quot;</ETag><Size>1</Size></Contents>' +
        '<CommonPrefixes><Prefix>a/dir%2F</Prefix></CommonPrefixes>' +
        '</ListBucketResult>',
    ),
  )

  const result = await client.listObjects({
    bucket: 'photos',
    prefix: 'a/',
    delimiter: '/',
    continuationToken: 'tok/+=',
    maxKeys: 100,
  })

  // canonical query 已排序，并原样作为线上 URL
  assert.equal(
    transport.last.url,
    '/photos?continuation-token=tok%2F%2B%3D&delimiter=%2F&encoding-type=url' +
      '&list-type=2&max-keys=100&prefix=a%2F',
  )
  assert.deepEqual(result.objects, [
    {
      key: 'a/中文 x.txt',
      size: 12,
      etag: 'abc',
      lastModified: new Date('2026-10-25T01:02:03.000Z'),
    },
    {
      key: 'a/b.txt',
      size: 1,
      etag: 'def',
      lastModified: new Date('2026-10-25T01:02:04.000Z'),
    },
  ])
  assert.deepEqual(result.prefixes, ['a/dir/'])
  assert.equal(result.isTruncated, true)
  assert.equal(result.nextToken, 'tok%2F%2B%3D')
})

test('路径按段编码，key 中的空格/中文/加号都被转义', async () => {
  const { client, transport } = createClient(() => response(200))
  await client.deleteObject('photos', 'dir/中文 name+1.bin')
  assert.equal(transport.last.url, '/photos/dir/%E4%B8%AD%E6%96%87%20name%2B1.bin')
})

test('非法 key 在发请求前就被拒绝', async () => {
  const { client, transport } = createClient(() => response(200))
  for (const key of ['', '/abs', 'a//b', 'a/./b', 'a/../b']) {
    await assert.rejects(client.deleteObject('photos', key), /key/)
  }
  // 末尾斜杠是合法 key，不应被拒绝
  await client.deleteObject('photos', 'dir/')
  assert.equal(transport.last.url, '/photos/dir/')
  // 只有末尾斜杠那一次到达传输层，其余都在本地被拒绝
  assert.equal(transport.requests.length, 1)
})

test('putObject 发送真实 SHA-256 作 payload hash 与校验和', async () => {
  const { client, transport } = createClient(() =>
    response(200, '', { etag: '"LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ="' }),
  )

  const result = await client.putObject('photos', 'a.bin', new TextEncoder().encode('hello'))
  assert.equal(
    transport.last.headers['x-amz-content-sha256'],
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  )
  assert.equal(transport.last.headers['x-amz-checksum-sha256'], 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=')
  assert.equal(transport.last.headers['content-type'], 'application/octet-stream')
  assert.equal(result.etag, 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=')
})

test('headObject 解析大小/ETag/元数据，并去掉 ETag 引号', async () => {
  const { client } = createClient(() =>
    response(200, '', {
      'content-length': '4096',
      etag: '"etag-1"',
      'content-type': 'application/octet-stream',
      'last-modified': 'Sat, 25 Oct 2026 01:02:03 GMT',
      'x-amz-meta-owner': 'alice',
      'x-amz-checksum-sha256': 'abc=',
      'x-amz-checksum-type': 'FULL_OBJECT',
    }),
  )

  const info = await client.headObject('photos', 'a.bin')
  assert.equal(info.size, 4096)
  assert.equal(info.etag, 'etag-1')
  assert.equal(info.contentType, 'application/octet-stream')
  assert.deepEqual(info.metadata, { owner: 'alice' })
  assert.equal(info.checksumSha256, 'abc=')
  assert.equal(info.checksumType, 'FULL_OBJECT')
})

test('错误响应解析为 S3Error，保留 code/requestId/resource', async () => {
  const { client } = createClient(() =>
    response(
      409,
      '<Error><Code>BucketNotEmpty</Code><Message>桶非空</Message>' +
        '<RequestId>req-1</RequestId><Resource>/photos</Resource></Error>',
      { 'x-amz-request-id': 'header-req' },
    ),
  )

  await assert.rejects(client.deleteBucket('photos'), (error: unknown) => {
    assert.ok(error instanceof S3Error)
    assert.equal(error.code, 'BucketNotEmpty')
    assert.equal(error.status, 409)
    assert.equal(error.requestId, 'req-1')
    assert.equal(error.resource, '/photos')
    return true
  })
})

test('无响应体的错误（HEAD 404）按状态码映射，不把响应体当消息', async () => {
  const { client } = createClient(() => response(404, '', { 'x-amz-request-id': 'req-2' }))

  await assert.rejects(client.headObject('photos', 'missing.bin'), (error: unknown) => {
    assert.ok(error instanceof S3Error)
    assert.equal(error.code, 'NotFound')
    assert.equal(error.status, 404)
    assert.equal(error.requestId, 'req-2')
    return true
  })
})

test('createMultipartUpload 带裸参数 uploads 与 SHA256 算法', async () => {
  const { client, transport } = createClient(() =>
    response(200, '<InitiateMultipartUploadResult><UploadId>up%2F1</UploadId></InitiateMultipartUploadResult>'),
  )

  const uploadId = await client.createMultipartUpload('photos', 'big.bin', 'application/octet-stream')
  assert.equal(uploadId, 'up%2F1')
  assert.equal(transport.last.method, 'POST')
  assert.equal(transport.last.url, '/photos/big.bin?uploads=')
  assert.equal(transport.last.headers['x-amz-checksum-algorithm'], 'SHA256')
})

test('completeMultipartUpload 按升序提交，ETag 补引号并带分片校验和', async () => {
  const { client, transport } = createClient(() =>
    response(
      200,
      '<CompleteMultipartUploadResult><ETag>&quot;final&quot;</ETag>' +
        '<ChecksumSHA256>composite-N</ChecksumSHA256>' +
        '<ChecksumType>COMPOSITE</ChecksumType></CompleteMultipartUploadResult>',
    ),
  )

  const result = await client.completeMultipartUpload('photos', 'big.bin', 'up/1', [
    { partNumber: 1, etag: 'e1', checksumSha256: 'c1' },
    { partNumber: 2, etag: 'e2', checksumSha256: undefined },
  ])

  const body = new TextDecoder().decode(transport.last.body as Uint8Array)
  assert.equal(
    body,
    '<CompleteMultipartUpload>' +
      '<Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag>' +
      '<ChecksumSHA256>c1</ChecksumSHA256></Part>' +
      '<Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part>' +
      '</CompleteMultipartUpload>',
  )
  assert.equal(transport.last.url, '/photos/big.bin?uploadId=up%2F1')
  // Complete 的请求体本身也要签名，不能沿用空体哈希
  assert.notEqual(transport.last.headers['x-amz-content-sha256'], SHA256_OF_EMPTY)
  assert.equal(result.etag, 'final')
  assert.equal(result.checksumType, 'COMPOSITE')
})

test('getObjectRange 发送 Range 与 If-Match，ETag 不会重复加引号', async () => {
  const { client, transport } = createClient(() => response(206, 'abc'))

  const res = await client.getObjectRange('photos', 'big.bin', {
    start: 0,
    end: 4_194_303,
    etag: '"etag-1"',
  })
  assert.equal(new TextDecoder().decode(await new Response(res.body).arrayBuffer()), 'abc')
  assert.equal(transport.last.method, 'GET')
  assert.equal(transport.last.headers['range'], 'bytes=0-4194303')
  assert.equal(transport.last.headers['if-match'], '"etag-1"')
  assert.equal(transport.last.body, undefined)
})

test('Range 请求的状态错误同样映射为 S3Error', async () => {
  const { client } = createClient(() =>
    response(416, '<Error><Code>InvalidRange</Code><Message>范围无效</Message></Error>'),
  )

  await assert.rejects(
    client.getObjectRange('photos', 'a.bin', { start: 10, end: 20 }),
    (error: unknown) => error instanceof S3Error && error.code === 'InvalidRange',
  )
})
