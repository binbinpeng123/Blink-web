import assert from 'node:assert/strict'
import { test } from 'node:test'
import { awsEncode, canonicalQuery, encodeKey, toBase64, toHex } from '../../src/core/encoding.ts'
import { SHA256_OF_EMPTY } from '../../src/core/crypto.ts'
import { SigV4Signer, formatAmzDate } from '../../src/core/signer.ts'

// 向量来自后端 Blink 仓库 internal/sigv4/vectors_test.go，源头是 aws-cli 2.36.2 的真实抓包。
// 如果这里失败，说明前端签名与 aws-cli 不一致，而不是向量有问题。
const AK = 'AKIATESTTEST1234'
const SK = 'test-secret-key-not-a-real-credential'

test('formatAmzDate', () => {
  assert.equal(formatAmzDate(new Date('2026-10-23T09:10:34Z')), '20261023T091034Z')
})

test('头部签名与 aws-cli 向量逐字节一致', async () => {
  const signer = new SigV4Signer({ accessKeyId: AK, secretKey: SK }, 'us-east-1')
  const signed = await signer.sign({
    method: 'GET',
    path: '/b',
    query: [{ key: 'uploads', value: null }],
    host: '127.0.0.1:19000',
    payloadHash: SHA256_OF_EMPTY,
    now: new Date('2026-10-23T09:10:34Z'),
  })

  // 裸参数在线上与签名里都补成 `uploads=`，后端两种写法都接受。
  assert.equal(signed.url, '/b?uploads=')
  assert.equal(signed.headers['x-amz-date'], '20261023T091034Z')
  assert.equal(signed.headers['x-amz-content-sha256'], SHA256_OF_EMPTY)
  assert.equal(
    signed.headers['authorization'],
    'AWS4-HMAC-SHA256 Credential=AKIATESTTEST1234/20261023/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
      'Signature=e60999e11a21971c2248da7b708e0e279d6eff4577a86eef55ccf429ce436877',
  )
  // Host 由运行时生成，绝不能出现在可发送头里（浏览器会忽略，Node 会覆盖）。
  assert.equal('host' in signed.headers, false)
})

test('空体哈希常量正确', () => {
  assert.equal(SHA256_OF_EMPTY, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('awsEncode 按 RFC 3986 转义 !\'()*', () => {
  assert.equal(awsEncode("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af')
  assert.equal(awsEncode('weird name+plus.txt'), 'weird%20name%2Bplus.txt')
  assert.equal(awsEncode('中文'), '%E4%B8%AD%E6%96%87')
})

test('encodeKey 保留斜杠、逐段编码', () => {
  assert.equal(encodeKey('a/b c/d+e.txt'), 'a/b%20c/d%2Be.txt')
  assert.equal(encodeKey('dir/'), 'dir/')
})

test('canonicalQuery 排序与裸参数规范化', () => {
  assert.equal(canonicalQuery([{ key: 'uploads', value: null }]), 'uploads=')
  assert.equal(
    canonicalQuery([
      { key: 'prefix', value: 'b' },
      { key: 'max-keys', value: '10' },
      { key: 'list-type', value: '2' },
    ]),
    'list-type=2&max-keys=10&prefix=b',
  )
  assert.equal(
    canonicalQuery([
      { key: 'b', value: '2' },
      { key: 'B', value: '1' },
    ]),
    'B=1&b=2',
  )
})

test('toBase64 / toHex', () => {
  assert.equal(toHex(new Uint8Array([0, 15, 255])), '000fff')
  assert.equal(toBase64(new TextEncoder().encode('hello')), 'aGVsbG8=')
  assert.equal(toBase64(new Uint8Array([0])), 'AA==')
  assert.equal(toBase64(new Uint8Array([0, 0])), 'AAA=')
  assert.equal(toBase64(new Uint8Array([])), '')
})

test('region 参与派生：换区域签名必变', async () => {
  const base = {
    method: 'GET' as const,
    path: '/b',
    query: [],
    host: '127.0.0.1:19000',
    payloadHash: SHA256_OF_EMPTY,
    now: new Date('2026-10-23T09:10:34Z'),
  }
  const a = await new SigV4Signer({ accessKeyId: AK, secretKey: SK }, 'us-east-1').sign(base)
  const b = await new SigV4Signer({ accessKeyId: AK, secretKey: SK }, 'us-west-2').sign(base)
  assert.notEqual(a.headers['authorization'], b.headers['authorization'])
})
