import type { WriteResult } from './client.ts'
import { sha256, sha256Base64 } from './crypto.ts'
import { toBase64, toHex } from './encoding.ts'
import { S3Error, TransportError, abortError, isAbortError } from './errors.ts'
import { objectKeyProblem } from './keys.ts'

const MiB = 1024 * 1024

export const DEFAULT_TARGET_SAMPLES = 1000
export const DEFAULT_MIN_DURATION_MS = 30_000
export const DEFAULT_WARMUP_FRACTION = 0.1
/** 本机磁盘紧张：一次运行最多写入 512 MiB，且按对象大小均分，避免大对象饿死其他尺寸。 */
export const DEFAULT_MAX_WRITE_BYTES = 512 * MiB
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 20

export type BenchmarkOperation = 'put' | 'get'
export type BenchmarkPhase = 'warmup' | 'measure'

export interface BenchmarkCase {
  /** 每个对象的大小（字节）。 */
  size: number
  concurrency: number
  operations: readonly BenchmarkOperation[]
}

/** 压测只需要 S3Client 的这两个方法；依赖收窄后单元测试可注入内存替身。 */
export interface BenchmarkClient {
  putObjectWithDigest(
    bucket: string,
    key: string,
    body: Uint8Array,
    digest: Uint8Array,
    contentType?: string,
    signal?: AbortSignal,
  ): Promise<WriteResult>
  getObject(
    bucket: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ body: Uint8Array; etag: string }>
}

export interface BenchmarkConfig {
  bucket: string
  /** 所有压测对象都落在该前缀下；运行器不会删除对象，由调用方按 onObjectCreated 清理。 */
  prefix?: string
  cases: readonly BenchmarkCase[]
  targetSamples?: number
  minDurationMs?: number
  warmupFraction?: number
  maxWriteBytes?: number
  maxConsecutiveErrors?: number
  /** 默认校验 PUT 响应与 GET 正文的 SHA-256。 */
  verifyChecksums?: boolean
  signal?: AbortSignal
  onEvent?: (event: BenchmarkEvent) => void
  /** 每个成功写入的对象（含 warmup 与 GET 数据集）都会回调一次，便于调用方清理。 */
  onObjectCreated?: (key: string) => void
  /** 仅测试注入。 */
  now?: () => number
}

export interface BenchmarkLatency {
  minMs: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

export interface BenchmarkErrorCount {
  code: string
  count: number
  message: string
}

export interface BenchmarkOperationResult {
  operation: BenchmarkOperation
  size: number
  concurrency: number
  /** 配置的目标样本数。 */
  targetSamples: number
  /** 预算允许的本次实际目标；小于 targetSamples 表示被预算截断。 */
  sampleTarget: number
  /** 已完成的测量请求数（包含失败的请求）。 */
  samples: number
  successes: number
  errors: number
  bytes: number
  durationMs: number
  throughputBytesPerSecond: number
  /** 只统计成功请求的延迟；全部失败时为 null。 */
  latency: BenchmarkLatency | null
  checksumMismatches: number
  errorBreakdown: BenchmarkErrorCount[]
  warmupSamples: number
  warmupErrors: number
  datasetSize: number
  budgetLimited: boolean
  stoppedOnErrors: boolean
  canceled: boolean
  skippedReason?: string
}

export interface BenchmarkReport {
  startedAt: string
  finishedAt: string
  durationMs: number
  bucket: string
  prefix: string
  targetSamples: number
  minDurationMs: number
  warmupFraction: number
  maxWriteBytes: number
  /** 每个对象尺寸分到的写入预算（maxWriteBytes / 尺寸种类数）。 */
  writeBudgetPerSize: number
  /** 实际成功写入的字节数（含 warmup 与 GET 数据集）。 */
  writtenBytes: number
  /** 已预占的写入预算；请求失败也可能已经落盘，因此不会回滚。 */
  reservedWriteBytes: number
  canceled: boolean
  results: BenchmarkOperationResult[]
}

export type BenchmarkEvent =
  | {
      type: 'operation-start'
      operation: BenchmarkOperation
      size: number
      concurrency: number
      targetSamples: number
      sampleTarget: number
      warmupSamples: number
      datasetSize: number
    }
  | {
      type: 'operation-progress'
      operation: BenchmarkOperation
      phase: BenchmarkPhase
      size: number
      concurrency: number
      completed: number
      total: number
      errors: number
    }
  | { type: 'operation-done'; result: BenchmarkOperationResult }

interface DatasetEntry {
  key: string
  checksumSha256: string
  etag: string
}

interface SampleOutcome {
  latencyMs: number
  bytes: number
  checksumMismatch: boolean
}

interface ErrorBucket {
  count: number
  message: string
}

interface PhaseStats {
  samples: number
  errors: number
  bytes: number
  checksumMismatches: number
  latencies: number[]
  errorCounts: Map<string, ErrorBucket>
  aborted: boolean
  budgetExhausted: boolean
  stoppedOnErrors: boolean
  durationMs: number
}

/**
 * 独立于 UI 的压测执行器：自己管理并发，不占用上传用的全局信号量，
 * 因此 CLI 的 16 并发不会被 transferPool(4) 悄悄截断。
 *
 * 每次请求都生成唯一内容 —— Blink 按块寻址去重，重复数据会让写入量失真。
 * 读取优先复用同尺寸已写入的对象；对象只删元数据，块由后端 GC 回收。
 */
export class BenchmarkRunner {
  readonly #client: BenchmarkClient
  readonly #bucket: string
  readonly #prefix: string
  readonly #cases: readonly BenchmarkCase[]
  readonly #targetSamples: number
  readonly #minDurationMs: number
  readonly #warmupFraction: number
  readonly #maxWriteBytes: number
  readonly #maxConsecutiveErrors: number
  readonly #verifyChecksums: boolean
  readonly #signal: AbortSignal | undefined
  readonly #onEvent: ((event: BenchmarkEvent) => void) | undefined
  readonly #onObjectCreated: ((key: string) => void) | undefined
  readonly #now: () => number

