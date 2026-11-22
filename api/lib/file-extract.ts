import path from 'node:path'

import { decodeText } from './novel-import/parsers/text.js'
import { DataAccessError } from './prisma.js'

/**
 * 上传文件文本提取（read_file 工具基座）：
 * txt/md 复用作品导入的文本解码；PDF 与 DOCX 按需加载文字提取器。
 * 借鉴 anthropics/skills 的 pdf/docx 思路与 offset 续读参数设计，Node 纯 JS 实现。
 */

/** 单次提取返回的最大字符数（≈15k token，对齐 loop 上下文预算） */
export const FILE_EXTRACT_MAX_CHARS = 20000

export type FileExtractResult = {
  text: string
  totalChars: number
  truncated: boolean
  notice?: string
  pdfPages?: { total: number; withoutText: number[] }
}

async function extractPdf(buffer: Buffer) {
  try {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: buffer, isEvalSupported: false })
    try {
      // v2 adds page labels by default; they are not part of the uploaded text.
      const parsed = await parser.getText({ pageJoiner: '' })
      return { text: parsed.text ?? '', pages: { total: parsed.total,
        withoutText: parsed.pages.filter(page => !page.text.trim()).map(page => page.num) } }
    } finally {
      // Release workers/document resources on successful and failed extraction.
      await parser.destroy()
    }
  } catch {
    throw new DataAccessError(
      502,
      'FILE_EXTRACT_ERROR',
      'PDF 解析失败：文件可能损坏，或为扫描版（扫描件没有可提取文字层）。',
    )
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer })
    return result.value ?? ''
  } catch {
    throw new DataAccessError(502, 'FILE_EXTRACT_ERROR', 'docx 解析失败：文件可能损坏或不是有效的 docx。')
  }
}

/** 按扩展名分发提取；offset 支持截断后续读 */
export async function extractFileText(
  buffer: Buffer,
  filename: string,
  offset = 0,
): Promise<FileExtractResult> {
  const extension = (path.extname(filename).slice(1) || '').toLowerCase()

  let full: string
  let notice: string | undefined
  let pdfPages: FileExtractResult['pdfPages']

  if (extension === 'txt' || extension === 'md') {
    const decoded = decodeText(buffer, filename)
    full = decoded.text
    notice = decoded.warnings.map(warning => warning.message).join(' ') || undefined
  } else if (extension === 'pdf') {
    const pdf = await extractPdf(buffer)
    full = pdf.text
    pdfPages = pdf.pages
  } else if (extension === 'docx') {
    full = await extractDocx(buffer)
  } else if (extension === 'doc') {
    throw new DataAccessError(
      400,
      'VALIDATION_ERROR',
      '旧版 .doc 二进制格式无法解析，请转存为 .docx 后重新上传。',
    )
  } else {
    throw new DataAccessError(400, 'VALIDATION_ERROR', `暂不支持解析 .${extension} 文件。`)
  }

  if (extension === 'pdf' || extension === 'docx') {
    if (full.includes('\uFFFD')) notice = '提取文字含替换字符（�），请核对原件或文字层后再引用。'
  }
  const normalized = full.replace(/\r\n?/g, '\n').trim()
  const totalChars = normalized.length

  const start = Math.min(Math.max(offset, 0), totalChars)
  const text = normalized.slice(start, start + FILE_EXTRACT_MAX_CHARS)

  return {
    text,
    totalChars,
    truncated: start + text.length < totalChars,
    ...(notice && { notice }),
    ...(pdfPages && { pdfPages }),
  }
}
