/**
 * Agent 对话附件（图片/文件）量化限制与元数据契约。
 * 前端上传校验与后端落盘复核共用，保证两端口径一致。
 */

/** 单条消息最多附带图片数 */
export const MAX_AGENT_IMAGE_COUNT = 6
/** 单张图片原始大小上限（压缩前）5MB */
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024
/** 单条消息最多附带文件数 */
export const MAX_AGENT_FILE_COUNT = 3
/** 单个 PDF 文件大小上限 10MB */
export const MAX_AGENT_FILE_BYTES_PDF = 10 * 1024 * 1024
/** 单个非 PDF 文件（含导入专用 ZIP/DOC）大小上限 5MB */
export const MAX_AGENT_FILE_BYTES_DOC = 5 * 1024 * 1024

export const AGENT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** ZIP/DOC 可作为导入原件保存；上传成功不代表解析器已开放或导入获批。 */
export const AGENT_FILE_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'zip', 'doc'] as const
export const AGENT_FILE_ACCEPT = AGENT_FILE_EXTENSIONS.map(extension => `.${extension}`).join(',')

export type AgentAttachmentKind = 'image' | 'file'

/** 附件元数据：上传端点返回、run 请求携带、消息 part 持久化 */
export interface AgentAttachmentMeta {
  id: string
  kind: AgentAttachmentKind
  name: string
  url: string
  size?: number
}

export interface UploadAgentAttachmentRequest {
  kind: AgentAttachmentKind
  name: string
  dataUrl: string
}

export type UploadAgentAttachmentResponse = AgentAttachmentMeta
