import type { S3Client } from '../core/client.ts'
import { isAbortError } from '../core/errors.ts'
import { formatBytes, formatDuration, formatRate } from '../core/formatters.ts'
import { objectKeyProblem } from '../core/keys.ts'
import { Uploader, type UploadProgress } from '../core/uploader.ts'
import { h } from './dom.ts'
import { describeError } from './errorText.ts'
import type { StatusSink } from './status.ts'

type TaskState = 'queued' | 'uploading' | 'done' | 'error' | 'canceled'

interface Task {
  id: number
  file: File
  bucket: string
  key: string
  controller: AbortController
  state: TaskState
  phase: UploadProgress['phase']
  uploaded: number
  total: number
  determinate: boolean
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

export interface UploadPanelOptions {
  onStatus: StatusSink
  /** 上传成功后通知组合根刷新对象列表 */
  onUploaded: (bucket: string, key: string) => void
  /** 抽象出上传器，便于测试注入；默认 Uploader。 */
  createUploader?: (client: S3Client) => Uploader
}

/**
 * 上传视图：拖拽/选择文件，展示每个文件的分片进度、速率与取消。
 * 网络并发由 Uploader 的全局信号量控制，这里只负责排队展示与取消。
 */
export class UploadPanel {
  readonly element: HTMLElement
  readonly #drop: HTMLElement
  readonly #fileInput: HTMLInputElement
  readonly #list: HTMLUListElement
  readonly #targetLabel: HTMLSpanElement
  readonly #clearButton: HTMLButtonElement
  readonly #onStatus: StatusSink
  readonly #onUploaded: UploadPanelOptions['onUploaded']
  readonly #createUploader: (client: S3Client) => Uploader
  #uploader: Uploader | null = null
  #target: { bucket: string; prefix: string } | null = null
  #tasks: Task[] = []
  #nextId = 1

