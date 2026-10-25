import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BenchmarkRunner,
  describeBenchmarkError,
  type BenchmarkClient,
  type BenchmarkConfig,
  type BenchmarkEvent,
} from '../../src/core/benchmark.ts'
import { toBase64 } from '../../src/core/encoding.ts'
import { S3Error, TransportError } from '../../src/core/errors.ts'
import type { WriteResult } from '../../src/core/client.ts'

interface StoredObject {
  body: Uint8Array
  digest: Uint8Array
}

/** 内存替身：记录对象、模拟延迟/失败/并发，并可按需破坏 GET 正文。 */
class FakeClient implements BenchmarkClient {
  readonly objects = new Map<string, StoredObject>()
  readonly putKeys: string[] = []
  readonly getKeys: string[] = []
  active = 0
  maxActive = 0
  delayMs = 0
  corruptGets = false
  failPuts: Error | null = null
  failGets: Error | null = null
  #putCount = 0

  async putObjectWithDigest(
    _bucket: string,
    key: string,
    body: Uint8Array,
    digest: Uint8Array,
  ): Promise<WriteResult> {
    await this.#enter()
    try {
      this.#putCount++
      if (this.failPuts) throw this.failPuts
      // 复制入参：调用方会复用缓冲区，替身必须保存快照。
      this.objects.set(key, { body: body.slice(), digest: digest.slice() })
      this.putKeys.push(key)
      return {
        etag: `etag-${this.#putCount}`,
        checksumSha256: toBase64(digest),
      }
    } finally {
      this.active--
    }
  }

  async getObject(_bucket: string, key: string): Promise<{ body: Uint8Array; etag: string }> {
    await this.#enter()
    try {
      if (this.failGets) throw this.failGets
      const stored = this.objects.get(key)
      if (!stored) throw new S3Error('NoSuchKey', `缺少对象 ${key}`, 404)
      this.getKeys.push(key)
      const body = stored.body.slice()
      // 只破坏正文不改长度：校验和必须能发现内容损坏。
      if (this.corruptGets && body.length > 0) body[0] = body[0]! ^ 0xff
      return { body, etag: `etag-${key}` }
    } finally {
      this.active--
    }
  }

  async #enter(): Promise<void> {
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
  }
}

function config(overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
  return {
    bucket: 'bench',
    cases: [{ size: 1024, concurrency: 1, operations: ['put'] }],
    targetSamples: 10,
    warmupFraction: 0,
    // 单元测试用样本数终止，不等待真实时长。
    minDurationMs: 1e9,
    ...overrides,
  }
}

test('PUT 按目标样本数执行并把 warmup 计入数据集', async () => {
  const client = new FakeClient()
  const created: string[] = []
  const events: BenchmarkEvent[] = []
  const runner = new BenchmarkRunner(
    client,
    config({
      targetSamples: 10,
      warmupFraction: 0.2,
      cases: [{ size: 1024, concurrency: 2, operations: ['put'] }],
      onObjectCreated: (key) => created.push(key),
      onEvent: (event) => events.push(event),
    }),
  )

  const report = await runner.run()
  const result = report.results[0]!

  assert.equal(result.samples, 10)
  assert.equal(result.successes, 10)
  assert.equal(result.errors, 0)
  assert.equal(result.warmupSamples, 2)
  assert.equal(client.putKeys.length, 12)
  assert.equal(created.length, 12)
  assert.equal(new Set(created).size, 12, '每次写入的 key 必须唯一')
  assert.equal(result.datasetSize, 12)
  assert.equal(result.checksumMismatches, 0)
  assert.ok(result.latency)
  assert.equal(result.budgetLimited, false)
  assert.equal(report.writtenBytes, 12 * 1024)
  assert.equal(report.reservedWriteBytes, 12 * 1024)

  assert.equal(events.filter((event) => event.type === 'operation-start').length, 1)
  assert.equal(events.filter((event) => event.type === 'operation-done').length, 1)
  const progress = events.filter((event) => event.type === 'operation-progress')
  assert.deepEqual(
    progress
      .filter((event) => event.type === 'operation-progress' && event.phase === 'warmup')
      .map((event) => (event.type === 'operation-progress' ? event.completed : -1)),
    [2],
    'warmup 收尾发一次进度',
  )
  assert.deepEqual(
    progress
      .filter((event) => event.type === 'operation-progress' && event.phase === 'measure')
      .map((event) => (event.type === 'operation-progress' ? event.completed : -1)),
    [10],
    '测量阶段每 10 个样本与收尾各发一次进度',
  )
})

