import { terminalCandidateSchema, type TerminalCandidate } from './terminal-candidate-contract.js'
import { runtimeJson } from './runtime-common.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'
import { terminalCandidateFacts, terminalFactId } from './terminal-fact-identity.js'
import { readTerminalProposalInput, readTerminalProposalState } from './terminal-proposal-review.js'
import { readAuthenticatedContinuityAssessment } from './authenticated-continuity-assessment.js'
import { authenticatedTerminalDraftIds, authenticatedTerminalReviewAuthority, authenticatedTerminalPreservation, terminalDraftIdentity,
  type TerminalPreservationPolicy } from './terminal-draft-authority.js'
import { inspectTerminalReview, terminalClaims, type TerminalReviewDiagnostic } from './terminal-review-engine.js'
import { effectiveContinuityAudit } from './continuity-coordinator.js'
export * from './terminal-review-engine.js'

export function readTerminalCandidate(validation: unknown): TerminalCandidate | undefined {
  const record = validation && typeof validation === 'object' ? validation as Record<string, unknown> : {}
  const parsed = terminalCandidateSchema.safeParse(record.terminalCandidate)
  return parsed.success ? parsed.data : undefined
}

/** Ledger/proposal IDs are read-only. Only one exact current field/claim can
 * supply an edit address; semantic similarity never authorizes a removal. */
export function currentCandidateEditAddress(candidate: TerminalCandidate, field: string | undefined, claim: string | undefined) {
  const matches = terminalCandidateFacts(candidate).filter(fact => fact.field === field && fact.claim === claim)
  return matches.length === 1 ? { factId: matches[0].id } : null
}

/** Reparse the saved independent response against today's body. A main-agent
 * supplied proof/quote is never accepted as a semantic attestation. */
export type TerminalDeliveryBinding = { taskId: string; preparedContext: unknown; userId?: string; novelId?: string; compilationId?: string;
  draftAuthority?: object; reviewAuthority?: object; scopeAuthority?: object }
export type TerminalDeliveryEligibility = { version: 1; basis: 'fully_supported' | 'current_supported_with_preserved_drafts' | 'preserved_canonical_with_pending_scope' | 'blocked';
  eligible: boolean; preservedUnknownProposalIds: string[]; preservation?: TerminalPreservationPolicy }

/** Delivery may preserve superseded, unverified transient drafts. This never
 * changes independent verdicts, resolves a proposal or discharges a real fact. */
function terminalDeliveryEligibility(review: NonNullable<ReturnType<typeof inspectTerminalReview>>, context?: TerminalEvidenceContext,
  binding?: TerminalDeliveryBinding, auditHash = '', revisionHash = ''): TerminalDeliveryEligibility {
  const unknown = review.proposals?.dispositions.filter(item => item.outcome === 'unknown') ?? []
  const preservedUnknownProposalIds = unknown.map(item => item.id)
  const preservation = context && binding?.scopeAuthority ? authenticatedTerminalPreservation(binding.scopeAuthority,
    terminalDraftIdentity(binding, context, review.candidateHash, auditHash, revisionHash)) : undefined
  const result = (eligible: boolean, basis: TerminalDeliveryEligibility['basis']): TerminalDeliveryEligibility => ({ version: 1, basis, eligible,
    preservedUnknownProposalIds, ...(preservation ? { preservation } : {}) })
  if (review.supported) return result(true, 'fully_supported')
  const currentComplete = review.verdicts.every(item => item.verdict === 'supported'
    || item.verdict === 'unknown' && preservation?.inherited.some(proof => proof.path === item.path))
  const coverageIds = [...(review.factCoverage?.dispositions.map(item => item.id) ?? []),
    ...(review.factCoverage?.serverRejectedReplacements?.map(item => item.id) ?? [])]
  const coverageComplete = review.factCoverage?.version === 2 && coverageIds.length === context?.factCoverage?.obligations.length
    && new Set(coverageIds).size === coverageIds.length && context.factCoverage.obligations.every(item => coverageIds.includes(item.id))
    && review.factCoverage.dispositions.every(item => item.outcome !== 'unknown' || preservation?.pendingCoverageIds.includes(item.id))
    && (review.factCoverage.serverRejectedReplacements ?? []).every(item => preservation?.version === 2 && preservation.pendingCoverageIds.includes(item.id))
  if (preservation && currentComplete && coverageComplete && !unknown.length)
    return result(true, 'preserved_canonical_with_pending_scope')
  const input = context?.proposalChanges
  if (!context || !binding || !input || !unknown.length || !terminalCandidateFacts(review.candidate).length
    || !review.verdicts.length || !currentComplete || !coverageComplete) return result(false, 'blocked')
  try {
    const identity = { taskId: binding.taskId, chapterId: context.current.id, bodyHash: context.current.contentHash,
      sourceHash: runtimeJson({ previous: context.previous }).hash }
    const saved = readTerminalProposalInput(binding.preparedContext, identity, review.candidate)
    const state = readTerminalProposalState(binding.preparedContext, identity)
    if (!saved || !state || runtimeJson(saved).hash !== runtimeJson(input).hash) return result(false, 'blocked')
    const current = new Set(terminalCandidateFacts(review.candidate).map(item => item.id))
    const verified = new Set([...input.verifiedFactIds, ...(context.factCoverage?.obligations.map(item => item.id) ?? []),
      ...(context.previous?.carried?.map(item => terminalFactId(item.field, item.claim)) ?? [])])
    const authenticatedDrafts = authenticatedTerminalDraftIds(binding.draftAuthority, terminalDraftIdentity(binding, context, review.candidateHash, auditHash, revisionHash))
    const eligible = unknown.every(item => {
      const proposal = input.proposals.find(proposal => proposal.id === item.id)
      return proposal && state.pending.some(pending => runtimeJson(pending).hash === runtimeJson(proposal).hash)
        && (['action', 'location', 'storyTime', 'emotion'].includes(proposal.field) || authenticatedDrafts.includes(proposal.id))
        && !current.has(proposal.id) && !verified.has(proposal.id)
        && (proposal.origin.bodyHash === identity.bodyHash || authenticatedDrafts.includes(proposal.id))
        && proposal.origin.sourceHash === identity.sourceHash
    })
    return result(eligible, eligible ? preservation ? 'preserved_canonical_with_pending_scope' : 'current_supported_with_preserved_drafts' : 'blocked')
  } catch { return result(false, 'blocked') }
}