  readonly #datasets = new Map<number, DatasetEntry[]>()
  readonly #sizeReserved = new Map<number, number>()
  #sizeBudget = 0
  #reservedWriteBytes = 0
  #writtenBytes = 0
  #sequence = 0
  #salt = new Uint32Array(4)
  #runId = ''
  #ran = false

  constructor(client: BenchmarkClient, config: BenchmarkConfig) {
    if (!client) throw new Error('缺少压测客户端')
    if (!config.bucket.trim()) throw new Error('缺少压测桶名')
    if (config.cases.length === 0) throw new Error('至少需要一个压测用例')
    this.#client = client
    this.#bucket = config.bucket
    this.#prefix = normalizePrefix(config.prefix ?? '')
    this.#cases = config.cases.map(validateCase)
    this.#targetSamples = positiveInteger(config.targetSamples ?? DEFAULT_TARGET_SAMPLES, '目标样本数')
    this.#minDurationMs = nonNegativeNumber(
      config.minDurationMs ?? DEFAULT_MIN_DURATION_MS,
      '最短测量时长',
    )
    this.#warmupFraction = fraction(config.warmupFraction ?? DEFAULT_WARMUP_FRACTION)
    this.#maxWriteBytes = positiveInteger(
      config.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES,
      '写入预算',
    )
    this.#maxConsecutiveErrors = positiveInteger(
      config.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS,
      '连续错误上限',
    )
    this.#verifyChecksums = config.verifyChecksums ?? true
    this.#signal = config.signal
    this.#onEvent = config.onEvent
    this.#onObjectCreated = config.onObjectCreated
    this.#now = config.now ?? (() => performance.now())
  }

  async run(): Promise<BenchmarkReport> {
    if (this.#ran) throw new Error('BenchmarkRunner 只能运行一次')
    this.#ran = true

    const random = new Uint8Array(16)
    crypto.getRandomValues(random)
    this.#salt = new Uint32Array(random.buffer, 0, 4)
    this.#runId = toHex(random.subarray(8))

    const sizes = new Set(this.#cases.map((item) => item.size))
    this.#sizeBudget = Math.max(0, Math.floor(this.#maxWriteBytes / sizes.size))
    const startedAt = new Date()
    const startedMark = this.#now()
    const results: BenchmarkOperationResult[] = []
    let canceled = false

    for (const item of this.#cases) {
      for (const operation of item.operations) {
        if (this.#signal?.aborted) {
          canceled = true
          break
        }
        let result: BenchmarkOperationResult
        try {
          result = await this.#runOperation(item.size, item.concurrency, operation)
        } catch (error) {
          if (this.#signal?.aborted || isAbortError(error)) {
            canceled = true
            result = this.#emptyResult(item.size, item.concurrency, operation, true)
          } else {
            result = this.#failedResult(item.size, item.concurrency, operation, error)
          }
        }
        results.push(result)
        this.#emit({ type: 'operation-done', result })
        if (result.canceled) {
          canceled = true
          break
        }
      }
      if (canceled) break
    }

    return {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, this.#now() - startedMark),
      bucket: this.#bucket,
      prefix: this.#prefix,
      targetSamples: this.#targetSamples,
      minDurationMs: this.#minDurationMs,
      warmupFraction: this.#warmupFraction,
      maxWriteBytes: this.#maxWriteBytes,
      writeBudgetPerSize: this.#sizeBudget,
      writtenBytes: this.#writtenBytes,
      reservedWriteBytes: this.#reservedWriteBytes,
      canceled,
      results,
    }
  }

  async #runOperation(
    size: number,
    concurrency: number,
    operation: BenchmarkOperation,
  ): Promise<BenchmarkOperationResult> {
    let warmupSamples = 0
    let sampleTarget = this.#targetSamples
    let budgetLimited = false

    if (operation === 'put') {
      const affordable = this.#affordableWrites(size)
      const idealWarmup = Math.round(this.#targetSamples * this.#warmupFraction)
      let warmup = Math.min(idealWarmup, Math.max(0, Math.floor(affordable * this.#warmupFraction)))
      if (warmup === 0 && idealWarmup > 0 && affordable >= 2) warmup = 1
      warmup = Math.min(warmup, Math.max(0, affordable - 1))
      sampleTarget = Math.min(this.#targetSamples, Math.max(0, affordable - warmup))
      if (sampleTarget === 0) {
        const result = this.#emptyResult(size, concurrency, operation, false)
        result.sampleTarget = 0
        result.budgetLimited = true
        result.skippedReason = `写入预算不足：最多只能写入 ${affordable} 个 ${size} 字节对象`
        this.#emit({
          type: 'operation-start',
          operation,
          size,
          concurrency,
          targetSamples: this.#targetSamples,
          sampleTarget: 0,
          warmupSamples: 0,
          datasetSize: this.#dataset(size).length,
        })
        return result
      }
      budgetLimited = sampleTarget < this.#targetSamples
      warmupSamples = warmup
    }

    if (operation === 'get') {
      // GET 不做写入预算扣减，但仍然需要预热：否则首批请求会在冷缓存上测量。
      warmupSamples = Math.round(this.#targetSamples * this.#warmupFraction)
      const prepared = await this.#prepareDataset(size, Math.max(4, concurrency * 2))
      budgetLimited = prepared.limited
      if (prepared.size === 0) {
        const result = this.#emptyResult(size, concurrency, operation, false)
        result.budgetLimited = true
        result.skippedReason = '没有可读取的压测对象：写入预算已被其他用例用完'
        return result
      }
    }

    const datasetSize = this.#dataset(size).length
    this.#emit({
      type: 'operation-start',
      operation,
      size,
      concurrency,
      targetSamples: this.#targetSamples,
      sampleTarget,
      warmupSamples,
      datasetSize,
    })

    const warmup = await this.#measure(operation, size, concurrency, warmupSamples, Infinity, false)
    if (warmup.aborted) return this.#abortedResult(size, concurrency, operation, warmup)

    const measured = await this.#measure(
      operation,
      size,
      concurrency,
      sampleTarget,
      this.#minDurationMs,
      true,
    )

    return {
      operation,
      size,
      concurrency,
      targetSamples: this.#targetSamples,
      sampleTarget,
      samples: measured.samples,
      successes: measured.samples - measured.errors,
      errors: measured.errors,
      bytes: measured.bytes,
      durationMs: measured.durationMs,
      throughputBytesPerSecond:
        measured.durationMs > 0 ? (measured.bytes / measured.durationMs) * 1000 : 0,
      latency: summarizeLatencies(measured.latencies),
      checksumMismatches: measured.checksumMismatches,
      errorBreakdown: summarizeErrors(measured.errorCounts),
      warmupSamples: warmup.samples,
      warmupErrors: warmup.errors,
      datasetSize: this.#dataset(size).length,
      budgetLimited: budgetLimited || measured.budgetExhausted,
      stoppedOnErrors: measured.stoppedOnErrors,
      canceled: measured.aborted,
      ...(measured.samples === 0 && measured.errors > 0
        ? { skippedReason: '所有测量请求均失败' }
        : {}),
    }
  }

  /**
   * 按固定并发执行一批请求。测量阶段同时受样本数与时长约束：
   * 到达任一条件即停止，但至少完成一个完整并发波次，避免时长过短时得到 0 个样本。
   */
  async #measure(
    operation: BenchmarkOperation,
    size: number,
    concurrency: number,
    count: number,
    durationMs: number,
    record: boolean,
  ): Promise<PhaseStats> {
    const stats: PhaseStats = {
      samples: 0,
      errors: 0,
      bytes: 0,
      checksumMismatches: 0,
      latencies: [],
      errorCounts: new Map(),
      aborted: false,
      budgetExhausted: false,
      stoppedOnErrors: false,
      durationMs: 0,
    }
    if (count === 0) return stats

    const started = this.#now()
    const phase: BenchmarkPhase = record ? 'measure' : 'warmup'
    let next = 0
    let completed = 0
    let consecutiveErrors = 0
    let stop = false
    const minimumWave = Math.min(concurrency, count)

    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop) return
        if (this.#signal?.aborted) {
          stats.aborted = true
          stop = true
          return
        }
        if (next >= count) return
        if (completed >= minimumWave && this.#now() - started >= durationMs) {
          stop = true
          return
        }

        next++
        let outcome: SampleOutcome | null
        try {
          outcome = await this.#runSample(operation, size)
        } catch (error) {
          if (this.#signal?.aborted || isAbortError(error)) {
            stats.aborted = true
            stop = true
            return
          }
          completed++
          stats.samples++
          stats.errors++
          consecutiveErrors++
          recordError(stats.errorCounts, error)
          if (consecutiveErrors >= this.#maxConsecutiveErrors) {
            stats.stoppedOnErrors = true
            stop = true
          }
          this.#emitProgress(phase, operation, size, concurrency, completed, count, stats.errors)
          continue
        }

        if (outcome === null) {
          stats.budgetExhausted = true
          stop = true
          return
        }

        completed++
        stats.samples++
        stats.bytes += outcome.bytes
        consecutiveErrors = 0
        if (outcome.checksumMismatch) stats.checksumMismatches++
        if (record) stats.latencies.push(outcome.latencyMs)
        this.#emitProgress(phase, operation, size, concurrency, completed, count, stats.errors)
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, count) }, () => worker()),
    )
    stats.durationMs = Math.max(0, this.#now() - started)
    return stats
  }

  /** 成功返回测量结果；预算用尽返回 null；请求失败抛出原始错误。 */
  async #runSample(
    operation: BenchmarkOperation,
    size: number,
  ): Promise<SampleOutcome | null> {
    if (operation === 'get') {
      const entries = this.#dataset(size)
      const entry = entries[this.#sequence++ % entries.length]
      if (!entry) throw new Error('压测数据集为空')
      const started = this.#now()
      const response = await this.#client.getObject(this.#bucket, entry.key, this.#signal)
      const latencyMs = Math.max(0, this.#now() - started)
      let checksumMismatch = response.body.byteLength !== size
      if (this.#verifyChecksums && entry.checksumSha256) {
        const actual = await sha256Base64(response.body)
        checksumMismatch ||= actual !== entry.checksumSha256
      }
      return { latencyMs, bytes: response.body.byteLength, checksumMismatch }
    }

    if (!this.#reserveWrite(size)) return null
    const index = this.#sequence++
    const payload = this.#makePayload(size, index)
    const key = this.#keyFor(size, index)
    const started = this.#now()
    // 哈希本身就是上传路径的一部分，计入请求延迟；只做一次并复用给签名与校验。
    const digest = await sha256(payload)
    const result = await this.#client.putObjectWithDigest(
      this.#bucket,
      key,
      payload,
      digest,
      'application/octet-stream',
      this.#signal,
    )
    const latencyMs = Math.max(0, this.#now() - started)
    const expected = toBase64(digest)
    const checksumMismatch = this.#verifyChecksums && result.checksumSha256 !== expected
    if (!checksumMismatch) {
      this.#dataset(size).push({ key, checksumSha256: expected, etag: result.etag })
    }
    this.#writtenBytes += size
    this.#notifyCreated(key)
    return { latencyMs, bytes: payload.byteLength, checksumMismatch }
  }

  async #prepareDataset(
    size: number,
    target: number,
  ): Promise<{ size: number; limited: boolean }> {
    const entries = this.#dataset(size)
    let limited = false
    while (entries.length < target) {
      if (this.#signal?.aborted) throw abortError()
      const outcome = await this.#runSample('put', size)
      if (outcome === null) {
        limited = true
        break
      }
      // 校验和不一致的对象不会入数据集；预算已消耗，继续尝试下一个。
    }
    return { size: entries.length, limited: limited || entries.length < target }
  }

  #affordableWrites(size: number): number {
    const bySize = Math.floor((this.#sizeBudget - (this.#sizeReserved.get(size) ?? 0)) / size)
    const byTotal = Math.floor((this.#maxWriteBytes - this.#reservedWriteBytes) / size)
    return Math.max(0, Math.min(bySize, byTotal))
  }

  #reserveWrite(size: number): boolean {
    if (this.#affordableWrites(size) < 1) return false
    this.#reservedWriteBytes += size
    this.#sizeReserved.set(size, (this.#sizeReserved.get(size) ?? 0) + size)
    return true
  }

  #dataset(size: number): DatasetEntry[] {
    let entries = this.#datasets.get(size)
    if (!entries) {
      entries = []
      this.#datasets.set(size, entries)
    }
    return entries
  }

  #keyFor(size: number, index: number): string {
    return `${this.#prefix}blink-bench/${this.#runId}/${size}/${index}`
  }

  /**
   * 会话随机盐 + 递增序号写入前 16 字节，保证每个对象内容唯一；
   * 其余字节用 xorshift 填满，接近不可压缩数据，避免存储层压缩影响结果。
   */
  #makePayload(size: number, index: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size)
    const words = new Uint32Array(bytes.buffer, 0, Math.floor(size / 4))
    let state = (this.#salt[0]! ^ Math.imul(index + 1, 0x9e3779b1) ^ 0xa5a5a5a5) >>> 0
    if (state === 0) state = 1
    for (let offset = 0; offset < words.length; offset++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      words[offset] = state
    }
    for (let offset = words.length * 4; offset < size; offset++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      bytes[offset] = state & 0xff
    }

    const marker = new Uint8Array(16)
    const view = new DataView(marker.buffer)
    view.setUint32(0, this.#salt[0]! ^ index)
    view.setUint32(4, this.#salt[1]! ^ Math.imul(index, 0x85ebca6b))
    view.setUint32(8, this.#salt[2]! ^ (index + 1))
    view.setUint32(12, this.#salt[3]! ^ Math.imul(index + 1, 0xc2b2ae35))
    bytes.set(marker.subarray(0, Math.min(16, size)))
    return bytes
  }

  #notifyCreated(key: string): void {
    try {
      this.#onObjectCreated?.(key)
    } catch {
      // 观察者异常不能中断正在进行的压测。
    }
  }

  #emptyResult(
    size: number,
    concurrency: number,
    operation: BenchmarkOperation,
    canceled: boolean,
  ): BenchmarkOperationResult {
    return {
      operation,
      size,
      concurrency,
      targetSamples: this.#targetSamples,
      sampleTarget: this.#targetSamples,
      samples: 0,
      successes: 0,
      errors: 0,
      bytes: 0,
      durationMs: 0,
      throughputBytesPerSecond: 0,
      latency: null,
      checksumMismatches: 0,
      errorBreakdown: [],
      warmupSamples: 0,
      warmupErrors: 0,
      datasetSize: this.#dataset(size).length,
      budgetLimited: false,
      stoppedOnErrors: false,
      canceled,
    }
  }

  #abortedResult(
    size: number,
    concurrency: number,
    operation: BenchmarkOperation,
    warmup: PhaseStats,
  ): BenchmarkOperationResult {
    return {
      ...this.#emptyResult(size, concurrency, operation, true),
      samples: warmup.samples,
      successes: warmup.samples - warmup.errors,
      errors: warmup.errors,
      warmupSamples: warmup.samples,
      warmupErrors: warmup.errors,
      errorBreakdown: summarizeErrors(warmup.errorCounts),
    }
  }

  #failedResult(
    size: number,
    concurrency: number,
    operation: BenchmarkOperation,
    error: unknown,
  ): BenchmarkOperationResult {
    const counts = new Map<string, ErrorBucket>()
    recordError(counts, error)
    return {
      ...this.#emptyResult(size, concurrency, operation, false),
      errors: 1,
      errorBreakdown: summarizeErrors(counts),
      skippedReason: '准备压测数据失败',
    }
  }

  #emitProgress(
    phase: BenchmarkPhase,
    operation: BenchmarkOperation,
    size: number,
    concurrency: number,
    completed: number,
    total: number,
    errors: number,
  ): void {
    // 进度事件只用于展示，按固定节流避免逐样本刷新 DOM。
    if (completed !== total && completed % 10 !== 0) return
    this.#emit({
      type: 'operation-progress',
      operation,
      phase,
      size,
      concurrency,
      completed,
      total,
      errors,
    })
  }

  #emit(event: BenchmarkEvent): void {
    try {
      this.#onEvent?.(event)
    } catch {
      // UI/CLI 的观察者异常不能影响测量。
    }
  }
}

