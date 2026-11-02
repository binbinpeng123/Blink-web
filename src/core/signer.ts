import { canonicalQuery, toHex } from './encoding.ts'
import { hmacSha256, utf8 } from './crypto.ts'
import type { Credentials, SignableRequest, SignedRequest, Signer } from './types.ts'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'
const TERMINATOR = 'aws4_request'
export const SIGNED_HEADERS = 'host;x-amz-content-sha256;x-amz-date'

/** 2026-10-25T09:10:34.000Z → 20261025T091034Z */
export function formatAmzDate(date: Date): string {
  const iso = date.toISOString()
  return (
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    'T' +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19) +
    'Z'
  )
}

/**
 * 浏览器与 Node 共用的 SigV4 签名器（WebCrypto）。
 *
 * 只签三个头：host、x-amz-content-sha256、x-amz-date。头越少，
 * 代理或运行时改动头值导致签名漂移的机会越小；后端也只校验声明的头。
 */
export class SigV4Signer implements Signer {
  readonly #accessKeyId: string
  readonly #secretKey: string
  readonly #region: string
  readonly #service: string
  /** 派生密钥按日期缓存：每个请求只剩一次 HMAC + 一次请求体摘要。 */
  readonly #keyCache = new Map<string, Promise<Uint8Array>>()

  constructor(credentials: Credentials, region: string, service: string = SERVICE) {
    if (!credentials.accessKeyId || !credentials.secretKey) {
      throw new Error('缺少访问密钥：拒绝创建签名器')
    }
    if (!region) {
      throw new Error('缺少区域：拒绝创建签名器')
    }
    this.#accessKeyId = credentials.accessKeyId
    this.#secretKey = credentials.secretKey
    this.#region = region
    this.#service = service
  }

  async sign(req: SignableRequest): Promise<SignedRequest> {
    const now = req.now ?? new Date()
    const amzDate = formatAmzDate(now)
    const dateStamp = amzDate.slice(0, 8)

    const query = canonicalQuery(req.query)
    const canonicalHeaders =
      `host:${req.host}\n` +
      `x-amz-content-sha256:${req.payloadHash}\n` +
      `x-amz-date:${amzDate}\n`

    const canonicalRequest = [
      req.method.toUpperCase(),
      req.path,
      query,
      canonicalHeaders,
      SIGNED_HEADERS,
      req.payloadHash,
    ].join('\n')

    const scope = `${dateStamp}/${this.#region}/${this.#service}/${TERMINATOR}`
    const stringToSign = [
      ALGORITHM,
      amzDate,
      scope,
      toHex(await this.#sha256(canonicalRequest)),
    ].join('\n')

    const signingKey = await this.#signingKey(dateStamp)
    const signature = toHex(await hmacSha256(signingKey, stringToSign))

    const headers: Record<string, string> = {
      ...(req.headers ?? {}),
      'x-amz-content-sha256': req.payloadHash,
      'x-amz-date': amzDate,
      authorization:
        `${ALGORITHM} Credential=${this.#accessKeyId}/${scope}, ` +
        `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    }

    return {
      url: query ? `${req.path}?${query}` : req.path,
      headers,
    }
  }

  async #sha256(value: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(value) as BufferSource))
  }

  async #signingKey(dateStamp: string): Promise<Uint8Array> {
    const cached = this.#keyCache.get(dateStamp)
    if (cached) return cached

    const derived = (async (): Promise<Uint8Array> => {
      const kDate = await hmacSha256(utf8(`AWS4${this.#secretKey}`), dateStamp)
      const kRegion = await hmacSha256(kDate, this.#region)
      const kService = await hmacSha256(kRegion, this.#service)
      return hmacSha256(kService, TERMINATOR)
    })()

    this.#keyCache.set(dateStamp, derived)
    // 只保留最近两天，避免长时间运行时无限增长。
    if (this.#keyCache.size > 2) {
      const oldest = this.#keyCache.keys().next().value
      if (oldest !== undefined && oldest !== dateStamp) this.#keyCache.delete(oldest)
    }
    return derived
  }
}
