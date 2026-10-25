import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createS3Proxy, targetPathProblem } from '../../server/proxy.ts'

interface Recorded {
  method: string | undefined
  url: string | undefined
  host: string | undefined
  body: Buffer
}

const recorded: Recorded[] = []
let upstream: Server
let upstreamPort = 0
let proxy: Server
let proxyPort = 0

before(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      recorded.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        body: Buffer.concat(chunks),
      })
      res.writeHead(201, { 'x-upstream': 'yes', 'content-type': 'text/plain' })
      res.end(`echo:${req.url ?? ''}`)
    })
  })
  upstreamPort = await listen(upstream)

  const handler = createS3Proxy({ endpoint: `http://127.0.0.1:${upstreamPort}` })
  proxy = createServer((req, res) => {
    handler(req, res, () => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('next')
    })
  })
  proxyPort = await listen(proxy)
})

after(async () => {
  proxy.closeAllConnections()
  upstream.closeAllConnections()
  await Promise.all([close(proxy), close(upstream)])
})

test('剥离前缀但保留原始路径字节与 Host', async () => {
  recorded.length = 0
  const res = await send(proxyPort, '/s3/photos/a%20b%2Bc.txt?uploads=&partNumber=1', {
    headers: { host: 'localhost:5173' },
  })

  assert.equal(res.status, 201)
  assert.equal(res.headers['x-upstream'], 'yes')
  assert.equal(res.body.toString(), 'echo:/photos/a%20b%2Bc.txt?uploads=&partNumber=1')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.url, '/photos/a%20b%2Bc.txt?uploads=&partNumber=1')
  // 后端用 r.Host 参与签名：改了就没法通过校验
  assert.equal(recorded[0]!.host, 'localhost:5173')
})

test('请求体流式转发，不被缓冲截断', async () => {
  recorded.length = 0
  const body = Buffer.alloc(1024 * 1024, 7)
  const res = await send(proxyPort, '/s3/photos/big.bin', { method: 'PUT', body })

  assert.equal(res.status, 201)
  assert.equal(recorded[0]!.method, 'PUT')
  assert.equal(recorded[0]!.body.length, body.length)
  assert.equal(recorded[0]!.body.compare(body), 0)
})

test('ListBuckets 的 /s3/ 转发为 /', async () => {
  recorded.length = 0
  await send(proxyPort, '/s3/')
  assert.equal(recorded[0]!.url, '/')
})

test('非 /s3 路径交给下一个中间件', async () => {
  const res = await send(proxyPort, '/index.html')
  assert.equal(res.status, 404)
  assert.equal(res.body.toString(), 'next')
})

test('拒绝 /s3 之后缺少斜杠、空段与点段', async () => {
  recorded.length = 0
  for (const path of ['/s3', '/s3/b//k', '/s3/b/./k', '/s3/b/../k', '/s3/b/%2E%2E/k', '/s3/b/%ZZ']) {
    const res = await send(proxyPort, path)
    assert.equal(res.status, 400, path)
  }
  assert.equal(recorded.length, 0, '非法路径不应到达后端')
})

test('后端不可达时返回 502 而不是挂起', async () => {
  const deadUpstream = createServer()
  const deadPort = await listen(deadUpstream)
  await close(deadUpstream)

  const handler = createS3Proxy({ endpoint: `http://127.0.0.1:${deadPort}` })
  const server = createServer((req, res) => {
    handler(req, res, () => {
      res.writeHead(404)
      res.end()
    })
  })
  const port = await listen(server)
  try {
    const res = await send(port, '/s3/photos/x')
    assert.equal(res.status, 502)
  } finally {
    server.closeAllConnections()
    await close(server)
  }
})

test('targetPathProblem 允许结尾斜杠与根路径', () => {
  assert.equal(targetPathProblem('/'), null)
  assert.equal(targetPathProblem('/bucket/dir/'), null)
  assert.equal(targetPathProblem('/bucket/a%20b'), null)
  assert.notEqual(targetPathProblem('/bucket//a'), null)
  assert.notEqual(targetPathProblem('/bucket/%2e%2e/a'), null)
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

interface SimpleResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[name] = value
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) })
        })
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}
