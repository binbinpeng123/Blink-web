import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { S3Client } from '../../src/core/client.ts'
import { S3Error } from '../../src/core/errors.ts'
import { SigV4Signer } from '../../src/core/signer.ts'
import { FetchTransport } from '../../src/core/transport.ts'
import { createS3Proxy } from '../../server/proxy.ts'
import {
  BLINK_BIN,
  TEST_ACCESS_KEY,
  TEST_REGION,
  TEST_SECRET_KEY,
  blinkAvailable,
  startBlink,
  type BlinkInstance,
} from './harness.ts'

const skip = blinkAvailable ? false : `找不到 Blink 二进制（${BLINK_BIN}）：先在 Blink 仓库 make build，或设置 BLINK_BIN`

describe('真实 Blink 集成：桶与列表', { skip }, () => {
  let blink: BlinkInstance
  let proxy: Server
  let proxyPort = 0

  before(async () => {
    blink = await startBlink()
    const handler = createS3Proxy({ endpoint: blink.endpoint })
    proxy = createServer((req, res) => {
      handler(req, res, () => {
        res.writeHead(404)
        res.end()
      })
    })
    await new Promise<void>((resolveListen) => proxy.listen(0, '127.0.0.1', resolveListen))
    proxyPort = (proxy.address() as AddressInfo).port
  })

  after(async () => {
    proxy?.closeAllConnections()
    if (proxy) await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
    await blink?.stop()
  })

  function client(baseUrl: string, host: string): S3Client {
    return new S3Client({
      transport: new FetchTransport(baseUrl),
      signer: new SigV4Signer({ accessKeyId: TEST_ACCESS_KEY, secretKey: TEST_SECRET_KEY }, TEST_REGION),
      host,
    })
  }

  test('直连：建桶、列出、删桶', async () => {
    const s3 = client(blink.endpoint, `127.0.0.1:${blink.port}`)

    assert.deepEqual(await s3.listBuckets(), [])

    await s3.createBucket('it-direct')
    const buckets = await s3.listBuckets()
    assert.deepEqual(buckets.map((b) => b.name), ['it-direct'])

    const listing = await s3.listObjects({ bucket: 'it-direct', delimiter: '/' })
    assert.deepEqual(listing.objects, [])
    assert.deepEqual(listing.prefixes, [])
    assert.equal(listing.isTruncated, false)

    await s3.deleteBucket('it-direct')
    assert.deepEqual(await s3.listBuckets(), [])
  })

  test('经同源代理：签名 Host 与路径不变式成立', async () => {
    // 浏览器视角：Host 是代理地址，canonical path 不含 /s3
    const s3 = client(`http://127.0.0.1:${proxyPort}/s3`, `127.0.0.1:${proxyPort}`)

    await s3.createBucket('it-proxy')
    const names = (await s3.listBuckets()).map((b) => b.name)
    assert.ok(names.includes('it-proxy'), `列表应包含 it-proxy，实际 ${names.join(',')}`)

    // 带特殊字符的 key 走同一条路径：代理只剥前缀，后端能把签名对上
    const listing = await s3.listObjects({ bucket: 'it-proxy', prefix: '中文 文件/' })
    assert.deepEqual(listing.objects, [])

    await s3.deleteBucket('it-proxy')
  })

  test('错误按 S3 Code 返回：删除不存在的桶是 404', async () => {
    const s3 = client(blink.endpoint, `127.0.0.1:${blink.port}`)
    await assert.rejects(s3.deleteBucket('no-such-bucket'), (error: unknown) => {
      assert.ok(error instanceof S3Error)
      assert.equal(error.code, 'NoSuchBucket')
      assert.equal(error.status, 404)
      assert.equal(error.resource, '/no-such-bucket')
      return true
    })
  })
})
