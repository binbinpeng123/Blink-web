import type { BucketInfo, S3Client } from '../core/client.ts'
import { bucketProblem } from '../core/keys.ts'
import { clear, h } from './dom.ts'
import { describeError } from './errorText.ts'
import type { StatusSink } from './status.ts'

export interface BucketListOptions {
  onSelect: (bucket: string | null) => void
  onStatus: StatusSink
}

export class BucketList {
  readonly element: HTMLElement
  readonly #list: HTMLUListElement
  readonly #empty: HTMLParagraphElement
  readonly #form: HTMLFormElement
  readonly #nameInput: HTMLInputElement
  readonly #createButton: HTMLButtonElement
  readonly #refreshButton: HTMLButtonElement
  readonly #onSelect: BucketListOptions['onSelect']
  readonly #onStatus: StatusSink
  #client: S3Client | null = null
  #buckets: BucketInfo[] = []
  #selected: string | null = null
  #busy = false
  #refreshing = false

  constructor(options: BucketListOptions) {
    this.#onSelect = options.onSelect
    this.#onStatus = options.onStatus

    this.#list = h('ul', { class: 'bucket-list', attrs: { 'aria-label': '桶列表' } })
    this.#empty = h('p', { class: 'muted bucket-empty', text: '尚未创建桶' })
    this.#nameInput = h('input', {
      class: 'text-input',
      type: 'text',
      name: 'new-bucket',
      placeholder: '新桶名，如 photos',
      autocomplete: 'off',
      attrs: { spellcheck: 'false' },
    })
    this.#createButton = h('button', { class: 'primary', type: 'submit' }, '创建')
    this.#refreshButton = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: '刷新桶列表',
        attrs: { 'aria-label': '刷新桶列表' },
        on: { click: () => void this.refresh() },
      },
      '⟳',
    )

    this.#form = h(
      'form',
      {
        class: 'bucket-create',
        on: {
          submit: (event) => {
            event.preventDefault()
            void this.#create()
          },
        },
      },
      this.#nameInput,
      this.#createButton,
    )

    this.element = h(
      'section',
      { class: 'panel panel-grow', attrs: { 'aria-labelledby': 'buckets-title' } },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { class: 'panel-title', attrs: { id: 'buckets-title' } }, '桶'),
        this.#refreshButton,
      ),
      this.#form,
      this.#list,
      this.#empty,
    )
    this.#render()
    this.setEnabled(false)
  }

  setClient(client: S3Client | null, initial?: BucketInfo[]): void {
    this.#client = client
    this.#selected = null
    this.#buckets = initial ?? []
    this.setEnabled(client !== null)
    this.#render()
  }

  /** 未连接时禁用创建/刷新，避免点击后静默失败。 */
  setEnabled(enabled: boolean): void {
    this.#nameInput.disabled = !enabled
    this.#createButton.disabled = !enabled
    this.#refreshButton.disabled = !enabled
    this.#empty.textContent = enabled ? '尚未创建桶' : '连接后显示桶列表'
  }

  async refresh(): Promise<void> {
    const client = this.#client
    if (!client || this.#refreshing) return
    this.#refreshing = true
    this.#refreshButton.disabled = true
    try {
      await this.#reload(client)
    } catch (error) {
      this.#onStatus(describeError(error), 'error')
    } finally {
      this.#refreshing = false
      this.#refreshButton.disabled = this.#client === null
    }
  }

  async #reload(client: S3Client): Promise<void> {
    this.#buckets = await client.listBuckets()
    if (this.#selected && !this.#buckets.some((bucket) => bucket.name === this.#selected)) {
      this.#selected = null
      this.#onSelect(null)
    }
    this.#render()
  }

  async #create(): Promise<void> {
    const client = this.#client
    if (!client || this.#busy) return
    const name = this.#nameInput.value.trim()
    const problem = bucketProblem(name)
    if (problem) {
      this.#onStatus(problem, 'error')
      this.#nameInput.focus()
      return
    }

    this.#busy = true
    this.#createButton.disabled = true
    try {
      await client.createBucket(name)
      this.#nameInput.value = ''
      this.#onStatus(`已创建桶 ${name}`, 'success')
      await this.#reload(client)
      this.#select(name)
    } catch (error) {
      this.#onStatus(describeError(error), 'error')
    } finally {
      this.#busy = false
      this.#createButton.disabled = this.#client === null
    }
  }

  async #delete(name: string): Promise<void> {
    const client = this.#client
    if (!client || this.#busy) return
    if (!window.confirm(`删除桶 ${name}？只有空桶可以删除。`)) return

    this.#busy = true
    try {
      await client.deleteBucket(name)
      this.#onStatus(`已删除桶 ${name}`, 'success')
      if (this.#selected === name) {
        this.#selected = null
        this.#onSelect(null)
      }
      await this.#reload(client)
    } catch (error) {
      this.#onStatus(describeError(error), 'error')
    } finally {
      this.#busy = false
    }
  }

  #select(name: string): void {
    this.#selected = name
    this.#render()
    this.#onSelect(name)
  }

  #render(): void {
    clear(this.#list)
    for (const bucket of this.#buckets) {
      const name = bucket.name
      const button = h(
        'button',
        {
          class: 'bucket-name',
          type: 'button',
          title: bucket.creationDate ? `创建于 ${bucket.creationDate.toISOString()}` : name,
          attrs: { 'data-bucket': name },
          on: { click: () => this.#select(name) },
        },
        name,
      )
      this.#list.appendChild(
        h(
          'li',
          {
            class: name === this.#selected ? 'bucket-row selected' : 'bucket-row',
          },
          button,
          h(
            'button',
            {
              class: 'icon-button bucket-delete',
              type: 'button',
              title: `删除桶 ${name}`,
              attrs: { 'aria-label': `删除桶 ${name}` },
              on: { click: () => void this.#delete(name) },
            },
            '×',
          ),
        ),
      )
    }
    this.#empty.hidden = this.#buckets.length > 0
    this.#list.hidden = this.#buckets.length === 0
  }
}