export function currentTerminalReview(validation: unknown, content: string, expectedContext?: TerminalEvidenceContext, binding?: TerminalDeliveryBinding) {
  const record = validation && typeof validation === 'object' ? validation as Record<string, unknown> : {}
  const candidate = readTerminalCandidate(validation)
  const audit = effectiveContinuityAudit(validation) as { parserVersion?: number; terminalEvidence?: unknown; terminalCandidate?: unknown; terminalContentHash?: unknown; rawResponse?: { content?: unknown; complete?: boolean }; responseContract?: unknown } | undefined
  const frozenCandidate = terminalCandidateSchema.safeParse(audit?.terminalCandidate)
  if (!candidate || !frozenCandidate.success || runtimeJson(candidate).hash !== runtimeJson(frozenCandidate.data).hash
    || audit?.terminalContentHash !== runtimeJson({ content }).hash
    || audit?.rawResponse?.complete !== true || typeof audit.rawResponse.content !== 'string') return null
  try {
    if (audit.parserVersion === 9 || audit.parserVersion === 10) {
      if (!binding || !expectedContext || !authenticatedTerminalReviewAuthority(binding.reviewAuthority, terminalDraftIdentity(binding, expectedContext, runtimeJson(candidate).hash,
        runtimeJson(audit).hash, runtimeJson({ newDraftRevision: record.newDraftRevision ?? null, retainedReviewDecision: record.retainedReviewDecision ?? null }).hash))) return null
      const manifest = (audit as unknown as { continuityV4?: { manifest?: { subject?: Record<string, unknown> } } }).continuityV4?.manifest?.subject
      if (!manifest || manifest.taskId !== binding.taskId
        || binding.userId !== undefined && manifest.userId !== binding.userId
        || binding.novelId !== undefined && manifest.novelId !== binding.novelId
        || binding.compilationId !== undefined && manifest.targetId !== binding.compilationId) return null
    }
    const review = readAuthenticatedContinuityAssessment(audit, content, expectedContext, record.independentCheck === 'complete')
    return review ? { ...review, deliveryEligibility: 'establishedIssuesComplete' in review && review.establishedIssuesComplete === false
      ? { version: 1 as const, eligible: false, basis: 'blocked' as const, preservedUnknownProposalIds: [] }
      : terminalDeliveryEligibility(review, expectedContext, binding, runtimeJson(audit).hash,
        runtimeJson({ newDraftRevision: record.newDraftRevision ?? null, retainedReviewDecision: record.retainedReviewDecision ?? null }).hash) } : null
  } catch { return null }
}

