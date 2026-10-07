import { z } from 'zod'

export const writingVolumeBoundarySchema = z.object({
  previousChapterId: z.string().min(1).max(64), previousRevision: z.number().int().positive(),
  quote: z.string().trim().min(12).max(1600), completedObjective: z.string().trim().min(2).max(500),
  nextConflict: z.string().trim().min(2).max(500),
}).strict()
export const writingNewVolumeSchema = z.object({
  title: z.string().trim().min(1).max(128), summary: z.string().trim().min(1).max(2000), boundary: writingVolumeBoundarySchema,
}).strict()
export const writingVolumeDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continue'), reason: z.string().trim().min(2).max(1000) }).strict(),
  z.object({ kind: z.literal('new_volume'), reason: z.string().trim().min(2).max(1000), newVolume: writingNewVolumeSchema }).strict(),
])
export const writingTailVolumeCapabilitySchema = z.object({ version: z.literal(1), targetOrderIndex: z.number().int().positive(),
  previousChapterId: z.string().min(1), previousRevision: z.number().int().positive() }).strict()
export type WritingVolumeDecision = z.infer<typeof writingVolumeDecisionSchema>
export type WritingNewVolume = z.infer<typeof writingNewVolumeSchema>
