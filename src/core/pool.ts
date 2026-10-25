import { abortError } from './errors.ts'

/**
 * 计数信号量。
 *
 * 浏览器对同一源的 HTTP/1.1 连接上限是 6，而上传分片、下载分块、列表请求
 * 都走同一个连接池。若每类操作各自限制并发，叠加后仍会把连接池占满，导致
 * 交互请求排队。因此传输类操作共用一个全局实例，上限 4，给交互留出余量。
 */
export class Semaphore {
  readonly #limit: number
  #active = 0
  readonly #waiters: Waiter[] = []

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`信号量上限必须是正整数，收到 ${limit}`)
    }
    this.#limit = limit
  }

  get limit(): number {
    return this.#limit
  }

  get active(): number {
    return this.#active
  }

  get pending(): number {
    return this.#waiters.length
  }

  /**
   * 占用一个名额，返回幂等的释放函数。等待期间收到 abort 会立即以
   * AbortError 失败且不会漏放名额。
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.#active < this.#limit) {
      this.#active++
      return Promise.resolve(this.#releaser())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }
      if (signal) {
        waiter.signal = signal
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) this.#waiters.splice(index, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.#waiters.push(waiter)
    })
  }

  /** 占名额执行任务，无论成功失败都会释放。 */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      return await task()
    } finally {
      release()
    }
  }

  #releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active--
      this.#drain()
    }
  }

  #drain(): void {
    while (this.#active < this.#limit && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()
      if (!waiter) return
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      this.#active++
      waiter.resolve(this.#releaser())
    }
  }
}

interface Waiter {
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/** 全局传输名额：上传、下载、压测共用，避免叠加超发。 */
export const transferPool = new Semaphore(4)
