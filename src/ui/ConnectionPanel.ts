import type { Credentials } from '../core/types.ts'
import { h } from './dom.ts'
import { describeError } from './errorText.ts'

export interface ConnectedSummary {
  accessKeyId: string
  region: string
}

interface Remembered {
  accessKeyId: string
  region: string
}

/** 只存 access key 与 region；secret 永远不进入任何存储。 */
const REMEMBER_KEY = 'blink-web.connection'

export interface ConnectionPanelOptions {
  onConnect: (credentials: Credentials, region: string) => Promise<void>
  onDisconnect: () => void
}

export class ConnectionPanel {
  readonly element: HTMLElement
  readonly #form: HTMLFormElement
  readonly #accessInput: HTMLInputElement
  readonly #secretInput: HTMLInputElement
  readonly #regionInput: HTMLInputElement
  readonly #rememberInput: HTMLInputElement
  readonly #submitButton: HTMLButtonElement
  readonly #errorBox: HTMLDivElement
  readonly #summary: HTMLDivElement
  readonly #summaryText: HTMLSpanElement
  readonly #onConnect: ConnectionPanelOptions['onConnect']
  readonly #onDisconnect: ConnectionPanelOptions['onDisconnect']
  #busy = false

  constructor(options: ConnectionPanelOptions) {
    this.#onConnect = options.onConnect
    this.#onDisconnect = options.onDisconnect

    this.#accessInput = h('input', {
      class: 'text-input',
      type: 'text',
      name: 'access-key',
      placeholder: 'Access Key ID',
      autocomplete: 'off',
      attrs: { spellcheck: 'false', required: '' },
    })
    this.#secretInput = h('input', {
      class: 'text-input',
      type: 'password',
      name: 'secret-key',
      placeholder: 'Secret Access Key',
      autocomplete: 'current-password',
      attrs: { required: '' },
    })
    this.#regionInput = h('input', {
      class: 'text-input',
      type: 'text',
      name: 'region',
      value: 'us-east-1',
      autocomplete: 'off',
      attrs: { spellcheck: 'false' },
    })
    this.#rememberInput = h('input', { type: 'checkbox', name: 'remember' })
    this.#submitButton = h('button', { class: 'primary', type: 'submit' }, '连接')
    this.#errorBox = h('p', { class: 'form-error', hidden: true, attrs: { role: 'alert' } })

    this.#form = h(
      'form',
      {
        class: 'connection-form',
        attrs: { novalidate: '' },
        on: {
          submit: (event) => {
            event.preventDefault()
            void this.#submit()
          },
        },
      },
      field('Access Key ID', this.#accessInput),
      field('Secret Access Key', this.#secretInput),
      field('Region', this.#regionInput),
      h(
        'label',
        { class: 'checkbox-row' },
        this.#rememberInput,
        h('span', { text: '仅本标签页记住 Access Key 与 Region' }),
      ),
      h('p', {
        class: 'hint',
        text: 'Secret 只保存在内存中，刷新页面后需重新输入；连接成功后输入框会被清空。',
      }),
      this.#errorBox,
      this.#submitButton,
    )

    this.#summaryText = h('span', { class: 'connection-summary-text' })
    this.#summary = h(
      'div',
      { class: 'connection-summary', hidden: true },
      h('div', { class: 'connection-summary-head' }, h('span', { class: 'dot dot-ok' }), '已连接'),
      h('p', { class: 'connection-summary-text-line' }, this.#summaryText),
      h(
        'button',
        {
          class: 'secondary',
          type: 'button',
          name: 'disconnect',
          on: { click: () => this.#onDisconnect() },
        },
        '断开',
      ),
    )

    this.element = h(
      'section',
      { class: 'panel', attrs: { 'aria-labelledby': 'connection-title' } },
      h('h2', { class: 'panel-title', attrs: { id: 'connection-title' } }, '连接'),
      this.#form,
      this.#summary,
    )

    this.#restoreRemembered()
  }

  setBusy(busy: boolean): void {
    this.#busy = busy
    this.#accessInput.disabled = busy
    this.#secretInput.disabled = busy
    this.#regionInput.disabled = busy
    this.#rememberInput.disabled = busy
    this.#submitButton.disabled = busy
    this.#submitButton.textContent = busy ? '连接中…' : '连接'
  }

  setError(message: string | null): void {
    this.#errorBox.textContent = message ?? ''
    this.#errorBox.hidden = !message
  }

  showConnected(summary: ConnectedSummary): void {
    this.#form.hidden = true
    this.#summary.hidden = false
    this.#summaryText.textContent = `${summary.accessKeyId} · ${summary.region}`
    this.#secretInput.value = ''
    this.setError(null)
    if (this.#rememberInput.checked) {
      remember({ accessKeyId: summary.accessKeyId, region: summary.region })
    } else {
      forget()
    }
  }

  showDisconnected(): void {
    this.#summary.hidden = true
    this.#form.hidden = false
    this.#secretInput.value = ''
    this.setBusy(false)
  }

  async #submit(): Promise<void> {
    if (this.#busy) return
    const accessKeyId = this.#accessInput.value.trim()
    const secretKey = this.#secretInput.value
    const region = this.#regionInput.value.trim() || 'us-east-1'
    if (!accessKeyId || !secretKey) {
      this.setError('Access Key ID 与 Secret Access Key 都必须填写')
      return
    }

    this.setError(null)
    this.setBusy(true)
    try {
      await this.#onConnect({ accessKeyId, secretKey }, region)
    } catch (error) {
      this.setError(describeError(error))
    } finally {
      this.setBusy(false)
    }
  }

  #restoreRemembered(): void {
    const saved = recall()
    if (!saved) return
    this.#accessInput.value = saved.accessKeyId
    this.#regionInput.value = saved.region
    this.#rememberInput.checked = true
  }
}

function field(labelText: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: labelText }), input)
}

function remember(value: Remembered): void {
  try {
    sessionStorage.setItem(REMEMBER_KEY, JSON.stringify(value))
  } catch {
    // 隐私模式或存储被禁用：记不住就算了，不影响连接。
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(REMEMBER_KEY)
  } catch {
    // 同上
  }
}

function recall(): Remembered | null {
  try {
    const raw = sessionStorage.getItem(REMEMBER_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (typeof record['accessKeyId'] !== 'string' || typeof record['region'] !== 'string') return null
    if (!record['accessKeyId'] || !record['region']) return null
    return { accessKeyId: record['accessKeyId'], region: record['region'] }
  } catch {
    return null
  }
}
