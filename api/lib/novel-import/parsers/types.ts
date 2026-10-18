import type { ImportEvidence, ImportImage } from '../document-types.js'
export type NovelImportChapter = { title: string; content: string; source: string }
export type NovelImportVolume = { title: string; chapters: NovelImportChapter[] }
export type NovelImportWarning = { code: string; message: string; source?: string; blocking: boolean }
export type ParsedNovelImport = {
  volumes: NovelImportVolume[]
  metadata: { title?: string; summary?: string; tags?: string[] }
  warnings: NovelImportWarning[]
  /** UTF-16 code units in decoded, newline-normalized source text, including headings. */
  sourceChars: number
  parserVersion: string
  /** Optional enriched pipeline result; never send image bytes directly over HTTP. */
  images?: ImportImage[]
  evidence?: ImportEvidence
  /** 标题关键词路由出的计划/设定段落（content-routing），不进 volumes。 */
  plans?: Array<{ title: string; content: string; source?: string }>
  memories?: Array<{ memoryType: 'characterCard' | 'worldbuilding' | 'storyBible'; title: string; content: string; source?: string }>
}
export type NovelImportParseOptions = { encoding?: string; signal?: AbortSignal;
  /** Trusted orchestration only, not uploaded options/manifest fields. */
  resources?: boolean;
  durationMs?: number;
  nativeParser?: (buffer: Buffer, filename: string, signal?: AbortSignal) => Promise<ParsedNovelImport>
}

export const NOVEL_IMPORT_PARSER_VERSION = 'deterministic-1'

export function emptyImport(): ParsedNovelImport {
  return { volumes: [], metadata: {}, warnings: [], sourceChars: 0, parserVersion: NOVEL_IMPORT_PARSER_VERSION }
}

/** No business/DB error dependency: callers map this stable code to their API envelope. */
export class NovelImportParseError extends Error {
  constructor(public readonly code: string, message: string, public readonly source?: string) {
    super(message)
    this.name = 'NovelImportParseError'
  }
}
