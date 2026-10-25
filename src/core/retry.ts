import { TransportError, abortError, isAbortError, isS3Error } from './errors.ts'

/**
 * 重试策略是纯数据 + 纯函数，方便单测；执行器只负责调度与取消。
 * attempts 是总尝试次数（含首次），因此 attempts=3 表示最多 2 次重试。
 */
export interface RetryPolicy {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** 抖动比例（0–1）：实际延迟在 [d*(1-j), d] 之间均匀取值 */
  jitter: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  jitter: 0.3,
}

export const NO_RETRY: RetryPolicy = {
  attempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  jitter: 0,
}

/** 明确可重试的 S3 错误码：其余 4xx 重试没有意义（签名、权限、key 都不会自己变好）。 */
const RETRYABLE_CODES = new Set([
  'InternalError',
  'ServiceUnavailable',
  'SlowDown',
  'RequestTimeout',
  'Throttling',
  'ThrottlingException',
  'RequestTimeTooSkewed',
])

export function isRetryable(error: unknown): boolean {
  // 取消是用户意图，绝不能重试。
  if (isAbortError(error)) return false
  if (isS3Error(error)) {
    if (error.status === 408 || error.status === 429 || error.status >= 500) return true
    return RETRYABLE_CODES.has(error.code)
  }
  // 网络层失败：连接被拒、连接被重置、响应中断等。
  return error instanceof TransportError
}

/**
 * 第 failedAttempt 次失败后的等待时间（failedAttempt 从 1 开始）。
 * 等额抖动：d 为指数退避值，实际取 [d/2, d] 的均匀随机 —— 既分散重试风暴，
 * 又不会让某次重试等到接近 0。
 */
export function retryDelayMs(
  failedAttempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  if (failedAttempt < 1) throw new RangeError(`failedAttempt 必须 ≥ 1，收到 ${failedAttempt}`)
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failedAttempt - 1))
  const half = exponential / 2
  return Math.round(half + random() * half)
}

export interface RetryAttemptInfo {
  /** 刚失败的尝试序号（1 基） */
  attempt: number
  error: unknown
  delayMs: number
}

export interface RetryOptions {
  policy?: RetryPolicy
  signal?: AbortSignal
  onRetry?: (info: RetryAttemptInfo) => void
  /** 测试注入；默认使用可取消的 setTimeout */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** 执行任务并在可重试错误上退避重试。取消时不重试、不算作失败。 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY
  const sleep = options.sleep ?? delay
  const attempts = Math.max(1, policy.attempts)

  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw abortError()
    try {
      return await task(attempt)
    } catch (error) {
      const canRetry = attempt < attempts && isRetryable(error) && !options.signal?.aborted
      if (!canRetry) throw error
      const delayMs = retryDelayMs(attempt, policy)
      options.onRetry?.({ attempt, error, delayMs })
      await sleep(delayMs, options.signal)
    }
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
