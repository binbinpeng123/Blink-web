import type { S3Client, UploadedPart } from './client.ts'
import { abortError, isAbortError } from './errors.ts'
import { Semaphore, transferPool } from './pool.ts'
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from './retry.ts'

/** S3 约束：除末片外每片至少 5 MiB。8 MiB 在"少请求"和"失败重传代价"之间取平衡。 */
export const PART_SIZE = 8 * 1024 * 1024
export const MIN_PART_SIZE = 5 * 1024 * 1024
export const MAX_PARTS = 10_000
export const DEFAULT_CONCURRENCY = 4

/** 只依赖 size / slice，File 与 Blob 都直接满足；测试可注入轻量替身。 */
export interface UploadSource {
  readonly size: number
  slice(start?: number, end?: number): Blob
}

export interface UploadProgress {
  phase: 'uploading' | 'completing'
  uploadedBytes: number
  totalBytes: number
  completedParts: number
  totalParts: number
  /** false 表示字节级进度不可知（fetch 不暴露上传进度），UI 应显示不确定进度条。 */
  determinate: boolean
}

export interface UploadOptions {
  bucket: string
  key: string
  contentType?: string
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
}

export interface UploadResult {
  mode: 'single' | 'multipart'
  bytes: number
  etag: string
  checksumSha256: string | undefined
  /**
   * single 为 FULL_OBJECT；
   * multipart 取后端返回的 ChecksumType（通常 COMPOSITE，不等于整文件 SHA-256）。
   */
  checksumType: string | undefined
  parts: number
}

export interface UploaderOptions {
  partSize?: number
  concurrency?: number
  retry?: RetryPolicy
  /** 默认使用全局传输信号量；注入独立实例便于单测并发上限。 */
  pool?: Semaphore
}

/**
 * 上传用例：≤ partSize 走单 PUT，否则分片并行 + 逐片重试 + 取消清理。
 * 只依赖 S3Client，不碰 DOM，浏览器与 Node 压测工具共用。
 */
export class Uploader {
  readonly #client: S3Client
  readonly #partSize: number
  readonly #concurrency: number
  readonly #retry: RetryPolicy
  readonly #pool: Semaphore

