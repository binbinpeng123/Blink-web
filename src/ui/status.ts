/** 底部状态行的语义：info 中性、success 完成、error 失败。 */
export type StatusKind = 'info' | 'success' | 'error'

export type StatusSink = (message: string, kind?: StatusKind) => void
