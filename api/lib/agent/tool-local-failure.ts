import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'

export const toolRestrictionSchema = z.object({
  action: z.string().min(1), target: z.string().nullable(), code: z.string().min(1), reason: z.string().min(1),
  reviewInput: z.object({ chapterId: z.string().min(1), revision: z.number().int().positive() }).strict().optional(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()
export type ToolRestriction = z.infer<typeof toolRestrictionSchema>

const localCodes = new Set(['CONTINUITY_CHECK_LIMIT', 'CONTINUITY_CHECK_BUDGET_EXCEEDED', 'REVIEW_AUTOMATION_STOPPED',
  'REPAIR_NOT_AUTHORIZED', 'REVIEW_REPAIR_RECHECK_REQUIRED', 'QUALITY_REPAIR_LIMIT', 'AI_QUALITY_NON_THINKING_UNSUPPORTED',
  'CONTINUITY_REPORT_INCOMPLETE', 'CONTINUITY_EVIDENCE_UNLOCATED', 'QUALITY_REPORT_INCOMPLETE', 'QUALITY_EVIDENCE_UNLOCATED'])

/** Historical review phases and known report failures are audits, not current
 * capability revocations. Unknown provider effects are fenced separately. */
export function isHistoricalReviewRestriction(item: ToolRestriction): boolean {
  if (item.code === 'STRUCTURE_RETRY_LIMIT' || item.reason === '结构操作连续失败，已隔离该目标的操作以免重复创建或错位；其他原授权工作可继续。') return true
  const manuscript = ['chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_bridge_commit', 'continuity_validate', 'quality_analyze'].includes(item.action)
  if (manuscript && (item.code === 'REPAIR_NOT_AUTHORIZED' || isInputScopedFailure(item.code))) return true
  // Keep the saved failure, while actual tools validate every current call.
  // Search/Fetch retain their own contracts. Failed structure attempts never
  // prove a creation effect; actual success/unknown receipts fence duplicates.
  if (!['web_search', 'web_read'].includes(item.action) && isInputScopedFailure(item.code)
    && item.reason === '连续三次参数无效，该工具未完成；继续其他可执行工作。') return true
  return ['CONTINUITY_CHECK_LIMIT', 'CONTINUITY_CHECK_BUDGET_EXCEEDED', 'CONTINUITY_PHASE_AUTHORITY_REQUIRED',
    'CONTINUITY_REPORT_INCOMPLETE', 'CONTINUITY_EVIDENCE_UNLOCATED', 'QUALITY_REPORT_INCOMPLETE',
    'QUALITY_EVIDENCE_UNLOCATED', 'REVIEW_DEPENDENCY_UNAVAILABLE', 'REVIEW_AUTOMATION_STOPPED',
    'REVIEW_REPAIR_RECHECK_REQUIRED', 'REVIEW_MERGED_REVISION_REQUIRED', 'QUALITY_REPAIR_LIMIT'].includes(item.code)
}

/** This allowlist describes confirmed local rejections, never uncertain external
 * effects, revoked execution authority, cancellation or corrupt receipts. */
export function isLocalToolFailure(code: string | undefined): boolean { return !!code && localCodes.has(code) }

/** Confirmed argument/locator errors are not a revoked manuscript capability. */
export function isInputScopedFailure(code: string): boolean {
  return ['CHAPTER_ANCHOR_CONFLICT', 'INVALID_ARGUMENTS', 'TOOL_SCHEMA_INVALID',
    'TOOL_ARGUMENTS_INVALID', 'TOOL_ARGUMENTS_INCOMPLETE', 'TOOL_NORMALIZATION_FAILED'].includes(code)
}
export function toolFailureInputHash(action: string, args: unknown): string {
  return runtimeJson(JSON.parse(JSON.stringify({ action, args: args ?? null, anchorProtocol: 2 }))).hash
}

/** Preserve old failure audits, but narrow confirmed unexecuted-input bans.
 * This is a one-time schema conversion; it neither grants a target nor records
 * progress. Real tools still verify current authority, revision and the body. */
export function restoreToolRestriction(item: ToolRestriction): ToolRestriction {
  if (item.inputHash || !isInputScopedFailure(item.code)) return item
  return { ...item, inputHash: item.code === 'CHAPTER_ANCHOR_CONFLICT'
    ? runtimeJson({ legacyAnchorRestriction: 1, action: item.action, target: item.target, reason: item.reason }).hash
    : runtimeJson({ legacyInputRestriction: 1, action: item.action, target: item.target, code: item.code, reason: item.reason }).hash }
}

export function toolRestrictionTarget(args: unknown, fallbackChapterId?: string | null): string | null {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const target = ['compilationId', 'chapterId', 'memoryId', 'volumeId', 'taskId']
    .map(key => value[key]).find(item => typeof item === 'string' && item.trim())
  return typeof target === 'string' ? target.trim() : fallbackChapterId?.trim() || null
}

export function findToolRestriction(restrictions: readonly ToolRestriction[], action: string, args: unknown, fallbackChapterId?: string | null, reviewInput?: { chapterId: string; revision: number } | null) {
  const target = toolRestrictionTarget(args, fallbackChapterId)
  return restrictions.find(item => !isHistoricalReviewRestriction(item) && item.action === action && (item.target === null || item.target === target)
    && (!item.inputHash || item.inputHash === toolFailureInputHash(action, args))
    && (!item.reviewInput || !reviewInput || item.reviewInput.chapterId !== reviewInput.chapterId || item.reviewInput.revision === reviewInput.revision))
}
