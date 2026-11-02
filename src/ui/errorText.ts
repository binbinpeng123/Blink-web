import { isAbortError, isS3Error } from '../core/errors.ts'

/** 界面统一错误文案：S3 错误带 Code/HTTP 状态，网络错误保留原始消息。 */
export function describeError(error: unknown): string {
  if (isAbortError(error)) return '操作已取消'
  if (isS3Error(error)) return error.describe()
  if (error instanceof Error) return error.message
  return String(error)
}
