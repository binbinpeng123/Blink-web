#!/usr/bin/env node
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { arch, cpus, hostname, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BenchmarkRunner,
  DEFAULT_MIN_DURATION_MS,
  DEFAULT_TARGET_SAMPLES,
  DEFAULT_WARMUP_FRACTION,
  type BenchmarkCase,
  type BenchmarkOperation,
  type BenchmarkOperationResult,
  type BenchmarkReport,
} from '../src/core/benchmark.ts'
import { S3Client } from '../src/core/client.ts'
import { toBase64 } from '../src/core/encoding.ts'
import { isS3Error } from '../src/core/errors.ts'
import { formatBytes } from '../src/core/formatters.ts'
import { Semaphore } from '../src/core/pool.ts'
import { SigV4Signer } from '../src/core/signer.ts'
import { FetchTransport } from '../src/core/transport.ts'

/**
 * 权威压测入口：直连 Blink（不经浏览器代理），每个对象尺寸可选启动一个
 * 独占的临时后端，跑完删除数据目录，避免块文件在仅剩数 GiB 的磁盘上累积。
 *
 * 浏览器面板受 HTTP/1.1 每源 6 连接限制，数字不能与这里混用。
 */

const MiB = 1024 * 1024
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_ENDPOINT = 'http://127.0.0.1:9000'
const DEFAULT_SIZES = [64 * 1024, MiB, 8 * MiB, 32 * MiB]
const DEFAULT_CONCURRENCIES = [1, 4, 16]
const DEFAULT_MAX_WRITE_MIB = 512
const CLEANUP_CONCURRENCY = 16

interface CliOptions {
  sizes: number[]
  concurrencies: number[]
  operations: BenchmarkOperation[]
  samples: number
  durationMs: number
  maxWriteBytes: number
  bucket: string | undefined
  prefix: string
  jsonPath: string | undefined
  keep: boolean
  spawn: boolean
  bin: string
  fsyncPolicy: 'always' | 'meta'
  endpoint: string
  force: boolean
  help: boolean
}

interface RunRecord {
  size: number
  report: BenchmarkReport
}

interface EnvironmentInfo {
  hostname: string
  platform: string
  arch: string
  cpuModel: string
  cpuCount: number
  totalMemoryBytes: number
  node: string
  startedAt: string
  finishedAt: string
  endpoint: string
  spawnPerSize: boolean
  blinkBinary: string | null
  blinkCommit: string | null
  fsyncPolicy: string
  diskPath: string
  diskFreeBytesBefore: number
  diskFreeBytesAfter: number
  note: string
}

