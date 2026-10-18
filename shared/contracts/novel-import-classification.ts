import { z } from 'zod'
import { novelImportSourceSchema } from './novel-import.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const sourceId = z.string().min(1).max(256)
export const IMPORT_CLASSIFICATION_LIMITS = Object.freeze({ sources: 2000, batchSources: 12, inputTokens: 8000, outputTokens: 2000, dispatches: 4, quoteMs: 300_000, timeoutMs: 90_000 })
export const importClassificationSelectionSchema = z.object({ manifestRevision: z.number().int().positive(), manifestHash: hash }).strict()
export const importClassificationRequestSchema = importClassificationSelectionSchema.extend({ quoteId: z.string().uuid(), confirmed: z.literal(true) }).strict()
export const importClassificationLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chapter'), volumeIndex: z.number().int().nonnegative(), chapterIndex: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('plan'), index: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('memory'), index: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('skipped'), index: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: z.string().uuid() }).strict(),
])

/** Server-only reader output. All leaf sources, with explicitly partial excerpts.
 * sourceId must already exist in the persisted manifest/report. No fabricated IDs.
 * Artifacts use the actual database ID, not a URL or parser-local logical ID.
 * complete describes source enumeration, NOT OCR quality or AI understanding.
 */
export const importClassificationSourcesSchema = importClassificationSelectionSchema.extend({
  complete: z.literal(true),
  sources: z.array(z.object({ sourceId, title: z.string().max(512), textHash: hash, characters: z.number().int().nonnegative().max(5_000_000), excerpt: z.object({ start: z.number().int().nonnegative(), text: z.string().max(2000) }).strict(), source: novelImportSourceSchema.optional(), location: importClassificationLocationSchema, artifactId: z.string().uuid().optional() }).strict()).min(1).max(IMPORT_CLASSIFICATION_LIMITS.sources),
  artifacts: z.array(z.object({ artifactId: z.string().uuid(), sha256: hash, coverCandidate: z.boolean() }).strict()).max(IMPORT_CLASSIFICATION_LIMITS.sources),
}).strict()
const evidence = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1).max(160) }).strict()
export const importClassificationOutputSchema = z.object({
  classifications: z.array(z.object({
    sourceId, category: z.enum(['chapter', 'plan', 'characterCard', 'worldbuilding', 'storyBible', 'skip']),
    confidence: z.number().finite().min(0).max(1), evidence: z.array(evidence).max(2),
  }).strict()).min(1).max(IMPORT_CLASSIFICATION_LIMITS.batchSources),
  cover: z.object({ sourceId, artifactId: z.string().uuid(), confidence: z.number().finite().min(0).max(1), evidence: z.array(evidence).min(1).max(2) }).strict().nullable(),
}).strict()
export type ImportClassificationSelection = z.infer<typeof importClassificationSelectionSchema>
export type ImportClassificationRequest = z.infer<typeof importClassificationRequestSchema>
export type ImportClassificationSources = z.infer<typeof importClassificationSourcesSchema>
export type ImportClassificationOutput = z.infer<typeof importClassificationOutputSchema>
export type ImportClassificationProof = ImportClassificationSources['sources'][number]
export type ImportClassificationDecision = ImportClassificationOutput['classifications'][number] & { reason: 'classified' | 'uncertain' | 'missing_source' | 'unclassified_budget' }
export type ImportClassificationResult = Omit<ImportClassificationOutput, 'classifications'> & ImportClassificationSelection & { classifications: ImportClassificationDecision[]; snapshotHash: string; sourceProofs: ImportClassificationProof[]; artifacts: ImportClassificationSources['artifacts'] }
export interface ImportClassificationSkipped { sourceId: string; title: string; content: string; source?: z.infer<typeof novelImportSourceSchema>; reason: ImportClassificationDecision['reason']; originalLocation: z.infer<typeof importClassificationLocationSchema> }
export interface ImportClassificationQuote extends ImportClassificationSelection {
  quoteId: string; snapshotHash: string; fingerprint: string; kind: 'basic' | 'custom'; modelName: string | null
  reasoningEffort: string; maxInputTokens: number; maxOutputTokens: number; maxDispatches: number
  batchCount: number; analyzedSourceCount: number; unclassifiedSourceCount: number
  expiresAt: string; notice: string
}
export interface ImportClassificationRecord extends ImportClassificationSelection {
  id: string; snapshotHash: string; status: 'quoted' | 'pending' | 'succeeded' | 'failed' | 'unknown'
  result: ImportClassificationResult | null; errorCode: string | null; message: string | null
  completedBatches: number; batchCount: number
  /** Advisory only. Applying ALWAYS requires a fresh transaction-level fence. */
  applicable: boolean
}
