import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 公网模式的访问门禁。
 *
 * 代理本身不鉴权，任何能访问它的人都能以代理身份访问 Blink；因此只要服务
 * 不是只监听回环地址，就必须启用这里的令牌登录：
 *
 * 1. 浏览器先 POST 访问令牌，服务端签发 HttpOnly 会话 Cookie；
 * 2. 之后所有静态资源与 `/s3` 请求都必须带有效 Cookie；
 * 3. Cookie 是 HMAC 签名的时间戳，令牌本身既不下发也不写入任何存储；
 * 4. 令牌比较与签名校验都用常量时间，避免时序侧信道。
 *
 * 不用 HTTP Basic：S3 请求自己的 `Authorization` 头是 SigV4 签名，会被
 * Basic 凭据覆盖，二者不能共用同一个头。
 */

export const SESSION_COOKIE = 'blink_web_session'
export const LOGIN_PATH = '/__login'
export const LOGOUT_PATH = '/__logout'

const MIN_TOKEN_LENGTH = 32
const MAX_LOGIN_BODY = 2048
const DEFAULT_SESSION_HOURS = 24
const MAX_NEXT_LENGTH = 512

export interface SessionAuthOptions {
  /** 至少 32 个字符的高熵随机串；只来自环境变量或调用方，不落盘。 */
  token: string
  sessionHours?: number
  /** 仅测试注入，默认 Date.now */
  now?: () => number
  log?: (line: string) => void
}

export interface SessionAuth {
  /**
   * 返回 true 表示请求已被处理（登录、登出、重定向或拒绝）；
   * 返回 false 表示已登录，可以继续走静态文件 / 代理。
   */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** 供测试与守卫使用的会话判断。 */
  isAuthenticated(req: IncomingMessage): boolean
  /** 通过 `x-forwarded-proto` / TLS socket 判断请求是否已经是 HTTPS。 */
  isSecure(req: IncomingMessage): boolean
}

export function assertTokenStrength(token: string): void {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`BLINK_WEB_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符（建议 openssl rand -base64 32）`)
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]'
}

