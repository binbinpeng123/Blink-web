/** 极简 DOM 构建助手：无框架、无虚拟 DOM，视图类直接持有元素引用。 */

export type DomChild = Node | string | number | null | undefined | false

export interface DomProps {
  class?: string
  text?: string
  title?: string
  type?: string
  name?: string
  placeholder?: string
  value?: string
  href?: string
  disabled?: boolean
  checked?: boolean
  hidden?: boolean
  autocomplete?: string
  /** 追加 attribute（值统一按字符串处理） */
  attrs?: Record<string, string>
  on?: Record<string, (event: Event) => void>
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: DomProps = {},
  ...children: DomChild[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (props.class) element.className = props.class
  if (props.text !== undefined) element.textContent = props.text
  if (props.hidden) element.hidden = true
  for (const name of ['title', 'type', 'name', 'placeholder', 'value', 'href', 'autocomplete'] as const) {
    const value = props[name]
    if (value !== undefined) element.setAttribute(name, value)
  }
  if (props.disabled) element.setAttribute('disabled', '')
  if (props.checked) element.setAttribute('checked', '')
  if (props.attrs) {
    for (const [name, value] of Object.entries(props.attrs)) element.setAttribute(name, value)
  }
  if (props.on) {
    for (const [name, handler] of Object.entries(props.on)) element.addEventListener(name, handler)
  }
  append(element, ...children)
  return element
}

export function append(parent: Node, ...children: DomChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function setText(node: Node, text: string): void {
  node.textContent = text
}
