import { requestData } from './api'

export type ImportSuggestionSelection = { manifestRevision: number; manifestHash: string; volumeIndex: number; chapterIndex: number }
export type ImportSuggestionBoundary = { offset: number; title: string }
export type ImportSuggestionResult = { id: string; status: 'succeeded' | 'pending' | 'failed'; result: { boundaries: ImportSuggestionBoundary[]; note: string } | null; errorCode?: string | null }
export type ImportSuggestionRecord = ImportSuggestionResult & ImportSuggestionSelection
export type ImportSuggestionQuote = { fingerprint: string; modelName: string | null; kind: 'basic' | 'custom'; reasoningEffort: string; maxInputTokens: number; maxOutputTokens: number; notice: string }
const path = (novelId: string, jobId: string) => `/api/novels/${encodeURIComponent(novelId)}/imports/${encodeURIComponent(jobId)}/suggestions`
export const importSuggestionsApi = {
  list: (novelId: string, jobId: string) => requestData<ImportSuggestionRecord[]>(path(novelId, jobId)),
  quote: (novelId: string, jobId: string, selection: ImportSuggestionSelection) => requestData<ImportSuggestionQuote>(`${path(novelId, jobId)}/quote`, { method: 'POST', body: JSON.stringify(selection) }),
  request: (novelId: string, jobId: string, selection: ImportSuggestionSelection, fingerprint: string) => requestData<ImportSuggestionResult>(path(novelId, jobId), { method: 'POST', body: JSON.stringify({ ...selection, fingerprint, confirmed: true }), timeoutMs: 120_000 }),
}

export function validateImportBoundaries(content: string, boundaries: ImportSuggestionBoundary[]): boolean {
  return !!content.trim() && boundaries.length > 0 && boundaries.length <= 40 && boundaries[0].offset === 0
    && boundaries.every((item, index) => Number.isInteger(item.offset) && item.offset >= 0 && item.offset < content.length
      && !!item.title.trim() && item.title.length <= 128
      && (index === 0 || item.offset > boundaries[index - 1].offset && content[item.offset - 1] === '\n'))
}
