import type { z } from 'zod'
import type { NovelImportChapterDto, NovelImportPreviewSummary, NovelImportReportDto, novelImportReviewSchema, novelImportStructureSchema, novelImportSelectionSchema } from '../../../shared/contracts/novel-import-preview.js'
import { requestData } from './api'

export type ImportStructureEdit = z.infer<typeof novelImportStructureSchema>
export type ImportSelectionEdit = z.infer<typeof novelImportSelectionSchema>
export type ImportReviewEdit = z.infer<typeof novelImportReviewSchema>
const path = (novelId: string, jobId: string) => `/api/novels/${encodeURIComponent(novelId)}/imports/${encodeURIComponent(jobId)}`
export const importPreviewApi = {
  summary: (novelId: string, jobId: string) => requestData<NovelImportPreviewSummary>(`${path(novelId, jobId)}/preview?view=summary`),
  chapter: (novelId: string, jobId: string, revision: number, volume: number, chapter: number) => requestData<NovelImportChapterDto>(`${path(novelId, jobId)}/chapters/${volume}/${chapter}?manifestRevision=${revision}`),
  report: (novelId: string, jobId: string) => requestData<NovelImportReportDto>(`${path(novelId, jobId)}/report`),
  structure: (novelId: string, jobId: string, edit: ImportStructureEdit) => requestData<NovelImportPreviewSummary>(`${path(novelId, jobId)}/structure`, { method: 'PATCH', body: JSON.stringify(edit) }),
  selection: (novelId: string, jobId: string, edit: ImportSelectionEdit) => requestData<NovelImportPreviewSummary>(`${path(novelId, jobId)}/selection`, { method: 'POST', body: JSON.stringify(edit) }),
  review: (novelId: string, jobId: string, edit: ImportReviewEdit) => requestData<NovelImportPreviewSummary>(`${path(novelId, jobId)}/review`, { method: 'POST', body: JSON.stringify(edit) }),
}
