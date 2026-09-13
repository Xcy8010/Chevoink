import iconv from 'iconv-lite'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { checkStructure, hasUnsafeControls, limit, NOVEL_IMPORT_LIMITS, ParseContext } from './limits.js'
import { emptyImport, NovelImportParseError, type ParsedNovelImport, type NovelImportWarning } from './types.js'

const NUMBER = '[0-9０-９零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+'
const VOLUME = new RegExp(`^第\\s*${NUMBER}\\s*[卷部篇](?:[ \\t\\u3000:：·、—-]+[^。！？!?；;]{0,100})?$`)
const CHAPTER = new RegExp(`^第\\s*${NUMBER}\\s*[章回节](?:[ \\t\\u3000:：·、—-]+[^。！？!?；;]{0,100})?$`)
const SPECIAL = /^(?:序章|序言|前言|楔子|引子|尾声|终章|后记|番外)(?:[ \t\u3000:：·、—-]+[^。！？!?；;]{0,100})?$/

export function headingKind(title: string): 'volume' | 'chapter' | undefined {
  if (title.length > 120) return undefined
  if (VOLUME.test(title)) return 'volume'
  if (CHAPTER.test(title) || SPECIAL.test(title) || /^(?:chapter|prologue|epilogue)(?:\s+[\divxlcdm]+)?(?:\s*[:.—-]\s*[^.!?]+)?$/i.test(title)) return 'chapter'
  return undefined
}

export function fileStem(filename: string): string {
  return filename.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]*$/, '') || '未命名章节'
}

export function decodeText(buffer: Buffer, source: string, encoding?: string): { text: string; warnings: NovelImportWarning[] } {
  const warnings: NovelImportWarning[] = []
  const bom = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 'utf8'
    : buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? 'utf16le'
      : buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff])) ? 'utf16be' : undefined
  if (buffer.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0])) || buffer.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) {
    throw new NovelImportParseError('IMPORT_ENCODING_AMBIGUOUS', '暂不支持 UTF-32，请另存为 UTF-8。', source)
  }
  const aliases: Record<string, string> = { utf8: 'utf8', utf16: 'utf16', utf16le: 'utf16le', utf16be: 'utf16be', gb18030: 'gb18030', gbk: 'gbk', gb2312: 'gbk', big5: 'big5' }
  let selected = encoding ? aliases[encoding.toLowerCase().replace(/[-_\s]/g, '')] : undefined
  if (encoding && !selected) throw new NovelImportParseError('IMPORT_ENCODING_AMBIGUOUS', '请选择 UTF-8、UTF-16LE/BE、GB18030、GBK 或 Big5 编码。', source)
  if (selected === 'utf16') selected = bom?.startsWith('utf16') ? bom : undefined
  if (encoding && !selected) throw new NovelImportParseError('IMPORT_ENCODING_AMBIGUOUS', '无 BOM 的 UTF-16 文件需要指定 LE 或 BE。', source)
  if (bom && selected && selected !== bom) throw new NovelImportParseError('IMPORT_ENCODING_AMBIGUOUS', '所选编码与文件 BOM 冲突。', source)
  selected ??= bom
  const payload = bom ? buffer.subarray(bom === 'utf8' ? 3 : 2) : buffer
  if (!selected) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(payload)
      selected = 'utf8'
    } catch {
      selected = 'gb18030'
      warnings.push({ code: 'IMPORT_ENCODING_AMBIGUOUS', message: '严格 UTF-8 校验失败，按 GB18030 生成预览；请确认编码或重新选择。', source, blocking: true })
    }
  }
  let text: string
  try {
    if (selected === 'utf8' || selected.startsWith('utf16')) {
      text = new TextDecoder(selected === 'utf8' ? 'utf-8' : selected === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(payload)
    } else {
      text = iconv.decode(payload, selected)
      if (!iconv.encode(text, selected).equals(payload) || text.includes('\ufffd')) throw new Error('Lossy decoding')
    }
  } catch {
    throw new NovelImportParseError('IMPORT_ENCODING_AMBIGUOUS', '无法无损解码文件，请检查编码或另存为 UTF-8。', source)
  }
  if (hasUnsafeControls(text, true)) throw new NovelImportParseError('FILE_TYPE_MISMATCH', '文件包含二进制控制字符或编码不匹配。', source)
  if (text.includes('\ufffd')) warnings.push({ code: 'IMPORT_ENCODING_AMBIGUOUS', message: '原文包含替换字符，请检查源文件是否已损坏。', source, blocking: true })
  return { text: text.replace(/\r\n?/g, '\n'), warnings }
}

