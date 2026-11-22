import { posix } from 'node:path'
import { DOMParser } from 'linkedom'
import { IMPORT_RESOURCE_LIMITS } from './novel-import/document-types.js'
import { readArchiveEntry, scanArchive, type ArchiveEntry } from './novel-import/parsers/archive.js'
import { DOCUMENT_VISUAL_MAX_EDGE, imageExtension, sanitizeImportImage } from './novel-import/parsers/images.js'
import { runConverter } from './novel-import/parsers/isolated.js'
import { limit, NOVEL_IMPORT_LIMITS, ParseContext } from './novel-import/parsers/limits.js'

type Extension = 'pdf' | 'docx'
export type DocumentVisualInventory = { count: number; unit: 'page' | 'image'; notice?: string }

// A single page per call. The scale caps both axes before PDF.js allocates its canvas.
const pdfSetup = `
  const parser = new library.PDFParse({data: buffer, isEvalSupported: false, useWasm: false,
    maxImageSize: ${IMPORT_RESOURCE_LIMITS.pixels}, canvasMaxAreaInBytes: ${IMPORT_RESOURCE_LIMITS.pixels * 4},
    stopAtErrors: true});
`

async function xmlElements(buffer: Buffer, entry: ArchiveEntry, context: ParseContext) {
  limit(entry.size <= 8 * 1024 * 1024, 'Word 图像索引的 XML 超过 8 MiB。')
  const bytes = await readArchiveEntry(buffer, entry, context)
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8'
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || xml.includes('\0')) throw new Error('Word 图片索引含不支持的 XML。')
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  return Array.from<ReturnType<typeof doc.createElement>>(doc.querySelectorAll('*'))
}

/** Follow only package relationships actually referenced in the body and its headers/footers.
 * This avoids exposing leftover media from deleted illustrations or following linked URLs. */
async function wordPictures(buffer: Buffer, context: ParseContext) {
  const files = new Map(scanArchive(buffer, context).filter(entry => !entry.directory).map(entry => [entry.path, entry]))
  const main = files.get('word/document.xml')
  if (!main || !files.has('[Content_Types].xml')) throw new Error('无效的 Word DOCX 文档。')
  const pictures = new Set<ArchiveEntry>()
  const visited = new Set<string>()
  let skipped = false
  async function visit(part: ArchiveEntry) {
    if (visited.has(part.path)) return
    visited.add(part.path)
    const dir = posix.dirname(part.path)
    const rels = files.get(posix.join(dir, '_rels', posix.basename(part.path) + '.rels'))
    if (!rels) return
    const targets = new Map<string, {type: string; entry?: ArchiveEntry}>()
    for (const el of await xmlElements(buffer, rels, context)) {
      if (el.localName.split(':').pop() !== 'Relationship') continue
      const type = el.getAttribute('Type')?.split('/').pop()
      const id = el.getAttribute('Id')
      if (!id || !type || !['header', 'footer', 'image'].includes(type)) continue
      const target = el.getAttribute('Target') ?? ''
      // Only look up local archive keys. URI-escaped member names are legal in OPC.
      let entry: ArchiveEntry | undefined
      if (el.getAttribute('TargetMode') !== 'External') {
        const local = decodeURIComponent(target)
        entry = files.get(local.startsWith('/') ? local.slice(1) : posix.join(dir, local))
      }
      targets.set(id, { type, entry })
    }
    if (targets.size === 0) return
    for (const el of await xmlElements(buffer, part, context)) {
      const tag = el.localName.split(':').pop()
      const picture = tag === 'blip' || tag === 'imagedata'
      const related = part === main && (tag === 'headerReference' || tag === 'footerReference')
      if (!picture && !related) continue
      const attribute = tag === 'blip' ? 'embed' : 'id'
      const key = Array.from<string>(el.getAttributeNames()).find(name => name.split(':').pop() === attribute)
      const ref = key && targets.get(el.getAttribute(key) ?? '')
      if (picture) {
        if (ref && ref.type === 'image' && ref.entry && imageExtension.test(ref.entry.path)) pictures.add(ref.entry)
        else skipped = true
      } else if (ref && ref.type === (tag === 'headerReference' ? 'header' : 'footer') && ref.entry) {
        await visit(ref.entry)
      }
    }
    context.check()
  }
  await visit(main)
  return { entries: [...pictures], skipped }
}

export async function inspectDocumentVisuals(buffer: Buffer, extension: Extension, signal: AbortSignal): Promise<DocumentVisualInventory> {
  const context = new ParseContext(signal)
  if (extension === 'docx') {
    const { entries, skipped } = await wordPictures(buffer, context)
    return { count: entries.length, unit: 'image', ...(skipped && { notice: '部分链接图片、缺失资源或不支持的图片格式未读取。' }) }
  }
  const count = await runConverter<number>('pdf-parse', pdfSetup + `
    try { return (await parser.getInfo()).total; } finally { await parser.destroy(); }
  `, buffer, context)
  limit(Number.isSafeInteger(count) && count > 0 && count <= NOVEL_IMPORT_LIMITS.pdfPages, 'PDF 页数超过读取范围。')
  return { count, unit: 'page' }
}

export async function readDocumentVisual(buffer: Buffer, extension: Extension, index: number, signal: AbortSignal): Promise<{buffer: Buffer; mime: string}> {
  const context = new ParseContext(signal)
  limit(Number.isSafeInteger(index) && index >= 1, '图片或页码从 1 开始。')
  if (extension === 'docx') {
    const { entries } = await wordPictures(buffer, context)
    const entry = entries[index - 1]
    if (!entry) throw new Error('该 Word 图片编号不存在。')
    const image = await sanitizeImportImage(await readArchiveEntry(buffer, entry, context), entry.path, context, 'visual-preview')
    return { buffer: image.bytes, mime: image.mediaType }
  }
  limit(index <= NOVEL_IMPORT_LIMITS.pdfPages, 'PDF 页码超出范围。')
  const page = await runConverter<string | null>('pdf-parse', pdfSetup + `
    try {
      const index = ${index};
      const info = await parser.getInfo({partial: [index], parsePageInfo: true});
      if (info.total > ${NOVEL_IMPORT_LIMITS.pdfPages}) throw Object.assign(new Error('page limit'), {code:'IMPORT_LIMIT_EXCEEDED'});
      const page = info.pages[0];
      if (!page) return null;
      const scale = Math.min(3, ${DOCUMENT_VISUAL_MAX_EDGE} / Math.max(page.width, page.height));
      if (!Number.isFinite(scale) || Math.min(page.width, page.height) * scale < 1) throw new Error('Invalid page geometry');
      const shot = await parser.getScreenshot({partial:[index], scale, imageBuffer:true, imageDataUrl:false});
      const png = shot.pages[0].data;
      if (!png.length || png.length > ${DOCUMENT_VISUAL_MAX_EDGE * DOCUMENT_VISUAL_MAX_EDGE * 5}) throw Object.assign(new Error('image limit'), {code:'IMPORT_LIMIT_EXCEEDED'});
      return Buffer.from(png).toString('base64');
    } finally { await parser.destroy(); }
  `, buffer, context)
  if (!page) throw new Error('该 PDF 页码不存在。')
  const png = Buffer.from(page, 'base64')
  if (png.length <= IMPORT_RESOURCE_LIMITS.imageBytes) return { buffer: png, mime: 'image/png' }
  const image = await sanitizeImportImage(png, 'PDF 页面', context, 'visual-preview')
  return { buffer: image.bytes, mime: image.mediaType }
}
