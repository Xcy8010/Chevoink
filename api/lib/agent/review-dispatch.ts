import { COMPILER_CONTINUITY_PROTOCOL } from './compiler-continuity-contract.js'
import type { ChapterReviewReadiness } from './chapter-review-guard.js'
import { projectReviewCycle } from './review-cycle.js'

export const currentReviewStepStates = ['blocked', 'check_required', 'terminal_review_required', 'must_pass_required', 'decision_required', 'commit_available'] as const
type CurrentReviewState = typeof currentReviewStepStates[number]

/** Current facts only. This is neither a writing grant nor a retry/paid-call instruction. */
export function projectCurrentReviewNextStep(readiness: ChapterReviewReadiness) {
  const retained = readiness.retainedDecisions ?? []
  const same = (a: { source: string; reportId: string; findingId: string }, b: typeof a) =>
    a.source === b.source && a.reportId === b.reportId && a.findingId === b.findingId
  const pending = (readiness.requiredDecisions ?? []).filter(item => !retained.some(saved => same(item, saved)))
  const decisionPending = readiness.decisionPending ?? (readiness.continuityErrorCount > 0 || readiness.qualityErrorCount > 0
    || (readiness.qualityCandidateCount ?? 0) > 0)
  const state: CurrentReviewState = !readiness.ready ? 'check_required'
    : readiness.mustPassPending ? 'must_pass_required'
      : decisionPending ? 'decision_required' : 'commit_available'
  const cycle = readiness.reviewCycle ?? projectReviewCycle(null, { revision: readiness.revision,
    contentHash: readiness.decisionBinding?.contentHash ?? '', ready: readiness.ready, pending: decisionPending, findings: [] })
  return { version: 1 as const, compilationId: readiness.compilationId, chapterId: readiness.chapterId, revision: readiness.revision,
    phase: cycle.phase, reviewCycle: cycle,
    ...(readiness.reviewBoundPlan ? { reviewBoundPlan: readiness.reviewBoundPlan } : {}),
    ...(readiness.terminalReview ? { terminalReview: readiness.terminalReview } : {}),
    state, continuity: readiness.continuity, quality: readiness.quality, binding: readiness.decisionBinding ?? null,
    requiredTools: readiness.requiredTools, pending, details: (readiness.decisionDetails ?? []).filter(item => state === 'must_pass_required' || pending.some(ref => same(item, ref))),
    decisionBatchesAvailable: readiness.reviewProtocol === 1,
    retainedCount: retained.length, automaticCandidateCount: readiness.qualityCandidateCount ?? 0,
    completeStrictReview: readiness.completeStrictReview === true, selectionOnly: readiness.selectionOnly === true,
    retentionCompletes: state === 'decision_required' && !readiness.mustPassPending, unresolvedFactErrors: readiness.continuityErrorCount + readiness.qualityErrorCount }
}

export type CurrentReviewNextStep = NonNullable<ReturnType<typeof projectCurrentReviewNextStep>>
export function currentReviewNextStepGuidance(step: CurrentReviewNextStep) {
  const facts = `当前 compilationId=${step.compilationId}、chapterId=${step.chapterId}、r${step.revision}：连续性=${step.continuity}，人类感=${step.quality}。${step.reviewBoundPlan?.guidance ?? ''}`
  const scope = step.selectionOnly
    ? '原任务仅授权局部范围，使用 chapter_edit_range 的当前唯一逐字锚点，保留范围外正文；不得使用 chapter_write 或 chapter_append 扩大范围。'
    : '根据当前真实报告，在原作者授权内按当前正文的唯一逐字锚点修订；报告本身不扩大写入权限。'
  if (step.state === 'check_required') return `${facts}当前版本尚缺有效检查：${JSON.stringify(step.requiredTools)}。调用相应工具只需 chapterId 或 compilationId；已知格式失败不是正文问题，未知供应商结果或费用须先核对，不能重放未知请求。`
  if (step.state === 'commit_available') return `${facts}当前必要检查已保存，可调用一次 chapter_bridge_commit 提交当前版本。提交工具会补齐仍缺的必要检查并核对当前版本与权限；实际提交回执才表示完成。`
  const decisions = `当前真实意见：${JSON.stringify(step.details)}。${scope}意见无法安全修改时，使用当前报告的 source、reportId、findingId、reason 在 retainedFindings 中写明具体原因；留置不是修复，也不是检查通过。`
  if (step.state === 'must_pass_required') return `${facts}${decisions}原作者明确要求检查通过，留置不能替代硬通过要求；按证据合法修改后复核最终版本。`
  return `${facts}${decisions}检查可在同一授权条件下自动局部修订；有新 revision 时须复查新版，旧报告不能认证新版。全部修改完成后核对当前两项必要检查，再调用一次 chapter_bridge_commit。`
}

export function reviewDispatchKey(readiness: { compilationId: string | null; chapterId: string; revision: number }, name: string): string {
  const base = `${readiness.compilationId}:${readiness.chapterId}:${readiness.revision}:${name}`
  return name === 'continuity_validate' ? `${base}:protocol${COMPILER_CONTINUITY_PROTOCOL}` : base
}

/** A completed assessment can still have one unspent, authorized decision.
 * This schedules a prompt, never a write, paid request or a new repair round. */
export function nextMergedReviewReminder(readiness: ChapterReviewReadiness | null,
  available: ReadonlySet<string>, attempted: ReadonlySet<string>, channelOpen: boolean): string | null {
  if (!readiness?.ready || !readiness.checksRequired || !channelOpen
    || !(readiness.decisionPending ?? (readiness.continuityErrorCount > 0 || (readiness.qualityCandidateCount ?? 0) > 0))
    || !['chapter_edit_range', 'chapter_write', 'chapter_bridge_commit'].some(name => available.has(name))) return null
  const key = reviewDispatchKey(readiness, 'merged')
  return attempted.has(key) ? null : key
}

/** Pending means an actual unresolved request, not a prior known failure.
 * Registered tools recheck source, authorization, provider receipts and billing. */
export function nextReviewDispatch(readiness: ChapterReviewReadiness | null,
  available: ReadonlySet<string>, pending: ReadonlySet<string>) {
  if (!readiness || readiness.ready) return { kind: 'ready' as const }
  const tool = readiness.requiredTools[0]
  if (!tool) return { kind: 'blocked' as const, reason: '当前版本的必要检查尚未确认完成。正文已保存，不能提交为完成。' }
  const key = reviewDispatchKey(readiness, tool.name)
  if (pending.has(key)) return { kind: 'blocked' as const, reason: '此前的检查请求结果或费用尚未确认，未重放付费请求。' }
  if (!available.has(tool.name)) return { kind: 'blocked' as const,
    reason: '原任务允许的工具中缺少必要检查，正文与进度保留；未扩大工具权限，也未判定任务完成。' }
  return { kind: 'tool' as const, tool, key }
}
