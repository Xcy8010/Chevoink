import { z } from 'zod'

export const toolRestrictionSchema = z.object({
  action: z.string().min(1), target: z.string().nullable(), code: z.string().min(1), reason: z.string().min(1),
}).strict()
export type ToolRestriction = z.infer<typeof toolRestrictionSchema>

const localCodes = new Set(['CONTINUITY_CHECK_LIMIT', 'CONTINUITY_CHECK_BUDGET_EXCEEDED', 'REVIEW_AUTOMATION_STOPPED',
  'REPAIR_NOT_AUTHORIZED', 'REVIEW_REPAIR_RECHECK_REQUIRED', 'QUALITY_REPAIR_LIMIT', 'AI_QUALITY_NON_THINKING_UNSUPPORTED', 'QUALITY_REPORT_INCOMPLETE', 'QUALITY_EVIDENCE_UNLOCATED'])

/** This allowlist describes confirmed local rejections, never uncertain external
 * effects, revoked execution authority, cancellation or corrupt receipts. */
export function isLocalToolFailure(code: string | undefined): boolean { return !!code && localCodes.has(code) }

export function toolRestrictionTarget(args: unknown, fallbackChapterId?: string | null): string | null {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const target = ['compilationId', 'chapterId', 'memoryId', 'volumeId', 'taskId']
    .map(key => value[key]).find(item => typeof item === 'string' && item.trim())
  return typeof target === 'string' ? target.trim() : fallbackChapterId?.trim() || null
}

export function findToolRestriction(restrictions: readonly ToolRestriction[], action: string, args: unknown, fallbackChapterId?: string | null) {
  const target = toolRestrictionTarget(args, fallbackChapterId)
  return restrictions.find(item => item.action === action && (item.target === null || item.target === target))
}