  constructor(client: S3Client, options: UploaderOptions = {}) {
    const partSize = options.partSize ?? PART_SIZE
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`并发数必须是正整数，收到 ${concurrency}`)
    }
    this.#client = client
    this.#partSize = partSize
    this.#concurrency = concurrency
    this.#retry = options.retry ?? DEFAULT_RETRY
    this.#pool = options.pool ?? transferPool
  }

  async upload(source: UploadSource, options: UploadOptions): Promise<UploadResult> {
    if (options.signal?.aborted) throw abortError()
    const totalBytes = source.size
    if (totalBytes <= this.#partSize) {
      return this.#singlePut(source, totalBytes, options)
    }
    return this.#multipart(source, totalBytes, options)
  }

  async #singlePut(
    source: UploadSource,
    totalBytes: number,
    options: UploadOptions,
  ): Promise<UploadResult> {
    // fetch 无法报告上传进度：先发一次不确定进度，UI 不要伪造百分比。
    this.#emit(options, {
      phase: 'uploading',
      uploadedBytes: 0,
      totalBytes,
      completedParts: 0,
      totalParts: 1,
      determinate: false,
    })
    const bytes = new Uint8Array(await source.slice(0, totalBytes).arrayBuffer())
    const result = await this.#client.putObject(
      options.bucket,
      options.key,
      bytes,
      options.contentType,
      options.signal,
    )
    return {
      mode: 'single',
      bytes: totalBytes,
      etag: result.etag,
      checksumSha256: result.checksumSha256,
      // 单 PUT 发送的是整对象 SHA-256，因此类型就是 FULL_OBJECT。
      checksumType: 'FULL_OBJECT',
      parts: 1,
    }
  }

  async #multipart(
    source: UploadSource,
    totalBytes: number,
    options: UploadOptions,
  ): Promise<UploadResult> {
    if (this.#partSize < MIN_PART_SIZE) {
      throw new RangeError(`分片大小不得小于 5 MiB，当前 ${this.#partSize} 字节`)
    }
    const totalParts = Math.ceil(totalBytes / this.#partSize)
    if (totalParts > MAX_PARTS) {
      throw new RangeError(`分片数 ${totalParts} 超过上限 ${MAX_PARTS}，请增大分片`)
    }

    const { bucket, key } = options
    // 创建请求不重试：网络中断时无法得知 uploadId，重试只会留下更多孤儿分片。
    const uploadId = await this.#client.createMultipartUpload(
      bucket,
      key,
      options.contentType,
      options.signal,
    )

    // 任一 worker 失败即中止其余 worker；合并调用方的取消信号。
    const controller = new AbortController()
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal

    const completed: UploadedPart[] = []
    let uploadedBytes = 0
    let cursor = 0
    let failed = false
    let failure: unknown = null

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return
        const index = cursor
        cursor++
        if (index >= totalParts) return

        const start = index * this.#partSize
        const end = Math.min(start + this.#partSize, totalBytes)
        try {
          const part = await withRetry(
            async () => {
              const release = await this.#pool.acquire(signal)
              try {
                // 排队期间可能已被取消：先退出，避免为一片注定丢弃的数据做哈希。
                if (signal.aborted) throw abortError()
                const bytes = new Uint8Array(await source.slice(start, end).arrayBuffer())
                return await this.#client.uploadPart(
                  bucket,
                  key,
                  uploadId,
                  index + 1,
                  bytes,
                  signal,
                )
              } finally {
                release()
              }
            },
            { policy: this.#retry, signal },
          )
          completed.push(part)
          uploadedBytes += end - start
          this.#emit(options, {
            phase: 'uploading',
            uploadedBytes,
            totalBytes,
            completedParts: completed.length,
            totalParts,
            determinate: true,
          })
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
          controller.abort()
          return
        }
      }
    }

    const workers = Math.min(this.#concurrency, totalParts)
    await Promise.all(Array.from({ length: workers }, worker))

    if (options.signal?.aborted) {
      await this.#abortQuietly(uploadId, bucket, key)
      throw abortError()
    }
    if (failed) {
      await this.#abortQuietly(uploadId, bucket, key)
      throw failure
    }

    completed.sort((a, b) => a.partNumber - b.partNumber)
    this.#emit(options, {
      phase: 'completing',
      uploadedBytes: totalBytes,
      totalBytes,
      completedParts: totalParts,
      totalParts,
      determinate: true,
    })

    try {
      const result = await this.#client.completeMultipartUpload(
        bucket,
        key,
        uploadId,
        completed,
        options.signal,
      )
      return {
        mode: 'multipart',
        bytes: totalBytes,
        etag: result.etag,
        checksumSha256: result.checksumSha256,
        checksumType: result.checksumType ?? 'COMPOSITE',
        parts: totalParts,
      }
    } catch (error) {
      // Complete 失败时清理残留：已成功完成的上传会返回 NoSuchUpload，不会误删对象。
      if (!isAbortError(error)) await this.#abortQuietly(uploadId, bucket, key)
      throw error
    }
  }

  async #abortQuietly(uploadId: string, bucket: string, key: string): Promise<void> {
    try {
      await this.#client.abortMultipartUpload(
        bucket,
        key,
        uploadId,
        AbortSignal.timeout(10_000),
      )
    } catch {
      // 清理是尽力而为：失败（含后端已无此上传）不能掩盖原始错误。
    }
  }

  #emit(options: UploadOptions, progress: UploadProgress): void {
    try {
      options.onProgress?.(progress)
    } catch {
      // 视图回调抛错不应中断传输。
    }
  }
}
