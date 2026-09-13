import { setImmediate } from 'node:timers/promises'
import { NovelImportParseError, type ParsedNovelImport } from './types.js'

export const NOVEL_IMPORT_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  entryBytes: 50 * 1024 * 1024,
  decompressedBytes: 200 * 1024 * 1024,
  entries: 3000,
  compressionRatio: 200,
  sourceChars: 5_000_000,
  chapters: 2000,
  volumes: 200,
  pdfPages: 1000,
  warnings: 5000,
  durationMs: 120_000,
})

export class ParseContext {
  readonly deadline = Date.now() + NOVEL_IMPORT_LIMITS.durationMs
  decompressedBytes = 0
  entries = 0
  sourceChars = 0
  constructor(readonly signal?: AbortSignal) {}
  check() {
    if (this.signal?.aborted) throw new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。')
    if (Date.now() > this.deadline) throw new NovelImportParseError('IMPORT_LIMIT_EXCEEDED', '文档解析超时，请拆分文件。')
  }
  async checkpoint() {
    await setImmediate()
    this.check()
  }
  addChars(chars: number) {
    this.sourceChars += chars
    limit(this.sourceChars <= NOVEL_IMPORT_LIMITS.sourceChars, '原文字符数超过 500 万，请拆分文件。')
  }
}

export function limit(condition: boolean, message: string, source?: string): asserts condition {
  if (!condition) throw new NovelImportParseError('IMPORT_LIMIT_EXCEEDED', message, source)
}

export function checkStructure(result: ParsedNovelImport) {
  limit(result.volumes.length <= NOVEL_IMPORT_LIMITS.volumes, '卷数超过 200，请拆分文件。')
  limit(result.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0) <= NOVEL_IMPORT_LIMITS.chapters,
    '章节数超过 2000，请拆分文件。')
  limit(result.warnings.length <= NOVEL_IMPORT_LIMITS.warnings, '解析警告数超过安全限制，请拆分文件。')
}

export function isFatal(error: unknown): boolean {
  return error instanceof NovelImportParseError &&
    ['IMPORT_CANCELLED', 'IMPORT_LIMIT_EXCEEDED', 'IMPORT_ARCHIVE_UNSAFE'].includes(error.code)
}

export function hasUnsafeControls(value: string, textWhitespace = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 127 || (code < 32 && !(textWhitespace && [9, 10, 12, 13].includes(code)))) return true
  }
  return false
}
