import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBlinkServer, type ServerOptions } from '../../server/server.ts'

/**
 * 公网模式（令牌登录）的服务器级测试：未登录拦截、登录/登出、Cookie 签名、
 * 过期、Secure/HSTS、next 重定向白名单、会话 Cookie 不透传给后端。
 */

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef'
const HOUR_MS = 3_600_000

interface Fixture {
  url: string
  seen: IncomingHttpHeaders[]
  close(): Promise<void>
}

async function fixture(options: Partial<ServerOptions> = {}): Promise<Fixture> {
  const dist = await mkdtemp(join(tmpdir(), 'blink-auth-'))
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>blink-app</title>')
  await writeFile(join(dist, 'app.js'), 'globalThis.__blink = 1')

  const seen: IncomingHttpHeaders[] = []
  const upstream = createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end('<ok/>')
  })
  await new Promise<void>((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen))
  const upstreamPort = (upstream.address() as AddressInfo).port

  const app = createBlinkServer({
    endpoint: `http://127.0.0.1:${upstreamPort}`,
    host: '127.0.0.1',
    port: 0,
    dist,
    token: TOKEN,
    log: () => {},
    ...options,
  })
  const { url } = await app.listen()

  return {
    url,
    seen,
    async close() {
      app.server.closeAllConnections()
      await app.close()
      upstream.closeAllConnections()
      await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()))
      await rm(dist, { recursive: true, force: true })
    },
  }
}

function postLogin(
  url: string,
  token = TOKEN,
  extra: { headers?: Record<string, string>; next?: string } = {},
): Promise<Response> {
  const body = new URLSearchParams({ token })
  if (extra.next) body.set('next', extra.next)
  return fetch(`${url}/__login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
      ...extra.headers,
    },
    body,
  })
}

function sessionCookie(response: Response): string {
  const [cookie] = response.headers.getSetCookie()
  assert.ok(cookie, '响应必须下发会话 Cookie')
  return cookie.split(';')[0]!
}

test('非回环监听且没有令牌时拒绝启动', () => {
  assert.throws(
    () => createBlinkServer({ host: '0.0.0.0', port: 0, token: '', dist: '/nonexistent' }),
    /BLINK_WEB_TOKEN/,
  )
  assert.throws(
    () => createBlinkServer({ host: '10.0.0.1', port: 0, token: '', dist: '/nonexistent' }),
    /BLINK_WEB_TOKEN/,
  )
})

test('令牌短于 32 字符时拒绝启动', () => {
  assert.throws(
    () => createBlinkServer({ host: '127.0.0.1', port: 0, token: 'too-short', dist: '/nonexistent' }),
    /32 个字符/,
  )
})

test('未登录：页面导航跳登录页，静态资源与 /s3 返回 401 且不触达后端', async () => {
  const f = await fixture()
  try {
    const nav = await fetch(`${f.url}/`, { redirect: 'manual', headers: { accept: 'text/html' } })
    assert.equal(nav.status, 303)
    assert.equal(nav.headers.get('location'), '/__login?next=%2F')

    const nested = await fetch(`${f.url}/objects?prefix=a%2Fb`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    })
    assert.equal(nested.status, 303)
    assert.equal(nested.headers.get('location'), '/__login?next=%2Fobjects%3Fprefix%3Da%252Fb')

    const asset = await fetch(`${f.url}/app.js`, { redirect: 'manual', headers: { accept: '*/*' } })
    assert.equal(asset.status, 401)

    const s3 = await fetch(`${f.url}/s3/bucket?list-type=2`, {
      redirect: 'manual',
      headers: { accept: 'application/xml' },
    })
    assert.equal(s3.status, 401)

    const head = await fetch(`${f.url}/`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { accept: 'text/html' },
    })
    assert.equal(head.status, 303)

    assert.equal(f.seen.length, 0, '未登录请求不得到达后端')
  } finally {
    await f.close()
  }
})

test('/__authz 匿名可读，只暴露是否需要登录', async () => {
  const f = await fixture()
  try {
    const res = await fetch(`${f.url}/__authz`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { required: true })
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally {
    await f.close()
  }
})

test('未配置令牌时保持回环免鉴权，/__authz 报告 false', async () => {
  const f = await fixture({ token: '' })
  try {
    const authz = await fetch(`${f.url}/__authz`)
    assert.deepEqual(await authz.json(), { required: false })

    const page = await fetch(`${f.url}/`, { headers: { accept: 'text/html' } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /blink-app/)
  } finally {
    await f.close()
  }
})

test('登录页可匿名访问，不回显令牌，也不允许外部 next', async () => {
  const f = await fixture()
  try {
    const res = await fetch(`${f.url}/__login?next=//evil.example/steal`, { redirect: 'manual' })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.ok(body.includes('<form'), '应返回登录表单')
    assert.equal(body.includes(TOKEN), false, '登录页不得包含令牌')
    assert.equal(body.includes('evil.example'), false, '外部 next 必须被丢弃')
    assert.match(body, /action="\/__login"/)
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    assert.equal(res.headers.get('cache-control'), 'no-store')

    const logout = await fetch(`${f.url}/__logout`, { redirect: 'manual' })
    assert.equal(logout.status, 405)
  } finally {
    await f.close()
  }
})

