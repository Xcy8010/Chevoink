import { DOMParser, parseHTML } from 'linkedom'
import { scanArchive, readArchiveEntry } from './archive.js'
import { limit, NOVEL_IMPORT_LIMITS, ParseContext } from './limits.js'
import { runConverter } from './isolated.js'
import { headingKind, splitText, type Heading } from './text.js'
import { NovelImportParseError, type NovelImportWarning } from './types.js'

type DocxExtraction = { html: string; messageCount: number; images: number }

export async function parseDocx(buffer: Buffer, source: string, context: ParseContext) {
  const entries = scanArchive(buffer, context)
  if (!entries.some((entry) => entry.path === '[Content_Types].xml') || !entries.some((entry) => entry.path === 'word/document.xml')) {
    throw new NovelImportParseError('FILE_TYPE_MISMATCH', '文件不是 Word DOCX 文档。', source)
  }
  const warnings: NovelImportWarning[] = []
  let xmlBytes = 0
  for (const entry of entries) {
    const bytes = await readArchiveEntry(buffer, entry, context)
    if (entry.directory) continue
    const memberSource = `${source}!/${entry.path}`
    const warn = (message: string) => {
      warnings.push({ code: 'IMPORT_DOCX_UNSUPPORTED_CONTENT', message, source: memberSource, blocking: true })
      limit(warnings.length <= NOVEL_IMPORT_LIMITS.warnings, 'DOCX 警告数超过安全限制。', source)
    }
    if (/\.(?:xml|rels)$/i.test(entry.path)) {
      xmlBytes += bytes.length
      limit(xmlBytes <= 50 * 1024 * 1024 && bytes.length <= 20 * 1024 * 1024, 'DOCX XML 超出安全解析大小。', memberSource)
      // OOXML may use UTF-16. Fatal decode before DOM inspection avoids entity/encoding bypasses.
      let xml: string
      try {
        const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
        xml = new TextDecoder(utf16, { fatal: true }).decode(bytes)
      } catch { throw new NovelImportParseError('IMPORT_CONVERT_FAILED', 'DOCX XML 编码无效。', memberSource) }
      if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || xml.includes('\0')) throw new NovelImportParseError('IMPORT_ARCHIVE_UNSAFE', 'DOCX 含不允许的 XML 实体或无效编码。', memberSource)
      const doc = new DOMParser().parseFromString(xml, 'text/xml')
      const names = new Set<string>()
      // linkedom's NodeList declaration loses element types. Derive the element type from
      // this actual XML document's factory instead of pretending it is a browser Document.
      doc.querySelectorAll('*').forEach((element: ReturnType<typeof doc.createElement>) => {
        names.add(element.localName.split(':').pop()!)
        if (element.getAttribute('TargetMode') === 'External') warn('文档包含外部关系；未访问外部目标，相关内容需核验。')
      })
      if (['altChunk', 'object', 'OLEObject', 'pict', 'drawing', 'txbxContent', 'subDoc', 'control', 'oMath', 'oMathPara'].some((name) => names.has(name))) warn('内嵌图片、文本框、公式或对象可能无法完整转换；尚未保存附件或执行 OCR。')
      if (['ins', 'del', 'moveFrom', 'moveTo', 'commentRangeStart'].some((name) => names.has(name))) warn('文档含修订或批注，需要确认显示版本；转换文本不能代替修订核验。')
      if (/^word\/(?:header|footer|comments)\d*\.xml$/i.test(entry.path)) warn('页眉、页脚或批注未作为正文导入，请确认是否含正文。')
    } else if (/^word\/(?:media|embeddings)\//i.test(entry.path) || /vbaProject/i.test(entry.path)) warn('内嵌资源未导入为可查看附件；宏及对象不会执行。')
  }
  const converted = await runConverter<DocxExtraction>('mammoth', `
    let images = 0;
    const result = await library.convertToHtml({buffer}, {
      externalFileAccess: false, includeEmbeddedStyleMap: false, ignoreEmptyParagraphs: false,
      convertImage: library.images.imgElement(async () => { images++; return {src: 'novel-import:unsupported-image'}; })
    });
    if (result.value.length > 20000000) throw Object.assign(new Error('HTML limit'), {code: 'IMPORT_LIMIT_EXCEEDED'});
    return {html: result.value, messageCount: result.messages.length, images};
  `, buffer, context)
  context.check()
  if (converted.messageCount) warnings.push({ code: 'IMPORT_DOCX_CONVERSION_WARNING', message: `Word 转换器报告 ${converted.messageCount} 项未完全支持的内容，请对照源文件。`, source, blocking: true })
  if (converted.images) warnings.push({ code: 'IMPORT_DOCX_IMAGE_UNSUPPORTED', message: `${converted.images} 张内嵌图片仅保留位置标记；未保存附件且尚未 OCR。`, source, blocking: true })
  const { document } = parseHTML(`<html><body>${converted.html}</body></html>`)
  const chunks: string[] = []
  const headings: Heading[] = []
  let length = 0
  const append = (value: string) => { const text = value.replace(/\r\n?/g, '\n'); length += text.length; limit(length <= 5_000_000, 'DOCX 正文超过 500 万字符。'); chunks.push(text) }
  const visit = (node: Node, depth = 0) => {
    limit(depth <= 128, 'DOCX 结构嵌套过深。')
    if (node.nodeType === 3) { append(node.textContent ?? ''); return }
    if (node.nodeType !== 1) return
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (tag === 'br') { append('\n'); return }
    if (tag === 'img') { append('[内嵌图片：待核验]'); return }
    const start = length
    if (tag === 'li') append('- ')
    for (const child of Array.from(node.childNodes)) visit(child, depth + 1)
    if (tag === 'a') {
      const href = element.getAttribute('href')
      if (href && !href.startsWith('#')) append(` (${href})`)
    }
    if (/^h[1-6]$/.test(tag)) {
      const title = element.textContent?.trim() || '未命名章节'
      append('\n\n')
      headings.push({ start, end: length, title, kind: headingKind(title) ?? 'chapter' })
    } else if (['p', 'tr', 'li'].includes(tag)) append('\n\n')
    else if (tag === 'td' || tag === 'th') append('\t')
  }
  for (const child of Array.from(document.body.childNodes)) visit(child)
  // Runs were normalized before recording heading offsets.
  const text = chunks.join('')
  context.addChars(text.length)
  const result = splitText(text, source, false, headings.length ? headings : undefined)
  result.warnings.push(...warnings)
  return result
}
