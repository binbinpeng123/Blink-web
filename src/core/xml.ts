/**
 * 极简 XML 解析器。
 *
 * 浏览器有 DOMParser，Node 没有；为了让同一份客户端代码在两端运行且不引入
 * 运行时依赖，这里实现 S3 响应所需的子集：元素、属性、文本、CDATA、注释、
 * 实体与自闭合标签。不实现 DTD、命名空间解析与验证。
 */
export interface XmlNode {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

export function parseXml(source: string): XmlNode {
  const document: XmlNode = { name: '#document', attributes: {}, children: [], text: '' }
  const stack: XmlNode[] = [document]
  let i = 0

  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt < 0) {
      appendText(stack[stack.length - 1]!, source.slice(i))
      break
    }
    if (lt > i) appendText(stack[stack.length - 1]!, source.slice(i, lt))

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      stack[stack.length - 1]!.text += source.slice(lt + 9, end < 0 ? source.length : end)
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2)
      i = end < 0 ? source.length : end + 1
      continue
    }

    const gt = findTagEnd(source, lt + 1)
    if (gt < 0) {
      appendText(stack[stack.length - 1]!, source.slice(lt))
      break
    }
    const raw = source.slice(lt + 1, gt)
    i = gt + 1

    if (raw.startsWith('/')) {
      const name = localName(raw.slice(1).trim())
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]!.name === name) {
          stack.length = s
          break
        }
      }
      continue
    }

    const selfClosing = raw.trimEnd().endsWith('/')
    const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw
    const nameEnd = body.search(/\s/)
    const name = localName((nameEnd < 0 ? body : body.slice(0, nameEnd)).trim())
    if (!name) continue

    const node: XmlNode = {
      name,
      attributes: nameEnd < 0 ? {} : parseAttributes(body.slice(nameEnd)),
      children: [],
      text: '',
    }
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return document.children[0] ?? document
}

function findTagEnd(source: string, from: number): number {
  let quote = ''
  for (let i = from; i < source.length; i++) {
    const ch = source[i]!
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i
  }
  return -1
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    attributes[localName(match[1]!)] = decodeEntities(match[3] ?? match[4] ?? '')
  }
  return attributes
}

function appendText(node: XmlNode, raw: string): void {
  node.text += decodeEntities(raw)
}

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        if (entity.startsWith('#x')) return safeCodePoint(parseInt(entity.slice(2), 16), whole)
        if (entity.startsWith('#')) return safeCodePoint(parseInt(entity.slice(1), 10), whole)
        return whole
    }
  })
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name)
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : []
}

/** 返回去空白后的文本；元素不存在时返回 undefined（区别于存在但为空）。 */
export function childText(node: XmlNode | undefined, name: string): string | undefined {
  const target = child(node, name)
  return target === undefined ? undefined : target.text.trim()
}
