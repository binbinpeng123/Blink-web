import type { S3Client } from '../core/client.ts'
import {
  DOWNLOAD_CHUNK_SIZE,
  Downloader,
  type DownloadProgress,
  type DownloadSink,
} from '../core/downloader.ts'
import { isAbortError } from '../core/errors.ts'
import { formatBytes, formatDuration, formatRate } from '../core/formatters.ts'
import { createDownloadSink, type SinkRequest } from './downloadSinks.ts'
import { h } from './dom.ts'
import { describeError } from './errorText.ts'
import type { StatusSink } from './status.ts'

type TaskState = 'preparing' | 'downloading' | 'done' | 'error' | 'canceled'

interface Task {
  id: number
  bucket: string
  key: string
  controller: AbortController
  state: TaskState
  downloaded: number
  total: number
  chunks: number
  totalChunks: number
  rate: number | null
  startedAt: number
  lastBytes: number
  lastTime: number
  elapsedMs: number
  detail: string
  errorText: string
  element: HTMLLIElement
  progress: HTMLElement
  bar: HTMLElement
  statusText: HTMLSpanElement
  sizeText: HTMLSpanElement
  action: HTMLButtonElement
}

export interface DownloadPanelOptions {
  onStatus: StatusSink
  /** 注入点：测试可替换掉真实的文件选择器与下载器。 */
  createSink?: (request: SinkRequest) => Promise<DownloadSink>
  createDownloader?: (client: S3Client) => Downloader
}

/**
 * 下载视图：每个对象一个任务，展示分块进度与速率，可取消。
 * 保存位置由 sink 决定（流式写盘或 Blob 回退），这里不接触字节。
 */
export class DownloadPanel {
  readonly element: HTMLElement
  readonly #list: HTMLUListElement
  readonly #clearButton: HTMLButtonElement
  readonly #onStatus: StatusSink
  readonly #createSink: (request: SinkRequest) => Promise<DownloadSink>
  readonly #createDownloader: (client: S3Client) => Downloader
  #downloader: Downloader | null = null
  #tasks: Task[] = []
  #nextId = 1