test('并发不会超过用例设定值', async () => {
  const client = new FakeClient()
  client.delayMs = 5
  const runner = new BenchmarkRunner(
    client,
    config({
      targetSamples: 24,
      cases: [{ size: 1024, concurrency: 4, operations: ['put'] }],
    }),
  )

  await runner.run()
  assert.equal(client.maxActive, 4)
})

test('写入预算按尺寸均分并如实截断样本', async () => {
  const client = new FakeClient()
  const runner = new BenchmarkRunner(
    client,
    config({
      maxWriteBytes: 4096,
      targetSamples: 10,
      warmupFraction: 0.1,
      cases: [{ size: 1024, concurrency: 1, operations: ['put'] }],
    }),
  )

  const report = await runner.run()
  const result = report.results[0]!

  assert.equal(report.writeBudgetPerSize, 4096)
  assert.equal(result.budgetLimited, true)
  assert.equal(result.sampleTarget, 3)
  assert.equal(result.samples, 3)
  assert.equal(result.warmupSamples, 1)
  assert.equal(client.putKeys.length, 4)
  assert.equal(report.writtenBytes, 4096)
  assert.equal(report.reservedWriteBytes, 4096)
})

test('多个尺寸各自获得预算，大对象不会饿死小对象', async () => {
  const client = new FakeClient()
  const runner = new BenchmarkRunner(
    client,
    config({
      maxWriteBytes: 4096,
      targetSamples: 10,
      warmupFraction: 0.1,
      cases: [
        { size: 1024, concurrency: 1, operations: ['put'] },
        { size: 2048, concurrency: 1, operations: ['put'] },
      ],
    }),
  )

  const report = await runner.run()
  assert.equal(report.writeBudgetPerSize, 2048)
  assert.equal(report.results[0]!.samples, 1)
  assert.equal(report.results[1]!.samples, 1)
  assert.equal(report.writtenBytes, 1024 * 2 + 2048)
  assert.equal(report.reservedWriteBytes, 4096)
})

test('GET 预写数据集、执行 warmup，并复用同尺寸 PUT 对象', async () => {
  const client = new FakeClient()
  const runner = new BenchmarkRunner(
    client,
    config({
      targetSamples: 10,
      warmupFraction: 0.2,
      cases: [
        { size: 1024, concurrency: 2, operations: ['put', 'get'] },
      ],
    }),
  )

  const report = await runner.run()
  const [put, get] = report.results

  assert.equal(put!.samples, 10)
  assert.equal(get!.samples, 10)
  assert.equal(get!.warmupSamples, 2)
  // PUT 的 warmup(2) + 测量(10) 共写入 12 个对象，GET 直接复用这 12 个。
  assert.equal(get!.datasetSize, 12)
  assert.equal(client.putKeys.length, 12, 'GET 应复用 PUT 已写入的对象，不再额外预写')
  assert.equal(client.getKeys.length, 12)
  for (const key of client.getKeys) {
    assert.ok(client.objects.has(key), `GET 必须命中已存在的对象：${key}`)
  }
})

test('仅 GET 时预写数据集；预算不足则标记且仍可测量', async () => {
  const client = new FakeClient()
  const runner = new BenchmarkRunner(
    client,
    config({
      maxWriteBytes: 3 * 1024,
      targetSamples: 12,
      cases: [{ size: 1024, concurrency: 4, operations: ['get'] }],
    }),
  )

  const report = await runner.run()
  const result = report.results[0]!

  // 目标数据集 max(4, 并发*2)=8，但预算只够 3 个对象。
  assert.equal(client.putKeys.length, 3)
  assert.equal(result.datasetSize, 3)
  assert.equal(result.budgetLimited, true)
  assert.equal(result.samples, 12)
  assert.equal(client.getKeys.length, 12)
})

