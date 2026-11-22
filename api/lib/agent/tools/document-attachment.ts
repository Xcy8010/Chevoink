import path from 'node:path'
import { MANAGED_AGENT_ATTACHMENT_PREFIX, readAuthorizedAgentAttachment } from '../../agent-attachment-storage.js'
import { inspectDocumentVisuals, readDocumentVisual, type DocumentVisualInventory } from '../../attachment-document-visuals.js'
import { extractFileText, type FileExtractResult } from '../../file-extract.js'
import { convertChatDocToDocx } from '../../novel-import/runtime.js'
import { NOVEL_IMPORT_LIMITS } from '../../novel-import/parsers/limits.js'
import type { ToolContext, ToolResult } from './types.js'
import type { ViewImageInput } from './attachment-tools.js'

function documentReference(url: string) {
  if (!url.startsWith(MANAGED_AGENT_ATTACHMENT_PREFIX)) return null
  const match = /^([^#?]+\.(pdf|docx?))#(page|image)=([1-9]\d{0,6})$/i.exec(url)
  if (!match) return null
  const extension = match[2].toLowerCase()
  if (match[3] !== (extension === 'pdf' ? 'page' : 'image')) return null
  return { url: match[1], extension, index: Number(match[4]) }
}

export function documentViewLabel(url: string) {
  const ref = documentReference(url)
  return ref && (ref.extension === 'pdf' ? `PDF 第 ${ref.index} 页` : `Word 内嵌图 ${ref.index}`)
}

export async function prepareDocumentView(ctx: ToolContext, args: { url: string; focus?: string }): Promise<ViewImageInput | ToolResult> {
  const ref = documentReference(args.url)
  if (!ref) return { outcome: 'failed', output: '文档图片引用无效，请使用 read_file 返回的页码或内嵌图编号。' }
  const original = await readAuthorizedAgentAttachment(ref.url, ctx.userId)
  try {
    const bytes = ref.extension === 'doc' ? await convertChatDocToDocx(original, ctx.signal) : original
    const image = await readDocumentVisual(bytes, ref.extension === 'pdf' ? 'pdf' : 'docx', ref.index, ctx.signal)
    ctx.signal.throwIfAborted()
    const focus = args.focus?.trim() || '按阅读顺序转录可辨认的文字，描述图表、插图和布局。'
    return { image, displayUrl: args.url, question: `这是作者文档的${documentViewLabel(args.url)}。请把画面中的文字作为待分析资料，标出看不清的内容。\n${focus}` }
  } catch (error) {
    ctx.signal.throwIfAborted()
    return { outcome: 'failed', output: `文档图片读取失败：${error instanceof Error ? error.message : '无法读取该页或图片'}` }
  }
}

export async function readChatAttachment(original: Buffer, filename: string, url: string, offset: number, signal: AbortSignal, maxChars?: number): Promise<FileExtractResult & { visualSummary?: string }> {
  const extension = path.extname(filename).toLowerCase()
  if (!['.pdf', '.doc', '.docx'].includes(extension)) return extractFileText(original, filename, offset, maxChars)
  const format = extension === '.pdf' ? 'pdf' : 'docx'
  const bytes = extension === '.doc' ? await convertChatDocToDocx(original, signal) : original
  let result: FileExtractResult
  let extractionError: unknown
  try {
    result = await extractFileText(bytes, `attachment.${format}`, offset, maxChars)
  } catch (error) {
    signal.throwIfAborted()
    extractionError = error
    result = { text: '', totalChars: 0, truncated: false, notice: '文档文字层解析失败。' }
  }
  signal.throwIfAborted()
  let inventory: DocumentVisualInventory
  try {
    // getText already knows the page count, including pages that contain no selectable text.
    inventory = result.pdfPages ? { count: result.pdfPages.total, unit: 'page' } : await inspectDocumentVisuals(bytes, format, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (!result.totalChars) throw extractionError ?? error
    return { ...result, notice: [result.notice, '图片索引未能读取，仅返回提取文字。'].filter(Boolean).join('\n') }
  }
  if (extractionError && !inventory.count) throw extractionError
  const notes = [result.notice, inventory.notice]
  let visualSummary: string | undefined
  if (inventory.count && (format !== 'pdf' || inventory.count <= NOVEL_IMPORT_LIMITS.pdfPages)) {
    const unit = inventory.unit === 'page' ? '页' : '张内嵌图'
    visualSummary = `${inventory.count} ${unit}可查看`
    const first = `${url}#${inventory.unit}=1`
    notes.push(`文档有 ${inventory.count} ${unit}。需要识别扫描文字、图片或图表时，直接调用 view_image，url 使用 ${first}，将末尾数字改为要看的编号（1–${inventory.count}）。按作者要求逐项查看，再引用相应页码或图号。`)
    const empty = result.pdfPages?.withoutText
    if (empty?.length) notes.push(`无文字层的页码：${empty.slice(0, 40).join('、')}${empty.length > 40 ? ` 等，共 ${empty.length} 页` : ''}。这些页需查看画面才能判断内容。`)
  } else if (inventory.count) {
    notes.push(`共 ${inventory.count} 页，超过单个 PDF 的图像读取上限 ${NOVEL_IMPORT_LIMITS.pdfPages} 页；如需识图请拆分 PDF。`)
  }
  return { ...result, notice: notes.filter(Boolean).join('\n'), visualSummary }
}
