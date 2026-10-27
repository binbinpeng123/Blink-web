import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'

/**
 * 登录失败的滑动窗口限速与客户端地址解析。
 *
 * 令牌是单一共享口令，一旦被暴力猜测就完全失守；因此失败次数必须受限：
 * 窗口内失败达到阈值后，该来源被暂停一段时间，连续触发则指数加倍。
 * 限速按「来源」隔离，来源的判定见 resolveClientAddress。
 */

const DEFAULT_MAX_FAILURES = 5
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_BLOCK_MS = 30_000
// 暂停上限刻意压到 5 分钟：共享口令下，任何人都能用错误令牌把合法用户挡在门外，
// 上限越短，这种「顺手锁人」的成本越低。
const MAX_BLOCK_MS = 300_000
const DEFAULT_MAX_KEYS = 10_000

/** 被暂停时建议客户端等待的毫秒数；0 表示可以尝试。 */
export interface LoginThrottle {
  retryAfterMs(key: string): number
  recordFailure(key: string): void
  recordSuccess(key: string): void
  /** 仅供测试：当前跟踪的来源数量。 */
  readonly size: number
}

export interface LoginThrottleOptions {
  /** 窗口内失败达到该次数即暂停，默认 5（即第 5 次错误令牌直接得到 429） */
  maxFailures?: number
  /** 滑动窗口长度，默认 60 秒 */
  windowMs?: number
  /** 首次暂停时长，默认 30 秒；连续触发每次翻倍 */
  blockMs?: number
  /** 暂停时长上限，默认 5 分钟 */
  maxBlockMs?: number
  /** 最多跟踪的来源数，默认 10000；超出时淘汰最久未活动的来源 */
  maxKeys?: number
  now?: () => number
  log?: (line: string) => void
}

interface Entry {
  /** 窗口内的失败时间戳（毫秒） */
  failures: number[]
  /** 暂停截止时间；0 表示未暂停 */
  blockedUntil: number
  /** 连续触发暂停的次数，用于指数加倍 */
  strikes: number
  lastSeen: number
}

export function createLoginThrottle(options: LoginThrottleOptions = {}): LoginThrottle {
  const maxFailures = Math.max(1, options.maxFailures ?? DEFAULT_MAX_FAILURES)
  const windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_WINDOW_MS)
  const blockMs = Math.max(1_000, options.blockMs ?? DEFAULT_BLOCK_MS)
  const maxBlockMs = Math.max(blockMs, options.maxBlockMs ?? MAX_BLOCK_MS)
  const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS)
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const entries = new Map<string, Entry>()

  function blockDuration(strikes: number): number {
    // 2^n 增长，指数上限取 30 防止溢出
    return Math.min(blockMs * 2 ** Math.min(strikes, 30), maxBlockMs)
  }

  /** 长时间空闲的来源整条丢弃，避免长期占用内存。 */
  function isExpired(entry: Entry, at: number): boolean {
    const idleSince = Math.max(entry.blockedUntil, entry.lastSeen)
    return at - idleSince > maxBlockMs + windowMs
  }

  function prune(at: number): void {
    if (entries.size <= maxKeys) {
      // 常规情况下顺手清掉过期来源（单次巡检最多 32 条，避免大表上做全量扫描）
      let checked = 0
      for (const [key, entry] of entries) {
        if (checked++ >= 32) break
        if (isExpired(entry, at)) entries.delete(key)
      }
      return
    }
    // 超出上限：淘汰最久未活动的来源，直到回到上限
    const ordered = [...entries.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    for (const [key] of ordered.slice(0, entries.size - maxKeys)) entries.delete(key)
  }

  return {
    get size() {
      return entries.size
    },

    retryAfterMs(key: string): number {
      const entry = entries.get(key)
      if (!entry) return 0
      const remaining = entry.blockedUntil - now()
      return remaining > 0 ? remaining : 0
    },

    recordFailure(key: string): void {
      const at = now()
      const entry = entries.get(key) ?? { failures: [], blockedUntil: 0, strikes: 0, lastSeen: at }
      entry.lastSeen = at
      entry.failures = entry.failures.filter((time) => at - time < windowMs)
      entry.failures.push(at)

      if (entry.failures.length >= maxFailures) {
        const duration = blockDuration(entry.strikes)
        entry.blockedUntil = at + duration
        entry.strikes += 1
        entry.failures = []
        // 暂停只在产生时记录一次，避免被限速的客户端刷爆日志
        log(`登录失败次数超限（${key}）：暂停 ${Math.round(duration / 1000)} 秒`)
      }

      entries.set(key, entry)
      prune(at)
    },

    recordSuccess(key: string): void {
      entries.delete(key)
    },
  }
}

/**
 * 解析来源地址（用于限速与日志）。
 *
 * 默认只信任 TCP 对端地址。经 Cloudflare 隧道或反向代理部署时，对端永远是
 * 127.0.0.1，所有访问者会挤在同一个限速桶里；这时需要显式设置
 * BLINK_TRUST_PROXY=1，才会读取 CF-Connecting-IP / X-Forwarded-For。
 *
 * 仅当对端是回环地址时才相信代理头：服务直接监听公网时，任何客户端都能伪造
 * 这些头来绕过限速。
 */
export function resolveClientAddress(
  req: IncomingMessage,
  options: { trustProxy?: boolean } = {},
): string {
  const peer = normalizeAddress(req.socket.remoteAddress) ?? 'unknown'
  if (!options.trustProxy || !isLoopbackAddress(peer)) return peer

  const cf = headerValue(req.headers['cf-connecting-ip'])
  if (cf) {
    const address = normalizeAddress(cf)
    if (address && isIP(address) !== 0) return address
  }

  const forwarded = headerValue(req.headers['x-forwarded-for'])
  if (forwarded) {
    // 标准反向代理会把真实对端追加在末尾；最左侧可被客户端伪造。
    const parts = forwarded.split(',')
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const address = normalizeAddress(parts[index])
      if (address && isIP(address) !== 0) return address
    }
  }
  return peer
}

export function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 去掉 IPv4 映射前缀，便于日志阅读；无法识别时返回 undefined。 */
function normalizeAddress(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed)
  return mapped ? mapped[1] : trimmed || undefined
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}
