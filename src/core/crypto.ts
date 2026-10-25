import { toBase64, toHex } from './encoding.ts'

const EMPTY = new Uint8Array(0)
const encoder = new TextEncoder()

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return new Uint8Array(digest)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes))
}

export async function sha256Base64(bytes: Uint8Array): Promise<string> {
  return toBase64(await sha256(bytes))
}

/** 空体哈希；每个请求都要带 `x-amz-content-sha256`，缺了后端会 400。 */
export const SHA256_OF_EMPTY = toHex(
  new Uint8Array([
    0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9,
    0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52,
    0xb8, 0x55,
  ]),
)

export async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message))
  return new Uint8Array(signature)
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function emptyBytes(): Uint8Array {
  return EMPTY
}
