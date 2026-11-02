import type { S3Client } from '../core/client.ts'
import {
  BenchmarkRunner,
  DEFAULT_WARMUP_FRACTION,
  type BenchmarkCase,
  type BenchmarkConfig,
  type BenchmarkEvent,
  type BenchmarkOperation,
  type BenchmarkOperationResult,
  type BenchmarkReport,
} from '../core/benchmark.ts'
import { formatBytes, formatDuration } from '../core/formatters.ts'
import { Semaphore } from '../core/pool.ts'
import { clear, h } from './dom.ts'
import { describeError } from './errorText.ts'
import type { StatusSink } from './status.ts'

const MiB = 1024 * 1024
/** 浏览器面板的写入预算低于 CLI 的 512 MiB，给本机磁盘留余量。 */
const BROWSER_WRITE_BUDGET = 256 * MiB
/** 固定前缀：测试对象不会混进正在浏览的业务目录，清理范围也可预测。 */
const BENCH_PREFIX = 'bench'
const MAX_SIZE = 64 * MiB
const MAX_CONCURRENCY = 32
const MAX_SAMPLES = 10_000
const MAX_DURATION_SECONDS = 600
const MAX_CASES = 64
const CLEANUP_CONCURRENCY = 4

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kib: 1024,
  mib: 1024 * 1024,
  gib: 1024 * 1024 * 1024,
}

export interface BenchmarkPanelOptions {
  onStatus: StatusSink
  /** 测试注入点；默认直接构造真实运行器。 */
  createRunner?: (client: S3Client, config: BenchmarkConfig) => BenchmarkRunner
}

interface FormValues {
  sizes: number[]
  concurrencies: number[]
  operations: BenchmarkOperation[]
  samples: number
  durationSeconds: number
}

/**
 * 浏览器内压测面板。
 *
 * 与 CLI 复用同一个 BenchmarkRunner，但数字只作本机浏览器基线：
 * HTTP/1.1 同源连接有限，且浏览器与后端可能争抢同一台机器的 CPU。
 * 面板负责表单、进度、结果展示与测试对象清理，不实现测量逻辑。
 */
export class BenchmarkPanel {
  readonly element: HTMLElement
  readonly #sizesInput: HTMLInputElement
  readonly #concurrencyInput: HTMLInputElement
  readonly #samplesInput: HTMLInputElement
  readonly #durationInput: HTMLInputElement
  readonly #putInput: HTMLInputElement
  readonly #getInput: HTMLInputElement
  readonly #formControls: HTMLInputElement[]
  readonly #form: HTMLFormElement
  readonly #formError: HTMLParagraphElement
  readonly #startButton: HTMLButtonElement
  readonly #cancelButton: HTMLButtonElement
  readonly #exportButton: HTMLButtonElement
  readonly #targetLabel: HTMLSpanElement
  readonly #progressWrap: HTMLElement
  readonly #progressBar: HTMLElement
  readonly #progress: HTMLElement
  readonly #phaseLabel: HTMLElement
  readonly #progressText: HTMLElement
  readonly #summary: HTMLElement
  readonly #resultsWrap: HTMLElement
  readonly #tbody: HTMLTableSectionElement
  readonly #onStatus: StatusSink
  readonly #createRunner: (client: S3Client, config: BenchmarkConfig) => BenchmarkRunner

  #client: S3Client | null = null
  #target: { bucket: string } | null = null
  #controller: AbortController | null = null
  #running = false
  #created = new Set<string>()
  #lastReport: BenchmarkReport | null = null
  #lastCleanup = ''
  #lastBucket = ''

  constructor(options: BenchmarkPanelOptions) {
    this.#onStatus = options.onStatus
    this.#createRunner =
      options.createRunner ?? ((client, config) => new BenchmarkRunner(client, config))

    this.#sizesInput = textInput('bench-sizes', '64KiB, 1MiB')
    this.#concurrencyInput = textInput('bench-concurrencies', '1, 4')
    this.#samplesInput = textInput('bench-samples', '100')
    this.#durationInput = textInput('bench-duration', '10')
    this.#putInput = h('input', { type: 'checkbox', name: 'bench-put', checked: true })
    this.#getInput = h('input', { type: 'checkbox', name: 'bench-get', checked: true })
    this.#formControls = [
      this.#sizesInput,
      this.#concurrencyInput,
      this.#samplesInput,
      this.#durationInput,
      this.#putInput,
      this.#getInput,
    ]

