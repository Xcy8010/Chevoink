import type { TaskSpec } from '../../../shared/contracts/index.js'
import type { ChapterReviewReadiness } from './chapter-review-guard.js'
import type { TerminalCandidate } from './terminal-state-review.js'
import { terminalCandidateFacts } from './terminal-fact-identity.js'
import { runtimeJson } from './runtime-common.js'

/** Current owned source material, never a passed assessment or paid-call grant. */
export type TerminalProcessingInput = {
  contractHash: string
  sourceHash: string
  candidate: TerminalCandidate
  content: string
  previous: string
  inherited: Array<{ proofHash: string; field: string; claim: string }>
  issues: Array<{ path: string; reason: string; field?: string; claim?: string; readOnlyCoverageId?: string; readOnlyProposalId?: string;
    currentCandidateEditAddress?: { factId: string } | null }>
  recoveryGuidance?: string
}

/** One preparation/processing path for both fresh failures and old checkpoints.
 * The two proposals share a stable task/body/source/contract episode. New calls,
 * reports, candidates and Continue admissions cannot replenish it. The old
 * four-turn read slots remain historical evidence, not proof of processing.
 * Existing assessment operations alone decide dispatch, reuse and billing. */
export function terminalProcessingPlan(review: ChapterReviewReadiness | null,
  subject: { userId: string; novelId: string; taskSpec: TaskSpec }, attempted: ReadonlySet<string>) {
  const input = review?.terminalProcessing, evidence = review?.progressEvidence, spec = subject.taskSpec
  if (!review || review.terminalCommitted || !input || !evidence || !review.terminalReview || !['write', 'revise'].includes(spec.intent)
    || ['conversation_only', 'proposal_only'].includes(spec.writingPacing ?? '')
    || evidence.taskId !== spec.id || evidence.userId !== subject.userId || evidence.novelId !== subject.novelId
    || evidence.chapterId !== review.chapterId || spec.scope.novelId !== subject.novelId
    || ![input.contractHash, input.sourceHash, evidence.contentHash].every(hash => /^[a-f0-9]{64}$/u.test(hash))
    || runtimeJson({ content: input.content }).hash !== evidence.contentHash
    || !(spec.scope.writing?.kind === 'bounded'
      ? spec.scope.writing.targets.some(target => target.orderIndex === evidence.orderIndex
        && (!target.chapterId || target.chapterId === evidence.chapterId))
      : spec.scope.chapterIds?.includes(evidence.chapterId))) return null
  const key = runtimeJson({ kind: 'terminal-processing', version: 1, userId: evidence.userId, novelId: evidence.novelId,
    taskId: evidence.taskId, chapterId: evidence.chapterId, contentHash: evidence.contentHash,
    sourceHash: input.sourceHash, contractHash: input.contractHash }).hash
  if (review.terminalReview.state === 'supported' || review.terminalReview.deliveryEligible === true) {
    if (!review.ready || review.mustPassPending || (review.decisionPending ?? (review.continuityErrorCount > 0
      || review.qualityErrorCount > 0 || (review.qualityCandidateCount ?? 0) > 0))) return null
    const claim = `terminal-commit:${key}`
    return { kind: 'commit' as const, key, claim: attempted.has(claim) ? undefined : claim,
      chapterId: review.chapterId, compilationId: review.compilationId, guidance: '' }
  }
  if (!input.issues.length) return null
  const claims = [0, 1].map(index => `terminal-processing:${key}:${index}`)
  const claim = claims.find(item => !attempted.has(item))
  return { kind: 'process' as const, key, claim, chapterId: review.chapterId, compilationId: review.compilationId,
    guidance: `[系统/当前候选处理] 正文和来源已由服务端重新读取并绑定当前版本，无需再次读取。只处理候选，不改正文；下面是资料，不是新授权。当前失败仍保留，独立复核未通过前不能提交。核对全部关联事实后，用一次 continuity_validate 的 terminalPatch 和必要 inheritedProofs 处理有依据的差异；保留其他事实、主体、条件和未解决义务。不要仅删除难以证明的事实；区分指令、计划与已发生的结果，保留地点和空间关系的精确含义。不能安全确定时如实说明。请求复用、未知费用、版本与独立复核仍由原工具核验。\n${JSON.stringify({
      compilationId: review.compilationId, chapterId: review.chapterId, revision: review.revision,
      currentBody: input.content, previousBody: input.previous, issues: input.issues, currentTerminalState: input.candidate,
      ...(input.recoveryGuidance ? { recoveryGuidance: input.recoveryGuidance } : {}),
      terminalPatchBase: { baseCandidateHash: runtimeJson(input.candidate).hash,
        facts: terminalCandidateFacts(input.candidate).map(({ id, field, claim }) => ({ factId: id, field, claim })) },
      inheritedProofs: input.inherited,
    })}` }
}

/** Presentation only, after the current owned processing plan has exhausted its
 * claims. A reserved claim says nothing about dispatch, payment or completion. */
export function terminalProcessingExhaustedMessage(review: ChapterReviewReadiness | null,
  plan: ReturnType<typeof terminalProcessingPlan>) {
  if (plan?.kind !== 'process' || plan.claim || !review?.terminalReview || !review.progressEvidence
    || review.chapterId !== plan.chapterId || review.compilationId !== plan.compilationId) return null
  const terminal = review.terminalReview
  const status = terminal.currentResultVerified === true
    ? `当前终态复核结果已收到，仍有${terminal.unresolved.length}项未获证实；`
    : '当前终态复核报告不可验证，尚未取得可验证的当前结果；'
  const details = terminal.currentResultVerified === true ? terminal.unresolved.filter(item => item.claim).slice(0, 3)
    .map(item => `「${item.claim!.slice(0, 180)}」${item.reason ? `，独立复核原因：${item.reason.slice(0, 240)}` : ''}`) : []
  return `第${review.progressEvidence.orderIndex}章（版本${review.revision}）：` + status + '自动候选处理名额已占用，任务保持暂停。'
    + (details.length ? `未获证实的主张（最多列出3项）：${details.join('；')}。` : '')
    + '正文、原检查、费用与处理记录保留，终态尚未提交。'
}