test('PUT 响应校验和不一致计入错误，且不入数据集', async () => {
  class BadChecksumClient extends FakeClient {
    override async putObjectWithDigest(
      bucket: string,
      key: string,
      body: Uint8Array,
      digest: Uint8Array,
    ): Promise<WriteResult> {
      const result = await super.putObjectWithDigest(bucket, key, body, digest)
      return { ...result, checksumSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
    }
  }

  const client = new BadChecksumClient()
  const runner = new BenchmarkRunner(
    client,
    config({ targetSamples: 5, cases: [{ size: 1024, concurrency: 1, operations: ['put'] }] }),
  )

  const report = await runner.run()
  const result = report.results[0]!
  assert.equal(result.samples, 5)
  assert.equal(result.checksumMismatches, 5)
  assert.equal(result.datasetSize, 0)
})

test('GET 正文损坏由 SHA-256 发现', async () => {
  const client = new FakeClient()
  client.corruptGets = true
  const runner = new BenchmarkRunner(
    client,
    config({
      targetSamples: 6,
      cases: [{ size: 1024, concurrency: 1, operations: ['get'] }],
    }),
  )

  const report = await runner.run()
  const result = report.results[0]!
  assert.equal(result.samples, 6)
  assert.equal(result.checksumMismatches, 6)
  assert.equal(result.errors, 0, '校验和不一致不应被当成传输错误')
})

test('关闭校验和时不比对内容', async () => {
  const client = new FakeClient()
  client.corruptGets = true
  const runner = new BenchmarkRunner(
    client,
    config({
      verifyChecksums: false,
      targetSamples: 3,
      cases: [{ size: 1024, concurrency: 1, operations: ['get'] }],
    }),
  )

  const report = await runner.run()
  assert.equal(report.results[0]!.checksumMismatches, 0)
})

test('连续错误达到上限即停止并保留错误分类', async () => {
  const client = new FakeClient()
  client.failPuts = new S3Error('InternalError', 'backend exploded', 500)
  const runner = new BenchmarkRunner(
    client,
    config({
      maxConsecutiveErrors: 3,
      targetSamples: 100,
      cases: [{ size: 1024, concurrency: 4, operations: ['put'] }],
    }),
  )

  const report = await runner.run()
  const result = report.results[0]!
  assert.equal(result.stoppedOnErrors, true)
  // 达到阈值时已在途的请求仍需收尾，因此允许最多不超过一个并发波次的超出。
  assert.ok(result.samples >= 3 && result.samples <= 3 + 4, `实际 ${result.samples}`)
  assert.equal(result.successes, 0)
  assert.deepEqual(result.errorBreakdown.map((item) => item.code), ['InternalError'])
  assert.equal(result.latency, null)
})

test('最短测量时长到达后停止，样本数可小于目标', async () => {
  const client = new FakeClient()
  let clock = 0
  // 每次取时间推进 100ms，让 minDurationMs 在少量样本后必然到达。
  const now = () => (clock += 100)
  const runner = new BenchmarkRunner(
    client,
    config({
      targetSamples: 100,
      minDurationMs: 500,
      now,
      cases: [{ size: 1024, concurrency: 1, operations: ['put'] }],
    }),
  )

  const report = await runner.run()
  const result = report.results[0]!
  assert.ok(result.samples > 0)
  assert.ok(result.samples < 100, `实际 ${result.samples}`)
  assert.ok(result.durationMs >= 500)
})

test('取消后报告 canceled 并停止后续用例', async () => {
  const client = new FakeClient()
  client.delayMs = 20
  const controller = new AbortController()
  const runner = new BenchmarkRunner(
    client,
    config({
      signal: controller.signal,
      targetSamples: 10_000,
      cases: [
        { size: 1024, concurrency: 2, operations: ['put'] },
        { size: 2048, concurrency: 2, operations: ['put'] },
      ],
    }),
  )

  const running = runner.run()
  setTimeout(() => controller.abort(), 30)
  const report = await running

  assert.equal(report.canceled, true)
  assert.equal(report.results.length, 1, '取消后不应继续执行下一个用例')
  assert.equal(report.results[0]!.canceled, true)
  assert.ok(report.results[0]!.samples > 0)
})

test('预取消信号不发起任何请求', async () => {
  const client = new FakeClient()
  const controller = new AbortController()
  controller.abort()
  const runner = new BenchmarkRunner(
    client,
    config({ signal: controller.signal, minDurationMs: 0 }),
  )

  const report = await runner.run()
  assert.equal(report.canceled, true)
  assert.equal(report.results.length, 0)
  assert.equal(client.putKeys.length, 0)
})

test('单样本时各百分位等于实测延迟', async () => {
  const client = new FakeClient()
  const runner = new BenchmarkRunner(
    client,
    config({
      targetSamples: 1,
      cases: [{ size: 1024, concurrency: 1, operations: ['put'] }],
    }),
  )

  const result = (await runner.run()).results[0]!
  const latency = result.latency!
  assert.equal(latency.p50Ms, latency.minMs)
  assert.equal(latency.p95Ms, latency.minMs)
  assert.equal(latency.p99Ms, latency.minMs)
  assert.equal(latency.maxMs, latency.minMs)
  assert.equal(latency.meanMs, latency.minMs)
})

test('前缀被规范化为以 / 结尾，且所有 key 落在其下', async () => {
  const client = new FakeClient()
  const runner = new BenchmarkRunner(
    client,
    config({
      prefix: '/team/bench',
      targetSamples: 2,
      cases: [{ size: 1024, concurrency: 1, operations: ['put'] }],
    }),
  )

  const report = await runner.run()
  assert.equal(report.prefix, 'team/bench/')
  for (const key of client.putKeys) assert.ok(key.startsWith('team/bench/blink-bench/'))
})

test('构造参数与重复运行被拒绝', async () => {
  const client = new FakeClient()
  assert.throws(() => new BenchmarkRunner(client, config({ bucket: '  ' })), /桶名/)
  assert.throws(
    () => new BenchmarkRunner(client, config({ cases: [{ size: 0, concurrency: 1, operations: ['put'] }] })),
    /对象大小/,
  )
  assert.throws(
    () => new BenchmarkRunner(client, config({ cases: [{ size: 1, concurrency: 0, operations: ['put'] }] })),
    /并发数/,
  )
  assert.throws(
    () =>
      new BenchmarkRunner(
        client,
        config({ cases: [{ size: 1, concurrency: 1, operations: [] }] }),
      ),
    /至少/,
  )
  assert.throws(() => new BenchmarkRunner(client, config({ warmupFraction: 1.5 })), /warmup/)
  assert.throws(() => new BenchmarkRunner(client, config({ prefix: 'a/../b' })), /压测前缀不可用/)

  const runner = new BenchmarkRunner(
    client,
    config({ minDurationMs: 0, targetSamples: 1, cases: [{ size: 1, concurrency: 1, operations: ['put'] }] }),
  )
  await runner.run()
  await assert.rejects(runner.run(), /只能运行一次/)
})

test('错误分类保留 S3 Code 与传输层类型', () => {
  assert.deepEqual(describeBenchmarkError(new S3Error('SlowDown', 'slow down', 503)), {
    code: 'SlowDown',
    message: 'slow down',
  })
  assert.deepEqual(describeBenchmarkError(new TransportError('socket hang up')), {
    code: 'TransportError',
    message: 'socket hang up',
  })
  assert.deepEqual(describeBenchmarkError(new Error('boom')), { code: 'Error', message: 'boom' })
  assert.deepEqual(describeBenchmarkError('plain'), { code: 'Error', message: 'plain' })
})
