import type { ObjectEntry, ObjectInfo, S3Client } from '../core/client.ts'
import { isAbortError } from '../core/errors.ts'
import { formatBytes, formatDate, truncate } from '../core/formatters.ts'
import { clear, h } from './dom.ts'
import { describeError } from './errorText.ts'
import type { Modal } from './Modal.ts'
import type { StatusSink } from './status.ts'

const PAGE_SIZE = 200

export interface ObjectBrowserOptions {
  onStatus: StatusSink
  modal: Modal
}

export class ObjectBrowser {
  readonly element: HTMLElement
  readonly #body: HTMLTableSectionElement
  readonly #breadcrumb: HTMLElement
  readonly #prefixInput: HTMLInputElement
  readonly #filterButton: HTMLButtonElement
  readonly #refreshButton: HTMLButtonElement
  readonly #bucketLabel: HTMLSpanElement
  readonly #countLabel: HTMLSpanElement
  readonly #prevButton: HTMLButtonElement
  readonly #nextButton: HTMLButtonElement
  readonly #pageLabel: HTMLSpanElement
  readonly #modal: Modal
  readonly #onStatus: StatusSink

  #client: S3Client | null = null
  #bucket: string | null = null
  #prefix = ''
  #tokens: Array<string | undefined> = [undefined]
  #page = 0
  #objects: ObjectEntry[] = []
  #prefixes: string[] = []
  #truncated = false
  #nextToken: string | undefined
  #loading = false
  #controller: AbortController | null = null

