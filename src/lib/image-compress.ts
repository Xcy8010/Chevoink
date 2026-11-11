/**
 * 上传图片的前端 canvas 压缩工具。
 * 头像入口专属：先 trim 掉透明/近似纯色边距（治理「圆形头像 + 透明边距」导致的灰圈显小问题），
 * 再铺白底压平透明通道，缩放到 512px 以内导出 JPEG——从此不存在透明像素。
 */

import { PROFILE_IMAGE_MAX_BYTES, PROFILE_IMAGE_MAX_MB } from '../../shared/contracts/api.js'

const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** 头像输出的最大边长：展示最大不过 96px，512 已冗余 */
const AVATAR_MAX_EDGE_PX = 512
const AVATAR_JPEG_QUALITY = 0.85
/** trim 边距扫描时的降采样上限，避免超大图逐像素扫描卡顿 */
const TRIM_SCAN_MAX_EDGE_PX = 1024
/** 判定为「边距」的像素：透明度低于该值 */
const TRIM_ALPHA_THRESHOLD = 24
/** 判定为「边距」的像素：与四角基准色的通道差之和低于该值 */
const TRIM_COLOR_TOLERANCE = 48
/** 裁切后内容面积低于原图该比例时放弃 trim（防误裁纯色背景证件照），只做 flatten */
const TRIM_MIN_AREA_RATIO = 0.4

export function getProfileImageUploadError(file: File, label: '头像' | '封面'): string | null {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    return `${label}仅支持 PNG、JPG 或 WebP 图片。`
  }

  if (file.size > PROFILE_IMAGE_MAX_BYTES) {
    return `${label}图片不能超过 ${PROFILE_IMAGE_MAX_MB}MB。`
  }

  return null
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取图片文件失败。'))
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

type ContentBox = { left: number; top: number; width: number; height: number }

/**
 * 扫描四边透明/近似纯色像素，返回实际内容的包围盒（原图坐标系）。
 * 四角颜色不一致（说明没有统一边距）或裁切过狠时返回 null，调用方跳过 trim。
 */
function detectContentBox(image: HTMLImageElement): ContentBox | null {
  const scale = Math.min(1, TRIM_SCAN_MAX_EDGE_PX / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return null
  }

  context.drawImage(image, 0, 0, width, height)

  let data: Uint8ClampedArray
  try {
    data = context.getImageData(0, 0, width, height).data
  } catch {
    // 极端场景（如画布污染）读不出像素时直接放弃 trim
    return null
  }

  const pixelAt = (x: number, y: number) => {
    const offset = (y * width + x) * 4
    return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]] as const
  }

  // 以四角像素均值为「边距基准色」；四角彼此差异过大说明没有统一边距，不 trim
  const corners = [pixelAt(0, 0), pixelAt(width - 1, 0), pixelAt(0, height - 1), pixelAt(width - 1, height - 1)]
  const opaqueCorners = corners.filter((corner) => corner[3] > TRIM_ALPHA_THRESHOLD)
  const hasTransparentCorner = opaqueCorners.length < corners.length

  let baseR = 0
  let baseG = 0
  let baseB = 0
  if (opaqueCorners.length > 0) {
    for (const corner of opaqueCorners) {
      baseR += corner[0]
      baseG += corner[1]
      baseB += corner[2]
    }
    baseR /= opaqueCorners.length
    baseG /= opaqueCorners.length
    baseB /= opaqueCorners.length

    const cornersAgree = opaqueCorners.every(
      (corner) =>
        Math.abs(corner[0] - baseR) + Math.abs(corner[1] - baseG) + Math.abs(corner[2] - baseB) <=
        TRIM_COLOR_TOLERANCE,
    )
    if (!cornersAgree) {
      // 不透明四角颜色不统一：仅当存在透明角时按「透明边距」继续，否则放弃
      if (!hasTransparentCorner) {
        return null
      }
    }
  }

  const isMarginPixel = (x: number, y: number) => {
    const [r, g, b, a] = pixelAt(x, y)
    if (a <= TRIM_ALPHA_THRESHOLD) {
      return true
    }
    if (opaqueCorners.length === 0) {
      return false
    }
    return Math.abs(r - baseR) + Math.abs(g - baseG) + Math.abs(b - baseB) <= TRIM_COLOR_TOLERANCE
  }

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isMarginPixel(x, y)) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  // 全图都是边距色（纯色图）或没裁出任何边距时不处理
  if (maxX < 0 || (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1)) {
    return null
  }

  const boxWidth = maxX - minX + 1
  const boxHeight = maxY - minY + 1
  if ((boxWidth * boxHeight) / (width * height) < TRIM_MIN_AREA_RATIO) {
    // 裁切过狠，可能是纯色背景的正常照片，放弃 trim
    return null
  }

  // 映射回原图坐标
  return {
    left: Math.max(0, Math.floor(minX / scale)),
    top: Math.max(0, Math.floor(minY / scale)),
    width: Math.min(image.naturalWidth, Math.ceil(boxWidth / scale)),
    height: Math.min(image.naturalHeight, Math.ceil(boxHeight / scale)),
  }
}

/**
 * 头像上传前预处理：trim 透明/纯色边距 → 铺白底压平透明 → 缩放到 512px 内 → JPEG 0.85。
 * 上传体积从原图 MB 级降到几十 KB，且不再产生「灰圈头像」。
 */
export async function prepareAvatarImage(file: File): Promise<string> {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('头像仅支持 PNG、JPG 或 WebP 图片。')
  }

  const sourceDataUrl = await readFileAsDataUrl(file)
  const image = await loadImage(sourceDataUrl)

  const box = detectContentBox(image) ?? {
    left: 0,
    top: 0,
    width: image.naturalWidth,
    height: image.naturalHeight,
  }

  const scale = Math.min(1, AVATAR_MAX_EDGE_PX / Math.max(box.width, box.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(box.width * scale))
  canvas.height = Math.max(1, Math.round(box.height * scale))

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('当前浏览器不支持图片压缩。')
  }

  // JPEG 无透明通道，先铺白底再绘制（flatten）
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, box.left, box.top, box.width, box.height, 0, 0, canvas.width, canvas.height)

  return canvas.toDataURL('image/jpeg', AVATAR_JPEG_QUALITY)
}
