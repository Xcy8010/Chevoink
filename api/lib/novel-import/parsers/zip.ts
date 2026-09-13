import { scanArchive, readArchiveEntry, naturalCompare } from './archive.js'
import { checkStructure, isFatal, limit, NOVEL_IMPORT_LIMITS, ParseContext } from './limits.js'
import { decodeText, fileStem, headingKind } from './text.js'
import { emptyImport, NovelImportParseError, type ParsedNovelImport } from './types.js'
import { checkImportImages, imageExtension, stableImportId } from './images.js'

type MemberParser = (buffer: Buffer, source: string) => Promise<ParsedNovelImport>
const SECTIONS = new Set(['正文', '规划', '目录', '作品信息以及发布建议'])
const ARCHIVE_EXTENSION = /\.(?:zip|7z|rar|tar|gz|bz2|xz|tgz)$/i

function exportSection(path: string): { root: string; section: string; rest: string[] } | undefined {
  const parts = path.split('/')
  const index = parts.findIndex((part, i) => i < 2 && SECTIONS.has(part))
  return index >= 0 ? { root: parts.slice(0, index).join('/'), section: parts[index], rest: parts.slice(index + 1) } : undefined
}

function exportMarker(path: string): string | undefined {
  const section = exportSection(path)
  if (!section) return undefined
  const { root, rest } = section
  if (section.section === '正文' && rest.length === 2 && /^第\d+章\s+.+\.txt$/i.test(rest[1])) return root
  if (section.section === '目录' && rest.join('/') === '目录.txt') return root
  if (section.section === '作品信息以及发布建议' && ['作品信息.txt', '发布建议.txt'].includes(rest.join('/'))) return root
  return undefined
}

function nativeMetadata(text: string): ParsedNovelImport['metadata'] {
  const title = /^作品名称[：:](.*)$/m.exec(text)?.[1].trim()
  const summary = /(?:^|\n)简介[：:]([\s\S]*?)(?=\n作者[：:]|$)/.exec(text)?.[1].trim()
  const tags = /^作品标签[：:](.*)$/m.exec(text)?.[1].trim()
  return {
    ...(title ? { title } : {}),
    ...(summary && summary !== '（暂无简介）' ? { summary } : {}),
    ...(tags && tags !== '（暂无标签）' ? { tags: tags.split('、').filter(Boolean) } : {}),
  }
}