  constructor(options: DownloadPanelOptions) {
    this.#onStatus = options.onStatus
    this.#createSink = options.createSink ?? createDownloadSink
    this.#createDownloader =
      options.createDownloader ??
      ((client) => new Downloader(client, { chunkSize: DOWNLOAD_CHUNK_SIZE }))

    this.#list = h('ul', {
      class: 'download-list',
      hidden: true,
      attrs: { 'aria-label': '下载任务' },
    })
    this.#clearButton = h(
      'button',
      {
        class: 'link-button',
        type: 'button',
        hidden: true,
        on: { click: () => this.#clearFinished() },
      },
      '清除已完成',
    )

    this.element = h(
      'section',
      { class: 'panel', attrs: { 'aria-labelledby': 'download-title' } },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { class: 'panel-title', attrs: { id: 'download-title' } }, '下载'),
        h(
          'div',
          { class: 'panel-head-right' },
          h('span', {
            class: 'muted',
            text: `Range · ${formatBytes(DOWNLOAD_CHUNK_SIZE)} 分块`,
          }),
          this.#clearButton,
        ),
      ),
      this.#list,
    )
    // 没有任务时不占版面；第一次下载时再出现。
    this.element.hidden = true
  }

  setClient(client: S3Client | null): void {
    if (!client) {
      // 断开后继续下载只剩认证错误；已开始的任务也失去意义。
      for (const task of this.#tasks) {
        if (task.state === 'preparing' || task.state === 'downloading') task.controller.abort()
      }
    }
    this.#downloader = client ? this.#createDownloader(client) : null
  }

  /** 由对象行触发；必须在用户手势的同步调用链里，保存对话框才能打开。 */
  start(bucket: string, key: string): void {
    const downloader = this.#downloader
    if (!downloader) {
      this.#onStatus('请先连接后再下载', 'error')
      return
    }
    const task = this.#createTask(bucket, key)
    this.#tasks.push(task)
    this.#list.appendChild(task.element)
    this.element.hidden = false
    this.#list.hidden = false
    void this.#run(downloader, task)
  }

  async #run(downloader: Downloader, task: Task): Promise<void> {
    task.state = 'preparing'
    task.startedAt = performance.now()
    task.lastTime = task.startedAt
    this.#renderTask(task)
    this.#onStatus(
      `准备下载 ${task.key}：如果弹出系统「保存文件」对话框，请在那里确认保存位置`,
      'info',
    )

    let sink: DownloadSink
    try {
      sink = await this.#createSink({
        key: task.key,
        onFallback: (reason) => this.#onStatus(`${task.key}：${reason}`, 'info'),
      })
    } catch (error) {
      this.#finishWithError(task, error, '已取消下载')
      return
    }

    if (task.controller.signal.aborted) {
      await sink.abort().catch(() => {})
      this.#finishWithError(task, new DOMException('操作已取消', 'AbortError'), '已取消下载')
      return
    }

    task.state = 'downloading'
    task.startedAt = performance.now()
    task.lastTime = task.startedAt
    task.lastBytes = 0
    this.#renderTask(task)

    try {
      const result = await downloader.download(task.bucket, task.key, sink, {
        signal: task.controller.signal,
        onProgress: (progress) => this.#onProgress(task, progress),
      })
      task.state = 'done'
      task.downloaded = result.bytes
      task.total = result.bytes
      task.chunks = result.chunks
      task.elapsedMs = performance.now() - task.startedAt
      task.detail =
        result.chunks === 0
          ? '空对象'
          : result.chunks === 1
            ? '单分块'
            : `${result.chunks} 个分块`
      this.#renderTask(task)
      this.#onStatus(`已下载 ${task.key}（${formatBytes(result.bytes)}，${task.detail}）`, 'success')
    } catch (error) {
      this.#finishWithError(task, error, '已取消下载')
      return
    }
    this.#syncClearButton()
  }

  #finishWithError(task: Task, error: unknown, canceledMessage: string): void {
    if (task.controller.signal.aborted || isAbortError(error)) {
      task.state = 'canceled'
      this.#onStatus(`${canceledMessage} ${task.key}`, 'info')
    } else {
      task.state = 'error'
      task.errorText = describeError(error)
      this.#onStatus(`下载失败 ${task.key}：${task.errorText}`, 'error')
    }
    this.#renderTask(task)
    this.#syncClearButton()
  }

  #onProgress(task: Task, progress: DownloadProgress): void {
    task.downloaded = progress.downloadedBytes
    task.total = progress.totalBytes
    task.chunks = progress.chunks
    task.totalChunks = progress.totalChunks

    const now = performance.now()
    const deltaBytes = progress.downloadedBytes - task.lastBytes
    const deltaMs = now - task.lastTime
    if (deltaBytes > 0 && deltaMs >= 50) {
      const instant = (deltaBytes / deltaMs) * 1000
      task.rate = task.rate === null ? instant : task.rate * 0.7 + instant * 0.3
      task.lastBytes = progress.downloadedBytes
      task.lastTime = now
    }
    this.#renderTask(task)
  }

  #createTask(bucket: string, key: string): Task {
    const bar = h('div', { class: 'progress-bar' })
    const progress = h(
      'div',
      { class: 'progress', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } },
      bar,
    )
    const statusText = h('span', { class: 'download-status', text: '等待系统保存对话框…' })
    const sizeText = h('span', { class: 'download-size muted', text: '' })
    const action = h('button', { class: 'link-button', type: 'button' }, '取消')
    const element = h(
      'li',
      {
        class: 'download-task',
        attrs: { 'data-state': 'preparing', 'data-key': key },
      },
      h(
        'div',
        { class: 'download-task-head' },
        h('span', { class: 'download-name', title: key, text: key }),
        action,
      ),
      progress,
      h('div', { class: 'download-meta' }, statusText, sizeText),
    )

    const task: Task = {
      id: this.#nextId++,
      bucket,
      key,
      controller: new AbortController(),
      state: 'preparing',
      downloaded: 0,
      total: 0,
      chunks: 0,
      totalChunks: 0,
      rate: null,
      startedAt: 0,
      lastBytes: 0,
      lastTime: 0,
      elapsedMs: 0,
      detail: '',
      errorText: '',
      element,
      progress,
      bar,
      statusText,
      sizeText,
      action,
    }
    action.addEventListener('click', () => this.#onAction(task))
    return task
  }

  #onAction(task: Task): void {
    if (task.state === 'preparing' || task.state === 'downloading') {
      task.controller.abort()
      task.action.disabled = true
      task.statusText.textContent = '正在取消…'
      return
    }
    this.#tasks = this.#tasks.filter((item) => item !== task)
    task.element.remove()
    this.#syncVisibility()
    this.#syncClearButton()
  }

  #clearFinished(): void {
    for (const task of this.#tasks) {
      if (task.state !== 'preparing' && task.state !== 'downloading') task.element.remove()
    }
    this.#tasks = this.#tasks.filter(
      (task) => task.state === 'preparing' || task.state === 'downloading',
    )
    this.#syncVisibility()
    this.#syncClearButton()
  }

  #syncVisibility(): void {
    this.#list.hidden = this.#tasks.length === 0
    this.element.hidden = this.#tasks.length === 0
  }

  #syncClearButton(): void {
    this.#clearButton.hidden = !this.#tasks.some(
      (task) => task.state !== 'preparing' && task.state !== 'downloading',
    )
  }

  #renderTask(task: Task): void {
    task.element.dataset['state'] = task.state
    const pct = task.total > 0 ? Math.min(100, Math.round((task.downloaded / task.total) * 100)) : 0
    task.bar.style.width = `${pct}%`
    task.progress.setAttribute('aria-valuenow', String(pct))

    switch (task.state) {
      case 'preparing':
        task.statusText.textContent = '等待系统保存对话框…'
        break
      case 'downloading': {
        const rate = task.rate ? ` · ${formatRate(task.rate, 1000)}` : ''
        const eta =
          task.rate && task.total > task.downloaded
            ? ` · 剩余 ${formatDuration(((task.total - task.downloaded) / task.rate) * 1000)}`
            : ''
        const chunks = task.totalChunks > 0 ? ` · ${task.chunks}/${task.totalChunks} 块` : ''
        task.statusText.textContent = `下载中 ${pct}%${chunks}${rate}${eta}`
        break
      }
      case 'done':
        task.statusText.textContent = `完成 · ${formatRate(task.total, task.elapsedMs)} · ${task.detail}`
        break
      case 'error':
        task.statusText.textContent = `失败：${task.errorText}`
        break
      case 'canceled':
        task.statusText.textContent = '已取消'
        break
    }

    task.sizeText.textContent =
      task.state === 'done'
        ? formatBytes(task.total)
        : task.total > 0
          ? `${formatBytes(task.downloaded)} / ${formatBytes(task.total)}`
          : ''

    const running = task.state === 'preparing' || task.state === 'downloading'
    task.action.textContent = running ? '取消' : '移除'
    task.action.disabled = false
  }
}
