import { z } from 'zod'
import { NOVEL_IMPORT_LIMITS, novelImportMetadataSchema, type NovelImportPreview } from './novel-import.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const index = z.number().int().nonnegative().max(NOVEL_IMPORT_LIMITS.chapters)
export const novelImportReviewSchema = z.object({
  expectedManifestRevision: z.number().int().positive(), manifestHash: hash, reportHash: hash,
  decisions: z.array(z.object({ itemId: z.string().min(1).max(256), action: z.enum(['exclude', 'review']), reason: z.string().trim().min(1).max(1000) }).strict()).min(1).max(1000),
}).strict()
export const novelImportStructureSchema = z.object({
  expectedManifestRevision: z.number().int().positive(), manifestHash: hash,
  metadataSelection: novelImportMetadataSchema.optional(),
  volumes: z.array(z.object({ title: z.string().trim().min(1).max(128), chapters: z.array(z.object({
    title: z.string().trim().min(1).max(128), segments: z.array(z.object({ volumeIndex: index, chapterIndex: index, start: z.number().int().nonnegative().max(NOVEL_IMPORT_LIMITS.characters), end: z.number().int().nonnegative().max(NOVEL_IMPORT_LIMITS.characters) }).strict()).min(1).max(4000),
  }).strict()).max(NOVEL_IMPORT_LIMITS.chapters) }).strict()).min(1).max(NOVEL_IMPORT_LIMITS.volumes),
}).strict()
export interface NovelImportArtifactDescriptor { id: string; source: string; sha256: string; bytes: number; mediaType: 'image/png'; width: number; height: number; coverCandidate: boolean; url: string }
export interface NovelImportReportItem {
  id: string; kind: 'file' | 'page' | 'block' | 'region' | 'image'; source: string; parentId?: string
  status: 'native' | 'ocr' | 'needs_review' | 'failed' | 'verified_blank' | 'excluded'
  excludable: boolean; page?: number; artifactId?: string; text?: string; duplicateOf?: string
  bbox?: [number, number, number, number]; confidence?: number | null
}
export interface NovelImportReportIssue { id: string; code: string; message: string; blocking: boolean; itemIds: string[]; resolution: 'review' | 'exclude' | 'none' }
export interface NovelImportDocumentReport { version: 1; sourceId: string; sourceHash: string; parserVersion: string; items: NovelImportReportItem[]; issues: NovelImportReportIssue[]; complete: boolean }
export interface NovelImportSourceDecision { itemId: string; action: 'exclude' | 'review'; reason: string; sourceHash: string; reportHash: string; contentHash: string; reviewedAt: string }
export interface NovelImportEvidencePreview extends NovelImportPreview {
  report?: NovelImportDocumentReport; reportHash?: string; artifacts?: NovelImportArtifactDescriptor[]
  decisions?: NovelImportSourceDecision[]; partialImport?: boolean
}
export interface NovelImportReportDto {
  manifestRevision: number; manifestHash: string; reportHash: string; sourceHash: string; partialImport: boolean
  items: Array<Omit<NovelImportReportItem, 'text'> & { textHash?: string; characters?: number }>
  issues: Array<NovelImportReportIssue & { resolved: boolean }>; decisions: NovelImportSourceDecision[]; artifacts: NovelImportArtifactDescriptor[]
}
export interface NovelImportPreviewSummary extends Omit<NovelImportEvidencePreview, 'volumes' | 'report'> {
  volumes: Array<{ title: string; chapters: Array<{ title: string; source: NovelImportPreview['volumes'][number]['chapters'][number]['source']; volumeIndex: number; chapterIndex: number; contentHash: string; characters: number; nonEmpty: boolean }> }>
}
export interface NovelImportChapterDto { manifestRevision: number; manifestHash: string; volumeIndex: number; chapterIndex: number; title: string; content: string; contentHash: string; characters: number; source: NovelImportPreview['volumes'][number]['chapters'][number]['source'] }
