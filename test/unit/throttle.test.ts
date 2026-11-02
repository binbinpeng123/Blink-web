import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createLoginThrottle, resolveClientAddress } from '../../server/throttle.ts'

/** 用假 socket 构造只有地址与请求头的 IncomingMessage 替身。 */
function fakeRequest(remoteAddress: string | undefined, headers: Record<string, string> = {}) {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage
}

test('窗口内失败达到阈值后才暂停，暂停期给出剩余等待时间', () => {
  let clock = 1_000_000
  const throttle = createLoginThrottle({
    maxFailures: 3,
    windowMs: 60_000,
    blockMs: 30_000,
    now: () => clock,
    log: () => {},
  })

  throttle.recordFailure('a')
  throttle.recordFailure('a')
  assert.equal(throttle.retryAfterMs('a'), 0, '未达阈值不应暂停')

  throttle.recordFailure('a')
  assert.equal(throttle.retryAfterMs('a'), 30_000)

  clock += 10_000
  assert.equal(throttle.retryAfterMs('a'), 20_000)

  clock += 20_000
  assert.equal(throttle.retryAfterMs('a'), 0, '到期后应放行')
})

test('失败计数按滑动窗口过期，不会无限累积', () => {
  let clock = 1_000_000
  const throttle = createLoginThrottle({
    maxFailures: 2,
    windowMs: 10_000,
    blockMs: 30_000,
    now: () => clock,
    log: () => {},
  })

  throttle.recordFailure('a')
  clock += 6_000
  throttle.recordFailure('a')
  assert.equal(throttle.retryAfterMs('a'), 30_000, '两次都在窗口内应触发暂停')

  // 换一个来源验证窗口过期：同样 2 次失败，间隔超过窗口则不触发
  throttle.recordFailure('b')
  clock += 11_000
  throttle.recordFailure('b')
  assert.equal(throttle.retryAfterMs('b'), 0, '过期失败不应计入窗口')
})

test('连续触发暂停时暂停时长指数加倍并封顶', () => {
  let clock = 1_000_000
  const throttle = createLoginThrottle({
    maxFailures: 1,
    windowMs: 60_000,
    blockMs: 1_000,
    maxBlockMs: 4_000,
    now: () => clock,
    log: () => {},
  })

  const durations: number[] = []
  for (let round = 0; round < 6; round += 1) {
    throttle.recordFailure('a')
    durations.push(throttle.retryAfterMs('a'))
    // 越过本次暂停，进入下一轮
    clock += throttle.retryAfterMs('a') + 1
  }
  assert.deepEqual(durations, [1_000, 2_000, 4_000, 4_000, 4_000, 4_000])
})

test('不同来源互不影响；暂停到期后继续失败会继续加倍', () => {
  let clock = 1_000_000
  const throttle = createLoginThrottle({
    maxFailures: 2,
    windowMs: 60_000,
    blockMs: 1_000,
    maxBlockMs: 60_000,
    now: () => clock,
    log: () => {},
  })

  throttle.recordFailure('a')
  throttle.recordFailure('a')
  assert.equal(throttle.retryAfterMs('a'), 1_000)
  assert.equal(throttle.retryAfterMs('b'), 0, '其他来源不应被连坐')

  // 暂停到期，计分却是清零的：需要重新攒满阈值才再次暂停
  clock += 1_001
  assert.equal(throttle.retryAfterMs('a'), 0)
  throttle.recordFailure('a')
  assert.equal(throttle.retryAfterMs('a'), 0)
  throttle.recordFailure('a')
  assert.equal(throttle.retryAfterMs('a'), 2_000, '第二次触发应为 1s 的两倍')
})

test('登录成功清除该来源的失败记录', () => {
  let clock = 1_000_000
  const throttle = createLoginThrottle({ maxFailures: 2, now: () => clock, log: () => {} })

  throttle.recordFailure('a')
  throttle.recordSuccess('a')
  throttle.recordFailure('a')
  assert.equal(throttle.retryAfterMs('a'), 0, '成功应重置计数')

  throttle.recordFailure('a')
  assert.equal(throttle.retryAfterMs('a'), 30_000)
})

test('跟踪的来源数有上限，超出时淘汰最久未活动的来源', () => {
  const clock = { value: 1_000_000 }
  const throttle = createLoginThrottle({
    maxFailures: 5,
    maxKeys: 3,
    now: () => clock.value,
    log: () => {},
  })

  for (const key of ['a', 'b', 'c']) {
    throttle.recordFailure(key)
    clock.value += 1
  }
  assert.equal(throttle.size, 3)

  clock.value += 1
  throttle.recordFailure('d')
  assert.equal(throttle.size, 3, '不得超出上限')
  assert.equal(throttle.retryAfterMs('a'), 0)
  // b 仍在窗口内：它的记录应被保留（淘汰的是最久未活动的 a）
  throttle.recordFailure('b')
  assert.equal(throttle.retryAfterMs('b'), 0)
})

test('来源解析：默认只信任 TCP 对端，忽略可伪造的代理头', () => {
  const req = fakeRequest('203.0.113.9', {
    'cf-connecting-ip': '198.51.100.7',
    'x-forwarded-for': '192.0.2.1, 10.0.0.1',
  })
  assert.equal(resolveClientAddress(req), '203.0.113.9')
  assert.equal(resolveClientAddress(req, { trustProxy: true }), '203.0.113.9')
})

test('来源解析：对端是回环且显式信任代理时取 CF-Connecting-IP', () => {
  const req = fakeRequest('127.0.0.1', {
    'cf-connecting-ip': '198.51.100.7',
    'x-forwarded-for': '192.0.2.1',
  })
  assert.equal(resolveClientAddress(req, { trustProxy: true }), '198.51.100.7')
})

test('来源解析：没有 CF 头时取 X-Forwarded-For 最右侧（最靠近服务的可信项）', () => {
  const req = fakeRequest('::1', {
    'x-forwarded-for': '192.0.2.1, 198.51.100.7 , 10.0.0.1',
  })
  assert.equal(resolveClientAddress(req, { trustProxy: true }), '10.0.0.1')

  const onlyClient = fakeRequest('127.0.0.1', { 'x-forwarded-for': '198.51.100.7' })
  assert.equal(resolveClientAddress(onlyClient, { trustProxy: true }), '198.51.100.7')
})

test('来源解析：代理头不是合法 IP 时退回对端地址', () => {
  const req = fakeRequest('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip' })
  assert.equal(resolveClientAddress(req, { trustProxy: true }), '127.0.0.1')
})

test('IPv4 映射地址归一化为点分形式，便于日志与限速桶一致', () => {
  const req = fakeRequest('::ffff:127.0.0.1', { 'cf-connecting-ip': '::ffff:198.51.100.7' })
  assert.equal(resolveClientAddress(req, { trustProxy: true }), '198.51.100.7')
  assert.equal(resolveClientAddress(fakeRequest('::ffff:203.0.113.9')), '203.0.113.9')
})

test('对端地址缺失时记为 unknown，不会共享成空键', () => {
  assert.equal(resolveClientAddress(fakeRequest(undefined)), 'unknown')
})

test('真实回环连接下，resolveClientAddress 与 node 提供的 remoteAddress 一致', async () => {
  const server = createServer((req, res) => {
    res.end(resolveClientAddress(req))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const body = await new Promise<string>((resolve, reject) => {
      fetch(`http://127.0.0.1:${port}/`)
        .then((res) => res.text())
        .then(resolve, reject)
    })
    assert.equal(body, '127.0.0.1')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