function normalizePrefix(prefix: string): string {
  let normalized = prefix.trim().replace(/^\/+/, '')
  if (normalized.length > 0 && !normalized.endsWith('/')) normalized += '/'
  if (normalized.length > 0) {
    const problem = objectKeyProblem(`${normalized}probe`)
    if (problem) throw new Error(`压测前缀不可用：${problem}`)
  }
  return normalized
}

function validateCase(item: BenchmarkCase): BenchmarkCase {
  const size = positiveInteger(item.size, '对象大小')
  const concurrency = positiveInteger(item.concurrency, '并发数')
  const operations = [...new Set(item.operations)]
  if (operations.length === 0) throw new Error('压测用例至少要指定一种操作')
  for (const operation of operations) {
    if (operation !== 'put' && operation !== 'get') {
      throw new Error(`未知压测操作：${String(operation)}`)
    }
  }
  return { size, concurrency, operations }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name}必须是正整数`)
  return value
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name}必须是非负数`)
  return value
}

function fraction(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('warmup 比例必须在 0–1 之间')
  }
  return value
}

function summarizeLatencies(values: readonly number[]): BenchmarkLatency | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  let total = 0
  for (const value of sorted) total += value
  return {
    minMs: sorted[0]!,
    meanMs: total / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1]!,
  }
}

