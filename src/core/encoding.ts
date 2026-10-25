import type { QueryParam } from './types.ts'

const HEX = '0123456789abcdef'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * RFC 3986 严格编码。`encodeURIComponent` 不转义 !'()*，而 SigV4 要求转义。
 */
export function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase()
  })
}

/**
 * 编码对象 key：按 `/` 分段编码，分隔符本身保持为 `/`。
 * 这样 `%2F` 不会出现在路径里（Go 侧会把它解码成 `/`，导致 key 与签名不一致）。
 */
export function encodeKey(key: string): string {
  return key.split('/').map(awsEncode).join('/')
}

export function encodeBucket(bucket: string): string {
  return awsEncode(bucket)
}

/**
 * 生成 canonical query，并**原样作为线上 query 发送**。
 * 两处使用同一个字符串，就不存在"签名一份、发送另一份"的漂移。
 */
export function canonicalQuery(params: readonly QueryParam[]): string {
  return params
    .map((p): [string, string] => [awsEncode(p.key), p.value === null ? '' : awsEncode(p.value)])
    .sort((a, b) => {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
      if (a[1] === b[1]) return 0
      return a[1] < b[1] ? -1 : 1
    })
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!
  return out
}

/** 手写 base64：不依赖 btoa / Buffer，浏览器与 Node 行为一致。 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64[b0 >> 2]!
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!
    out += b1 === undefined ? '=' : B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!
    out += b2 === undefined ? '=' : B64[b2 & 0x3f]!
  }
  return out
}

export function decodeKeyText(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