export function createSessionAuth(options: SessionAuthOptions): SessionAuth {
  assertTokenStrength(options.token)
  const now = options.now ?? Date.now
  const sessionMs = Math.max(60, (options.sessionHours ?? DEFAULT_SESSION_HOURS) * 3_600_000)
  // 从令牌派生签名密钥：换令牌即让所有旧 Cookie 失效。
  const key = createHmac('sha256', options.token).update('blink-web-session-v1').digest()
  const tokenDigest = createHash('sha256').update(options.token).digest()
  const log = options.log ?? (() => {})

  function sign(payload: string): string {
    return createHmac('sha256', key).update(payload).digest('base64url')
  }

  function issueCookie(): string {
    const issued = now()
    const payload = `${issued}.${issued + sessionMs}`
    return `${payload}.${sign(payload)}`
  }

  function isAuthenticated(req: IncomingMessage): boolean {
    const value = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (!value) return false
    const parts = value.split('.')
    if (parts.length !== 3) return false
    const [issued, expires, signature] = parts as [string, string, string]
    if (!/^\d{1,16}$/.test(issued) || !/^\d{1,16}$/.test(expires)) return false
    if (Number(expires) <= now()) return false
    const expected = sign(`${issued}.${expires}`)
    return safeEqual(signature, expected)
  }

  function isSecure(req: IncomingMessage): boolean {
    // IncomingMessage 的 socket 类型是 net.Socket；TLS 连接才有 encrypted 标志。
    if ((req.socket as { encrypted?: boolean }).encrypted === true) return true
    const forwarded = req.headers['x-forwarded-proto']
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
    return value?.split(',')[0]?.trim().toLowerCase() === 'https'
  }

  function setSessionCookie(req: IncomingMessage, res: ServerResponse): void {
    const attributes = [
      `${SESSION_COOKIE}=${issueCookie()}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(sessionMs / 1000)}`,
    ]
    // 公网必须经 HTTPS（Cloudflare / TLS 反向代理）才能拿到 Secure Cookie；
    // 本机明文 HTTP 调试时不下发 Secure，否则浏览器拒绝保存。
    if (isSecure(req)) attributes.push('Secure')
    res.setHeader('set-cookie', attributes.join('; '))
  }

  function clearSessionCookie(req: IncomingMessage, res: ServerResponse): void {
    const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
    if (isSecure(req)) attributes.push('Secure')
    res.setHeader('set-cookie', attributes.join('; '))
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? '/'
    const query = url.indexOf('?')
    const pathname = query < 0 ? url : url.slice(0, query)
    const search = query < 0 ? '' : url.slice(query)

    if (pathname === LOGIN_PATH) {
      handleLogin(req, res, search)
      return true
    }
    if (pathname === LOGOUT_PATH) {
      if (req.method !== 'POST') {
        plain(res, 405, '仅支持 POST')
        return true
      }
      clearSessionCookie(req, res)
      redirect(res, LOGIN_PATH)
      return true
    }

    if (isAuthenticated(req)) return false

    // 页面导航给登录页；API / 资源请求直接 401，避免把 HTML 当成 JS/XML 解析。
    const acceptsHtml = String(req.headers.accept ?? '').includes('text/html')
    if ((req.method === 'GET' || req.method === 'HEAD') && acceptsHtml) {
      redirect(res, `${LOGIN_PATH}?next=${encodeURIComponent(pathname + search)}`)
    } else {
      plain(res, 401, '未登录或会话已过期，请刷新页面重新登录')
    }
    return true
  }

  function handleLogin(req: IncomingMessage, res: ServerResponse, search: string): void {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const failed = new URLSearchParams(search).get('error') === '1'
      sendLoginPage(req, res, failed ? '令牌不正确，请重试' : null, nextFrom(search))
      return
    }
    if (req.method !== 'POST') {
      plain(res, 405, '仅支持 GET / POST')
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_LOGIN_BODY) {
        rejected = true
        plain(res, 413, '请求体过大')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => {
      if (!res.headersSent) plain(res, 400, '读取请求失败')
    })
    req.on('end', () => {
      if (rejected || res.headersSent) return
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const supplied = form.get('token') ?? ''
      if (!safeEqual(createHash('sha256').update(supplied).digest(), tokenDigest)) {
        const next = nextFrom(search, form.get('next'))
        const location = `${LOGIN_PATH}?error=1${next ? `&next=${encodeURIComponent(next)}` : ''}`
        log(`登录失败（${req.socket.remoteAddress ?? 'unknown'}）`)
        redirect(res, location, 303)
        return
      }
      setSessionCookie(req, res)
      log(`登录成功（${req.socket.remoteAddress ?? 'unknown'}）`)
      redirect(res, safeNext(form.get('next')) ?? '/', 303)
    })
  }

  function nextFrom(search: string, formValue?: string | null): string | undefined {
    const fromQuery = new URLSearchParams(search).get('next')
    return safeNext(formValue) ?? safeNext(fromQuery)
  }

  function sendLoginPage(
    req: IncomingMessage,
    res: ServerResponse,
    error: string | null,
    next: string | undefined,
  ): void {
    const action = next ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH
    const body = loginHtml(action, error, req.method === 'HEAD')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; " +
        "base-uri 'none'; frame-ancestors 'none'",
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  return { handle, isAuthenticated, isSecure }
}

function loginHtml(action: string, error: string | null, headOnly: boolean): string {
  void headOnly
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blink-web · 访问验证</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0;
  }
  main {
    width: min(92vw, 380px); background: #1e293b; border: 1px solid #334155;
    border-radius: 12px; padding: 28px 24px; box-shadow: 0 20px 50px #0006;
  }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 18px; color: #94a3b8; font-size: 13px; }
  label { display: block; font-size: 13px; margin-bottom: 8px; color: #cbd5e1; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569;
    background: #0f172a; color: #e2e8f0; font: inherit;
  }
  input:focus { outline: 2px solid #38bdf8; outline-offset: 1px; }
  button {
    width: 100%; margin-top: 16px; padding: 10px 12px; border: 0; border-radius: 8px;
    background: #0284c7; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #0369a1; }
  .error { color: #fca5a5; font-size: 13px; margin-top: 14px; }
</style>
</head>
<body>
<main>
  <h1>Blink-web</h1>
  <p>该测试台未公开注册。请输入部署时配置的访问令牌。</p>
  <form method="post" action="${escapeHtml(action)}">
    <label for="token">访问令牌</label>
    <input id="token" name="token" type="password" required autofocus
      autocomplete="current-password" spellcheck="false">
    <button type="submit">进入</button>
    ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
  </form>
</main>
</body>
</html>
`
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim()
  }
  return undefined
}

function safeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const a = typeof left === 'string' ? Buffer.from(left) : left
  const b = typeof right === 'string' ? Buffer.from(right) : right
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 只接受站内相对路径，避免登录后被重定向到外部站点。 */
function safeNext(value: string | null | undefined): string | undefined {
  if (!value || value.length > MAX_NEXT_LENGTH) return undefined
  if (!value.startsWith('/') || value.startsWith('//')) return undefined
  if (value.includes('\\') || value.includes('\0')) return undefined
  return value
}

function redirect(res: ServerResponse, location: string, status = 303): void {
  res.writeHead(status, {
    location,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end()
}

function plain(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
