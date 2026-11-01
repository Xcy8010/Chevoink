import { z } from 'zod'
export const adminModelKindSchema = z.enum(['text', 'vision', 'image_generation', 'web_search', 'web_fetch'])
export type AdminModelKind = z.infer<typeof adminModelKindSchema>
const revision = z.number().int().positive().max(2147483646)
export const archiveAdminModelSchema = z.object({ expectedRevision: revision, previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(1000), replacementId: z.string().min(1).max(64).optional(), replacementRevision: revision.optional() }).strict()
export const restoreAdminModelSchema = z.object({ expectedRevision: revision, reason: z.string().trim().min(1).max(1000) }).strict()
export type ArchiveAdminModelInput = z.infer<typeof archiveAdminModelSchema>
export type RestoreAdminModelInput = z.infer<typeof restoreAdminModelSchema>
export type AdminModelLifecyclePreview = {
  id: string; revision: number; archivedAt: string | null; displayName: string; modelKind: AdminModelKind; isDefault: boolean; systemRoles: string[]
  impact: { queued: number; running: number; paused: number; historicalCalls: number; assignments: number; queuedRequests: number; goals: number; schedules: number; imports: number }
  historyAttribution: 'tier'; previewHash: string
  candidates: Array<{ id: string; displayName: string; revision: number; modelKind: AdminModelKind; eligible: boolean; reasons: string[] }>
}
export type AdminModelLifecycleResult = { id: string; revision: number; archived: boolean }
