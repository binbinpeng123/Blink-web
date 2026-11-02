import assert from 'node:assert/strict'
import { test } from 'node:test'
import { S3Error, TransportError } from '../../src/core/errors.ts'
import {
  DEFAULT_RETRY,
  NO_RETRY,
  isRetryable,
  retryDelayMs,
  withRetry,
  type RetryAttemptInfo,
} from '../../src/core/retry.ts'

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

test('退避延迟落在 [d/2, d] 区间，并受 maxDelayMs 截断', () => {
  const policy = { attempts: 5, baseDelayMs: 100, maxDelayMs: 1_000, jitter: 0.3 }
  assert.equal(retryDelayMs(1, policy, () => 0), 50)
  assert.equal(retryDelayMs(1, policy, () => 1), 100)
  assert.equal(retryDelayMs(2, policy, () => 0), 100)
  assert.equal(retryDelayMs(2, policy, () => 1), 200)
  // 100 * 2^4 = 1600 → 截断到 1000，区间 [500, 1000]
  assert.equal(retryDelayMs(5, policy, () => 0), 500)
  assert.equal(retryDelayMs(5, policy, () => 1), 1_000)
  assert.throws(() => retryDelayMs(0, policy), RangeError)
})

test('可重试判定：5xx/408/429/网络错误重试，4xx 与取消不重试', () => {
  assert.equal(isRetryable(new S3Error('InternalError', 'x', 500)), true)
  assert.equal(isRetryable(new S3Error('BadRequest', 'x', 400)), false)
  assert.equal(isRetryable(new S3Error('Forbidden', 'x', 403)), false)
  assert.equal(isRetryable(new S3Error('NotFound', 'x', 404)), false)
  assert.equal(isRetryable(new S3Error('RequestTimeout', 'x', 408)), true)
  assert.equal(isRetryable(new S3Error('Throttling', 'x', 429)), true)
  // 某些实现用 400/503 返回 SlowDown：按 code 判定
  assert.equal(isRetryable(new S3Error('SlowDown', 'x', 400)), true)
  assert.equal(isRetryable(new S3Error('ServiceUnavailable', 'x', 400)), true)
  assert.equal(isRetryable(new TransportError('connection reset')), true)
  assert.equal(isRetryable(new DOMException('canceled', 'AbortError')), false)
  assert.equal(isRetryable(new Error('random')), false)
})

test('首次失败后成功返回，onRetry 收到尝试序号', async () => {
  const info: RetryAttemptInfo[] = []
  let calls = 0
  const value = await withRetry(
    async () => {
      calls++
      if (calls < 3) throw new S3Error('InternalError', 'x', 500)
      return 'ok'
    },
    {
      policy: { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 0 },
      sleep: async () => {},
      onRetry: (attempt) => info.push(attempt),
    },
  )

  assert.equal(value, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(
    info.map((item) => item.attempt),
    [1, 2],
  )
  // withRetry 内部使用 Math.random 抖动：只断言落在各自的等额抖动区间
  assert.ok(info[0]!.delayMs >= 5 && info[0]!.delayMs <= 10)
  assert.ok(info[1]!.delayMs >= 10 && info[1]!.delayMs <= 20)
})

test('不可重试的错误立即抛出不消耗尝试次数', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(
      async () => {
        calls++
        throw new S3Error('AccessDenied', 'x', 403)
      },
      { policy: DEFAULT_RETRY, sleep: async () => {} },
    ),
    (error: unknown) => error instanceof S3Error && error.code === 'AccessDenied',
  )
  assert.equal(calls, 1)
})

test('尝试次数耗尽后抛出最后一次错误', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(
      async () => {
        calls++
        throw new TransportError('reset')
      },
      { policy: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 }, sleep: async () => {} },
    ),
    (error: unknown) => error instanceof TransportError,
  )
  assert.equal(calls, 3)
})

test('NO_RETRY 只执行一次', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(
      async () => {
        calls++
        throw new S3Error('InternalError', 'x', 500)
      },
      { policy: NO_RETRY },
    ),
  )
  assert.equal(calls, 1)
})

test('退避期间取消会立即以 AbortError 结束', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(
    withRetry(
      async () => {
        calls++
        throw new S3Error('InternalError', 'x', 500)
      },
      {
        policy: { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, jitter: 0 },
        signal: controller.signal,
        sleep: async () => {
          controller.abort()
          throw new DOMException('操作已取消', 'AbortError')
        },
      },
    ),
    isAbort,
  )
  assert.equal(calls, 1)
})

test('信号已取消时任务根本不会执行', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(
    withRetry(
      async () => {
        calls++
        return 'never'
      },
      { signal: controller.signal },
    ),
    isAbort,
  )
  assert.equal(calls, 0)
})
