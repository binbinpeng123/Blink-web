import type { S3Client } from './client.ts'
import { TransportError, abortError } from './errors.ts'
import { Semaphore, transferPool } from './pool.ts'
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from './retry.ts'

/**
 * 4 MiB 在"请求次数"与"内存/重传代价"之间取平衡：
 * 每块完整读入后才写盘，因此重试不会把同一段数据写两遍。
 */
export const DOWNLOAD_CHUNK_SIZE = 4 * 1024 * 1024

/**
 * 下载落点。File System Access 与内存回退都实现这个接口，
 * Downloader 不关心字节最终去了磁盘还是 Blob。
 */
export interface DownloadSink {
  write(chunk: Uint8Array): Promise<void>
  /** 收尾：关闭文件句柄或交付 Blob。 */
  close(): Promise<void>
  /** 失败或取消：丢弃已写内容，不得掩盖原始错误。 */
  abort(): Promise<void>
}

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number
  chunks: number
  totalChunks: number
}

export interface DownloadOptions {
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
}

export interface DownloadResult {
  bytes: number
  etag: string
  chunks: number
  contentType: string
}

export interface DownloaderOptions {
  chunkSize?: number
  retry?: RetryPolicy
  /** 默认使用全局传输信号量，与上传共用连接预算。 */
  pool?: Semaphore
}

/**
 * 下载用例：HEAD 取大小与 ETag → 按 Range 顺序取块 → 逐块写入 sink。
 *
 * 顺序下载而非并行，是为了让 sink 只做追加写（File System Access 的
 * WritableStream 不接受乱序写），同时把内存占用限制在一个分块。
 */
export class Downloader {
  readonly #client: S3Client
  readonly #chunkSize: number
  readonly #retry: RetryPolicy
  readonly #pool: Semaphore

  constructor(client: S3Client, options: DownloaderOptions = {}) {
    const chunkSize = options.chunkSize ?? DOWNLOAD_CHUNK_SIZE
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError(`分块大小必须是正整数，收到 ${chunkSize}`)
    }
    this.#client = client
    this.#chunkSize = chunkSize
    this.#retry = options.retry ?? DEFAULT_RETRY
    this.#pool = options.pool ?? transferPool
  }

  async download(
    bucket: string,
    key: string,
    sink: DownloadSink,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    const { signal } = options
    if (signal?.aborted) throw abortError()

    let finished = false
    try {
      const info = await this.#client.headObject(bucket, key, signal)
      const totalBytes = info.size
      const totalChunks = Math.ceil(totalBytes / this.#chunkSize)
      let downloadedBytes = 0

      this.#emit(options, { downloadedBytes, totalBytes, chunks: 0, totalChunks })

      for (let index = 0; index < totalChunks; index++) {
        if (signal?.aborted) throw abortError()
        const start = index * this.#chunkSize
        const end = Math.min(start + this.#chunkSize, totalBytes) - 1

        // 先把整块读进内存再写：中途失败重试时不会向 sink 追加重复数据。
        const bytes = await withRetry(
          () =>
            this.#pool.run(
              async () => {
                if (signal?.aborted) throw abortError()
                return this.#fetchRange(bucket, key, start, end, info.etag, signal)
              },
              signal,
            ),
          { policy: this.#retry, signal },
        )

        // 传输层空闲之后才落盘：写慢不该占用连接名额。
        await sink.write(bytes)
        downloadedBytes += bytes.byteLength
        this.#emit(options, {
          downloadedBytes,
          totalBytes,
          chunks: index + 1,
          totalChunks,
        })
      }

      await sink.close()
      finished = true
      return {
        bytes: totalBytes,
        etag: info.etag,
        chunks: totalChunks,
        contentType: info.contentType,
      }
    } catch (error) {
      if (!finished) {
        try {
          await sink.abort()
        } catch {
          // 清理是尽力而为：不能掩盖原始错误。
        }
      }
      throw error
    }
  }

  async #fetchRange(
    bucket: string,
    key: string,
    start: number,
    end: number,
    etag: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const expected = end - start + 1
    const response = await this.#client.getObjectRange(bucket, key, {
      start,
      end,
      etag,
      signal,
    })

    const bytes = new Uint8Array(expected)
    const reader = response.body.getReader()
    let offset = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (offset + value.byteLength > expected) {
          throw new TransportError(`范围响应超出预期长度：bytes=${start}-${end}`)
        }
        bytes.set(value, offset)
        offset += value.byteLength
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }

    // fetch 的流在连接被提前关闭时不一定报错，必须自己核对长度，
    // 否则短读会被当成"文件就这么大"写进磁盘。
    if (offset !== expected) {
      throw new TransportError(
        `范围响应不完整：bytes=${start}-${end} 期望 ${expected} 字节，实际 ${offset} 字节`,
      )
    }
    return bytes
  }

  #emit(options: DownloadOptions, progress: DownloadProgress): void {
    try {
      options.onProgress?.(progress)
    } catch {
      // 视图回调抛错不应中断传输。
    }
  }
}
