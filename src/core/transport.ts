import { TransportError } from './errors.ts'
import type { HttpRequest, HttpResponse, HttpStreamResponse, HttpTransport } from './types.ts'

const BASE_OPTIONS: RequestInit = {
  // 后端不返回 Cache-Control；不显式禁用的话，浏览器可能用 Last-Modified 做启发式缓存，
  // 下载与压测就会变成"读浏览器内存"。
  cache: 'no-store',
  // 公网模式下 /s3 与页面同源，必须带上 Blink-web 的会话 Cookie；设为
  // same-origin 不会把凭据发给跨源端点（压测 CLI 在 Node 中也没有 Cookie 罐）。
  credentials: 'same-origin',
  // 代理或后端若返回 3xx，跟随后的路径不再匹配签名；直接失败更诚实。
  redirect: 'error',
  referrerPolicy: 'no-referrer',
}

/** 浏览器与 Node 24 都提供 fetch，因此只有这一套实现。 */
export class FetchTransport implements HttpTransport {
  readonly #baseUrl: string

  constructor(baseUrl: string = '') {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const response = await this.#fetch(req)
    const body = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, headers: response.headers, body }
  }

  async stream(req: HttpRequest): Promise<HttpStreamResponse> {
    const response = await this.#fetch(req)
    if (!response.body) {
      throw new TransportError('响应没有可读流')
    }
    return { status: response.status, headers: response.headers, body: response.body }
  }

  async #fetch(req: HttpRequest): Promise<Response> {
    const init: RequestInit = {
      ...BASE_OPTIONS,
      method: req.method,
      headers: req.headers,
      signal: req.signal ?? null,
    }
    if (req.body !== undefined && req.body !== null) {
      init.body = toBodyInit(req.body)
    }
    try {
      return await fetch(this.#baseUrl + req.url, init)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new TransportError(`请求失败：${describeNetworkError(error)}`, error)
    }
  }
}

/**
 * fetch 的 BodyInit 只接受 ArrayBuffer 背书的视图。常规路径下直接传底层
 * ArrayBuffer（零拷贝）；只有 SharedArrayBuffer 或子视图时才复制。
 */
function toBodyInit(body: Uint8Array | Blob): BodyInit {
  if (body instanceof Blob) return body
  const buffer: ArrayBufferLike = body.buffer
  if (buffer instanceof ArrayBuffer && body.byteOffset === 0 && body.byteLength === buffer.byteLength) {
    return buffer
  }
  return body.slice().buffer
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    // 浏览器的 TypeError 往往只有 "Failed to fetch"，补充可能的原因更利于排查。
    return error.message || error.name
  }
  return String(error)
}
