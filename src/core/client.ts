import { SHA256_OF_EMPTY, sha256 } from './crypto.ts'
import { decodeKeyText, encodeBucket, encodeKey, toBase64, toHex } from './encoding.ts'
import { S3Error, abortError, errorFromResponse } from './errors.ts'
import { assertObjectKey, bucketProblem } from './keys.ts'
import type { Signer } from './types.ts'
import type { HttpRequest, HttpResponse, HttpStreamResponse, HttpTransport, QueryParam } from './types.ts'
import { child, childText, children, parseXml } from './xml.ts'

export interface S3ClientOptions {
  transport: HttpTransport
  signer: Signer
  /** 签名用的 Host，必须与请求实际到达的 Host 一致（浏览器为 location.host） */
  host: string
}

export interface BucketInfo {
  name: string
  creationDate: Date | null
}

export interface ObjectEntry {
  key: string
  size: number
  etag: string
  lastModified: Date | null
}

export interface ListObjectsOptions {
  bucket: string
  prefix?: string
  delimiter?: string
  continuationToken?: string
  maxKeys?: number
  signal?: AbortSignal
}

export interface ListObjectsResult {
  objects: ObjectEntry[]
  prefixes: string[]
  isTruncated: boolean
  nextToken: string | undefined
}

export interface ObjectInfo {
  key: string
  size: number
  etag: string
  contentType: string
  lastModified: Date | null
  metadata: Record<string, string>
  checksumSha256: string | undefined
  checksumType: string | undefined
}

export interface WriteResult {
  etag: string
  checksumSha256: string | undefined
}

export interface UploadedPart {
  partNumber: number
  etag: string
  checksumSha256: string | undefined
}

export interface CompleteResult extends WriteResult {
  checksumType: string | undefined
}

interface CallOptions {
  method: string
  bucket?: string
  key?: string
  query?: QueryParam[]
  body?: Uint8Array
  headers?: Record<string, string>
  signal?: AbortSignal
}

/**
 * 只负责协议：构造路径 → 签名 → 发送 → 解析/映射错误。
 * 分片、并发、重试、进度都在上层用例类里，便于单独测试。
 */
export class S3Client {
  readonly #transport: HttpTransport
  readonly #signer: Signer
  readonly #host: string

  constructor(options: S3ClientOptions) {
    if (!options.host) throw new Error('缺少签名 Host')
    this.#transport = options.transport
    this.#signer = options.signer
    this.#host = options.host
  }

  async listBuckets(signal?: AbortSignal): Promise<BucketInfo[]> {
    const res = await this.#call({ method: 'GET', signal })
    const root = this.#xml(res)
    if (root.name !== 'ListAllMyBucketsResult') {
      throw new S3Error('UnexpectedResponse', `期望 ListAllMyBucketsResult，实际 ${root.name}`, res.status)
    }
    return children(child(root, 'Buckets'), 'Bucket').map((bucket) => ({
      name: childText(bucket, 'Name') ?? '',
      creationDate: parseDate(childText(bucket, 'CreationDate')),
    }))
  }

  async createBucket(bucket: string, signal?: AbortSignal): Promise<void> {
    const problem = bucketProblem(bucket)
    if (problem) throw new Error(problem)
    await this.#call({ method: 'PUT', bucket, signal })
  }

  async deleteBucket(bucket: string, signal?: AbortSignal): Promise<void> {
    await this.#call({ method: 'DELETE', bucket, signal })
  }