class UsageError extends Error {}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const credentials = readCredentials()
  const endpoint = options.spawn ? '' : options.endpoint
  if (!options.spawn) validateEndpoint(endpoint)

  const diskPath = options.spawn ? tmpdir() : ROOT
  const diskFreeBytesBefore = freeBytes(diskPath)
  checkDisk(diskFreeBytesBefore, options)

  // 每个尺寸独立起一个 runner；预算必须在这里分摊，否则 --max-write-mib
  // 会变成"每个尺寸各一份"，整次运行的实际写入量放大到尺寸数量倍。
  const perSizeWriteBytes = Math.max(1, Math.floor(options.maxWriteBytes / options.sizes.length))

  const startedAt = new Date()
  const controller = new AbortController()
  const onSignal = () => {
    if (controller.signal.aborted) return
    console.error('\n收到中断信号：正在停止请求并清理…（再按一次强制退出）')
    controller.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const runs: RunRecord[] = []
  const autoBucket = options.bucket === undefined
  const bucket = options.bucket ?? uniqueBucketName()
  // 非 spawn 模式复用同一个客户端；临时后端的端点每个尺寸都不同。
  const cleanupClient: S3Client | null = options.spawn
    ? null
    : createClient(endpoint, credentials)
  let exitCode = 0
  let backend: BlinkProcess | null = null

  try {
    for (const size of options.sizes) {
      if (controller.signal.aborted) break
      let targetEndpoint = endpoint
      if (options.spawn) {
        backend = await BlinkProcess.start({
          bin: options.bin,
          credentials,
          fsyncPolicy: options.fsyncPolicy,
        })
        targetEndpoint = backend.endpoint
        console.error(`临时后端：${targetEndpoint}（数据目录 ${backend.dataDir}）`)
      }

      const client = cleanupClient ?? createClient(targetEndpoint, credentials)
      const created = new Set<string>()
      try {
        await ensureBucket(client, bucket)
        const cases: BenchmarkCase[] = options.concurrencies.map((concurrency) => ({
          size,
          concurrency,
          operations: options.operations,
        }))
        const runner = new BenchmarkRunner(client, {
          bucket,
          prefix: options.prefix,
          cases,
          targetSamples: options.samples,
          minDurationMs: options.durationMs,
          warmupFraction: DEFAULT_WARMUP_FRACTION,
          maxWriteBytes: perSizeWriteBytes,
          verifyChecksums: true,
          signal: controller.signal,
          onObjectCreated: (key) => created.add(key),
          onEvent: (event) => {
            if (event.type === 'operation-start') {
              console.error(
                `[${formatSize(size)} × ${event.concurrency}] ${event.operation} 开始：` +
                  `目标 ${event.sampleTarget} 样本（总目标 ${event.targetSamples}，` +
                  `warmup ${event.warmupSamples}，数据集 ${event.datasetSize}）`,
              )
            } else if (event.type === 'operation-done') {
              console.error(
                `[${formatSize(event.result.size)} × ${event.result.concurrency}] ` +
                  `${event.result.operation} 完成：` +
                  `${event.result.samples} 样本 / ${event.result.errors} 错误，` +
                  `${formatThroughput(event.result)}` +
                  (event.result.budgetLimited ? '（预算截断）' : ''),
              )
            }
          },
        })
        const report = await runner.run()
        runs.push({ size, report })

        if (controller.signal.aborted) {
          exitCode = 130
          break
        }
      } finally {
        // 对象清理放在 finally：异常与取消路径也要释放磁盘。
        // 临时后端随数据目录一起删除，不需要逐个 DeleteObject。
        if (!options.spawn && !options.keep) {
          await cleanup(client, bucket, created, autoBucket).catch((error) => {
            console.error(`清理失败：${error instanceof Error ? error.message : String(error)}`)
            exitCode = exitCode || 1
          })
        }
        await backend?.stop(!options.keep)
        backend = null
      }
    }

    if (!options.spawn && !options.keep && cleanupClient && autoBucket) {
      // 自动桶归本次运行所有；对象已按尺寸清空，最后删除桶本身。
      await deleteBucket(cleanupClient, bucket).catch((error) => {
        console.error(`删除桶失败：${error instanceof Error ? error.message : String(error)}`)
        exitCode = exitCode || 1
      })
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await backend?.stop(!options.keep)
  }

  const finishedAt = new Date()
  const environment: EnvironmentInfo = {
    hostname: hostname(),
    platform: `${platform()} ${release()}`,
    arch: arch(),
    cpuModel: cpus()[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    endpoint: options.spawn ? 'per-size temporary backend' : endpoint,
    spawnPerSize: options.spawn,
    blinkBinary: options.spawn ? options.bin : null,
    blinkCommit: options.spawn ? blinkCommit(options.bin) : null,
    fsyncPolicy: options.spawn ? options.fsyncPolicy : '由被测后端决定',
    diskPath,
    diskFreeBytesBefore,
    diskFreeBytesAfter: freeBytes(diskPath),
    note:
      '同机自环：客户端与服务端争抢同一台机器的 CPU/磁盘，数字仅作本机回归基线，' +
      '不是对外性能承诺。浏览器面板受 HTTP/1.1 每源 6 连接限制，不与 CLI 数字混用。',
  }

  const results = runs.flatMap((run) => run.report.results)
  if (results.length > 0) printTable(results, environment)
  if (controller.signal.aborted) {
    exitCode = 130
    console.error('压测已取消；已写入已完成部分的结果。')
  }

  const jsonPath = options.jsonPath ?? join('bench-results', `bench-${stamp(startedAt)}.json`)
  const absoluteJson = resolve(jsonPath)
  await mkdir(dirname(absoluteJson), { recursive: true })
  await writeFile(
    absoluteJson,
    `${JSON.stringify(
      {
        meta: environment,
        options: {
          sizes: options.sizes,
          concurrencies: options.concurrencies,
          operations: options.operations,
          samples: options.samples,
          durationMs: options.durationMs,
          maxWriteBytes: options.maxWriteBytes,
          writeBudgetPerSize: perSizeWriteBytes,
          warmupFraction: DEFAULT_WARMUP_FRACTION,
          bucket,
          autoBucket,
          prefix: options.prefix,
          keep: options.keep,
          spawnPerSize: options.spawn,
        },
        runs,
        results,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`\nJSON 结果：${absoluteJson}`)
  process.exitCode = exitCode
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    sizes: [...DEFAULT_SIZES],
    concurrencies: [...DEFAULT_CONCURRENCIES],
    operations: ['put', 'get'],
    samples: DEFAULT_TARGET_SAMPLES,
    durationMs: DEFAULT_MIN_DURATION_MS,
    maxWriteBytes: DEFAULT_MAX_WRITE_MIB * MiB,
    bucket: undefined,
    prefix: 'bench',
    jsonPath: undefined,
    keep: false,
    spawn: false,
    bin: process.env['BLINK_BIN']
      ? resolve(process.env['BLINK_BIN'])
      : resolve(ROOT, '../Blink/bin/blink'),
    fsyncPolicy: 'always',
    endpoint: process.env['BLINK_ENDPOINT'] ?? DEFAULT_ENDPOINT,
    force: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]!
    const [name, inline] = splitOption(raw)
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} 缺少取值`)
      return next
    }
    switch (name) {
      case '--help':
      case '-h':
        options.help = true
        return options
      case '--sizes':
        options.sizes = unique(sizes(value()))
        break
      case '--concurrency':
      case '--concurrencies':
        options.concurrencies = unique(intList(value(), '并发数'))
        break
      case '--ops':
        options.operations = unique(
          value()
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => {
              if (item !== 'put' && item !== 'get') throw new UsageError(`未知操作：${item}`)
              return item
            }),
        )
        if (options.operations.length === 0) throw new UsageError('至少需要一种操作（put,get）')
        break
      case '--samples':
        options.samples = positiveInt(value(), '样本数')
        break
      case '--duration':
        options.durationMs = seconds(value(), '最短时长')
        break
      case '--max-write-mib':
        options.maxWriteBytes = positiveInt(value(), '写入预算') * MiB
        break
      case '--bucket':
        options.bucket = value()
        break
      case '--prefix':
        options.prefix = value()
        break
      case '--json':
        options.jsonPath = value()
        break
      case '--keep':
        options.keep = true
        break
      case '--spawn':
        options.spawn = true
        break
      case '--bin':
        options.bin = resolve(value())
        break
      case '--fsync-policy': {
        const policy = value()
        if (policy !== 'always' && policy !== 'meta') {
          throw new UsageError('--fsync-policy 只支持 always 或 meta')
        }
        options.fsyncPolicy = policy
        break
      }
      case '--endpoint':
        options.endpoint = value()
        break
      case '--force':
        options.force = true
        break
      default:
        throw new UsageError(`未知参数：${raw}`)
    }
  }
  return options
}

