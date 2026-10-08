import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'

export const toolRestrictionSchema = z.object({
  action: z.string().min(1), target: z.string().nullable(), code: z.string().min(1), reason: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()
export type ToolRestriction = z.infer<typeof toolRestrictionSchema>

const localCodes = new Set(['CONTINUITY_CHECK_LIMIT', 'CONTINUITY_CHECK_BUDGET_EXCEEDED', 'REVIEW_AUTOMATION_STOPPED',
  'REPAIR_NOT_AUTHORIZED', 'REVIEW_REPAIR_RECHECK_REQUIRED', 'QUALITY_REPAIR_LIMIT', 'AI_QUALITY_NON_THINKING_UNSUPPORTED',
  'CONTINUITY_REPORT_INCOMPLETE', 'CONTINUITY_EVIDENCE_UNLOCATED', 'QUALITY_REPORT_INCOMPLETE', 'QUALITY_EVIDENCE_UNLOCATED'])

/** This allowlist describes confirmed local rejections, never uncertain external
 * effects, revoked execution authority, cancellation or corrupt receipts. */
export function isLocalToolFailure(code: string | undefined): boolean { return !!code && localCodes.has(code) }

/** Confirmed argument/locator errors are not a revoked manuscript capability. */
export function isInputScopedFailure(code: string): boolean {
  return ['CHAPTER_ANCHOR_CONFLICT', 'INVALID_ARGUMENTS'].includes(code)
}
export function toolFailureInputHash(action: string, args: unknown): string {
  return runtimeJson(JSON.parse(JSON.stringify({ action, args: args ?? null, anchorProtocol: 2 }))).hash
}

/** Preserve old failure audits, but narrow the obsolete family-wide anchor ban.
 * This is a one-time schema conversion; it neither grants a target nor records
 * progress. Real tools still verify current authority, revision and the body. */
export function restoreToolRestriction(item: ToolRestriction): ToolRestriction {
  return item.code === 'CHAPTER_ANCHOR_CONFLICT' && !item.inputHash
    ? { ...item, inputHash: runtimeJson({ legacyAnchorRestriction: 1, action: item.action, target: item.target, reason: item.reason }).hash }
    : item
}

export function toolRestrictionTarget(args: unknown, fallbackChapterId?: string | null): string | null {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const target = ['compilationId', 'chapterId', 'memoryId', 'volumeId', 'taskId']
    .map(key => value[key]).find(item => typeof item === 'string' && item.trim())
  return typeof target === 'string' ? target.trim() : fallbackChapterId?.trim() || null
}

export function findToolRestriction(restrictions: readonly ToolRestriction[], action: string, args: unknown, fallbackChapterId?: string | null) {
  const target = toolRestrictionTarget(args, fallbackChapterId)
  return restrictions.find(item => item.action === action && (item.target === null || item.target === target)
    && (!item.inputHash || item.inputHash === toolFailureInputHash(action, args)))
}