  async listObjects(options: ListObjectsOptions): Promise<ListObjectsResult> {
    const query: QueryParam[] = [
      { key: 'list-type', value: '2' },
      // 让后端把 key 里的非 ASCII、空格与 & 等编码后返回，避免 XML 语义歧义。
      { key: 'encoding-type', value: 'url' },
    ]
    if (options.prefix) query.push({ key: 'prefix', value: options.prefix })
    if (options.delimiter !== undefined) query.push({ key: 'delimiter', value: options.delimiter })
    if (options.continuationToken) {
      query.push({ key: 'continuation-token', value: options.continuationToken })
    }
    if (options.maxKeys !== undefined) {
      query.push({ key: 'max-keys', value: String(options.maxKeys) })
    }

    const res = await this.#call({
      method: 'GET',
      bucket: options.bucket,
      query,
      signal: options.signal,
    })
    const root = this.#xml(res)
    if (root.name !== 'ListBucketResult') {
      throw new S3Error('UnexpectedResponse', `期望 ListBucketResult，实际 ${root.name}`, res.status)
    }

    const objects = children(root, 'Contents').map((entry) => ({
      key: decodeKeyText(childText(entry, 'Key') ?? ''),
      size: Number(childText(entry, 'Size') ?? '0'),
      etag: stripQuotes(childText(entry, 'ETag') ?? ''),
      lastModified: parseDate(childText(entry, 'LastModified')),
    }))
    const prefixes = children(root, 'CommonPrefixes').map((entry) =>
      decodeKeyText(childText(entry, 'Prefix') ?? ''),
    )
    const nextToken = childText(root, 'NextContinuationToken')

    return {
      objects,
      prefixes,
      isTruncated: childText(root, 'IsTruncated') === 'true',
      nextToken: nextToken || undefined,
    }
  }

  async headObject(bucket: string, key: string, signal?: AbortSignal): Promise<ObjectInfo> {
    const res = await this.#call({
      method: 'HEAD',
      bucket,
      key,
      // 与 AWS 一致：不表态就不回传校验和头。详情页要显示 checksum 类型，必须显式要求。
      headers: { 'x-amz-checksum-mode': 'ENABLED' },
      signal,
    })
    const metadata: Record<string, string> = {}
    for (const [name, value] of res.headers) {
      if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = value
    }
    return {
      key,
      size: Number(res.headers.get('content-length') ?? '0'),
      etag: stripQuotes(res.headers.get('etag') ?? ''),
      contentType: res.headers.get('content-type') ?? '',
      lastModified: parseDate(res.headers.get('last-modified') ?? undefined),
      metadata,
      checksumSha256: res.headers.get('x-amz-checksum-sha256') ?? undefined,
      checksumType: res.headers.get('x-amz-checksum-type') ?? undefined,
    }
  }

  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
    contentType?: string,
    signal?: AbortSignal,
  ): Promise<WriteResult> {
    const digest = await sha256(body)
    const res = await this.#call({
      method: 'PUT',
      bucket,
      key,
      body,
      payloadHash: toHex(digest),
      headers: {
        'content-type': contentType || 'application/octet-stream',
        'x-amz-checksum-sha256': toBase64(digest),
      },
      signal,
    })
    return {
      etag: stripQuotes(res.headers.get('etag') ?? ''),
      checksumSha256: res.headers.get('x-amz-checksum-sha256') ?? toBase64(digest),
    }
  }

  async deleteObject(bucket: string, key: string, signal?: AbortSignal): Promise<void> {
    await this.#call({ method: 'DELETE', bucket, key, signal })
  }

  async createMultipartUpload(
    bucket: string,
    key: string,
    contentType?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await this.#call({
      method: 'POST',
      bucket,
      key,
      query: [{ key: 'uploads', value: null }],
      headers: {
        'content-type': contentType || 'application/octet-stream',
        // 显式声明 SHA256：后端据此把校验和类型定为 COMPOSITE。
        'x-amz-checksum-algorithm': 'SHA256',
      },
      signal,
    })
    const root = this.#xml(res)
    const uploadId = childText(root, 'UploadId')
    if (!uploadId) {
      throw new S3Error('UnexpectedResponse', '创建分片上传未返回 UploadId', res.status)
    }
    return uploadId
  }

  async uploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<UploadedPart> {
    const digest = await sha256(body)
    const res = await this.#call({
      method: 'PUT',
      bucket,
      key,
      query: [
        { key: 'partNumber', value: String(partNumber) },
        { key: 'uploadId', value: uploadId },
      ],
      body,
      payloadHash: toHex(digest),
      headers: { 'x-amz-checksum-sha256': toBase64(digest) },
      signal,
    })
    return {
      partNumber,
      etag: stripQuotes(res.headers.get('etag') ?? ''),
      checksumSha256: res.headers.get('x-amz-checksum-sha256') ?? toBase64(digest),
    }
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: readonly UploadedPart[],
    signal?: AbortSignal,
  ): Promise<CompleteResult> {
    const body = new TextEncoder().encode(completeBody(parts))
    const digest = await sha256(body)
    const res = await this.#call({
      method: 'POST',
      bucket,
      key,
      query: [{ key: 'uploadId', value: uploadId }],
      body,
      payloadHash: toHex(digest),
      // 这里刻意不带 x-amz-checksum-sha256：在 Complete 请求上它不是"请求体的校验和"，
      // 而是客户端声明的**全对象**校验和（S3 会用它与合并结果比对）。分片校验和已在
      // UploadPart 逐片核对过，再多声明一个形状不同的值只会被判 BadDigest。
      headers: { 'content-type': 'application/xml' },
      signal,
    })
    const root = this.#xml(res)
    return {
      etag: stripQuotes(childText(root, 'ETag') ?? res.headers.get('etag') ?? ''),
      checksumSha256: childText(root, 'ChecksumSHA256') ?? undefined,
      checksumType: childText(root, 'ChecksumType') ?? undefined,
    }
  }

  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call({
      method: 'DELETE',
      bucket,
      key,
      query: [{ key: 'uploadId', value: uploadId }],
      signal,
    })
  }

  async getObjectRange(
    bucket: string,
    key: string,
    options: { start: number; end: number; etag?: string; signal?: AbortSignal },
  ): Promise<HttpStreamResponse> {
    if (options.signal?.aborted) throw abortError()
    const headers: Record<string, string> = {
      range: `bytes=${options.start}-${options.end}`,
    }
    if (options.etag) {
      // 并发覆盖保护：若对象在分块之间被替换，宁可直接失败，也不要把两版拼成一个文件。
      headers['if-match'] = quoted(options.etag)
    }
    const signed = await this.#sign({
      method: 'GET',
      bucket,
      key,
      headers,
    })
    if (options.signal?.aborted) throw abortError()
    const res = await this.#transport.stream({
      method: 'GET',
      ...signed,
      signal: options.signal,
    })
    if (res.status >= 300) {
      const bytes = new Uint8Array(await new Response(res.body).arrayBuffer())
      throw errorFromResponse(res.status, res.headers.get('x-amz-request-id'), bytes)
    }
    return res
  }

  /** GET 整对象（小文件与压测用），返回字节与响应头。 */
  async getObject(
    bucket: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ body: Uint8Array; etag: string }> {
    const res = await this.#call({ method: 'GET', bucket, key, signal })
    return { body: res.body, etag: stripQuotes(res.headers.get('etag') ?? '') }
  }

  async #call(options: CallOptions & { payloadHash?: string }): Promise<HttpResponse> {
    // 已取消的请求绝不下发：传输层实现未必保证对"入场即已取消"的信号立即失败，
    // 提前拦截既省一次哈希/签名，也避免请求在取消后才到达后端。
    if (options.signal?.aborted) throw abortError()
    const signed = await this.#sign(options)
    // 签名是异步边界：等待期间可能已被取消，下发前必须再确认一次。
    if (options.signal?.aborted) throw abortError()
    const request: HttpRequest = {
      method: options.method,
      ...signed,
      signal: options.signal,
    }
    if (options.body !== undefined) request.body = options.body
    const res = await this.#transport.send(request)
    if (res.status >= 300) {
      throw errorFromResponse(res.status, res.headers.get('x-amz-request-id'), res.body)
    }
    return res
  }

  async #sign(options: CallOptions & { payloadHash?: string }) {
    const path = this.#path(options.bucket, options.key)
    let payloadHash = options.payloadHash
    if (!payloadHash) {
      payloadHash = options.body ? toHex(await sha256(options.body)) : SHA256_OF_EMPTY
    }
    return this.#signer.sign({
      method: options.method,
      path,
      query: options.query ?? [],
      host: this.#host,
      payloadHash,
      headers: options.headers,
    })
  }

  #path(bucket?: string, key?: string): string {
    if (!bucket) return '/'
    const base = '/' + encodeBucket(bucket)
    if (key === undefined) return base
    assertObjectKey(key)
    return `${base}/${encodeKey(key)}`
  }

  #xml(res: HttpResponse) {
    return parseXml(new TextDecoder().decode(res.body))
  }
}

function completeBody(parts: readonly UploadedPart[]): string {
  const entries = parts
    .map((part) => {
      const checksum = part.checksumSha256
        ? `<ChecksumSHA256>${xmlEscape(part.checksumSha256)}</ChecksumSHA256>`
        : ''
      return (
        '<Part>' +
        `<PartNumber>${part.partNumber}</PartNumber>` +
        `<ETag>${xmlEscape(quoted(part.etag))}</ETag>` +
        checksum +
        '</Part>'
      )
    })
    .join('')
  return `<CompleteMultipartUpload>${entries}</CompleteMultipartUpload>`
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function stripQuotes(etag: string): string {
  return etag.replace(/^"+|"+$/g, '')
}

function quoted(etag: string): string {
  return `"${stripQuotes(etag)}"`
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
