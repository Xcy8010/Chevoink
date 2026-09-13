import { describe, expect, it, vi } from 'vitest'
import iconv from 'iconv-lite'
import { parseNovelImportFile as parse, NOVEL_IMPORT_LIMITS, type ParsedNovelImport } from '../../api/lib/novel-import/parser.js'
import { readArchiveEntry, scanArchive } from '../../api/lib/novel-import/parsers/archive.js'
import { ParseContext } from '../../api/lib/novel-import/parsers/limits.js'
import * as converters from '../../api/lib/novel-import/parsers/isolated.js'
import { centralOffset, docx, JSZip, paragraph, pdf, zipFiles } from './novel-import-parser.fixtures.js'

const chapters = (result: ParsedNovelImport) => result.volumes.flatMap((volume) => volume.chapters)
const contents = (result: ParsedNovelImport) => chapters(result).map((chapter) => chapter.content).join('')
const warning = (result: ParsedNovelImport, code: string) => result.warnings.find((item) => item.code === code)
const text = (value: string, name = 'book.txt') => parse(Buffer.from(value), name)

describe('deterministic full-text import', () => {
  it('preserves >20k characters, whitespace, paragraphs and final tail exactly', async () => {
    const body = `  前文\n\n${'正文💫\n'.repeat(14_000)}\n最后一段 FINAL_TAIL  \n`
    const result = await text(body)
    expect(chapters(result)).toHaveLength(1)
    expect(contents(result)).toBe(body)
    expect(result.sourceChars).toBe(body.length)
    expect(result.parserVersion).toBe('deterministic-1')
    expect(warning(result, 'IMPORT_STRUCTURE_FALLBACK')).toMatchObject({ blocking: false })
    expect(await text(body)).toEqual(result)
  })

  it('normalizes only line endings (not indentation, blank paragraphs or tail)', async () => {
    const result = await text('  一\r\n\r\n　　二\r三  \r\n')
    expect(contents(result)).toBe('  一\n\n　　二\n三  \n')
    expect(result.sourceChars).toBe(contents(result).length)
  })

  it('retains >100k full preview for splitting, with a blocking commit-limit warning', async () => {
    const body = '文'.repeat(100_001) + 'FINAL_TAIL'
    const result = await text(body)
    expect(contents(result)).toBe(body)
    expect(warning(result, 'IMPORT_CHAPTER_TOO_LARGE')?.blocking).toBe(true)
  })

  it.each(['utf8', 'utf16le', 'utf16be', 'gb18030', 'gbk', 'big5'])('losslessly decodes explicit %s', async (encoding) => {
    const body = '第一章 開始\n\n天地玄黃。\n最後一行'
    const result = await parse(iconv.encode(body, encoding), '小说.txt', { encoding })
    expect(contents(result)).toBe('\n天地玄黃。\n最後一行')
    expect(chapters(result)[0].title).toBe('第一章 開始')
    expect(result.warnings.some((item) => item.blocking)).toBe(false)
  })

  it.each(['utf8', 'utf16le', 'utf16be'])('detects %s BOM', async (encoding) => {
    const body = '完整中文\n尾巴'
    const result = await parse(iconv.encode(body, encoding, { addBOM: true }), 'book.txt')
    expect(contents(result)).toBe(body)
  })

  it('offers a blocking GB18030 preview when UTF-8 fails', async () => {
    const result = await parse(iconv.encode('中文正文与结尾', 'gb18030'), 'book.txt')
    expect(contents(result)).toBe('中文正文与结尾')
    expect(warning(result, 'IMPORT_ENCODING_AMBIGUOUS')).toMatchObject({ blocking: true })
  })

  it.each([
    [Buffer.from([0xc3]), 'utf8'],
    [Buffer.from([0x81]), 'gb18030'],
    [Buffer.from([0, 0xd8]), 'utf16le'],
    [Buffer.from('hello'), 'rot13'],
    [Buffer.from('hello'), 'utf16'],
    [Buffer.from([0xff, 0xfe, 0x61, 0]), 'utf8'],
    [Buffer.from([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]), undefined],
  ])('rejects invalid/lossy/ambiguous encoding %#', async (bytes, encoding) => {
    await expect(parse(bytes, 'book.txt', { encoding })).rejects.toMatchObject({ code: 'IMPORT_ENCODING_AMBIGUOUS' })
  })

  it('preserves existing replacement characters but blocks completeness', async () => {
    const result = await text('原稿\ufffd尾巴')
    expect(contents(result)).toBe('原稿\ufffd尾巴')
    expect(warning(result, 'IMPORT_ENCODING_AMBIGUOUS')?.blocking).toBe(true)
  })

  it('rejects binary content disguised as text', async () => {
    await expect(text('abc\0binary')).rejects.toMatchObject({ code: 'FILE_TYPE_MISMATCH' })
    await expect(parse(pdf(['text']), 'book.txt')).rejects.toMatchObject({ code: 'FILE_TYPE_MISMATCH' })
  })

  it('splits volumes, Arabic/Chinese chapters, prologue and extras without losing preambles', async () => {
    const body = '书前原文\n\n第一卷 初来\n卷前原文\n\n序章\n开头\n\n第一章 初见\n  正文一\n\n第２回 风云\n正文二\n第二卷 归途\n第十二节 落幕\n正文三\n番外 一\n最终尾巴'
    const result = await text(body)
    expect(result.volumes.map((volume) => volume.title)).toEqual(['正文卷', '第一卷 初来', '第二卷 归途'])
    expect(chapters(result).map((chapter) => chapter.title)).toEqual(['未分章正文', '卷前正文', '序章', '第一章 初见', '第２回 风云', '第十二节 落幕', '番外 一'])
    expect(contents(result)).toBe('书前原文\n\n卷前原文\n\n开头\n\n  正文一\n\n正文二\n正文三\n最终尾巴')
    expect(result.sourceChars).toBe(body.length)
  })

  it('does not split chapter references in sentences, dialogue or unseparated prose', async () => {
    const body = '他说第一章已经完成。\n“第一章 初见”\n第一章讲的是一条河\n第一章 初见，然后他笑了。\n第1章标题正文'
    expect(contents(await text(body))).toBe(body)
    expect(chapters(await text(body))).toHaveLength(1)
  })

  it('does not fabricate body for empty files or heading-only documents', async () => {
    expect(warning(await text(''), 'IMPORT_NO_BODY')?.blocking).toBe(true)
    const result = await text('第一卷\n第一章\n')
    expect(warning(result, 'IMPORT_NO_BODY')?.blocking).toBe(true)
    expect(chapters(result)[0].content).toBe('')
  })

  it('rejects source/byte/chapter/volume limits instead of truncating', async () => {
    await expect(text('x'.repeat(NOVEL_IMPORT_LIMITS.sourceChars + 1))).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    await expect(parse(Buffer.alloc(NOVEL_IMPORT_LIMITS.fileBytes + 1), 'book.txt')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    await expect(text(Array.from({ length: 2001 }, (_, i) => `第${i + 1}章\nx\n`).join(''))).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    await expect(text(Array.from({ length: 201 }, (_, i) => `第${i + 1}卷\nx\n`).join(''))).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
  })

  it('honors abort before work and while yielding', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(parse(Buffer.from('原文'), 'book.txt', { signal: cancelled.signal })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    const controller = new AbortController()
    const pending = parse(zipFiles({ 'a.txt': '原文' }), 'book.zip', { signal: controller.signal })
    setImmediate(() => controller.abort())
    await expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })
})

describe('Markdown AST boundaries', () => {
  it('protects code, quotes, nested headings, HTML and TOC links; preserves their raw Markdown', async () => {
    const protectedBody = '\n```md\n# 第九章 假标题\n第一卷\n```\n\n> ## 第八章 引用\n\n    第七章 缩进代码\n\n- [第六章 目录](#six)\n- item\n  ## 第五章 列表内\n\n<div>\n# 第四章 HTML\n</div>\n\n原文 [外链](https://example.invalid) ![图](https://example.invalid/p.png)\n\n'
    const body = `# 小说名称\n## 第一章 开场\n${protectedBody}## 第二章 尾声\n尾巴`
    const result = await text(body, 'book.md')
    expect(result.metadata.title).toBe('小说名称')
    expect(chapters(result).map((chapter) => chapter.title)).toEqual(['第一章 开场', '第二章 尾声'])
    expect(chapters(result)[0].content).toBe(protectedBody)
    expect(chapters(result)[1].content).toBe('尾巴')
  })

  it('uses explicit chapter depth and keeps generic subheadings within their chapter', async () => {
    const result = await text('# 书名\n## 开篇\n正文\n### 场景一\n对白\n## 结局\n最后', 'book.md')
    expect(chapters(result).map((chapter) => chapter.title)).toEqual(['开篇', '结局'])
    expect(chapters(result)[0].content).toBe('正文\n### 场景一\n对白\n')
  })

  it('supports setext headings and standalone plain chapter paragraphs', async () => {
    const result = await text('开始\n=====\n\n第一章 起步\n\n正文\n\n第2章 收束\n\n尾巴', 'book.md')
    expect(chapters(result).map((chapter) => chapter.title)).toEqual(['开始', '第一章 起步', '第2章 收束'])
    expect(contents(result)).toContain('尾巴')
  })

  it('returns literal code-only Markdown as a single chapter', async () => {
    const body = '~~~\n# 第一章\n第一卷\n~~~\n'
    expect(contents(await text(body, 'book.md'))).toBe(body)
  })
})

describe('ZIP structure and integrity', () => {
  it('round-trips native export bodies only, naturally orders chapters, and deduplicates exactly once', async () => {
    const first = '\n  正文\n\n结尾  '
    const result = await parse(zipFiles({
      '书名/规划/故事.txt': '不得当正文',
      '书名/目录/目录.txt': '第999章 不得补出',
      '书名/正文/第一卷/第0010章 结局.txt': '结局\n\n尾章',
      '书名/正文/第一卷/第0002章 开篇.txt': `开篇\n\n${first}`,
      '书名/作品信息以及发布建议/作品信息.txt': '作品名称：真实书名\n简介：第一行\n第二行\n作者：甲\n作品标签：玄幻、冒险\n',
      '书名/作品信息以及发布建议/发布建议.txt': '简介：禁止推断的建议',
    }), 'export.zip')
    expect(chapters(result).map((chapter) => chapter.title)).toEqual(['开篇', '结局'])
    expect(chapters(result)[0].content).toBe(first)
    expect(chapters(result)[0].source).toBe('export.zip!/书名/正文/第一卷/第0002章 开篇.txt')
    expect(contents(result)).not.toMatch(/不得|禁止/)
    expect(result.metadata).toEqual({ title: '真实书名', summary: '第一行\n第二行', tags: ['玄幻', '冒险'] })
    expect(result.warnings.some((item) => item.blocking)).toBe(false)
  })

  it('preserves nonmatching first lines and repeated body titles, without recursive splitting native chapters', async () => {
    const result = await parse(zipFiles({ '书/正文/第一卷/第0001章 开篇.txt': '不同的标题\n\n第一章 正文里的标题\n尾巴' }), 'export.zip')
    expect(chapters(result)).toHaveLength(1)
    expect(contents(result)).toBe('不同的标题\n\n第一章 正文里的标题\n尾巴')
    const repeated = await parse(zipFiles({ '书/正文/第一卷/第0001章 开篇.txt': '开篇\n\n开篇\n\n尾巴' }), 'export.zip')
    expect(contents(repeated)).toBe('开篇\n\n尾巴')
  })

  it('never treats plans/catalog/info-only exports as body', async () => {
    const result = await parse(zipFiles({ '书/规划/大纲.txt': '大纲', '书/目录/目录.txt': '第一章 目录', '书/作品信息以及发布建议/发布建议.txt': '建议' }), 'export.zip')
    expect(chapters(result)).toHaveLength(0)
    expect(warning(result, 'IMPORT_NO_BODY')?.blocking).toBe(true)
  })

  it('sorts generic files naturally, preserving final tails and same titles', async () => {
    const result = await parse(zipFiles({ '10.txt': '同名\n尾10', '2.txt': '同名\n尾2', '1.txt': '同名\n尾1' }), 'generic.zip')
    expect(chapters(result).map((chapter) => chapter.title)).toEqual(['1', '2', '10'])
    expect(contents(result)).toBe('同名\n尾1同名\n尾2同名\n尾10')
  })

  it('uses explicit volume directories but blocks multiple ambiguous book roots', async () => {
    const volumes = await parse(zipFiles({ '第一卷/1.txt': '一', '第二卷/1.txt': '二' }), 'book.zip')
    expect(volumes.volumes.map((volume) => volume.title)).toEqual(['第一卷', '第二卷'])
    const books = await parse(zipFiles({ '书A/1.txt': '一', '书B/1.txt': '二' }), 'books.zip')
    expect(books.volumes).toEqual([])
    expect(warning(books, 'IMPORT_ARCHIVE_ROOT_AMBIGUOUS')?.blocking).toBe(true)
    expect(books.warnings.filter((item) => item.code === 'IMPORT_ARCHIVE_MEMBER_UNSELECTED')).toHaveLength(2)
  })

  it('blocks multiple native book roots without merging', async () => {
    const result = await parse(zipFiles({ '甲/正文/第一卷/第0001章 一.txt': '一', '乙/正文/第一卷/第0001章 二.txt': '二' }), 'books.zip')
    expect(result.volumes).toEqual([])
    expect(warning(result, 'IMPORT_ARCHIVE_ROOT_AMBIGUOUS')?.blocking).toBe(true)
  })

  it('does not classify an ordinary planning directory or deep section names as native export', async () => {
    const planning = await parse(zipFiles({ 'book/规划/1.txt': '保留正文', 'book/卷一/2.txt': '尾巴' }), 'ordinary.zip')
    expect(contents(planning)).toContain('保留正文')
    expect(warning(planning, 'IMPORT_ARCHIVE_STRUCTURE_AMBIGUOUS')?.blocking).toBe(true)
    const deep = await parse(zipFiles({ 'book/nested/规划/1.txt': '完整正文' }), 'ordinary.zip')
    expect(contents(deep)).toBe('完整正文')
    expect(warning(deep, 'IMPORT_ARCHIVE_MEMBER_EXCLUDED')).toBeUndefined()
  })

  it('does not merge a non-marker body directory from another root into a recognized export', async () => {
    const result = await parse(zipFiles({ '甲/正文/第一卷/第0001章 一.txt': '一\n\n正文一', '乙/正文/第一卷/other.txt': '不得合并' }), 'roots.zip')
    expect(contents(result)).toBe('正文一')
    expect(warning(result, 'IMPORT_ARCHIVE_MEMBER_UNSELECTED')?.blocking).toBe(true)
  })

  it('collects every unsupported/corrupt/empty member and keeps good members', async () => {
    const result = await parse(zipFiles({ '1.txt': '完整正文', '2.pdf': '%PDF-1.4\nbroken', '3.doc': Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), '4.png': 'image', '5.txt': '', '__MACOSX/._1.txt': 'metadata' }), 'mixed.zip')
    expect(contents(result)).toContain('完整正文')
    for (const member of ['2.pdf', '3.doc', '4.png', '5.txt']) expect(result.warnings.some((item) => item.blocking && item.source === `mixed.zip!/${member}`)).toBe(true)
    expect(result.warnings.some((item) => item.source === 'mixed.zip!/__MACOSX/._1.txt' && !item.blocking)).toBe(true)
  }, 20_000)

  it('detects CRC failure and continues reporting other members', async () => {
    const bytes = zipFiles({ 'bad.txt': 'BAD', 'good.txt': 'GOOD' })
    bytes[30 + Buffer.byteLength('bad.txt')] ^= 1
    const result = await parse(bytes, 'crc.zip')
    expect(contents(result)).toBe('GOOD')
    expect(warning(result, 'IMPORT_ARCHIVE_CORRUPT')).toMatchObject({ source: 'crc.zip!/bad.txt', blocking: true })
  })

  it.each(['../evil.txt', '/evil.txt', 'C:/evil.txt', '\\\\server\\evil.txt', 'a\\..\\evil.txt', 'a/../evil.txt', 'a//evil.txt', 'a/evil. ', 'NUL.txt', 'a/．./evil.txt'])('rejects hostile path %s', async (path) => {
    await expect(parse(zipFiles({ [path]: 'x' }), 'unsafe.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
  })

  it.each([['a.txt', 'A.txt'], ['é.txt', 'e\u0301.txt'], ['a', 'a/child.txt']])('rejects path collisions %j', async (first, second) => {
    await expect(parse(zipFiles({ [first]: 'x', [second]: 'y' }), 'unsafe.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
  })

  it('rejects symlinks, encryption and central/local filename mismatch', async () => {
    for (const mutate of [
      (b: Buffer) => { b.writeUInt32LE((0xa1ff << 16) >>> 0, centralOffset(b) + 38) },
      (b: Buffer) => { b.writeUInt16LE(0x801, centralOffset(b) + 8) },
      (b: Buffer) => { b[30] = 'b'.charCodeAt(0) },
    ]) {
      const bytes = zipFiles({ 'a.txt': 'body' })
      mutate(bytes)
      await expect(parse(bytes, 'unsafe.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
    }
  })

  it('rejects truncated archives and hidden trailing bytes', async () => {
    const bytes = zipFiles({ 'a.txt': 'body' })
    await expect(parse(bytes.subarray(0, -1), 'bad.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
    await expect(parse(Buffer.concat([bytes, Buffer.from('hidden')]), 'bad.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
  })

  it('rejects member-count, member-byte, total-byte, ratio and nested-archive limits', async () => {
    const count = zipFiles({ 'a.txt': 'body' })
    count.writeUInt16LE(3001, count.length - 14)
    count.writeUInt16LE(3001, count.length - 12)
    await expect(parse(count, 'many.zip')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    const size = zipFiles({ 'a.txt': 'body' })
    size.writeUInt32LE(NOVEL_IMPORT_LIMITS.entryBytes + 1, centralOffset(size) + 24)
    await expect(parse(size, 'large.zip')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    const zip = new JSZip()
    zip.file('bomb.txt', 'x'.repeat(1_000_000))
    await expect(parse(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'bomb.zip')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    await expect(parse(zipFiles({ 'nested.zip': zipFiles({ 'a.txt': 'x' }) }), 'nested.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
    await expect(parse(zipFiles({ 'hidden.dat': zipFiles({ 'a.txt': 'x' }) }), 'nested.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
  })

  it('caps actual inflate output when declared sizes lie', async () => {
    const zip = new JSZip()
    zip.file('lying.txt', 'ABCD'.repeat(1000))
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    bytes.writeUInt32LE(1, 22)
    bytes.writeUInt32LE(1, centralOffset(bytes) + 24)
    await expect(parse(bytes, 'lying.zip')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
  })

  it('rejects hidden bytes following a valid deflate stream', async () => {
    const zip = new JSZip()
    zip.file('chapter.txt', '原文尾巴')
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const cd = centralOffset(bytes)
    const hidden = Buffer.from('hidden')
    const changed = Buffer.concat([bytes.subarray(0, cd), hidden, bytes.subarray(cd)])
    changed.writeUInt32LE(changed.readUInt32LE(18) + hidden.length, 18)
    changed.writeUInt32LE(changed.readUInt32LE(cd + hidden.length + 20) + hidden.length, cd + hidden.length + 20)
    changed.writeUInt32LE(cd + hidden.length, changed.length - 6)
    await expect(parse(changed, 'hidden.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
  })

  it('charges nested DOCX preflight and decompression to the same aggregate budget', async () => {
    const bytes = zipFiles({ 'chapter.txt': '12345' })
    const countContext = new ParseContext()
    countContext.entries = NOVEL_IMPORT_LIMITS.entries
    expect(() => scanArchive(bytes, countContext)).toThrow(expect.objectContaining({ code: 'IMPORT_LIMIT_EXCEEDED' }))
    const context = new ParseContext()
    const [entry] = scanArchive(bytes, context)
    context.decompressedBytes = NOVEL_IMPORT_LIMITS.decompressedBytes - 4
    expect(() => scanArchive(bytes, context)).toThrow(expect.objectContaining({ code: 'IMPORT_LIMIT_EXCEEDED' }))
    await expect(readArchiveEntry(bytes, entry, context)).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
  })

  it('rejects unsupported ZIP64 extras, local-overlap offsets and decompression corruption', async () => {
    const zip = new JSZip()
    zip.file('chapter.txt', '原文一二三四五六七八九十')
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const corrupt = Buffer.from(bytes)
    const [entry] = scanArchive(bytes, new ParseContext())
    corrupt.fill(0xff, entry.dataOffset, entry.dataOffset + entry.compressedSize)
    expect(warning(await parse(corrupt, 'corrupt.zip'), 'IMPORT_ARCHIVE_CORRUPT')?.blocking).toBe(true)
    const overlap = zipFiles({ 'a.txt': 'one', 'b.txt': 'two' })
    const second = centralOffset(overlap) + 46 + Buffer.byteLength('a.txt')
    overlap.writeUInt32LE(0, second + 42)
    await expect(parse(overlap, 'overlap.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
    const unicode = new JSZip()
    unicode.file('中文.txt', '正文')
    const extra = await unicode.generateAsync({ type: 'nodebuffer' })
    const cd = centralOffset(extra)
    extra.writeUInt16LE(1, cd + 46 + extra.readUInt16LE(cd + 28))
    await expect(parse(extra, 'zip64.zip')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
  })

  it.each([false, true])('reads real deflated UTF-8 ZIP (stream descriptors=%s)', async (streamFiles) => {
    const zip = new JSZip()
    zip.file('第一卷/2.txt', '原文二\n最终尾巴')
    zip.file('第一卷/1.txt', '原文一')
    const result = await parse(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', streamFiles }), 'compressed.zip')
    expect(contents(result)).toBe('原文一原文二\n最终尾巴')
  })
})

describe('real DOCX and PDF compatibility, honest unsupported paths', () => {
  it('retains DOCX heading styles, paragraphs, tables and >20k tail', async () => {
    const long = '正文'.repeat(12_000) + 'FINAL_TAIL'
    const table = `<w:tbl><w:tr><w:tc>${paragraph('角色甲')}</w:tc><w:tc>${paragraph('对白 & 内容')}</w:tc></w:tr></w:tbl>`
    const result = await parse(docx(paragraph('第一卷 初来', 'Heading1') + paragraph('第一章 起步', 'Heading2') + paragraph('  第一段') + paragraph('') + table + paragraph(long)), 'book.docx')
    expect(result.volumes[0].title).toBe('第一卷 初来')
    expect(chapters(result)[0].title).toBe('第一章 起步')
    expect(contents(result)).toContain('  第一段\n\n\n\n')
    expect(contents(result)).toContain('角色甲\n\n\t对白 & 内容')
    expect(contents(result)).toContain(long)
    expect(result.warnings.some((item) => item.blocking)).toBe(false)
  }, 20_000)

  it('warns about embedded unsupported content, external links, headers and tracked revisions', async () => {
    const result = await parse(docx(paragraph('原文') + '<w:ins w:id="1">' + paragraph('新增') + '</w:ins><w:del w:id="2"><w:r><w:delText>删除</w:delText></w:r></w:del>', {
      'word/media/image1.png': 'not decoded or read as image',
      'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:hdr>',
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private" TargetMode="External"/></Relationships>',
    }), 'review.docx')
    expect(contents(result)).toContain('原文')
    expect(result.warnings.filter((item) => item.code === 'IMPORT_DOCX_UNSUPPORTED_CONTENT').length).toBeGreaterThanOrEqual(4)
    expect(result.warnings.every((item) => item.code === 'IMPORT_STRUCTURE_FALLBACK' || item.blocking)).toBe(true)
  }, 20_000)

  it('allows a DOCX member as a dedicated OOXML container, not a generic nested ZIP', async () => {
    const result = await parse(zipFiles({ 'book.docx': docx(paragraph('内嵌 DOCX 正文')) }), 'docs.zip')
    expect(contents(result)).toContain('内嵌 DOCX 正文')
  }, 20_000)

  it('preserves an inline DOCX image position without loading it and blocks missing attachment/OCR', async () => {
    const drawing = '<w:p><w:r><w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><wp:inline><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rImage"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    const result = await parse(docx(paragraph('图片前') + drawing + paragraph('图片后'), {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>',
      'word/media/image.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=', 'base64'),
    }), 'image.docx')
    expect(contents(result)).toMatch(/图片前[\s\S]*\[内嵌图片：待核验\][\s\S]*图片后/)
    expect(warning(result, 'IMPORT_DOCX_IMAGE_UNSUPPORTED')?.blocking).toBe(true)
  }, 20_000)

  it('rejects a disguised DOCX or entity-bearing XML before conversion', async () => {
    await expect(parse(zipFiles({ 'book.txt': '原文' }), 'book.docx')).rejects.toMatchObject({ code: 'FILE_TYPE_MISMATCH' })
    await expect(parse(docx(paragraph('原文'), { 'word/evil.xml': '<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///secret">]><x>&ext;</x>' }), 'evil.docx')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_UNSAFE' })
  })

  it('rejects DOCX bombs and CRC failures before Mammoth can inflate unchecked', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', 'x'.repeat(1_000_000))
    await expect(parse(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'bomb.docx')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    const bytes = docx(paragraph('原文'))
    const entry = scanArchive(bytes, new ParseContext()).find((entry) => entry.path === 'word/document.xml')!
    bytes[entry.dataOffset] ^= 1
    await expect(parse(bytes, 'corrupt.docx')).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_CORRUPT' })
  })

  it('extracts every physical PDF page, retains last-page tail, blocks unverified mixed coverage', async () => {
    const result = await parse(pdf(['PAGE_ONE', '', 'FINAL_TAIL']), 'mixed.pdf')
    expect(contents(result)).toContain('PAGE_ONE')
    expect(contents(result)).toContain('FINAL_TAIL')
    expect(warning(result, 'IMPORT_VISION_REQUIRED')).toMatchObject({ source: 'mixed.pdf#page=2', blocking: true })
    expect(result.warnings.filter((item) => item.code === 'IMPORT_PDF_COMPLETENESS_UNVERIFIED')).toHaveLength(2)
    expect(warning(result, 'IMPORT_PDF_COVERAGE')?.message).toContain('共 3 页；有原生文字 2 页；无文字待核 1 页；失败 0 页；OCR 0 页')
    expect(chapters(result).some((chapter) => chapter.source.startsWith('mixed.pdf#page=3'))).toBe(true)
    expect(contents(result)).not.toContain('of 3')
  }, 20_000)

  it('never reports blank/scanned PDF as a successful body', async () => {
    const result = await parse(pdf(['', ''], { imagePages: [1, 2] }), 'scan.pdf')
    expect(result.volumes).toEqual([])
    expect(result.warnings.filter((item) => item.code === 'IMPORT_VISION_REQUIRED')).toHaveLength(2)
    expect(warning(result, 'IMPORT_NO_BODY')?.blocking).toBe(true)
  }, 20_000)

  it('blocks image coverage even when a page also has a small native header', async () => {
    const result = await parse(pdf(['header', 'FINAL_TAIL'], { imagePages: [1] }), 'image-mixed.pdf')
    expect(contents(result)).toContain('header')
    expect(contents(result)).toContain('FINAL_TAIL')
    expect(result.warnings.some((item) => item.source === 'image-mixed.pdf#page=1' && item.blocking)).toBe(true)
  }, 20_000)

  it('marks an undecodable middle PDF page unresolved without losing first/last page text', async () => {
    const result = await parse(pdf(['FIRST', 'invalid compression', 'FINAL_TAIL'], { corruptPages: [2] }), 'partial.pdf')
    expect(contents(result)).toContain('FIRST')
    expect(contents(result)).toContain('FINAL_TAIL')
    // PDF.js may recover a corrupt stream as empty text rather than throwing. It is still
    // unresolved, never a verified blank page or silently excluded from the coverage report.
    expect(warning(result, 'IMPORT_VISION_REQUIRED')).toMatchObject({ source: 'partial.pdf#page=2', blocking: true })
  }, 20_000)

  it('accounts for explicit failed and missing converter pages without dropping later pages', async () => {
    const converter = vi.spyOn(converters, 'runConverter').mockResolvedValue({ total: 4, pages: [{ num: 1, text: 'FIRST' }, { num: 2, failed: true }, { num: 4, text: 'FINAL_TAIL' }] })
    try {
      const result = await parse(pdf(['FIRST', '', '', 'FINAL_TAIL']), 'partial.pdf')
      expect(contents(result)).toContain('FINAL_TAIL')
      expect(result.warnings.filter((item) => item.code === 'IMPORT_PDF_PAGE_FAILED').map((item) => item.source)).toEqual(['partial.pdf#page=2', 'partial.pdf#page=3'])
      expect(warning(result, 'IMPORT_PDF_COVERAGE')?.message).toContain('失败 2 页')
    } finally { converter.mockRestore() }
  })

  it('aborts a running converter and cleans up its worker', async () => {
    const controller = new AbortController()
    const promise = parse(pdf(['one']), 'cancel.pdf', { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(promise).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  }, 20_000)

  it('rejects PDF page limits rather than selecting a page prefix', async () => {
    await expect(parse(pdf(Array.from({ length: 1001 }, () => '')), 'too-many.pdf')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
  }, 20_000)

  it('rejects corrupt PDF safely without leaking dependency exception text', async () => {
    await expect(parse(Buffer.from('%PDF-1.4\nnot-a-document'), 'bad.pdf')).rejects.toMatchObject({ code: 'IMPORT_CONVERT_FAILED', message: '文档转换失败或超过资源限制。' })
  }, 20_000)

  it('explicitly rejects real OLE DOC and renamed DOCX, never invokes a shell converter', async () => {
    for (const bytes of [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), docx(paragraph('原文'))]) {
      await expect(parse(bytes, 'legacy.doc')).rejects.toMatchObject({ code: 'IMPORT_UNSUPPORTED_FORMAT' })
    }
  })
})