export function terminalReviewFailure(validation: unknown, content: string, context?: TerminalEvidenceContext,
  proseReport?: { errors: number; text: string }, binding?: TerminalDeliveryBinding) {
  if (!readTerminalCandidate(validation)) return null
  const review = currentTerminalReview(validation, content, context, binding)
  if (review?.deliveryEligibility.eligible) return null
  const diagnostics = (validation as { continuityCriticResponse?: { terminalReviewDiagnostics?: TerminalReviewDiagnostic[] } }).continuityCriticResponse?.terminalReviewDiagnostics
  if (review && (context?.factCoverage?.version === 2 || context?.verdictProtocol !== undefined)) {
    const claims = terminalClaims(review.candidate)
    const disputed = review.verdicts.filter(item => item.verdict !== 'supported').map(item => ({ path: item.path,
      claim: claims.find(claim => claim.path === item.path)?.claim ?? '', verdict: item.verdict,
      ...('sourceEvidence' in item ? { sourceEvidence: item.sourceEvidence } : {}) }))
    const unresolved = review.factCoverage?.dispositions.filter(item => item.outcome === 'unknown').map(item => {
      const fact = context.factCoverage?.obligations.find(fact => fact.id === item.id)
      return { ...item, readOnlyCoverageId: item.id, fact, currentCandidateEditAddress: currentCandidateEditAddress(review.candidate, fact?.field, fact?.claim) }
    }) ?? []
    const proposals = review.proposals?.dispositions.filter(item => item.outcome === 'unknown').map(item => {
      const proposal = context.proposalChanges?.proposals.find(proposal => proposal.id === item.id)
      return { ...item, readOnlyProposalId: item.id, ...(proposal ? { field: proposal.field, claim: proposal.claim } : {}),
        currentCandidateEditAddress: currentCandidateEditAddress(review.candidate, proposal?.field, proposal?.claim) }
    }) ?? []
    const establishedIssues = (review as { establishedIssueDispositions?: Array<{ issueIndex: number; outcome: string; explanation: string;
      issue?: { text: string } }> }).establishedIssueDispositions?.filter(item => item.outcome === 'unknown') ?? []
    const selectable = context.previous?.carried?.filter(fact => fact.depth < 16
      && context.previous!.carried!.filter(other => other.proofHash === fact.proofHash).length === 1
      && context.previous!.carried!.filter(other => other.field === fact.field && other.claim === fact.claim && other.depth < 16).length === 1
      && (unresolved.some(item => item.fact?.field === fact.field && item.fact.claim === fact.claim)
      || disputed.some(item => item.path.split('.')[1] === fact.field && item.claim === fact.claim)))
      .map(({ proofHash, field, claim }) => ({ proofHash, field, claim })) ?? []
    const selection = selectable.length ? `\n可显式选择的当前有效证明：${JSON.stringify(selectable)}。保持同一 compilationId，可只传顶层 inheritedProofs=[所选proofHash]，服务端在本任务已保存候选上还原原字段与完整主张；这只是待核选择，仍须独立判断本章是否改变。不要复制临时编号或手拼旧事实。` : ''
    const updateGuidance = context.verdictProtocol === 4 || context.verdictProtocol === 5 || context.verdictProtocol === 6
      ? `按实际裁决用 terminalPatch={baseCandidateHash:${JSON.stringify(runtimeJson(review.candidate).hash)},removeFactIds:[],addFacts:[{field,claim}]} 只更新需要处理的候选，未指定项保留；当前事实地址：${JSON.stringify(terminalCandidateFacts(review.candidate).map(({ id, field, claim }) => ({ factId: id, field, claim })))}。removeFactIds 只能使用本次当前事实地址或非空 currentCandidateEditAddress.factId；readOnlyCoverageId、readOnlyProposalId 仅用于核对旧记录，不能当作候选删除地址。删除候选不解除持续事实或旧提议的独立处置要求。也可提供完整 terminalState。更新后调用 continuity_validate；`
      : '按实际裁决更新 terminalState 后调用 continuity_validate；'
    return { reviewCompleted: true, reviewOutcome: 'decision_required' as const,
      summary: '终态候选尚未获独立证实',
      output: `${proseReport ? proseReport.text + '\n' : ''}本次检查尚未通过：独立正文报告已收到，但终态与持续事实尚未获证实，禁止称检查通过或提交。终态待处理候选或旧事实：${JSON.stringify({ disputed, unresolved, ...(proposals.length ? { proposals } : {}), ...(establishedIssues.length ? { establishedIssues } : {}), ...('proofChecks' in review ? { proofChecks: review.proofChecks } : {}) })}。其余已支持项无需同义重写。以本章明确完成证据判为 negated 的旧待办，可据该裁决移除或更新；unknown 不能删空，持续事实请使用已有核验的原字段/原主张证明并核对本章是否变化，不要求正文重述历史。保留事实主体、条件和未解决义务，不把状态误改成已完成。${updateGuidance}同一版本检查通过再 chapter_bridge_commit，${proseReport?.errors ? '正文仍有真实错误，按完整报告、当前证据和原授权处理后复核；终态待核不覆盖这些错误。' : '无需为终态候选改正文或重跑已通过的质量检查。'}${selection}` }
  }
  return { ...(review ? {} : { outcome: 'failed' as const, failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' }), reviewCompleted: !!review,
    reviewOutcome: review ? 'decision_required' as const : 'evidence_repair_required' as const,
    summary: '终态候选尚未获正文证实',
    output: `正文与候选均保留，终态未提交；不把连续性 findings 为空当作终态通过。${review
      ? `逐项核验：${JSON.stringify(review.verdicts.map(item => ({ path: item.path, verdict: item.verdict, evidence: item.evidence })))}${review.factCoverage ? `；持续事实处置：${JSON.stringify(review.factCoverage.dispositions)}` : ''}`
      : `独立响应缺少完整逐项判定或有效 current 原文编号，不能补造证据。${diagnostics?.length ? `终态证据诊断：${JSON.stringify(diagnostics)}。` : ''}`}核对真实正文后，调用 continuity_validate，以 terminalState={exitState,lastUnfinishedAction} 传入完整准确候选重检。候选任何改动（含删除未知项）都须重新核验；重检通过后才可 chapter_bridge_commit，提交同一候选或省略状态复用。不得把计划、推断或转述改称实况，也不要清空已知状态绕过核验。` }
}
