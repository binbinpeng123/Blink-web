import { append, clear, h } from './dom.ts'

/** 单例模态框：遮罩点击与 Esc 关闭，关闭后把焦点还给触发元素。 */
export class Modal {
  readonly #backdrop: HTMLDivElement
  readonly #title: HTMLHeadingElement
  readonly #body: HTMLDivElement
  readonly #closeButton: HTMLButtonElement
  #restoreFocus: HTMLElement | null = null
  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    }
  }

  constructor() {
    this.#title = h('h2', { class: 'modal-title', attrs: { id: 'modal-title' } })
    this.#body = h('div', { class: 'modal-body' })
    this.#closeButton = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: '关闭（Esc）',
        attrs: { 'aria-label': '关闭' },
        on: { click: () => this.close() },
      },
      '×',
    )
    const dialog = h(
      'div',
      {
        class: 'modal',
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
      },
      h('header', { class: 'modal-header' }, this.#title, this.#closeButton),
      this.#body,
    )
    this.#backdrop = h(
      'div',
      {
        class: 'modal-backdrop',
        hidden: true,
        on: {
          click: (event) => {
            if (event.target === this.#backdrop) this.close()
          },
        },
      },
      dialog,
    )
  }

  open(title: string, content: Node): void {
    if (this.#backdrop.hidden) {
      this.#restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      document.addEventListener('keydown', this.#onKeydown)
    }
    this.#title.textContent = title
    clear(this.#body)
    append(this.#body, content)
    if (!this.#backdrop.isConnected) document.body.appendChild(this.#backdrop)
    this.#backdrop.hidden = false
    this.#closeButton.focus()
  }

  close(): void {
    if (this.#backdrop.hidden) return
    this.#backdrop.hidden = true
    document.removeEventListener('keydown', this.#onKeydown)
    const target = this.#restoreFocus
    this.#restoreFocus = null
    target?.focus()
  }
}
