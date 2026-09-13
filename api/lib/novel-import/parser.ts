import { parseDocx } from './parsers/docx.js'
import { parsePdf } from './parsers/pdf.js'
import { parseText } from './parsers/text.js'
import { parseZip } from './parsers/zip.js'
import { checkStructure, hasUnsafeControls, limit, NOVEL_IMPORT_LIMITS, ParseContext } from './parsers/limits.js'
import { NovelImportParseError, type NovelImportParseOptions, type ParsedNovelImport } from './parsers/types.js'

export type { ParsedNovelImport, NovelImportChapter, NovelImportVolume, NovelImportWarning, NovelImportParseOptions } from './parsers/types.js'
export { NovelImportParseError, NOVEL_IMPORT_PARSER_VERSION } from './parsers/types.js'
export { NOVEL_IMPORT_LIMITS } from './parsers/limits.js'

/** Pure, deterministic full-file parsing. No DB, network, AI, shell conversion, or filesystem writes.
 * Blocking warnings mean preview-only: callers must not treat returned text as complete/approved.
 * Invalid/unsafe input, unsupported DOC and exhausted limits reject with NovelImportParseError.
 * sourceChars counts normalized decoded source, including titles (not bytes or AI tokens).
 */
export async function parseNovelImportFile(buffer: Buffer, filename: string, options: NovelImportParseOptions = {}): Promise<ParsedNovelImport> {
  const context = new ParseContext(options.signal)
  const parse = async (bytes: Buffer, source: string, member = false): Promise<ParsedNovelImport> => {
    await context.checkpoint()
    limit(bytes.length <= NOVEL_IMPORT_LIMITS.fileBytes, '单文件超过 50 MiB，请拆分文件。', source)
    const extension = /\.([^./\\]+)$/.exec(source)?.[1].toLowerCase()
    let result: ParsedNovelImport
    if (extension === 'txt' || extension === 'md') {
      if (bytes.subarray(0, 5).toString('ascii') === '%PDF-' || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) || bytes.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
        throw new NovelImportParseError('FILE_TYPE_MISMATCH', '文件扩展名与二进制格式不匹配。', source)
      }
      result = parseText(bytes, source, context, extension === 'md', options.encoding)
    } else if (extension === 'docx') result = await parseDocx(bytes, source, context)
    else if (extension === 'pdf') result = await parsePdf(bytes, source, context)
    else if (extension === 'zip' && !member) result = await parseZip(bytes, source, context, (data, name) => parse(data, name, true), options.encoding)
    else if (extension === 'doc') throw new NovelImportParseError('IMPORT_UNSUPPORTED_FORMAT', '旧版 DOC 的隔离转换适配器尚未接入，请另存为 DOCX；不会调用本机 shell 转换。', source)
    else throw new NovelImportParseError('IMPORT_UNSUPPORTED_FORMAT', '不支持此文件格式，请使用 TXT、MD、DOCX、PDF 或 ZIP。', source)
    checkStructure(result)
    // The downstream commit contract caps chapter content at 100k; keep the full preview.
    if (!member) for (const chapter of result.volumes.flatMap((volume) => volume.chapters)) {
      if (chapter.content.length > 100_000) result.warnings.push({ code: 'IMPORT_CHAPTER_TOO_LARGE', message: '单章正文超过 10 万字符，请在预览中拆章；原文未截断。', source: chapter.source, blocking: true })
    }
    if (!result.volumes.some((volume) => volume.chapters.some((chapter) => chapter.content.trim()))) {
      result.warnings.push({ code: 'IMPORT_NO_BODY', message: '未取得非空正文，不能导入或覆盖作品。', source, blocking: true })
    }
    checkStructure(result)
    context.check()
    return result
  }
  if (!filename || filename.length > 2048 || hasUnsafeControls(filename)) throw new NovelImportParseError('FILE_TYPE_MISMATCH', '文件名无效。')
  return parse(buffer, filename)
}
