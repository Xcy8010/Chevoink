import { z } from 'zod'

export const NOVEL_IMPORT_LIMITS = { sourceBytes: 50 * 1024 * 1024, characters: 5_000_000, chapters: 2000, volumes: 200, chapterCharacters: 100_000 } as const
export interface NovelImportCapabilities { enabled: boolean; overwriteEnabled: boolean; overwriteVerified: false; restoreEnabled: false; retainsEmptyVolumes: true; sourceBytes: number; aiEnabled: false; formats: { extension: string; enabled: boolean; reason?: string }[]; limitations: string[] }
export const novelImportSourceSchema = z.object({
  filename: z.string().max(512).optional(), memberPath: z.string().max(4096).optional(),
  page: z.number().int().positive().optional(), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(),
}).strict()
export const novelImportVolumeSchema = z.object({
  title: z.string().trim().min(1).max(128),
  // Preserve oversized individual chapters in previews so humans can split them.
  // The commit service independently enforces chapterCharacters without truncation.
  chapters: z.array(z.object({ title: z.string().trim().min(1).max(128), content: z.string().max(NOVEL_IMPORT_LIMITS.characters), source: novelImportSourceSchema })).max(NOVEL_IMPORT_LIMITS.chapters),
}).strict()
export const novelImportMetadataSchema = z.object({ title: z.string().trim().min(1).max(128).optional(), summary: z.string().max(20_000).optional(), tags: z.array(z.string().max(64)).max(20).optional() }).strict()
export const novelImportModelSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('basic') }).strict(), z.object({ kind: z.literal('custom'), customModelId: z.string().min(1).max(64) }).strict()])
export const novelImportCreateSchema = z.object({ intentId: z.string().uuid(), modelSelection: novelImportModelSchema.optional() }).strict()
export const novelImportManifestEditSchema = z.object({ expectedManifestRevision: z.number().int().positive(), volumes: z.array(novelImportVolumeSchema).min(1).max(NOVEL_IMPORT_LIMITS.volumes), metadataSelection: novelImportMetadataSchema.optional() }).strict()
export const novelImportConfirmSchema = z.object({ manifestRevision: z.number().int().positive(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), targetHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const novelImportCommitSchema = z.object({ approvalId: z.string().uuid(), idempotencyKey: z.string().min(8).max(128) }).strict()
export const novelImportIntentConfirmSchema = z.object({ step: z.union([z.literal(1), z.literal(2)]), targetHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type NovelImportVolume = z.infer<typeof novelImportVolumeSchema>
export type NovelImportModelSelection = z.infer<typeof novelImportModelSchema>
export type NovelImportManifestEdit = z.infer<typeof novelImportManifestEditSchema>
export interface NovelImportWarning { code: string; message: string; source?: unknown; blocking: boolean }
export interface NovelImportPreview {
  manifestRevision: number; manifestHash: string; sourceHash: string; parserVersion: string
  volumes: NovelImportVolume[]; metadata: z.infer<typeof novelImportMetadataSchema>
  metadataSelection: z.infer<typeof novelImportMetadataSchema>; warnings: NovelImportWarning[]; sourceChars: number
}
export type NovelImportStatus = 'uploading' | 'uploaded' | 'parsing' | 'needs_review' | 'ready' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
export interface NovelImportPreflight { intentId: string; targetHash: string; volumeCount: number; chapterCount: number; nonEmptyChapterCount: number; overwriteRequired: boolean; confirmationStep: number; expiresAt: string }
export interface NovelImportReceipt { jobId: string; novelId: string; backupId: string; volumeCount: number; chapterCount: number; wordCount: number; firstChapterId: string; targetHash: string; restoreExpiresAt: string }
export interface NovelImportJobStatus { jobId: string; novelId: string; status: NovelImportStatus; jobVersion: number; manifestRevision: number; manifestHash: string | null; sourceHash: string | null; targetHash: string; errorCode: string | null; expiresAt: string; receipt: NovelImportReceipt | null }
