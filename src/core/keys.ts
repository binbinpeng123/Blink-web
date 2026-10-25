/**
 * 对象 key 的可用性检查。
 *
 * 后端用 Go 的 ServeMux 分发，实测对 `//`、`/./`、`/../` 返回 301/307；
 * 而浏览器在发起 fetch 之前就会按 URL 规范折叠 `%2E%2E`。也就是说这类 key
 * 在 Blink 上签名必然对不上，必须在客户端提前拒绝，而不是等 403 再猜。
 */
export function objectKeyProblem(key: string): string | null {
  if (key.length === 0) return 'key 不能为空'
  if (key.startsWith('/')) return 'key 不能以 / 开头'
  if (key.includes('\u0000')) return 'key 不能包含空字符'
  const segments = key.split('/')
  for (const segment of segments) {
    if (segment === '') return 'key 不能包含连续的 /（会产生空路径段，后端会 301）'
    if (segment === '.' || segment === '..') {
      return 'key 不能包含 . 或 .. 路径段（URL 规范会折叠，导致签名不匹配）'
    }
  }
  return null
}

export function assertObjectKey(key: string): void {
  const problem = objectKeyProblem(key)
  if (problem) throw new Error(problem)
}

export function bucketProblem(bucket: string): string | null {
  if (bucket.length < 3 || bucket.length > 63) return '桶名长度必须为 3–63'
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    return '桶名只能包含小写字母、数字、点和连字符，且以字母或数字开头结尾'
  }
  return null
}