export async function parseZip(buffer: Buffer, source: string, context: ParseContext, parseMember: MemberParser, encoding?: string, resources = false) {
  const entries = scanArchive(buffer, context).sort((a, b) => naturalCompare(a.path, b.path))
  const files = entries.filter((entry) => !entry.directory)
  // A directory named 规划/目录 alone is not an export marker. Recognize the actual exporter
  // layout/filenames, at root or under exactly one book folder, never arbitrary deep matches.
  const nativeRoots = new Set(files.map((entry) => exportMarker(entry.path)).filter((root): root is string => root !== undefined))
  const native = nativeRoots.size > 0
  const result = emptyImport()
  if (resources) { result.images = []; result.evidence = { items: [] } }
  const singleRoot = nativeRoots.size === 1 ? [...nativeRoots][0] : undefined
  if (singleRoot) result.metadata.title = singleRoot
  const paths = files.filter((entry) => !entry.path.startsWith('__MACOSX/')).map((entry) => entry.path.split('/'))
  const commonRoot = paths.length > 0 && paths.every((parts) => parts.length > 1 && parts[0] === paths[0][0]) ? paths[0][0] : undefined
  const possibleRoots = new Set(paths.filter((parts) => parts.length > 1).map((parts) => parts[0]))
  const multipleBooks = nativeRoots.size > 1 || (!native && possibleRoots.size > 1 && [...possibleRoots].some((root) => headingKind(root) !== 'volume'))
  if (multipleBooks) result.warnings.push({ code: 'IMPORT_ARCHIVE_ROOT_AMBIGUOUS', message: 'ZIP 含多个可能的作品根目录；请选择一本作品后重新打包，不自动合并。', source, blocking: true })
  const volumeMap = new Map<string, ParsedNovelImport['volumes'][number]>()
  const append = (key: string, title: string, chapters: ParsedNovelImport['volumes'][number]['chapters']) => {
    let volume = volumeMap.get(key)
    if (!volume) { volume = { title, chapters: [] }; volumeMap.set(key, volume); result.volumes.push(volume) }
    volume.chapters.push(...chapters)
    checkStructure(result)
  }
  for (const entry of entries) {
    const memberSource = `${source}!/${entry.path}`
    const item = { id: stableImportId('file', memberSource), kind: 'file' as const, source: memberSource,
      status: 'native' as 'native' | 'failed' | 'needs_review' | 'excluded', excludable: true }
    if (resources && !entry.directory) result.evidence!.items.push(item)
    try {
      // Even excluded/unsupported members are integrity-checked and charged to decompression limits.
      const data = await readArchiveEntry(buffer, entry, context)
      if (entry.directory) continue
      if (ARCHIVE_EXTENSION.test(entry.path) || (data.length >= 4 && [0x04034b50, 0x06054b50].includes(data.readUInt32LE(0)) && !/\.docx$/i.test(entry.path))) {
        throw new NovelImportParseError('IMPORT_ARCHIVE_UNSAFE', '不支持嵌套压缩包。', memberSource)
      }
      if (entry.path.split('/').some((part) => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'))) {
        item.status = 'excluded'
        result.warnings.push({ code: 'IMPORT_ARCHIVE_MEMBER_EXCLUDED', message: '系统辅助文件不作为正文导入。', source: memberSource, blocking: false })
        continue
      }
      if (multipleBooks) {
        item.status = 'needs_review'
        result.warnings.push({ code: 'IMPORT_ARCHIVE_MEMBER_UNSELECTED', message: '尚未选择作品，此成员未导入。', source: memberSource, blocking: true })
        continue
      }
      if (resources && imageExtension.test(entry.path)) {
        const parsed = await parseMember(data, memberSource)
        result.images!.push(...(parsed.images ?? [])); checkImportImages(result.images!)
        result.evidence!.items.push(...(parsed.evidence?.items ?? []))
        result.sourceChars += parsed.sourceChars
        result.warnings.push(...parsed.warnings)
        for (const [index, volume] of parsed.volumes.entries()) append(`image:${entry.path}:${index}`, volume.title, volume.chapters)
        item.status = 'needs_review'
        continue
      }
      const section = exportSection(entry.path)
      if (!native && section && section.section !== '正文') {
        result.warnings.push({ code: 'IMPORT_ARCHIVE_STRUCTURE_AMBIGUOUS', message: '目录名类似辅助资料，但没有本站导出标记；原文保留预览，请确认是否属于正文。', source: memberSource, blocking: true })
      }
      if (native && section && section.root !== singleRoot) {
        item.status = 'needs_review'
        result.warnings.push({ code: 'IMPORT_ARCHIVE_MEMBER_UNSELECTED', message: '此成员位于已识别作品根目录以外，未合并导入，请单独选择作品。', source: memberSource, blocking: true })
        continue
      }
      if (native && section?.section !== '正文') {
        item.status = section ? 'excluded' : 'needs_review'
        if (section?.section === '作品信息以及发布建议' && section.rest.join('/') === '作品信息.txt') {
          const decoded = decodeText(data, memberSource, encoding)
          context.addChars(decoded.text.length)
          result.sourceChars += decoded.text.length
          result.metadata = { ...result.metadata, ...nativeMetadata(decoded.text) }
          result.warnings.push(...decoded.warnings)
        }
        result.warnings.push({ code: 'IMPORT_ARCHIVE_MEMBER_EXCLUDED', message: section ? '本站导出中的规划、目录及发布建议等辅助资料不作为正文。' : '正文目录以外的未知成员未导入，请确认。', source: memberSource, blocking: !section })
        continue
      }
      if (native && section) {
        if (section.rest.length !== 2 || !/\.txt$/i.test(entry.path)) {
          result.warnings.push({ code: 'IMPORT_ARCHIVE_MEMBER_FAILED', message: '本站正文成员不是预期的“卷/章节.txt”结构。', source: memberSource, blocking: true })
          continue
        }
        const decoded = decodeText(data, memberSource, encoding)
        context.addChars(decoded.text.length)
        result.sourceChars += decoded.text.length
        result.warnings.push(...decoded.warnings)
        const stem = fileStem(entry.path)
        const unnumbered = stem.replace(/^第\d+章\s+/, '')
        const first = /^([^\n]*)(?:\n\n|\n|$)/.exec(decoded.text)!
        const duplicated = first[1] === stem || first[1] === unnumbered
        // Exporter writes title + exactly two newlines. Strip only a proven duplicate once.
        const title = duplicated ? first[1] : unnumbered
        const content = duplicated ? decoded.text.slice(first[0].length) : decoded.text
        append(section.rest[0], section.rest[0], [{ title, content, source: memberSource }])
        if (duplicated) result.warnings.push({ code: 'IMPORT_DUPLICATE_TITLE_REMOVED', message: '已将与文件章名一致的首行标题移至章名，仅去重一次；原文件仍是来源。', source: memberSource, blocking: false })
        if (!content.trim()) result.warnings.push({ code: 'IMPORT_ARCHIVE_MEMBER_EMPTY', message: '章节成员没有非空正文。', source: memberSource, blocking: true })
        continue
      }
      const parsed = await parseMember(data, memberSource)
      if (resources) {
        result.images!.push(...(parsed.images ?? [])); checkImportImages(result.images!)
        result.evidence!.items.push(...(parsed.evidence?.items ?? []).filter(child => child.id !== item.id))
        if (parsed.warnings.some(warning => warning.blocking)) item.status = 'needs_review'
      }
      result.sourceChars += parsed.sourceChars
      result.warnings.push(...parsed.warnings)
      const parts = entry.path.split('/')
      if (commonRoot) parts.shift()
      const directory = parts.slice(0, -1).join('/')
      for (const [index, volume] of parsed.volumes.entries()) {
        const title = volume.title === '正文卷' ? directory || '正文卷' : volume.title
        // Same-titled explicit volumes in distinct source files must not overwrite/merge.
        append(volume.title === '正文卷' ? `dir:${directory}` : `file:${entry.path}:${index}`, title, volume.chapters)
      }
    } catch (error) {
      item.status = 'failed'
      if (isFatal(error)) throw error
      result.warnings.push({ code: error instanceof NovelImportParseError ? error.code : 'IMPORT_ARCHIVE_MEMBER_FAILED', message: error instanceof NovelImportParseError ? error.message : 'ZIP 成员解析失败，请单独检查此文件。', source: memberSource, blocking: true })
    } finally {
      limit(result.warnings.length <= NOVEL_IMPORT_LIMITS.warnings, 'ZIP 警告数超过安全限制，请拆分文件。')
    }
  }
  return result
}
