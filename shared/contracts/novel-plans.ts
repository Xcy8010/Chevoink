import { z } from 'zod'

export const planKindSchema = z.enum(['outline', 'detail'])
export const planTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chapter'), chapterId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('future'), targetOrderIndex: z.number().int().positive().max(2_147_483_647) }).strict(),
])
export type PlanKind = z.infer<typeof planKindSchema> | 'legacy'
export type PlanTarget = z.infer<typeof planTargetSchema>
export const planMetadataPatchSchema = z.object({
  planKind: planKindSchema.optional(),
  parentPlanId: z.string().trim().min(1).nullable().optional(),
  expectedParentPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  target: planTargetSchema.nullable().optional(),
  expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
export type PlanMetadataPatch = z.infer<typeof planMetadataPatchSchema>
export type PlanLinkFields = {
  planKind: PlanKind
  planHash: string
  parentPlanId: string | null
  parentPlanHash: string | null
  target: PlanTarget | null
  reviewState: 'unlinked' | 'current' | 'stale' | 'missing_parent'
}
