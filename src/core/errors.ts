import { childText, parseXml } from './xml.ts'

/** S3 返回的结构化错误；code 取自 XML，HEAD 等无体响应按状态码映射。 */
export class S3Error extends Error {
  readonly code: string
  readonly status: number
  readonly requestId: string | undefined
  readonly resource: string | undefined

  constructor(
    code: string,
    message: string,
    status: number,
    requestId?: string,
    resource?: string,
  ) {
    super(message || code)
    this.name = 'S3Error'
    this.code = code
    this.status = status
    this.requestId = requestId
    this.resource = resource
  }

  /** 给界面展示的一行文本，不包含签名等敏感信息。 */
  describe(): string {
    const id = this.requestId ? ` (request_id=${this.requestId})` : ''
    return `${this.code} [HTTP ${this.status}] ${this.message}${id}`
  }
}

export function isS3Error(error: unknown): error is S3Error {
  return error instanceof S3Error
}

export function errorFromResponse(
  status: number,
  requestId: string | null,
  body: Uint8Array,
): S3Error {
  if (body.length > 0) {
    try {
      const root = parseXml(new TextDecoder().decode(body))
      if (root.name === 'Error') {
        return new S3Error(
          childText(root, 'Code') || statusCodeName(status),
          childText(root, 'Message') ?? '',
          status,
          childText(root, 'RequestId') ?? requestId ?? undefined,
          childText(root, 'Resource') ?? undefined,
        )
      }
    } catch {
      // 响应体不是 XML：退回状态码，绝不把原始体当成消息（可能含敏感信息）。
    }
  }
  return new S3Error(statusCodeName(status), `HTTP ${status}`, status, requestId ?? undefined)
}

/** HEAD 无响应体，只能按状态码近似映射。 */
export function statusCodeName(status: number): string {
  switch (status) {
    case 301:
      return 'PermanentRedirect'
    case 400:
      return 'BadRequest'
    case 403:
      return 'AccessDenied'
    case 404:
      return 'NotFound'
    case 405:
      return 'MethodNotAllowed'
    case 409:
      return 'Conflict'
    case 411:
      return 'MissingContentLength'
    case 412:
      return 'PreconditionFailed'
    case 416:
      return 'InvalidRange'
    case 501:
      return 'NotImplemented'
    case 503:
      return 'SlowDown'
    default:
      return status >= 500 ? 'InternalError' : 'UnknownError'
  }
}

/** 网络层失败（连接被拒、DNS、超时、被中止）与 S3 业务错误区分开。 */
export class TransportError extends Error {
  override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'TransportError'
    this.cause = cause
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

/** 统一的取消错误：所有层（传输、重试、信号量、用例）抛出同一种形态。 */
export function abortError(message = '操作已取消'): Error {
  return new DOMException(message, 'AbortError')
}
