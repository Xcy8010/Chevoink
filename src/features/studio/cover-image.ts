import {
  FIXED_NOVEL_COVER_HEIGHT,
  FIXED_NOVEL_COVER_WIDTH,
  MAX_MANUAL_NOVEL_COVER_BYTES,
} from '../../../shared/contracts/index.js'

const SUPPORTED_COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const COVER_PREVIEW_WIDTH = 240
export const COVER_PREVIEW_HEIGHT = 320

export type NovelCoverCropState = {
  zoom: number
  offsetX: number
  offsetY: number
}

export function validateNovelCoverFile(file: File) {
  if (!SUPPORTED_COVER_TYPES.includes(file.type)) {
    throw new Error('作品封面仅支持 PNG、JPG 或 WebP 图片。')
  }

  if (file.size > MAX_MANUAL_NOVEL_COVER_BYTES) {
    throw new Error(`作品封面图片不能超过 ${MAX_MANUAL_NOVEL_COVER_BYTES / (1024 * 1024)} MiB。`)
  }
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取封面文件失败。'))
    reader.readAsDataURL(file)
  })
}

export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('读取封面图片失败。'))
    image.src = dataUrl
  })
}

function getImageMetrics(image: HTMLImageElement, frameWidth: number, frameHeight: number, zoom: number) {
  const scale = Math.max(frameWidth / image.width, frameHeight / image.height) * zoom
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale

  return {
    drawWidth,
    drawHeight,
    maxOffsetX: Math.max(0, (drawWidth - frameWidth) / 2),
    maxOffsetY: Math.max(0, (drawHeight - frameHeight) / 2),
  }
}

export function clampNovelCoverCropState(
  image: HTMLImageElement,
  crop: NovelCoverCropState,
  frameWidth = COVER_PREVIEW_WIDTH,
  frameHeight = COVER_PREVIEW_HEIGHT,
): NovelCoverCropState {
  const zoom = Math.min(3, Math.max(1, crop.zoom))
  const metrics = getImageMetrics(image, frameWidth, frameHeight, zoom)

  return {
    zoom,
    offsetX: Math.min(metrics.maxOffsetX, Math.max(-metrics.maxOffsetX, crop.offsetX)),
    offsetY: Math.min(metrics.maxOffsetY, Math.max(-metrics.maxOffsetY, crop.offsetY)),
  }
}

export function getNovelCoverPreviewMetrics(image: HTMLImageElement, crop: NovelCoverCropState) {
  const normalized = clampNovelCoverCropState(image, crop)
  const metrics = getImageMetrics(image, COVER_PREVIEW_WIDTH, COVER_PREVIEW_HEIGHT, normalized.zoom)

  return {
    ...normalized,
    drawWidth: metrics.drawWidth,
    drawHeight: metrics.drawHeight,
    drawX: (COVER_PREVIEW_WIDTH - metrics.drawWidth) / 2 + normalized.offsetX,
    drawY: (COVER_PREVIEW_HEIGHT - metrics.drawHeight) / 2 + normalized.offsetY,
    maxOffsetX: metrics.maxOffsetX,
    maxOffsetY: metrics.maxOffsetY,
  }
}

export async function createNovelCoverCropSource(file: File): Promise<{
  image: HTMLImageElement
  dataUrl: string
}> {
  validateNovelCoverFile(file)

  const dataUrl = await readFileAsDataUrl(file)
  const image = await loadImage(dataUrl)

  return { image, dataUrl }
}

export async function buildFixedNovelCoverDataUrl(
  file: File,
  crop: NovelCoverCropState = { zoom: 1, offsetX: 0, offsetY: 0 },
): Promise<string> {
  const { image } = await createNovelCoverCropSource(file)
  const normalized = clampNovelCoverCropState(image, crop)
  const canvas = document.createElement('canvas')
  canvas.width = FIXED_NOVEL_COVER_WIDTH
  canvas.height = FIXED_NOVEL_COVER_HEIGHT

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('封面画布初始化失败。')
  }

  const metrics = getImageMetrics(image, FIXED_NOVEL_COVER_WIDTH, FIXED_NOVEL_COVER_HEIGHT, normalized.zoom)
  const offsetScaleX = FIXED_NOVEL_COVER_WIDTH / COVER_PREVIEW_WIDTH
  const offsetScaleY = FIXED_NOVEL_COVER_HEIGHT / COVER_PREVIEW_HEIGHT
  const drawX = (FIXED_NOVEL_COVER_WIDTH - metrics.drawWidth) / 2 + normalized.offsetX * offsetScaleX
  const drawY = (FIXED_NOVEL_COVER_HEIGHT - metrics.drawHeight) / 2 + normalized.offsetY * offsetScaleY

  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, drawX, drawY, metrics.drawWidth, metrics.drawHeight)

  return canvas.toDataURL('image/jpeg', 0.85)
}

export async function downloadCoverAssetImage(imageUrl: string, filename: string) {
  try {
    const response = await fetch(imageUrl)
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(objectUrl)
  } catch {
    window.open(imageUrl, '_blank', 'noopener,noreferrer')
  }
}
