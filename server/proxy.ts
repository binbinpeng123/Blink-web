import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

/**
 * 同源代理：把 `/s3/<path>` 原样转发到固定后端。
 *
 * 不变式：
 * 1. 只做字符串前缀剥离，不解析、不解码、不规范化路径 —— 浏览器签名的
 *    canonical URI 与后端看到的路径必须逐字节一致。
 * 2. 保留原始 Host 头 —— 后端用 r.Host 参与签名校验，改 Host 就会 403。
 * 3. 目标地址只来自服务端配置，客户端无法指定 —— 不是开放代理。
 */

export interface ProxyOptions {
  /** 后端地址，只允许 http(s)://host[:port]，不允许携带路径与查询 */
  endpoint: string
  /** 浏览器侧前缀，默认 /s3 */
  prefix?: string
  /** 仅用于自签证书的本地后端；默认 false */
  insecureTls?: boolean
  log?: (line: string) => void
}

/** Connect 风格中间件（Vite 与自建服务器共用） */
export type ConnectNext = (error?: unknown) => void
export type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: ConnectNext,
) => void

interface Target {
  hostname: string
  port: string
  secure: boolean
}

// 逐跳头与由本代理重新生成的表示性头，都不能透传。
const DROPPED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  // 会话 Cookie 只属于 Blink-web，不透传给后端，也禁止后端设置 Cookie
  'cookie',
  'set-cookie',
])

export function createS3Proxy(options: ProxyOptions): ConnectMiddleware {
  const target = parseEndpoint(options.endpoint)
  const prefix = normalizePrefix(options.prefix ?? '/s3')
  const send = target.secure ? httpsRequest : httpRequest
  const log = options.log ?? (() => {})

  return function s3Proxy(req, res, next) {
    const url = req.url ?? ''
    if (url !== prefix && !url.startsWith(`${prefix}/`)) {
      next()
      return
    }

    const startedAt = process.hrtime.bigint()
    const targetPath = url.slice(prefix.length)
    const problem = targetPathProblem(targetPath)
    if (problem) {
      respondText(res, 400, problem)
      return
    }
    if (!req.headers.host) {
      // 没有 Host 就无法复现浏览器签名里的 host 头
      respondText(res, 400, '缺少 Host 头')
      return
    }

    const headers: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (DROPPED_HEADERS.has(lower) || lower === 'host') continue
      headers[name] = value
    }
    headers['host'] = req.headers.host

    const upstream = send(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: targetPath,
        headers,
        // 自签证书只用于本机后端，且必须显式开启
        ...(target.secure ? { rejectUnauthorized: !options.insecureTls } : {}),
      },
      (upstreamRes) => {
        res.statusCode = upstreamRes.statusCode ?? 502
        res.statusMessage = upstreamRes.statusMessage ?? ''
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue
          if (DROPPED_HEADERS.has(name.toLowerCase())) continue
          res.setHeader(name, value)
        }
        upstreamRes.on('error', () => res.destroy())
        upstreamRes.pipe(res)
        res.on('finish', () => {
          const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
          log(`${req.method} ${url} -> ${res.statusCode} ${ms.toFixed(1)}ms`)
        })
      },
    )

    upstream.on('error', (error) => {
      log(`${req.method} ${url} -> 502 ${error.message}`)
      if (!res.headersSent) {
        respondText(res, 502, '无法连接后端（BLINK_ENDPOINT）')
      } else {
        res.destroy()
      }
    })

    // 浏览器取消（AbortSignal）时立刻停止向上游写，避免白传大文件。
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })

    req.pipe(upstream)
  }
}

function parseEndpoint(endpoint: string): Target {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`BLINK_ENDPOINT 不是合法 URL：${endpoint}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`BLINK_ENDPOINT 只支持 http/https：${endpoint}`)
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('BLINK_ENDPOINT 不能包含路径、查询或片段（代理只做端口级转发）')
  }
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    secure: url.protocol === 'https:',
  }
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '')
  if (!trimmed.startsWith('/')) throw new Error(`代理前缀必须以 / 开头：${prefix}`)
  return trimmed
}

/**
 * 拒绝代理层不应出现的路径形态。合法对象 key 的空段/点段在客户端已拒绝，
 * 这里再挡一次，避免把会触发 ServeMux 307 的请求带到后端。
 */
export function targetPathProblem(path: string): string | null {
  if (!path.startsWith('/')) return '代理前缀后必须以 / 开头'
  if (path.includes('\0')) return '路径不能包含空字符'
  const pathname = path.split('?')[0] ?? ''
  // 根路径（ListBuckets）与末尾斜杠（目录占位对象 / 前缀）都是合法形态
  if (pathname === '/') return null
  const segments = pathname.slice(1).split('/')
  if (segments.at(-1) === '') segments.pop()
  for (const raw of segments) {
    let segment = raw
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return '路径包含非法的百分号编码'
    }
    if (segment === '' || segment === '.' || segment === '..') {
      return '路径不能包含空段或 . / .. 段'
    }
  }
  return null
}

function respondText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(body)
}
