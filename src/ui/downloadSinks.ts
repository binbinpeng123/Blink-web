import type { DownloadSink } from '../core/downloader.ts'
import { isAbortError } from '../core/errors.ts'
import { formatBytes } from '../core/formatters.ts'

/**
 * 内存回退的上限。超过后整文件常驻内存，标签页很容易被系统杀掉；
 * 与其在下载末尾崩溃，不如在写入过程中明确报错。
 */
export const MEMORY_DOWNLOAD_LIMIT = 256 * 1024 * 1024

/** File System Access API 的最小类型声明：只声明本文件用到的部分。 */
interface WritableFileStreamLike {
  write(data: BufferSource | Blob | string): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

interface FileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableFileStreamLike>
}

interface PickerWindow {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<FileHandleLike>
}

export interface SinkRequest {
  key: string
  /** FS Access 不可用时的原因，供界面提示；用户主动取消不会触发。 */
  onFallback?: (reason: string) => void
}

/**
 * 优先用 File System Access 流式写盘（内存只占一个分块），
 * 不支持时回退到内存 Blob。两者对 Downloader 是同一个接口。
 */
export async function createDownloadSink(request: SinkRequest): Promise<DownloadSink> {
  const picker = (window as unknown as PickerWindow).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      // 必须在用户手势的同步调用链里打开选择器，否则浏览器会拒绝
      const handle = await picker.call(window, { suggestedName: suggestedName(request.key) })
      return new FileSink(await handle.createWritable({ keepExistingData: false }))
    } catch (error) {
      // 用户关掉保存对话框不是故障：不能悄悄改成"下载到默认目录"。
      if (isAbortError(error)) throw error
      request.onFallback?.(
        `当前环境无法流式写盘（${describePickerFailure(error)}），改用内存下载`,
      )
    }
  } else {
    request.onFallback?.('当前浏览器不支持 File System Access，改用内存下载')
  }
  return new MemorySink(request.key)
}

class FileSink implements DownloadSink {
  readonly #writable: WritableFileStreamLike
  #closed = false

  constructor(writable: WritableFileStreamLike) {
    this.#writable = writable
  }

  // Downloader 的每个分块都由 new Uint8Array(n) 分配，缓冲一定是 ArrayBuffer；
  // 收窄参数即可满足 WritableStream 的 BufferSource 约束，无需运行时拷贝。
  async write(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.#writable.write(chunk)
  }

  async close(): Promise<void> {
    await this.#writable.close()
    this.#closed = true
  }

  async abort(): Promise<void> {
    if (this.#closed) return
    // abort 之后流通常已不可用；清理失败不应覆盖原始错误。
    await this.#writable.abort().catch(() => {})
  }
}

export class MemorySink implements DownloadSink {
  readonly #chunks: Uint8Array<ArrayBuffer>[] = []
  readonly #key: string
  readonly #limit: number
  readonly #deliver: (blob: Blob, name: string) => void
  #bytes = 0

  constructor(
    key: string,
    limit = MEMORY_DOWNLOAD_LIMIT,
    deliver: (blob: Blob, name: string) => void = saveBlob,
  ) {
    this.#key = key
    this.#limit = limit
    this.#deliver = deliver
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#bytes + chunk.byteLength > this.#limit) {
      throw new Error(
        `文件超过内存下载上限 ${formatBytes(this.#limit)}；请使用 Chrome/Edge 的流式写盘，或改用 Node CLI`,
      )
    }
    // 复制一份：调用方可能复用缓冲区，而 Blob 需要稳定的快照。
    this.#chunks.push(chunk.slice())
    this.#bytes += chunk.byteLength
  }

  async close(): Promise<void> {
    const blob = new Blob(this.#chunks)
    this.#chunks.length = 0
    this.#deliver(blob, suggestedName(this.#key))
  }

  async abort(): Promise<void> {
    this.#chunks.length = 0
  }
}

/** 用隐藏链接交付 Blob；延迟释放 URL，避免下载被浏览器取消。 */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 只取最后一段作为文件名，并替换各操作系统不允许的字符。 */
export function suggestedName(key: string): string {
  // 以 / 结尾的 key 是"目录占位对象"，没有可用的文件名，交给默认值。
  const base = key.endsWith('/') ? '' : (key.split('/').at(-1) ?? '')
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim()
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'download.bin'
  return cleaned
}

function describePickerFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'SecurityError') return '需要安全上下文或用户手势'
  if (error instanceof Error && error.name === 'NotAllowedError') return '权限被拒绝'
  return error instanceof Error ? error.name : '未知错误'
}