    this.#startButton = h(
      'button',
      {
        class: 'secondary',
        type: 'submit',
        name: 'bench-start',
        disabled: true,
      },
      '开始压测',
    )
    this.#cancelButton = h(
      'button',
      {
        class: 'link-button danger',
        type: 'button',
        name: 'bench-cancel',
        hidden: true,
        on: { click: () => this.#cancel('用户取消') },
      },
      '取消',
    )
    this.#formError = h('p', { class: 'form-error', hidden: true, attrs: { role: 'alert' } })
    this.#form = h(
      'form',
      {
        class: 'bench-form',
        on: {
          submit: (event) => {
            event.preventDefault()
            void this.#start()
          },
        },
      },
      h(
        'div',
        { class: 'bench-grid' },
        field('对象大小', this.#sizesInput, '逗号分隔，支持 KiB / MiB，单个 ≤ 64 MiB'),
        field('并发', this.#concurrencyInput, '每个用例的并发请求数'),
        field('样本数', this.#samplesInput, '测量阶段目标样本数'),
        field('时长上限（秒）', this.#durationInput, '与样本数先到先停；0 表示只跑一个最小波次'),
      ),
      h(
        'div',
        { class: 'bench-ops' },
        h('span', { class: 'field-label', text: '操作' }),
        h('label', { class: 'checkbox-row bench-checkbox' }, this.#putInput, 'PUT 写入'),
        h('label', { class: 'checkbox-row bench-checkbox' }, this.#getInput, 'GET 读取'),
      ),
      h(
        'div',
        { class: 'bench-actions' },
        this.#startButton,
        this.#cancelButton,
        h('span', {
          class: 'muted',
          text: `写入预算 ${formatBytes(BROWSER_WRITE_BUDGET)}（按尺寸均分）· 全程 SHA-256 校验`,
        }),
      ),
      this.#formError,
    )

    this.#targetLabel = h('span', { class: 'muted bench-target', text: '未选择桶' })
    this.#exportButton = h(
      'button',
      {
        class: 'link-button',
        type: 'button',
        name: 'bench-export',
        hidden: true,
        on: { click: () => this.#export() },
      },
      '导出 JSON',
    )

    this.#phaseLabel = h('span', { class: 'bench-phase', text: '准备…' })
    this.#progressText = h('span', { class: 'muted bench-progress-text' })
    this.#progressBar = h('div', { class: 'progress-bar' })
    this.#progress = h(
      'div',
      {
        class: 'progress',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'data-indeterminate': 'true',
        },
      },
      this.#progressBar,
    )
    this.#progressWrap = h(
      'div',
      { class: 'bench-progress', hidden: true },
      h('div', { class: 'bench-progress-head' }, this.#phaseLabel, this.#progressText),
      this.#progress,
    )

    this.#summary = h('p', { class: 'bench-summary', hidden: true })
    this.#tbody = h('tbody')
    this.#resultsWrap = h(
      'div',
      { class: 'table-wrap bench-table-wrap', hidden: true },
      h(
        'table',
        { class: 'object-table bench-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { text: '操作' }),
            h('th', { class: 'bench-col-size', text: '大小' }),
            h('th', { class: 'bench-col-number', text: '并发' }),
            h('th', { class: 'bench-col-number', text: '样本' }),
            h('th', { class: 'bench-col-number', text: 'p50' }),
            h('th', { class: 'bench-col-number', text: 'p95' }),
            h('th', { class: 'bench-col-number', text: 'p99' }),
            h('th', { class: 'bench-col-number', text: '吞吐' }),
            h('th', { text: '状态' }),
          ),
        ),
        this.#tbody,
      ),
    )

    this.element = h(
      'section',
      { class: 'panel bench-panel', attrs: { 'aria-labelledby': 'bench-title' } },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { class: 'panel-title', attrs: { id: 'bench-title' } }, '压测'),
        h(
          'div',
          { class: 'panel-head-right' },
          h('span', {
            class: 'muted',
            title: 'HTTP/1.1 同一源通常最多 6 个连接，浏览器内并发受此限制',
            text: '浏览器基线 · 每源 6 连接',
          }),
          this.#targetLabel,
          this.#exportButton,
        ),
      ),
      h('p', {
        class: 'hint',
        text: `固定写入 ${BENCH_PREFIX}/ 前缀，结束后删除本次写入的对象；快速自测用此面板，权威数字请用 npm run bench。`,
      }),
      this.#form,
      this.#progressWrap,
      this.#summary,
      this.#resultsWrap,
      h('p', {
        class: 'hint bench-footnote',
        text: '结果绑定当前浏览器、同机后端与网络条件，不与 Node CLI 的吞吐直接比较。',
      }),
    )
  }

  setClient(client: S3Client | null): void {
    if (!client && this.#running) this.#cancel('连接已断开')
    this.#client = client
    this.#syncEnabled()
  }

  /** 压测只跟随当前桶；前缀固定为 bench/，避免和正在浏览的业务目录混在一起。 */
  setTarget(state: { bucket: string | null; prefix: string }): void {
    this.#target = state.bucket ? { bucket: state.bucket } : null
    this.#syncEnabled()
    if (this.#running && this.#target?.bucket !== this.#lastBucket) {
      this.#cancel('桶已切换')
    }
  }

  #syncEnabled(): void {
    this.#startButton.disabled = this.#running || this.#client === null || this.#target === null
    for (const control of this.#formControls) control.disabled = this.#running
    this.#cancelButton.hidden = !this.#running
    this.#targetLabel.textContent = this.#target
      ? `${this.#target.bucket}/${BENCH_PREFIX}/`
      : '未选择桶'
    this.#targetLabel.title = this.#target
      ? `压测对象写入 ${this.#target.bucket}/${BENCH_PREFIX}/blink-bench/`
      : '请先在左侧选择桶'
  }

  async #start(): Promise<void> {
    const client = this.#client
    const target = this.#target
    if (!client || !target) {
      this.#showError('请先连接并选择桶')
      return
    }

    let form: FormValues
    try {
      form = this.#readForm()
    } catch (error) {
      this.#showError(describeError(error))
      this.#onStatus(`压测参数无效：${describeError(error)}`, 'error')
      return
    }

    this.#formError.hidden = true
    this.#created.clear()
    this.#lastReport = null
    this.#lastCleanup = ''
    this.#lastBucket = target.bucket
    this.#exportButton.hidden = true
    this.#summary.hidden = true
    this.#resultsWrap.hidden = false
    this.#progressWrap.hidden = false
    this.#resetProgress()
    clear(this.#tbody)

    const controller = new AbortController()
    this.#controller = controller
    this.#setRunning(true)
    this.#onStatus(`开始压测 ${target.bucket}/${BENCH_PREFIX}/`, 'info')

    let report: BenchmarkReport | null = null
    let failure: string | null = null
    try {
      const config: BenchmarkConfig = {
        bucket: target.bucket,
        prefix: BENCH_PREFIX,
        cases: buildCases(form),
        targetSamples: form.samples,
        minDurationMs: Math.round(form.durationSeconds * 1000),
        warmupFraction: DEFAULT_WARMUP_FRACTION,
        maxWriteBytes: BROWSER_WRITE_BUDGET,
        verifyChecksums: true,
        signal: controller.signal,
        onEvent: (event) => this.#onEvent(event),
        onObjectCreated: (key) => this.#created.add(key),
      }
      report = await this.#createRunner(client, config).run()
      this.#lastReport = report
    } catch (error) {
      failure = describeError(error)
      this.#showError(`压测失败：${failure}`)
    } finally {
      this.#controller = null
      this.#phaseLabel.textContent = '清理测试对象…'
      this.#progressText.textContent = `已写入 ${this.#created.size} 个对象`
      this.#lastCleanup = await this.#cleanup(client)
      this.#setRunning(false)
      this.#renderResults(report)
      if (report) {
        this.#renderSummary(report)
        this.#exportButton.hidden = report.results.length === 0
      }
      if (failure) {
        this.#onStatus(`压测失败：${failure}${this.#lastCleanup}`, 'error')
      } else if (report) {
        const state = report.canceled ? '压测已取消' : '压测完成'
        this.#onStatus(
          `${state}：${report.results.length} 个用例，写入 ${formatBytes(report.writtenBytes)}${this.#lastCleanup}`,
          report.canceled ? 'info' : 'success',
        )
      } else {
        this.#onStatus(`压测结束${this.#lastCleanup}`, 'info')
      }
    }
  }

  #cancel(reason: string): void {
    if (!this.#controller || this.#controller.signal.aborted) return
    this.#controller.abort()
    this.#cancelButton.disabled = true
    this.#phaseLabel.textContent = '正在停止…'
    this.#onStatus(`${reason}，正在停止压测`, 'info')
  }

  #setRunning(running: boolean): void {
    this.#running = running
    this.#cancelButton.disabled = false
    this.#syncEnabled()
  }

  #resetProgress(): void {
    this.#phaseLabel.textContent = '准备…'
    this.#progressText.textContent = ''
    this.#progress.dataset['indeterminate'] = 'true'
    this.#progress.removeAttribute('aria-valuenow')
    this.#progressBar.style.width = ''
  }

  #onEvent(event: BenchmarkEvent): void {
    if (event.type === 'operation-start') {
      this.#phaseLabel.textContent =
        `${operationLabel(event.operation)} ${formatBytes(event.size)} · 并发 ${event.concurrency}`
      this.#progressText.textContent =
        `预热 ${event.warmupSamples} · 测量目标 ${event.sampleTarget}${
          event.datasetSize > 0 ? ` · 数据集 ${event.datasetSize}` : ''
        }`
      this.#progress.dataset['indeterminate'] = 'true'
      return
    }

    if (event.type === 'operation-progress') {
      const percent =
        event.total > 0 ? Math.min(100, Math.round((event.completed / event.total) * 100)) : 0
      this.#progress.dataset['indeterminate'] = 'false'
      this.#progress.setAttribute('aria-valuenow', String(percent))
      this.#progressBar.style.width = `${percent}%`
      this.#phaseLabel.textContent =
        `${operationLabel(event.operation)} ${formatBytes(event.size)} · ` +
        `${event.phase === 'warmup' ? '预热' : '测量'} ${event.completed}/${event.total}`
      this.#progressText.textContent = `并发 ${event.concurrency} · 错误 ${event.errors}`
      return
    }

    this.#progress.dataset['indeterminate'] = 'false'
    this.#progress.setAttribute('aria-valuenow', '100')
    this.#progressBar.style.width = '100%'
    this.#phaseLabel.textContent =
      `${operationLabel(event.result.operation)} ${formatBytes(event.result.size)} · 完成`
    this.#progressText.textContent =
      `${event.result.samples} 个样本 · 错误 ${event.result.errors}` +
      (event.result.checksumMismatches > 0
        ? ` · 校验和不一致 ${event.result.checksumMismatches}`
        : '')
    this.#appendResult(event.result)
  }

  #appendResult(result: BenchmarkOperationResult): void {
    const status = resultStatus(result)
    const samplesTitle =
      `目标 ${result.sampleTarget} / 配置 ${result.targetSamples} · ` +
      `预热 ${result.warmupSamples}（错误 ${result.warmupErrors}）· 数据集 ${result.datasetSize}` +
      (result.budgetLimited ? ' · 受写入预算限制' : '')
    const errorTitle = result.errorBreakdown
      .map((item) => `${item.code} × ${item.count}：${item.message}`)
      .join('\n')

    const row = h(
      'tr',
      {
        attrs: {
          'data-operation': result.operation,
          'data-size': String(result.size),
        },
      },
      h('td', { text: operationLabel(result.operation) }),
      h('td', { class: 'bench-col-size', text: formatBytes(result.size) }),
      h('td', { class: 'bench-col-number', text: String(result.concurrency) }),
      h('td', {
        class: 'bench-col-number',
        text: String(result.samples),
        title: samplesTitle,
      }),
      h('td', { class: 'bench-col-number', text: latency(result, 'p50Ms') }),
      h('td', { class: 'bench-col-number', text: latency(result, 'p95Ms') }),
      h('td', { class: 'bench-col-number', text: latency(result, 'p99Ms') }),
      h('td', { class: 'bench-col-number', text: `${formatBytes(result.throughputBytesPerSecond)}/s` }),
      h('td', {
        class: 'bench-status',
        text: status.text,
        title: errorTitle || samplesTitle,
        attrs: { 'data-kind': status.kind },
      }),
    )
    this.#tbody.appendChild(row)
  }

  #renderResults(report: BenchmarkReport | null): void {
    if (!report) return
    clear(this.#tbody)
    for (const result of report.results) this.#appendResult(result)
    if (report.results.length === 0) {
      this.#phaseLabel.textContent = '未执行任何用例'
      this.#progressText.textContent = ''
    }
  }

  #renderSummary(report: BenchmarkReport): void {
    const limited = report.results.filter((result) => result.budgetLimited).length
    const parts = [
      `${report.bucket}/${report.prefix}`,
      `${report.results.length} 个用例`,
      `写入 ${formatBytes(report.writtenBytes)} / 预算 ${formatBytes(report.maxWriteBytes)}`,
      `用时 ${formatDuration(report.durationMs)}`,
    ]
    if (limited > 0) parts.push(`${limited} 个用例受预算限制`)
    if (report.canceled) parts.push('已取消')
    this.#summary.textContent = parts.join(' · ') + this.#lastCleanup
    this.#summary.hidden = false
  }

  /** 只删除本次 onObjectCreated 记录的 key；失败也继续清理其余对象。 */
  async #cleanup(client: S3Client): Promise<string> {
    if (this.#created.size === 0) {
      this.#phaseLabel.textContent = '完成'
      return ''
    }
    const pool = new Semaphore(CLEANUP_CONCURRENCY)
    const keys = [...this.#created]
    const results = await Promise.allSettled(
      keys.map((key) => pool.run(() => client.deleteObject(this.#lastBucket, key))),
    )
    const failed = results.filter((item) => item.status === 'rejected').length
    this.#created.clear()
    if (failed > 0) {
      this.#phaseLabel.textContent = `清理未完成：${failed}/${keys.length} 个对象删除失败`
      return `；清理失败 ${failed}/${keys.length} 个对象`
    }
    this.#phaseLabel.textContent = '完成'
    return `；已清理 ${keys.length} 个测试对象`
  }

  #readForm(): FormValues {
    const sizes = parseSizes(this.#sizesInput.value)
    const concurrencies = parseIntegerList(
      this.#concurrencyInput.value,
      '并发',
      1,
      MAX_CONCURRENCY,
    )
    const operations: BenchmarkOperation[] = []
    if (this.#putInput.checked) operations.push('put')
    if (this.#getInput.checked) operations.push('get')
    if (operations.length === 0) throw new Error('至少选择一种操作（PUT 或 GET）')

    const samples = parseInteger(this.#samplesInput.value, '样本数', 1, MAX_SAMPLES)
    const durationSeconds = parseDuration(this.#durationInput.value)

    if (sizes.length * concurrencies.length > MAX_CASES) {
      throw new Error(`用例过多：${sizes.length} 个尺寸 × ${concurrencies.length} 个并发超过 ${MAX_CASES}`)
    }
    return { sizes, concurrencies, operations, samples, durationSeconds }
  }

  #showError(message: string): void {
    this.#formError.textContent = message
    this.#formError.hidden = false
  }

  #export(): void {
    const report = this.#lastReport
    if (!report) {
      this.#onStatus('没有可导出的压测结果', 'error')
      return
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      meta: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        host: location.host,
        transport: 'HTTP/1.1 同源代理（浏览器每源约 6 个连接）',
        note: '浏览器面板结果只作本机基线，不是对外性能承诺；权威数字请用 npm run bench。',
        cleanup: this.#lastCleanup.replace(/^；/, ''),
      },
      report,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `blink-bench-${stamp(report.startedAt)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
    this.#onStatus(`已导出 ${link.download}`, 'success')
  }
}

function textInput(name: string, value: string): HTMLInputElement {
  return h('input', {
    class: 'text-input',
    type: 'text',
    name,
    value,
    autocomplete: 'off',
    attrs: { spellcheck: 'false' },
  })
}

function field(label: string, input: HTMLInputElement, hint: string): HTMLElement {
  return h(
    'label',
    { class: 'field bench-field' },
    h('span', { class: 'field-label', text: label }),
    input,
    h('span', { class: 'bench-field-hint', text: hint }),
  )
}

function buildCases(form: FormValues): BenchmarkCase[] {
  const cases: BenchmarkCase[] = []
  for (const size of form.sizes) {
    for (const concurrency of form.concurrencies) {
      cases.push({ size, concurrency, operations: form.operations })
    }
  }
  return cases
}

function parseSizes(raw: string): number[] {
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error('至少填写一个对象大小')
  const sizes = parts.map((item) => {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kib|mib|gib)?$/i.exec(item)
    if (!match) throw new Error(`无法识别的大小：${item}（示例：64KiB, 1MiB）`)
    const value = Number(match[1]) * (SIZE_UNITS[(match[2] ?? 'b').toLowerCase()] ?? 1)
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`对象大小必须是正整数：${item}`)
    }
    if (value > MAX_SIZE) {
      throw new Error(`浏览器面板单个对象最大 ${formatBytes(MAX_SIZE)}：${item}`)
    }
    return value
  })
  return [...new Set(sizes)]
}

function parseIntegerList(raw: string, label: string, min: number, max: number): number[] {
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error(`至少填写一个${label}值`)
  return [...new Set(parts.map((item) => parseInteger(item, label, min, max)))]
}

function parseInteger(raw: string, label: string, min: number, max: number): number {
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}必须是 ${min}–${max} 的整数，收到「${raw.trim()}」`)
  }
  return value
}

function parseDuration(raw: string): number {
  const text = raw.trim()
  const value = Number(text)
  if (text === '' || !Number.isFinite(value) || value < 0 || value > MAX_DURATION_SECONDS) {
    throw new Error(`时长必须是 0–${MAX_DURATION_SECONDS} 秒，收到「${text}」`)
  }
  return value
}

function operationLabel(operation: BenchmarkOperation): string {
  return operation === 'put' ? 'PUT' : 'GET'
}

function latency(result: BenchmarkOperationResult, key: 'p50Ms' | 'p95Ms' | 'p99Ms'): string {
  const value = result.latency?.[key]
  if (value === undefined) return '-'
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`
}

function resultStatus(result: BenchmarkOperationResult): {
  text: string
  kind: 'ok' | 'warn' | 'error'
} {
  if (result.skippedReason) return { text: `跳过：${result.skippedReason}`, kind: 'warn' }
  if (result.canceled) return { text: '已取消', kind: 'warn' }
  if (result.checksumMismatches > 0) {
    return { text: `校验和不一致 ${result.checksumMismatches}`, kind: 'error' }
  }
  if (result.stoppedOnErrors) {
    return { text: `连续错误停止（${result.errors}）`, kind: 'error' }
  }
  if (result.errors > 0) return { text: `错误 ${result.errors}`, kind: 'error' }
  if (result.budgetLimited) return { text: '受预算限制', kind: 'warn' }
  return { text: '正常', kind: 'ok' }
}

function stamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}
