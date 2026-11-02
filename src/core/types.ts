/** 凭据只保存在内存中；secret 从不写入任何存储。 */
export interface Credentials {
  accessKeyId: string
  secretKey: string
}

/**
 * 查询参数。value 为 null 表示裸参数（如 `?uploads`）。
 * 序列化时会补成 `uploads=`，与后端规范化规则一致。
 */
export interface QueryParam {
  key: string
  value: string | null
}

/** 待签名请求。path 与 query 都是**已经编码好**的最终形态，签名与发送共用它们。 */
export interface SignableRequest {
  method: string
  /** 以 `/` 开头、已按段编码的路径，例如 `/bucket/a%20b/c.bin` */
  path: string
  query: readonly QueryParam[]
  /** 签名用的 Host（浏览器里是 location.host，Node 里是后端 host:port） */
  host: string
  /** 请求体的 SHA-256 十六进制摘要；空体用 SHA256_OF_EMPTY */
  payloadHash: string
  /** 仅测试注入；默认取当前时间 */
  now?: Date
  /** 不参与签名但需要发送的头（如 content-type、if-match） */
  headers?: Record<string, string>
}

export interface SignedRequest {
  /** path + canonical query，可直接交给 Transport 拼接 baseUrl */
  url: string
  /** 不含 host —— 浏览器禁止脚本设置 Host，必须由运行时自动生成 */
  headers: Record<string, string>
}

export interface Signer {
  sign(req: SignableRequest): Promise<SignedRequest>
}

export type RequestBody = Uint8Array | Blob | null

export interface HttpRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: RequestBody
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  headers: Headers
  body: Uint8Array
}

export interface HttpStreamResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array>
}

/** 传输层是唯一为"边端分布式路由"预留的扩展点。 */
export interface HttpTransport {
  send(req: HttpRequest): Promise<HttpResponse>
  stream(req: HttpRequest): Promise<HttpStreamResponse>
}
