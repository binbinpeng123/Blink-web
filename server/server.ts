import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertTokenStrength, createSessionAuth, isLoopbackHost } from './auth.ts'
import { createS3Proxy } from './proxy.ts'

/**
 * 生产服务器：托管 dist 静态文件 + 同源 /s3 代理。
 * 零依赖；默认只监听 127.0.0.1。非回环监听必须配置 BLINK_WEB_TOKEN，
 * 此时所有静态资源与 /s3 都要经过会话 Cookie 鉴权（见 auth.ts）。
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = join(ROOT, 'dist')

const SECURITY_HEADERS: Record<string, string> = {
  // 无内联脚本/样式：Vite 产物全部是外部文件
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

export interface ServerOptions {
  endpoint?: string
  host?: string
  port?: number
  dist?: string
  insecureTls?: boolean
  /** 公网访问令牌；配置后启用登录页与会话 Cookie */
  token?: string
  /** 会话有效期，默认 24 小时 */
  sessionHours?: number
  /** 仅测试注入的时钟，默认 Date.now */
  now?: () => number
  log?: (line: string) => void
}

export function createBlinkServer(options: ServerOptions = {}) {
  const endpoint = options.endpoint ?? process.env['BLINK_ENDPOINT'] ?? 'http://127.0.0.1:9000'
  const dist = resolve(options.dist ?? DIST)
  const log = options.log ?? console.log
  const insecureTls = options.insecureTls ?? process.env['BLINK_TLS_INSECURE'] === '1'
  const host = options.host ?? process.env['HOST'] ?? '127.0.0.1'
  const port = options.port ?? Number(process.env['PORT'] ?? 8080)
  const sessionHours = options.sessionHours ?? numberFromEnv('BLINK_WEB_SESSION_HOURS', 24)
  const token = options.token ?? process.env['BLINK_WEB_TOKEN'] ?? ''

  if (token) {
    assertTokenStrength(token)
  } else if (!isLoopbackHost(host)) {
    // 非回环监听却没有令牌 = 任何人都能以代理身份访问 Blink（含凭据签名接口）。
    throw new Error(
      `监听 ${host} 时必须设置 BLINK_WEB_TOKEN（至少 32 字符，可用 openssl rand -base64 32 生成）；` +
        '只有回环地址允许无鉴权运行。',
    )
  }

  const auth = token
    ? createSessionAuth({
        token,
        sessionHours,
        now: options.now,
        log: (line) => log(`[auth] ${line}`),
      })
    : undefined

  const proxy = createS3Proxy({ endpoint, insecureTls, log })

  const server = createServer((req, res) => {
    // 前端用它判断是否显示「退出登录」；不泄露任何配置内容。
    if (isAuthzPath(req)) {
      respondAuthz(req, res, Boolean(auth))
      return
    }
    if (auth) {
      // Cloudflare / TLS 反向代理已终止 TLS 时，浏览器到边缘这一段必须强制 HTTPS。
      // 回环明文调试不会带这个头，因此不会把 127.0.0.1 钉死到 HTTPS。
      if (auth.isSecure(req)) {
        res.setHeader('strict-transport-security', 'max-age=31536000')
      }
      if (auth.handle(req, res)) return
    }
    if (isProxyPath(req)) {
      proxy(req, res, () => notFound(res))
      return
    }
    serveStatic(req, res, dist).catch(() => {
      if (!res.headersSent) notFound(res)
    })
  })

  // 上传/下载可能持续数分钟，Node 默认 300s 的 requestTimeout 会误杀。
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  return {
    server,
    host,
    port,
    listen(): Promise<{ url: string; port: number }> {
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, host, () => {
          server.off('error', rejectListen)
          const address = server.address()
          const actualPort = typeof address === 'object' && address ? address.port : port
          resolveListen({ url: `http://${host}:${actualPort}`, port: actualPort })
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      })
    },
  }
}

function isProxyPath(req: IncomingMessage): boolean {
  const url = req.url ?? ''
  return url === '/s3' || url.startsWith('/s3/') || url.startsWith('/s3?')
}

function isAuthzPath(req: IncomingMessage): boolean {
  const url = req.url ?? ''
  return url === '/__authz' || url.startsWith('/__authz?')
}

function respondAuthz(req: IncomingMessage, res: ServerResponse, required: boolean): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
    res.end()
    return
  }
  const body = JSON.stringify({ required })
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正数，实际：${raw}`)
  }
  return value
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, dist: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }

  const url = req.url ?? '/'
  const question = url.indexOf('?')
  const rawPath = question < 0 ? url : url.slice(0, question)

  let pathname: string
  try {
    pathname = decodeURIComponent(rawPath)
  } catch {
    notFound(res)
    return
  }
  if (pathname.includes('\0')) {
    notFound(res)
    return
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = resolve(dist, relative)
  // 目录穿越防护：解析后必须仍在 dist 内（含分隔符，避免 dist-evil 前缀绕过）
  if (filePath !== dist && !filePath.startsWith(dist + sep)) {
    notFound(res)
    return
  }

  const info = await stat(filePath).catch(() => null)
  if (!info || !info.isFile()) {
    // SPA 回退：无扩展名的路径交给前端路由
    if (pathname === '/' || extname(pathname) === '') {
      await sendFile(req, res, join(dist, 'index.html'), true)
      return
    }
    notFound(res)
    return
  }
  await sendFile(req, res, filePath, false)
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  noStore: boolean,
): Promise<void> {
  const info = await stat(filePath).catch(() => null)
  if (!info || !info.isFile()) {
    notFound(res)
    return
  }

  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(info.size),
    // 带哈希的构建产物可以长缓存；index.html 必须每次校验
    'cache-control': noStore ? 'no-store' : 'public, max-age=31536000, immutable',
    'last-modified': info.mtime.toUTCString(),
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res)
}

function notFound(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
  res.end('404 Not Found')
}

// 直接执行时启动；被测试 import 时不自动监听
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createBlinkServer()
  app
    .listen()
    .then(({ url }) => {
      const mode = process.env['BLINK_WEB_TOKEN'] ? '令牌登录' : '回环免鉴权'
      console.log(
        `Blink-web 已启动：${url}（${mode}；代理目标 ${process.env['BLINK_ENDPOINT'] ?? 'http://127.0.0.1:9000'}）`,
      )
    })
    .catch((error: unknown) => {
      console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0))
    })
  }
}