/** 最近秩百分位：小样本时也给出实际观测值，不做插值。 */
function percentile(sorted: readonly number[], value: number): number {
  const rank = Math.ceil(value * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!
}

function recordError(counts: Map<string, ErrorBucket>, error: unknown): void {
  const { code, message } = describeBenchmarkError(error)
  const bucket = counts.get(code)
  if (bucket) bucket.count++
  else counts.set(code, { count: 1, message })
}

export function describeBenchmarkError(error: unknown): { code: string; message: string } {
  if (error instanceof S3Error) {
    return { code: error.code, message: truncateMessage(error.message) }
  }
  if (error instanceof TransportError) {
    return { code: 'TransportError', message: truncateMessage(error.message) }
  }
  if (isAbortError(error)) return { code: 'AbortError', message: '操作已取消' }
  if (error instanceof Error) {
    return { code: error.name || 'Error', message: truncateMessage(error.message) }
  }
  return { code: 'Error', message: truncateMessage(String(error)) }
}

function summarizeErrors(counts: Map<string, ErrorBucket>): BenchmarkErrorCount[] {
  return [...counts.entries()]
    .map(([code, bucket]) => ({ code, count: bucket.count, message: bucket.message }))
    .sort((left, right) => right.count - left.count)
}

function truncateMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, ' ').trim()
  return singleLine.length <= 200 ? singleLine : `${singleLine.slice(0, 199)}…`
}