test('错误令牌回到登录页且不下发 Cookie', async () => {
  const f = await fixture()
  try {
    const res = await postLogin(f.url, 'wrong-token-0123456789abcdef0123456789')
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), '/__login?error=1')
    assert.deepEqual(res.headers.getSetCookie(), [])

    const page = await fetch(`${f.url}/__login?error=1`)
    assert.match(await page.text(), /令牌不正确/)
  } finally {
    await f.close()
  }
})

test('正确令牌签发 HttpOnly 会话，静态资源与 /s3 放行；Cookie 不透传给后端', async () => {
  const f = await fixture()
  try {
    const res = await postLogin(f.url, TOKEN, { headers: { 'x-forwarded-proto': 'https' } })
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), '/')
    const attributes = res.headers.getSetCookie()[0]!
    assert.match(attributes, /^blink_web_session=\d+\.\d+\.[A-Za-z0-9_-]+;/)
    assert.match(attributes, /; HttpOnly/)
    assert.match(attributes, /; SameSite=Lax/)
    assert.match(attributes, /; Path=\//)
    assert.match(attributes, /; Max-Age=86400/)
    assert.match(attributes, /; Secure/)
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000')

    const cookie = sessionCookie(res)
    const page = await fetch(`${f.url}/`, {
      redirect: 'manual',
      headers: { cookie, accept: 'text/html' },
    })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /blink-app/)

    const asset = await fetch(`${f.url}/app.js`, { headers: { cookie } })
    assert.equal(asset.status, 200)

    const s3 = await fetch(`${f.url}/s3/bucket?list-type=2`, {
      headers: { cookie, accept: 'application/xml' },
    })
    assert.equal(s3.status, 200)
    const upstreamHeaders = f.seen.at(-1)
    assert.ok(upstreamHeaders, '请求应转发到后端')
    assert.equal(upstreamHeaders.cookie, undefined, '会话 Cookie 不得透传给后端')
    assert.equal(upstreamHeaders.host, new URL(f.url).host, '代理必须保留原始 Host')
  } finally {
    await f.close()
  }
})

test('明文直连时 Cookie 不带 Secure，也不下发 HSTS', async () => {
  const f = await fixture()
  try {
    const res = await postLogin(f.url)
    const attributes = res.headers.getSetCookie()[0]!
    assert.equal(attributes.includes('; Secure'), false)
    assert.equal(res.headers.get('strict-transport-security'), null)
  } finally {
    await f.close()
  }
})

test('被篡改的 Cookie 视为未登录', async () => {
  const f = await fixture()
  try {
    const res = await postLogin(f.url)
    const cookie = sessionCookie(res)
    const prefix = 'blink_web_session='
    const [issued, expires, signature] = cookie.slice(prefix.length).split('.')
    const altered = (signature![0] === 'A' ? 'B' : 'A') + signature!.slice(1)
    const tampered = `${prefix}${issued}.${expires}.${altered}`

    const page = await fetch(`${f.url}/`, {
      redirect: 'manual',
      headers: { cookie: tampered, accept: 'text/html' },
    })
    assert.equal(page.status, 303)
    assert.equal(page.headers.get('location'), '/__login?next=%2F')
  } finally {
    await f.close()
  }
})

test('会话在配置的有效期后失效', async () => {
  let clock = Date.UTC(2026, 9, 26, 0, 0, 0)
  const f = await fixture({ now: () => clock })
  try {
    const res = await postLogin(f.url)
    const cookie = sessionCookie(res)
    const before = await fetch(`${f.url}/`, {
      redirect: 'manual',
      headers: { cookie, accept: 'text/html' },
    })
    assert.equal(before.status, 200)

    clock += 24 * HOUR_MS - 1
    const stillValid = await fetch(`${f.url}/`, {
      redirect: 'manual',
      headers: { cookie, accept: 'text/html' },
    })
    assert.equal(stillValid.status, 200)

    clock += 1
    const expired = await fetch(`${f.url}/`, {
      redirect: 'manual',
      headers: { cookie, accept: 'text/html' },
    })
    assert.equal(expired.status, 303)
    assert.equal(expired.headers.get('location'), '/__login?next=%2F')
  } finally {
    await f.close()
  }
})

test('登录后的 next 只允许站内相对路径', async () => {
  const f = await fixture()
  try {
    const external = await postLogin(f.url, TOKEN, { next: '//evil.example/x' })
    assert.equal(external.headers.get('location'), '/')

    const absolute = await postLogin(f.url, TOKEN, { next: 'https://evil.example/x' })
    assert.equal(absolute.headers.get('location'), '/')

    const internal = await postLogin(f.url, TOKEN, { next: '/objects?prefix=a%2Fb' })
    assert.equal(internal.headers.get('location'), '/objects?prefix=a%2Fb')
  } finally {
    await f.close()
  }
})

test('登出清除 Cookie 并回到登录页', async () => {
  const f = await fixture()
  try {
    const res = await postLogin(f.url)
    const cookie = sessionCookie(res)
    const logout = await fetch(`${f.url}/__logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie },
    })
    assert.equal(logout.status, 303)
    assert.equal(logout.headers.get('location'), '/__login')
    const cleared = logout.headers.getSetCookie()[0]!
    assert.match(cleared, /^blink_web_session=;/)
    assert.match(cleared, /Max-Age=0/)
  } finally {
    await f.close()
  }
})