  constructor(options: ObjectBrowserOptions) {
    this.#modal = options.modal
    this.#onStatus = options.onStatus

    this.#bucketLabel = h('span', { class: 'muted', text: '未选择桶' })
    this.#refreshButton = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: '刷新当前前缀',
        attrs: { 'aria-label': '刷新当前前缀' },
        on: { click: () => void this.load() },
      },
      '⟳',
    )
    this.#breadcrumb = h('nav', { class: 'breadcrumb', attrs: { 'aria-label': '前缀路径' } })

    this.#prefixInput = h('input', {
      class: 'text-input',
      type: 'text',
      name: 'prefix',
      placeholder: '按前缀筛选，例如 logs/2026/',
      autocomplete: 'off',
      attrs: { spellcheck: 'false' },
    })
    this.#filterButton = h('button', { class: 'secondary', type: 'submit' }, '筛选')
    const filterForm = h(
      'form',
      {
        class: 'filter-form',
        on: {
          submit: (event) => {
            event.preventDefault()
            this.#setPrefix(this.#prefixInput.value.trim())
          },
        },
      },
      this.#prefixInput,
      this.#filterButton,
    )

    this.#body = h('tbody')
    const table = h(
      'table',
      { class: 'object-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: '名称' }),
          h('th', { class: 'col-size', text: '大小' }),
          h('th', { class: 'col-date', text: '修改时间' }),
          h('th', { class: 'col-etag', text: 'ETag' }),
          h('th', { class: 'col-actions', text: '操作' }),
        ),
      ),
      this.#body,
    )
    const tableWrap = h('div', { class: 'table-wrap' }, table)

    this.#countLabel = h('span', { class: 'muted' })
    this.#prevButton = h(
      'button',
      { class: 'secondary small', type: 'button', on: { click: () => this.#prev() } },
      '上一页',
    )
    this.#pageLabel = h('span', { class: 'page-number', text: '第 1 页' })
    this.#nextButton = h(
      'button',
      { class: 'secondary small', type: 'button', on: { click: () => this.#next() } },
      '下一页',
    )
    const footer = h(
      'div',
      { class: 'browser-footer' },
      this.#countLabel,
      h('div', { class: 'pager' }, this.#prevButton, this.#pageLabel, this.#nextButton),
    )

    this.element = h(
      'section',
      { class: 'panel panel-grow', attrs: { 'aria-labelledby': 'objects-title' } },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { class: 'panel-title', attrs: { id: 'objects-title' } }, '对象'),
        h('div', { class: 'panel-head-right' }, this.#bucketLabel, this.#refreshButton),
      ),
      this.#breadcrumb,
      filterForm,
      tableWrap,
      footer,
    )

    this.setEnabled(false)
    this.#render()
  }

  setClient(client: S3Client | null): void {
    this.#client = client
    this.setEnabled(client !== null && this.#bucket !== null)
    if (!client) {
      this.#bucket = null
      this.#bucketLabel.textContent = '未选择桶'
      this.#resetView()
      this.#render()
    }
  }

  setBucket(bucket: string | null): void {
    this.#bucket = bucket
    this.#bucketLabel.textContent = bucket ?? '未选择桶'
    this.#prefixInput.value = ''
    this.#resetView()
    this.setEnabled(this.#client !== null && bucket !== null)
    void this.load()
  }

  async load(): Promise<void> {
    this.#controller?.abort()
    const client = this.#client
    const bucket = this.#bucket
    if (!client || !bucket) {
      this.#resetView()
      this.#render()
      return
    }

    const controller = new AbortController()
    this.#controller = controller
    this.#loading = true
    this.#render()
    try {
      const result = await client.listObjects({
        bucket,
        prefix: this.#prefix || undefined,
        delimiter: '/',
        continuationToken: this.#tokens[this.#page],
        maxKeys: PAGE_SIZE,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      this.#objects = result.objects
      this.#prefixes = result.prefixes
      this.#truncated = result.isTruncated
      this.#nextToken = result.nextToken
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      this.#onStatus(describeError(error), 'error')
      this.#objects = []
      this.#prefixes = []
      this.#truncated = false
      this.#nextToken = undefined
    } finally {
      if (this.#controller === controller) {
        this.#loading = false
        this.#render()
      }
    }
  }

  #resetView(): void {
    this.#prefix = ''
    this.#prefixInput.value = ''
    this.#tokens = [undefined]
    this.#page = 0
    this.#objects = []
    this.#prefixes = []
    this.#truncated = false
    this.#nextToken = undefined
    this.#loading = false
  }

  #setPrefix(prefix: string): void {
    this.#prefix = prefix
    this.#prefixInput.value = prefix
    this.#tokens = [undefined]
    this.#page = 0
    void this.load()
  }

  #prev(): void {
    if (this.#page === 0 || this.#loading) return
    this.#page--
    void this.load()
  }

  #next(): void {
    if (this.#loading || !this.#truncated || !this.#nextToken) return
    this.#tokens = this.#tokens.slice(0, this.#page + 1)
    this.#tokens.push(this.#nextToken)
    this.#page = this.#tokens.length - 1
    void this.load()
  }

  async #showDetails(key: string): Promise<void> {
    const client = this.#client
    const bucket = this.#bucket
    if (!client || !bucket) return
    try {
      const info = await client.headObject(bucket, key)
      this.#modal.open('对象详情', detailContent(info))
    } catch (error) {
      this.#onStatus(describeError(error), 'error')
    }
  }

  async #deleteObject(key: string): Promise<void> {
    const client = this.#client
    const bucket = this.#bucket
    if (!client || !bucket) return
    if (!window.confirm(`删除对象 ${key}？`)) return

    try {
      await client.deleteObject(bucket, key)
      this.#onStatus(`已删除 ${key}`, 'success')
      await this.load()
      // 当前页删空时退回上一页，避免停在空列表上
      if (this.#page > 0 && this.#objects.length === 0 && this.#prefixes.length === 0) {
        this.#page--
        await this.load()
      }
    } catch (error) {
      this.#onStatus(describeError(error), 'error')
    }
  }

  #render(): void {
    this.#renderBreadcrumb()
    clear(this.#body)

    if (!this.#bucket) {
      this.#body.appendChild(messageRow('请选择左侧的桶'))
    } else if (this.#loading) {
      this.#body.appendChild(messageRow('加载中…'))
    } else if (this.#prefixes.length === 0 && this.#objects.length === 0) {
      this.#body.appendChild(messageRow(this.#prefix ? '此前缀下没有对象' : '桶是空的'))
    } else {
      for (const prefix of this.#prefixes) {
        this.#body.appendChild(this.#prefixRow(prefix))
      }
      for (const object of this.#objects) {
        this.#body.appendChild(this.#objectRow(object))
      }
    }

    this.#countLabel.textContent = this.#bucket
      ? `${this.#prefixes.length} 个目录 · ${this.#objects.length} 个对象`
      : '—'
    this.#pageLabel.textContent = `第 ${this.#page + 1} 页`
    this.#prevButton.disabled = this.#loading || this.#page === 0
    this.#nextButton.disabled = this.#loading || !this.#truncated || !this.#nextToken
  }

  #renderBreadcrumb(): void {
    clear(this.#breadcrumb)
    this.#breadcrumb.appendChild(
      h(
        'button',
        { class: 'crumb', type: 'button', on: { click: () => this.#setPrefix('') } },
        '全部对象',
      ),
    )
    if (!this.#bucket) return

    const parts = this.#prefix.split('/').filter((part) => part.length > 0)
    const endsWithSlash = this.#prefix.endsWith('/')
    let accumulated = ''
    parts.forEach((part, index) => {
      accumulated += `${part}/`
      const isCurrentLeaf = index === parts.length - 1 && !endsWithSlash
      this.#breadcrumb.appendChild(h('span', { class: 'crumb-sep', text: '/' }))
      if (isCurrentLeaf) {
        this.#breadcrumb.appendChild(h('span', { class: 'crumb current', text: part }))
      } else {
        const target = accumulated
        this.#breadcrumb.appendChild(
          h(
            'button',
            { class: 'crumb', type: 'button', on: { click: () => this.#setPrefix(target) } },
            part,
          ),
        )
      }
    })
  }

  #prefixRow(prefix: string): HTMLTableRowElement {
    const name = prefix.slice(this.#prefix.length) || prefix
    return h(
      'tr',
      { class: 'row-dir' },
      h(
        'td',
        {},
        h(
          'button',
          {
            class: 'row-name dir',
            type: 'button',
            title: prefix,
            attrs: { 'data-prefix': prefix },
            on: { click: () => this.#setPrefix(prefix) },
          },
          h('span', { class: 'dir-mark', text: '▸' }),
          name,
        ),
      ),
      h('td', { class: 'col-size muted', text: '-' }),
      h('td', { class: 'col-date muted', text: '-' }),
      h('td', { class: 'col-etag muted', text: '-' }),
      h('td', { class: 'col-actions' }),
    )
  }

  #objectRow(object: ObjectEntry): HTMLTableRowElement {
    const name = object.key.slice(this.#prefix.length) || object.key
    return h(
      'tr',
      { attrs: { 'data-key': object.key } },
      h('td', {}, h('button', { class: 'row-name', type: 'button', title: object.key, on: { click: () => void this.#showDetails(object.key) } }, name)),
      h('td', { class: 'col-size', text: formatBytes(object.size) }),
      h('td', { class: 'col-date', text: formatDate(object.lastModified) }),
      h(
        'td',
        { class: 'col-etag', title: object.etag, text: truncate(object.etag, 12) },
      ),
      h(
        'td',
        { class: 'col-actions' },
        h(
          'div',
          { class: 'row-actions' },
          h(
            'button',
            { class: 'link-button', type: 'button', on: { click: () => void this.#showDetails(object.key) } },
            '详情',
          ),
          h(
            'button',
            {
              class: 'link-button danger',
              type: 'button',
              on: { click: () => void this.#deleteObject(object.key) },
            },
            '删除',
          ),
        ),
      ),
    )
  }

  setEnabled(enabled: boolean): void {
    this.#prefixInput.disabled = !enabled
    this.#filterButton.disabled = !enabled
    this.#refreshButton.disabled = !enabled
    this.#prevButton.disabled = !enabled || this.#loading || this.#page === 0
    this.#nextButton.disabled = !enabled || this.#loading || !this.#truncated || !this.#nextToken
  }
}

function messageRow(text: string): HTMLTableRowElement {
  return h(
    'tr',
    { class: 'row-message' },
    h('td', { attrs: { colspan: '5' }, text }),
  )
}

function detailContent(info: ObjectInfo): HTMLElement {
  const rows: Array<[string, string]> = [
    ['Key', info.key],
    ['大小', `${formatBytes(info.size)}（${info.size} 字节）`],
    ['Content-Type', info.contentType || '—'],
    ['ETag', info.etag || '—'],
    ['最后修改', formatDate(info.lastModified)],
    [
      'Checksum',
      info.checksumSha256
        ? `${info.checksumType ? `${info.checksumType} · ` : ''}${info.checksumSha256}`
        : '—',
    ],
  ]

  const list = h('dl', { class: 'details' })
  for (const [label, value] of rows) {
    list.appendChild(h('dt', { text: label }))
    list.appendChild(h('dd', { text: value }))
  }

  const metadataNames = Object.keys(info.metadata)
  list.appendChild(h('dt', { text: 'Metadata' }))
  if (metadataNames.length === 0) {
    list.appendChild(h('dd', { class: 'muted', text: '（无）' }))
  } else {
    for (const name of metadataNames) {
      list.appendChild(h('dd', { text: `x-amz-meta-${name}: ${info.metadata[name] ?? ''}` }))
    }
  }

  const children: HTMLElement[] = [list]
  if (info.checksumType === 'COMPOSITE') {
    children.push(
      h('p', {
        class: 'hint',
        text: 'COMPOSITE 校验和是各分片摘要的合成值，不等于整文件的 SHA-256；换用官方工具按相同分片方式可复现。',
      }),
    )
  }
  return h('div', {}, ...children)
}