function splitOption(raw: string): [string, string | undefined] {
  if (!raw.startsWith('--')) throw new UsageError(`未知参数：${raw}`)
  const eq = raw.indexOf('=')
  return eq > 0 ? [raw.slice(0, eq), raw.slice(eq + 1)] : [raw, undefined]
}

function sizes(value: string): number[] {
  return value
    .split(',')
    .map((item) => parseSize(item.trim()))
}

function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)?$/i.exec(text)
  if (!match) throw new UsageError(`无法识别的对象大小：${text}`)
  const amount = Number(match[1])
  const unit = (match[2] ?? 'B').toLowerCase()
  const scale =
    unit === 'kib' ? 1024 : unit === 'mib' ? 1024 * 1024 : unit === 'gib' ? 1024 * 1024 * 1024 : 1
  const bytes = Math.round(amount * scale)
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new UsageError(`对象大小无效：${text}`)
  return bytes
}

function intList(value: string, name: string): number[] {
  return value
    .split(',')
    .map((item) => positiveInt(item.trim(), name))
}

function positiveInt(text: string, name: string): number {
  if (!/^\d+$/.test(text)) throw new UsageError(`${name}必须是正整数：${text}`)
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(`${name}必须是正整数：${text}`)
  }
  return value
}

function seconds(text: string, name: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new UsageError(`${name}必须是非负秒数：${text}`)
  return Math.round(Number(text) * 1000)
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function readCredentials(): { accessKeyId: string; secretKey: string } {
  const accessKeyId = process.env['BLINK_ACCESS_KEY']
  const secretKey = process.env['BLINK_SECRET_KEY']
  if (!accessKeyId || !secretKey) {
    throw new UsageError(
      '缺少 BLINK_ACCESS_KEY / BLINK_SECRET_KEY；压测不提供任何默认凭据，请显式设置环境变量。',
    )
  }
  return { accessKeyId, secretKey }
}

function validateEndpoint(endpoint: string): void {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new UsageError(`BLINK_ENDPOINT 不是合法 URL：${endpoint}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError('BLINK_ENDPOINT 只支持 http/https')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new UsageError('BLINK_ENDPOINT 不能带路径前缀（签名路径必须与后端一致）')
  }
}

function createClient(
  endpoint: string,
  credentials: { accessKeyId: string; secretKey: string },
): S3Client {
  const url = new URL(endpoint)
  return new S3Client({
    transport: new FetchTransport(endpoint),
    signer: new SigV4Signer(credentials, process.env['BLINK_REGION'] ?? 'us-east-1'),
    host: url.host,
  })
}

function uniqueBucketName(): string {
  const random = new Uint8Array(3)
  crypto.getRandomValues(random)
  return `blink-bench-${Date.now().toString(36)}-${Buffer.from(random).toString('hex')}`
}

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.createBucket(bucket)
  } catch (error) {
    // 非 spawn 的多个尺寸共用一个桶；显式桶也允许用户复用已有桶。
    if (isS3Error(error) && (error.code === 'BucketAlreadyOwnedByYou' || error.status === 409)) {
      return
    }
    throw error
  }
}

/**
 * 清理策略：
 * - 自动桶归本次运行所有，整个桶清空（桶本身由调用方在所有尺寸结束后删除）；
 * - 显式桶只删 onObjectCreated 记录下来的 key，绝不触碰同前缀下的其他数据。
 */
async function cleanup(
  client: S3Client,
  bucket: string,
  created: ReadonlySet<string>,
  autoBucket: boolean,
): Promise<void> {
  const pool = new Semaphore(CLEANUP_CONCURRENCY)
  if (autoBucket) {
    for (const key of await listAllKeys(client, bucket)) {
      await pool.run(() => client.deleteObject(bucket, key))
    }
    return
  }
  for (const key of created) {
    await pool.run(() => client.deleteObject(bucket, key))
  }
}

async function listAllKeys(client: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const page = await client.listObjects({
      bucket,
      continuationToken: token,
      maxKeys: 1000,
    })
    for (const object of page.objects) keys.push(object.key)
    token = page.isTruncated ? page.nextToken : undefined
  } while (token)
  return keys
}

async function deleteBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.deleteBucket(bucket)
  } catch (error) {
    if (isS3Error(error) && error.code === 'NoSuchBucket') return
    throw error
  }
}

interface Credentials {
  accessKeyId: string
  secretKey: string
}

interface BlinkOptions {
  bin: string
  credentials: Credentials
  fsyncPolicy: 'always' | 'meta'
}

class BlinkProcess {
  readonly endpoint: string
  readonly dataDir: string
  readonly #child: ChildProcess
  readonly #exited: Promise<number | null>
  readonly #stderr: string[] = []
  #spawnError: Error | null = null
  #stopped = false

  private constructor(endpoint: string, dataDir: string, child: ChildProcess) {
    this.endpoint = endpoint
    this.dataDir = dataDir
    this.#child = child
    this.#exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
    // 二进制不存在/不可执行时 spawn 只发 error 事件；不监听会让整个 CLI 崩掉。
    child.once('error', (error) => {
      this.#spawnError = error
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr.push(chunk.toString())
      if (this.#stderr.length > 200) this.#stderr.splice(0, 100)
    })
  }

  static async start(options: BlinkOptions): Promise<BlinkProcess> {
    const dataDir = await mkdtemp(join(tmpdir(), 'blink-bench-'))
    const port = await freePort()
    const endpoint = `http://127.0.0.1:${port}`

    const env: NodeJS.ProcessEnv = { ...process.env }
    env['BLINK_ACCESS_KEY'] = options.credentials.accessKeyId
    env['BLINK_SECRET_KEY'] = options.credentials.secretKey
    env['BLINK_FSYNC_POLICY'] = options.fsyncPolicy

    const child = spawn(
      options.bin,
      ['--addr', `127.0.0.1:${port}`, '--data-dir', dataDir, '--log-level', 'error'],
      { env, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const instance = new BlinkProcess(endpoint, dataDir, child)
    const ready = await instance.waitReady(15_000)
    if (!ready) {
      child.kill('SIGKILL')
      await rm(dataDir, { recursive: true, force: true })
      throw new Error(`临时 Blink 未就绪：${instance.failureDetail()}`)
    }
    return instance
  }

  failureDetail(): string {
    if (this.#spawnError) return this.#spawnError.message
    return this.stderrTail() || '15s 内未通过 /healthz'
  }

  get pid(): number | undefined {
    return this.#child.pid
  }

  stderrTail(): string {
    return this.#stderr.join('').slice(-2000)
  }

  async stop(removeData: boolean): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill('SIGTERM')
      const timer = setTimeout(() => this.#child.kill('SIGKILL'), 5_000)
      await this.#exited
      clearTimeout(timer)
    }
    if (removeData) await rm(this.dataDir, { recursive: true, force: true })
    else console.error(`保留临时后端数据目录：${this.dataDir}`)
  }

  async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.#spawnError || this.#child.exitCode !== null) return false
      try {
        const response = await fetch(`${this.endpoint}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        })
        if (response.ok) return true
      } catch {
        // 尚未监听：继续轮询
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    return false
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function checkDisk(free: number, options: CliOptions): void {
  if (!options.spawn) return
  const required = options.maxWriteBytes + 256 * MiB
  if (free < required && !options.force) {
    throw new UsageError(
      `临时目录只剩 ${formatBytes(free)}，低于本次写入预算 ${formatBytes(options.maxWriteBytes)}` +
        ` + 安全余量；请降低 --max-write-mib，或确认后用 --force 继续。`,
    )
  }
}

function freeBytes(path: string): number {
  const stats = statfsSync(path)
  return stats.bavail * stats.bsize
}

function blinkCommit(bin: string): string | null {
  try {
    return execFileSync('git', ['-C', resolve(dirname(bin), '..'), 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function formatSize(bytes: number): string {
  return formatBytes(bytes)
}

function formatThroughput(result: BenchmarkOperationResult): string {
  return `${formatBytes(result.throughputBytesPerSecond)}/s`
}

function printTable(results: readonly BenchmarkOperationResult[], environment: EnvironmentInfo): void {
  console.log('\n环境：')
  console.log(`  主机       ${environment.hostname} / ${environment.platform} / ${environment.arch}`)
  console.log(`  CPU        ${environment.cpuModel} × ${environment.cpuCount}`)
  console.log(`  内存       ${formatBytes(environment.totalMemoryBytes)}`)
  console.log(`  Node       ${environment.node}`)
  console.log(`  后端       ${environment.endpoint}`)
  if (environment.blinkCommit) console.log(`  Blink      ${environment.blinkCommit}`)
  console.log(`  fsync      ${environment.fsyncPolicy}`)
  console.log(
    `  磁盘       ${environment.diskPath} 剩余 ${formatBytes(environment.diskFreeBytesBefore)}` +
      ` → ${formatBytes(environment.diskFreeBytesAfter)}`,
  )
  console.log(`  说明       ${environment.note}`)

  console.log('\n结果：')
  const headers = ['大小', '并发', '操作', '样本', '错误', 'p50', 'p95', 'p99', '吞吐', '校验和', '备注']
  const rows = results.map((result) => [
    formatSize(result.size),
    String(result.concurrency),
    result.operation,
    String(result.samples),
    String(result.errors),
    result.latency ? `${result.latency.p50Ms.toFixed(1)} ms` : '-',
    result.latency ? `${result.latency.p95Ms.toFixed(1)} ms` : '-',
    result.latency ? `${result.latency.p99Ms.toFixed(1)} ms` : '-',
    formatThroughput(result),
    result.checksumMismatches > 0 ? `不一致 ${result.checksumMismatches}` : '0',
    notes(result),
  ])
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column]!))),
  )
  console.log(headers.map((header, index) => pad(header, widths[index]!)).join('  '))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) {
    console.log(row.map((cell, index) => pad(cell, widths[index]!)).join('  '))
  }
}

function notes(result: BenchmarkOperationResult): string {
  const items: string[] = []
  if (result.budgetLimited) items.push('预算截断')
  if (result.stoppedOnErrors) items.push('连续错误停止')
  if (result.canceled) items.push('已取消')
  if (result.warmupSamples > 0) items.push(`warmup ${result.warmupSamples}`)
  if (result.datasetSize > 0) items.push(`数据集 ${result.datasetSize}`)
  if (result.skippedReason) items.push(result.skippedReason)
  if (result.errorBreakdown.length > 0) {
    const top = result.errorBreakdown[0]!
    items.push(`${top.code} × ${top.count}`)
  }
  return items.join('；') || '-'
}

/** 中文按两个终端列估算，避免表格在等宽字体下错位。 */
function displayWidth(text: string): number {
  return [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function stamp(date: Date): string {
  const pad2 = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  )
}

function printUsage(): void {
  console.log(`用法：npm run bench -- [选项]

环境变量：
  BLINK_ACCESS_KEY / BLINK_SECRET_KEY   必填，无默认值
  BLINK_REGION                          默认 us-east-1
  BLINK_ENDPOINT                        默认 ${DEFAULT_ENDPOINT}（--spawn 时忽略）
  BLINK_BIN                             临时后端二进制，默认 ../Blink/bin/blink

选项：
  --sizes 64KiB,1MiB,8MiB,32MiB   对象大小列表
  --concurrency 1,4,16            并发列表
  --ops put,get                   压测操作
  --samples 1000                  每个用例的目标样本数
  --duration 30                   测量阶段时长上限（秒）；与样本数先到先停
  --max-write-mib 512             整次运行的写入预算（按尺寸均分）
  --bucket <name>                 使用已有桶（只清理本次创建的对象）
  --prefix bench                  对象前缀
  --json <path>                   结果 JSON 路径（默认 bench-results/）
  --spawn                         每个尺寸启动独占临时后端，结束后删除数据目录
  --bin <path>                    临时后端的 Blink 二进制
  --fsync-policy always|meta      临时后端的落盘策略（默认 always）
  --endpoint <url>                覆盖 BLINK_ENDPOINT
  --keep                          保留对象、桶与临时数据目录
  --force                         磁盘余量不足时仍然继续
  -h, --help                      显示帮助

说明：
  不指定 --bucket 时会创建唯一桶并在结束后删除；指定 --bucket 时只删除本次
  写入的 key。--spawn 需要本机有可执行的 Blink 二进制。浏览器面板受每源
  6 连接限制，权威数字以本命令为准。`)
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(error.message)
    console.error('使用 --help 查看可用选项。')
    process.exitCode = 2
    return
  }
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