export type Heading = { start: number; end: number; title: string; kind: 'volume' | 'chapter' | 'book' }

function textHeadings(text: string): Heading[] {
  const headings: Heading[] = []
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const title = match[0].trim()
    const kind = headingKind(title)
    if (kind) {
      headings.push({ start: match.index, end: match.index + match[0].length, title, kind })
      limit(headings.length <= NOVEL_IMPORT_LIMITS.chapters + NOVEL_IMPORT_LIMITS.volumes, '卷章标题数超过安全限制。')
    }
  }
  return headings
}

function markdownHeadings(text: string): Heading[] {
  // Root children only: nested quotes/lists, HTML, fenced/indented code and TOCs stay literal.
  const root = fromMarkdown(text)
  const nodes = root.children.filter((node) => node.type === 'heading')
  const book = nodes[0]?.depth === 1 && nodes.some((node) => node.depth === 2) && !headingKind(nodes[0].children.map((child) => 'value' in child ? child.value : '').join('')) ? nodes[0] : undefined
  const chapterDepth = Math.min(...nodes.filter((node) => node !== book).map((node) => node.depth))
  const headings: Heading[] = []
  for (const node of root.children) {
    const start = node.position?.start.offset
    let end = node.position?.end.offset
    if (start === undefined || end === undefined) continue
    if (text[end] === '\n') end++
    if (node.type === 'heading') {
      // Keep inline Markdown as title rather than dropping link/image/emphasis text.
      const raw = text.slice(start, node.position!.end.offset).replace(/^ {0,3}#{1,6}[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/\n[ \t]*[=-]+[ \t]*$/, '').trim()
      const kind = node === book ? 'book' : headingKind(raw) ?? (node.depth === chapterDepth ? 'chapter' : undefined)
      if (kind) headings.push({ start, end, title: raw, kind })
    } else if (node.type === 'paragraph') {
      const raw = text.slice(start, node.position!.end.offset)
      const kind = !raw.includes('\n') ? headingKind(raw.trim()) : undefined
      if (kind) headings.push({ start, end, title: raw.trim(), kind })
    }
  }
  return headings
}

export function splitText(text: string, source: string, markdown = false, explicitHeadings?: Heading[]): ParsedNovelImport {
  const result = emptyImport()
  result.sourceChars = text.length
  const headings = explicitHeadings ?? (markdown ? markdownHeadings(text) : textHeadings(text))
  if (!headings.length) {
    if (text.length) result.volumes.push({ title: '正文卷', chapters: [{ title: fileStem(source), content: text, source }] })
    result.warnings.push({ code: 'IMPORT_STRUCTURE_FALLBACK', message: '未识别到明确章节标题，原文保留为单章，请确认章名。', source, blocking: false })
    return result
  }
  let volume = { title: '正文卷', chapters: [] as ParsedNovelImport['volumes'][number]['chapters'] }
  let title = '未分章正文'
  let offset = 0
  let bodyStart = 0
  let hasChapter = false
  const flush = (end: number) => {
    const content = text.slice(bodyStart, end)
    if (content.length || hasChapter) {
      if (!result.volumes.includes(volume)) result.volumes.push(volume)
      volume.chapters.push({ title, content, source: `${source}#char=${offset}-${end}` })
      checkStructure(result)
    }
  }
  for (const heading of headings) {
    flush(heading.start)
    if (heading.kind === 'volume') {
      volume = { title: heading.title, chapters: [] }
      result.volumes.push(volume)
      title = '卷前正文'
      hasChapter = false
    } else if (heading.kind === 'book') {
      result.metadata.title = heading.title
      title = '卷前正文'
      hasChapter = false
    } else {
      title = heading.title
      hasChapter = true
    }
    bodyStart = heading.end
    offset = heading.start
  }
  flush(text.length)
  checkStructure(result)
  return result
}

export function parseText(buffer: Buffer, source: string, context: ParseContext, markdown = false, encoding?: string) {
  const decoded = decodeText(buffer, source, encoding)
  context.addChars(decoded.text.length)
  const result = splitText(decoded.text, source, markdown)
  result.warnings.push(...decoded.warnings)
  context.check()
  return result
}
