import {
  AGENT_FILE_EXTENSIONS,
  AGENT_IMAGE_MIME_TYPES,
  MAX_AGENT_FILE_BYTES_DOC,
  MAX_AGENT_FILE_BYTES_PDF,
  MAX_AGENT_IMAGE_BYTES,
} from '../../../../shared/contracts/agent-attachments.js'

/**
 * Agent 附件前端预处理：限额与后端复核同源（shared/contracts/agent-attachments）。
 * 图片 canvas 压缩（长边 ≤1600px、目标 400KB、硬顶 1.5MB）；文件仅校验类型/大小后原样 base64。
 */

const MAX_EDGE_PX = 1600
/** 目标体积：超过则阶梯重编码，控制视觉请求与上传体积 */
const TARGET_OUTPUT_IMAGE_BYTES = 400 * 1024
const MAX_OUTPUT_IMAGE_BYTES = 1.5 * 1024 * 1024

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取文件失败，请重试。'))
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('读取图片内容失败。'))
    image.src = dataUrl
  })
}

/** 估算 data URL 对应的二进制字节数 */
function estimateDataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return Math.floor((base64.length * 3) / 4)
}

/** 校验并压缩一张参考图，返回 base64 data URL（服务端还会再转 WebP） */
export async function prepareAgentImage(file: File): Promise<string> {
  if (!(AGENT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    throw new Error('参考图仅支持 PNG、JPG 或 WebP 图片。')
  }

  if (file.size > MAX_AGENT_IMAGE_BYTES) {
    throw new Error('每张参考图不能超过 5MB。')
  }

  const sourceDataUrl = await readFileAsDataUrl(file)
  const image = await loadImage(sourceDataUrl)
  const longEdge = Math.max(image.naturalWidth, image.naturalHeight)

  // 尺寸和体积都在目标内时直接用原图，保留原始格式
  if (longEdge <= MAX_EDGE_PX && estimateDataUrlBytes(sourceDataUrl) <= TARGET_OUTPUT_IMAGE_BYTES) {
    return sourceDataUrl
  }

  const scale = Math.min(1, MAX_EDGE_PX / longEdge)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('当前浏览器不支持图片压缩。')
  }

  // JPEG 不支持透明通道，先铺白底避免透明区域变黑
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  let fallback = ''
  for (const quality of [0.82, 0.7, 0.58]) {
    const output = canvas.toDataURL('image/jpeg', quality)
    if (estimateDataUrlBytes(output) <= TARGET_OUTPUT_IMAGE_BYTES) {
      return output
    }
    fallback = output
  }

  // 降到最低档仍超目标体积时，只要不超硬上限就接受
  if (fallback && estimateDataUrlBytes(fallback) <= MAX_OUTPUT_IMAGE_BYTES) {
    return fallback
  }

  throw new Error('这张图片压缩后仍然过大，请换一张再试。')
}

/** 校验一个待上传文件：通过返回 null，否则返回中文错误提示 */
export function validateAgentFile(file: File): string | null {
  const extension = (file.name.split('.').pop() ?? '').toLowerCase()

  if (!(AGENT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    return '文件仅支持 pdf、docx、txt、md、zip、doc 格式；ZIP/DOC 需通过作品导入核验。'
  }

  if (!file.size) return '文件不能为空。'

  const maxBytes = extension === 'pdf' ? MAX_AGENT_FILE_BYTES_PDF : MAX_AGENT_FILE_BYTES_DOC

  if (file.size > maxBytes) {
    return extension === 'pdf' ? '单个 PDF 不能超过 10MB。' : '单个文件不能超过 5MB。'
  }

  return null
}
