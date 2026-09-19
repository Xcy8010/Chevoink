import { z } from 'zod'

/** Agent 2.0 P1 卷模型与结构操作契约。 */
export const volumeSchema = z.object({
  id: z.string().min(1),
  novelId: z.string().min(1),
  title: z.string().min(1).max(128),
  summary: z.string().nullable(),
  orderIndex: z.number().int().positive(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const volumeListItemSchema = volumeSchema.pick({
  id: true,
  novelId: true,
  title: true,
  summary: true,
  orderIndex: true,
  revision: true,
}).extend({
  chapterCount: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
})

export const createVolumeSchema = z.object({
  title: z.string().trim().min(1).max(128),
  summary: z.string().optional(),
  position: z.number().int().positive().optional(),
})

export const updateVolumeSchema = z.object({
  title: z.string().trim().min(1).max(128).optional(),
  summary: z.string().nullable().optional(),
  expectedRevision: z.number().int().positive().optional(),
})

export const moveVolumeSchema = z.object({
  position: z.number().int().positive(),
  expectedRevision: z.number().int().positive().optional(),
})

/** Human confirmation binds the exact chapters that will move with removal. */
export const deleteVolumeSchema = z.object({
  expectedRevision: z.number().int().positive(),
  moveChapters: z.literal(true),
  targetVolumeId: z.string().min(1),
  expectedChapterRevisions: z.array(z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict()).max(10000),
}).strict()
export type DeleteVolumeRequest = z.infer<typeof deleteVolumeSchema>

export const moveChapterSchema = z.object({
  targetVolumeId: z.string().min(1),
  position: z.number().int().positive(),
  expectedRevision: z.number().int().positive().optional(),
})

export const splitChapterSchema = z.object({
  splitOffset: z.number().int().nonnegative(),
  newChapterTitle: z.string().trim().min(1).max(120),
  expectedRevision: z.number().int().positive().optional(),
})

export const mergeChaptersSchema = z.object({
  sourceChapterId: z.string().min(1),
  separator: z.string().max(16).default('\n\n'),
  expectedTargetRevision: z.number().int().positive().optional(),
  expectedSourceRevision: z.number().int().positive().optional(),
})

export const structureIssueSchema = z.object({
  code: z.enum([
    'VOLUME_ORDER_GAP',
    'CHAPTER_ORDER_GAP',
    'GLOBAL_ORDER_GAP',
    'CHAPTER_VOLUME_MISMATCH',
    'STRUCTURE_TITLE_EMPTY',
  ]),
  message: z.string(),
  entityId: z.string().nullable(),
})

export const structureReportSchema = z.object({
  valid: z.boolean(),
  volumeCount: z.number().int().nonnegative(),
  chapterCount: z.number().int().nonnegative(),
  issues: z.array(structureIssueSchema),
})

export type Volume = z.infer<typeof volumeSchema>
export type VolumeListItem = z.infer<typeof volumeListItemSchema>
export type CreateVolumeRequest = z.infer<typeof createVolumeSchema>
export type UpdateVolumeRequest = z.infer<typeof updateVolumeSchema>
export type MoveVolumeRequest = z.infer<typeof moveVolumeSchema>
export type MoveChapterRequest = z.infer<typeof moveChapterSchema>
export type SplitChapterRequest = z.infer<typeof splitChapterSchema>
export type MergeChaptersRequest = z.infer<typeof mergeChaptersSchema>
export type StructureIssue = z.infer<typeof structureIssueSchema>
export type StructureReport = z.infer<typeof structureReportSchema>