  constructor(options: UploadPanelOptions) {
    this.#onStatus = options.onStatus
    this.#onUploaded = options.onUploaded
    this.#createUploader = options.createUploader ?? ((client) => new Uploader(client))

    this.#fileInput = h('input', {
      type: 'file',
      hidden: true,
      attrs: { multiple: '' },
    })
    this.#fileInput.addEventListener('change', () => {
      this.#enqueue(this.#fileInput.files)
      // 清空以便再次选择同一个文件
      this.#fileInput.value = ''
    })

    this.#drop = h(
      'div',
      {
        class: 'upload-drop disabled',
        attrs: {
          role: 'button',
          tabindex: '0',
          'aria-disabled': 'true',
          'aria-label': '选择或拖拽要上传的文件',
        },
        on: {
          click: () => this.#pick(),
          keydown: (event) => {
            const key = (event as KeyboardEvent).key
            if (key === 'Enter' || key === ' ') {
              event.preventDefault()
              this.#pick()
            }
          },
          dragenter: (event) => this.#drag(event, true),
          dragover: (event) => this.#drag(event, true),
          dragleave: (event) => this.#drag(event, false),
          drop: (event) => {
            event.preventDefault()
            this.#drop.classList.remove('dragover')
            const files = (event as DragEvent).dataTransfer?.files
            if (files) this.#enqueue(files)
          },
        },
      },
      h('span', { class: 'upload-cta', text: '拖拽文件到此处，或点击选择文件' }),
      h('span', {
        class: 'hint',
        text: '写入当前前缀；≤ 8 MiB 单 PUT，更大文件自动分片（8 MiB / 4 并发 / 3 次重试）',
      }),
    )

    this.#list = h('ul', { class: 'upload-list', hidden: true, attrs: { 'aria-label': '上传任务' } })
    this.#targetLabel = h('span', { class: 'muted upload-target', text: '未选择桶' })
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
      { class: 'panel', attrs: { 'aria-labelledby': 'upload-title' } },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { class: 'panel-title', attrs: { id: 'upload-title' } }, '上传'),
        h('div', { class: 'panel-head-right' }, this.#targetLabel, this.#clearButton),
      ),
      this.#drop,
      this.#fileInput,
      this.#list,
    )
  }

  setClient(client: S3Client | null): void {
    if (!client) {
      // 断开连接后继续上传只会得到认证错误：直接取消，状态更诚实。
      for (const task of this.#tasks) {
        if (task.state === 'queued' || task.state === 'uploading') task.controller.abort()
      }
    }
    this.#uploader = client ? this.#createUploader(client) : null
    this.#syncEnabled()
  }

  setTarget(state: { bucket: string | null; prefix: string }): void {
    this.#target = state.bucket ? { bucket: state.bucket, prefix: state.prefix } : null
    this.#targetLabel.textContent = this.#target
      ? `${this.#target.bucket}/${this.#target.prefix}`
      : '未选择桶'
    this.#targetLabel.title = this.#targetLabel.textContent
    this.#syncEnabled()
  }

  #syncEnabled(): void {
    const enabled = this.#uploader !== null && this.#target !== null
    this.#drop.classList.toggle('disabled', !enabled)
    this.#drop.setAttribute('aria-disabled', String(!enabled))
    this.#fileInput.disabled = !enabled
  }

  #pick(): void {
    if (!this.#uploader || !this.#target) {
      this.#onStatus('请先选择要上传到的桶', 'error')
      return
    }
    this.#fileInput.click()
  }

  #drag(event: Event, over: boolean): void {
    event.preventDefault()
    if (!this.#uploader || !this.#target) return
    this.#drop.classList.toggle('dragover', over)
  }

  #enqueue(files: FileList | null): void {
    const uploader = this.#uploader
    const target = this.#target
    if (!uploader || !target) {
      this.#onStatus('请先选择要上传到的桶', 'error')
      return
    }
    if (!files || files.length === 0) return

    for (const file of Array.from(files)) {
      const key = `${target.prefix}${file.name}`
      const problem = objectKeyProblem(key)
      if (problem) {
        this.#onStatus(`${file.name}：${problem}`, 'error')
        continue
      }
      const task = this.#createTask(file, target.bucket, key)
      this.#tasks.push(task)
      this.#list.appendChild(task.element)
      this.#list.hidden = false
      void this.#run(uploader, task)
    }
  }

  async #run(uploader: Uploader, task: Task): Promise<void> {
    task.state = 'uploading'
    task.startedAt = performance.now()
    task.lastTime = task.startedAt
    this.#renderTask(task)
    this.#onStatus(`开始上传 ${task.key}`, 'info')

    try {
      const result = await uploader.upload(task.file, {
        bucket: task.bucket,
        key: task.key,
        contentType: task.file.type || undefined,
        signal: task.controller.signal,
        onProgress: (progress) => this.#onProgress(task, progress),
      })
      task.state = 'done'
      task.uploaded = result.bytes
      task.total = result.bytes
      task.determinate = true
      task.elapsedMs = performance.now() - task.startedAt
      task.detail =
        result.mode === 'multipart'
          ? `${result.parts} 个分片 · ${result.checksumType ?? 'COMPOSITE'} 校验和`
          : '单 PUT · FULL_OBJECT 校验和'
      this.#renderTask(task)
      this.#onStatus(`已上传 ${task.key}（${formatBytes(result.bytes)}，${task.detail}）`, 'success')
      this.#onUploaded(task.bucket, task.key)
    } catch (error) {
      if (task.controller.signal.aborted || isAbortError(error)) {
        task.state = 'canceled'
        this.#onStatus(`已取消上传 ${task.key}`, 'info')
      } else {
        task.state = 'error'
        task.errorText = describeError(error)
        this.#onStatus(`上传失败 ${task.key}：${task.errorText}`, 'error')
      }
      this.#renderTask(task)
    }
    this.#syncClearButton()
  }

  #onProgress(task: Task, progress: UploadProgress): void {
    task.uploaded = progress.uploadedBytes
    task.total = progress.totalBytes
    task.determinate = progress.determinate
    task.phase = progress.phase

    const now = performance.now()
    if (progress.determinate) {
      const deltaBytes = progress.uploadedBytes - task.lastBytes
      const deltaMs = now - task.lastTime
      if (deltaBytes > 0 && deltaMs >= 50) {
        const instant = (deltaBytes / deltaMs) * 1000
        task.rate = task.rate === null ? instant : task.rate * 0.7 + instant * 0.3
        task.lastBytes = progress.uploadedBytes
        task.lastTime = now
      }
    }
    this.#renderTask(task)
  }

  #createTask(file: File, bucket: string, key: string): Task {
    const bar = h('div', { class: 'progress-bar' })
    const progress = h(
      'div',
      {
        class: 'progress',
        attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' },
      },
      bar,
    )
    const statusText = h('span', { class: 'upload-status', text: '等待中' })
    const sizeText = h('span', { class: 'upload-size muted', text: formatBytes(file.size) })
    const action = h('button', { class: 'link-button', type: 'button' }, '取消')
    const element = h(
      'li',
      { class: 'upload-task', attrs: { 'data-state': 'queued', 'data-name': file.name } },
      h(
        'div',
        { class: 'upload-task-head' },
        h('span', { class: 'upload-name', title: key, text: key }),
        action,
      ),
      progress,
      h('div', { class: 'upload-meta' }, statusText, sizeText),
    )

    const task: Task = {
      id: this.#nextId++,
      file,
      bucket,
      key,
      controller: new AbortController(),
      state: 'queued',
      phase: 'uploading',
      uploaded: 0,
      total: file.size,
      determinate: true,
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
    if (task.state === 'uploading' || task.state === 'queued') {
      task.controller.abort()
      task.action.disabled = true
      task.statusText.textContent = '正在取消…'
      return
    }
    this.#tasks = this.#tasks.filter((item) => item !== task)
    task.element.remove()
    this.#list.hidden = this.#tasks.length === 0
    this.#syncClearButton()
  }

  #clearFinished(): void {
    for (const task of this.#tasks) {
      if (task.state !== 'uploading' && task.state !== 'queued') task.element.remove()
    }
    this.#tasks = this.#tasks.filter(
      (task) => task.state === 'uploading' || task.state === 'queued',
    )
    this.#list.hidden = this.#tasks.length === 0
    this.#syncClearButton()
  }

  #syncClearButton(): void {
    this.#clearButton.hidden = !this.#tasks.some(
      (task) => task.state !== 'uploading' && task.state !== 'queued',
    )
  }

  #renderTask(task: Task): void {
    task.element.dataset['state'] = task.state
    const pct = task.total > 0 ? Math.min(100, Math.round((task.uploaded / task.total) * 100)) : 100
    const indeterminate = task.state === 'uploading' && !task.determinate
    task.progress.dataset['indeterminate'] = String(indeterminate)
    task.bar.style.width = indeterminate ? '35%' : `${pct}%`
    if (indeterminate) {
      task.progress.removeAttribute('aria-valuenow')
    } else {
      task.progress.setAttribute('aria-valuenow', String(pct))
    }

    switch (task.state) {
      case 'queued':
        task.statusText.textContent = '等待中'
        break
      case 'uploading': {
        if (!task.determinate) {
          task.statusText.textContent = '上传中…'
        } else if (task.phase === 'completing') {
          task.statusText.textContent = '正在合并分片…'
        } else {
          const rate = task.rate ? ` · ${formatRate(task.rate, 1000)}` : ''
          const eta =
            task.rate && task.total > task.uploaded
              ? ` · 剩余 ${formatDuration(((task.total - task.uploaded) / task.rate) * 1000)}`
              : ''
          task.statusText.textContent = `上传中 ${pct}%${rate}${eta}`
        }
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
        : `${formatBytes(task.uploaded)} / ${formatBytes(task.total)}`
    task.action.textContent = task.state === 'uploading' || task.state === 'queued' ? '取消' : '移除'
    task.action.disabled = false
  }
}
