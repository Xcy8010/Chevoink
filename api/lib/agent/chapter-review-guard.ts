import { createHash } from 'node:crypto'

import { Prisma } from '@prisma/client'
import { currentReviewNextStepGuidance, projectCurrentReviewNextStep } from './review-dispatch.js'
import { DataAccessError } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { continuityCheckRounds } from './story-compiler.js'
import { readOriginalTaskRequest, originalTaskRunIds, originalRepairAuthority } from './original-request.js'
import { activeChapterScope } from '../data/internal.js'
import { compilerContinuityCoverage, currentCompilerContinuityAssessment, continuityStoryInput, storedContinuityProtocol } from './compiler-continuity-contract.js'
import { qualityReportCheckedCurrentContent, selectAutomaticQualityFindings } from './quality-report-contract.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { runtimeJson } from './runtime-common.js'
import { assertSelectionBodyEffect, effectiveWritingTaskSpec, originalSelectionBoundary } from './writing-scope.js'
import { hasReadOnlyRevisionAssessment, localEditGuidance, localRevisionAuthorityText, originalLocalEditBoundary } from './local-edit-scope.js'
import { projectReviewCycle, readReviewCycle, reviewCycleFinding, type ReviewCycleFinding, type ReviewCycle, type ReviewCycleBinding } from './review-cycle.js'
import { observedReviewCycleVerification, prepareReviewCycleTransition } from './review-cycle-store.js'
import { readTerminalCandidate } from './terminal-state-review.js'
import { type TerminalCandidateCorrection } from './terminal-candidate-feedback.js'
import type { TerminalProcessingInput } from './terminal-processing.js'

import type { ChapterReviewProgressEvidence } from './semantic-progress.js'
import { originalChapterReviewRequirements } from './chapter-review-requirements.js'
export { originalChapterReviewRequirements } from './chapter-review-requirements.js'
import { projectReviewBoundEditPlan, type ReviewBoundEditPlan, type ReviewBoundEvidence } from './review-bound-edit.js'

export type ChapterReviewDecision = { source: 'continuity' | 'quality'; reportId: string; findingId: string }
export type RetainedChapterReviewDecision = ChapterReviewDecision & { reason: string }
export type ReviewDecisionFeedback = { key: string; taskId: string; userId: string; novelId: string; chapterId: string;
  orderIndex: number; compilationId: string; revision: number; contentHash: string }
export type ChapterReviewDecisionDetail = ChapterReviewDecision & { evidence: string; explanation: string; suggestion: string; severity: string; disposition: string; startOffset?: number; endOffset?: number }
type ReviewStatus = 'complete' | 'missing' | 'stale' | 'incomplete'
// Prisma rows contain Dates; persist only JSON-safe finding data in the binding.
function qualityDecisionHash(findings: unknown[], version?: 2) {
  const safe = JSON.parse(JSON.stringify(findings)) as unknown[]
  return runtimeJson(version === 2 ? safe.map(row => JSON.stringify(runtimeJson(row).value)).sort() : safe).hash
}

/** v1 keeps its original array meaning. A scoped frozen baseline can prove
 * that only the database return order changed; it cannot repair changed rows. */
function qualityBindingMatches(binding: { qualityReportId?: unknown; qualityReportHash?: unknown; qualityReportHashVersion?: unknown;
  contentHash?: unknown; continuityBinding?: unknown }, report: { id: string; findings: unknown[] } | null,
  compilationId: string, chapter: { id: string; revision: number; contentHash: string }, cycle?: ReviewCycle | null) {
  if (binding.qualityReportHashVersion !== undefined && binding.qualityReportHashVersion !== 2) return false
  if (binding.qualityReportId !== (report?.id ?? null)) return false
  if (!report) return binding.qualityReportHash === null
  if (binding.qualityReportHash === qualityDecisionHash(report.findings, binding.qualityReportHashVersion)) return true
  const baseline = cycle?.baseline
  if (binding.qualityReportHashVersion !== undefined || !baseline || cycle!.scope.chapterId !== chapter.id
    || baseline.compilationId !== compilationId || baseline.body.revision !== chapter.revision || baseline.body.contentHash !== chapter.contentHash
    || baseline.binding.contentHash !== binding.contentHash || baseline.binding.continuityBinding !== binding.continuityBinding
    || baseline.binding.qualityReportHashVersion !== undefined || baseline.binding.qualityReportId !== report.id
    || baseline.binding.qualityReportHash !== binding.qualityReportHash) return false
  const refs = baseline.findings.filter(finding => finding.source === 'quality')
  const rows = report.findings.map(row => row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : null)
  if (refs.length !== rows.length || refs.some(ref => ref.reportId !== report.id)
    || rows.some(row => !row || typeof row.id !== 'string' || !row.id) || new Set(rows.map(row => row!.id)).size !== rows.length
    || new Set(refs.map(ref => ref.findingId)).size !== refs.length) return false
  const byId = new Map(rows.map(row => [row!.id, row!]))
  if (refs.some(ref => !byId.has(ref.findingId))) return false
  return qualityDecisionHash(refs.map(ref => byId.get(ref.findingId)!)) === binding.qualityReportHash
}
/** Read tools order findings for presentation; compare the full persisted set. */
export function qualityDecisionSnapshotHash(findings: unknown[]) {
  return runtimeJson(findings.map(item => JSON.stringify(item)).sort()).hash
}
/** Single chapter, same transaction, before its body CAS only. Never retain
 * this scope on a context or reuse it after a manuscript/source write. */
export type ChapterReviewReadScope = {
  inheritanceScope: import('./terminal-inheritance-chain.js').TerminalInheritanceReadScope
  terminalDraftScope: import('./terminal-draft-authority.js').TerminalDraftReadScope
}
export function createChapterReviewReadScope(): ChapterReviewReadScope {
  return { inheritanceScope: { identities: new Set(), authenticating: new Set(), authenticated: new Map() }, terminalDraftScope: new WeakMap() }
}

export type ChapterReviewRevisionOptions = {
  readScope?: ChapterReviewReadScope
  requireQualityChannel?: boolean
  /** Pending quality has no persisted report yet; check required continuity
   * before paying for a repair, without treating candidates as a report. */
  requireCurrentContinuity?: boolean
  mutation?: 'replace' | 'range' | 'append'
  mergedBatch?: boolean
  after?: string
  editRanges?: Array<{ start: number; end: number; newText: string }>
  retainedFindings?: Array<{ source: 'continuity' | 'quality'; reportId: string; findingId: string; reason: string }>
  pendingQuality?: { compilationId: string; candidates: number }
}
export type ChapterReviewReadiness = {
  terminalCommitted?: boolean
  terminalProcessing?: TerminalProcessingInput
  terminalCorrection?: TerminalCandidateCorrection
  reviewBoundPlan?: ReviewBoundEditPlan
  terminalReview?: { state: 'supported' | 'unverified';
    /** True only after replaying the independent response against current bound evidence. */
    currentResultVerified?: boolean;
    deliveryEligible?: boolean;
    unresolved: Array<{ path: string; verdict: string; field?: string; claim?: string; reason?: string;
      readOnlyCoverageId?: string; readOnlyProposalId?: string; currentCandidateEditAddress?: { factId: string } | null }> }
  /** Server-only mutation proof projection; ordinary read tools never request it. */
  reviewBoundEvidence?: ReviewBoundEvidence
  reviewCycle?: ReturnType<typeof projectReviewCycle>
  reviewCycleFindings?: ReviewCycleFinding[]
  reviewProtocol?: 1
  completeStrictReview?: boolean
  selectionOnly?: boolean
  progressEvidence?: ChapterReviewProgressEvidence
  ready: boolean; checksRequired: boolean; compilationId: string; chapterId: string; revision: number
  continuity: ReviewStatus; quality: ReviewStatus; continuityErrorCount: number; qualityErrorCount: number
  qualityCandidateCount?: number
  /** Current bound decisions, independent of paid repair quotas. */
  decisionPending?: boolean
  decisionFeedbackSnapshotHash?: string
  decisionFeedback?: ReviewDecisionFeedback
  decisionDetails?: ChapterReviewDecisionDetail[]
  requiredDecisions?: ChapterReviewDecision[]
  retainedDecisions?: RetainedChapterReviewDecision[]
  decisionEntries?: ChapterReviewDecision[]
  mustPassPending?: boolean
  qualityPassRequired?: boolean
  decisionBinding?: ReviewCycleBinding
  continuityExhausted?: boolean
  qualityReportId: string | null; requiredTools: Array<{ name: 'continuity_validate' | 'quality_analyze'; args: { compilationId: string } }>
}

/** Retention is a current, explicit decision; a paid reservation is not one.
 * Undefined report checks only continuity decisions for canonical preservation;
 * the ordinary commit caller still supplies the real current quality report. */
export function retainedReviewDecisionMatches(validation: unknown, chapter: { id: string; revision: number; content: string },
  compilationId: string, report: { id: string; findings: unknown[] } | null | undefined,
  required: Array<{ source: string; reportId: string; findingId: string }>, cycle?: ReviewCycle | null) {
  const value = validation && typeof validation === 'object' && !Array.isArray(validation) ? validation as Record<string, unknown> : null
  const decision = value?.retainedReviewDecision as Record<string, unknown> | undefined
  if (!decision || decision.version !== 1 || decision.chapterId !== chapter.id || decision.revision !== chapter.revision
    || decision.contentHash !== runtimeJson({ content: chapter.content }).hash
    || decision.continuityBinding !== continuityDecisionBinding(compilationId, chapter.revision, validation)
    || decision.qualityReportHashVersion !== undefined && decision.qualityReportHashVersion !== 2
    || report !== undefined && !qualityBindingMatches(decision, report, compilationId,
      { id: chapter.id, revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash }, cycle)
    || !Array.isArray(decision.findings)) return false
  const entries = decision.findings as Array<{ source?: string; reportId?: string; findingId?: string; reason?: string }>
  const key = (item: typeof entries[number]) => `${item.source}:${item.reportId}:${item.findingId}`
  return entries.every(item => item && typeof item.reason === 'string' && item.reason.trim())
    && new Set(entries.map(key)).size === entries.length
    && required.every(item => entries.some(entry => key(entry) === key(item)))
}

export function hasPendingChapterReviewDecision(readiness: ChapterReviewReadiness) {
  return readiness.decisionPending ?? (readiness.continuityErrorCount > 0 || readiness.qualityErrorCount > 0 || (readiness.qualityCandidateCount ?? 0) > 0)
}

/** Only authenticated original human text may waive a delivery assessment. */

/** Server COMMIT proof preserves the exact reviewed bridge; it never rewrites
 * a critic's hash. Any subsequent story-state change invalidates this proof. */
export function terminalReviewStateHash(bridge: unknown, sceneTasks: unknown[]) {
  return runtimeJson({ bridge: continuityStoryInput(JSON.parse(JSON.stringify(bridge))), scenes: continuityStoryInput(JSON.parse(JSON.stringify(sceneTasks))) }).hash
}

/** Fresh current-state assessments take precedence over the original COMMIT
 * proof. The proof only preserves an assessment of the reviewed precommit
 * bridge; it must not hide a later read-only assessment of the terminal bridge. */
export function readCurrentCompilerContinuity(compilation: {
  status: string; stage: string; validation: unknown; preparedContext: unknown
  bridge: { targetRevision: number | null; committedAt: Date | null }; sceneTasks: Array<{ ordinal: number }>
}, chapter: { id: string; title?: string; revision: number; content: string; orderIndex: number }, source: unknown | null) {
  const validation = compilation.validation && typeof compilation.validation === 'object' && !Array.isArray(compilation.validation)
    ? compilation.validation as Record<string, unknown> : null
  const scenes = [...compilation.sceneTasks].sort((a, b) => a.ordinal - b.ordinal)
  const coverageFor = (bridge: unknown) => compilerContinuityCoverage({ chapter, bridge, sceneTasks: scenes, source,
    focus: typeof validation?.reviewFocus === 'string' ? validation.reviewFocus : undefined, terminalCandidate: readTerminalCandidate(validation) }, storedContinuityProtocol(validation))
  const coverage = coverageFor(compilation.bridge)
  const assessment = currentCompilerContinuityAssessment(validation, chapter, coverage)
  if (assessment) return { assessment, coverage, checkedBridge: compilation.bridge }
  const context = compilation.preparedContext && typeof compilation.preparedContext === 'object' && !Array.isArray(compilation.preparedContext)
    ? compilation.preparedContext as Record<string, unknown> : null
  const proof = context?.terminalReviewProof && typeof context.terminalReviewProof === 'object' && !Array.isArray(context.terminalReviewProof)
    ? context.terminalReviewProof as Record<string, unknown> : null
  const proofCurrent = compilation.status === 'completed' && compilation.stage === 'commit' && compilation.bridge.targetRevision === chapter.revision
    && !!compilation.bridge.committedAt && context?.terminalContentHash === runtimeJson({ content: chapter.content }).hash
    && proof?.version === 2 && !!proof.checkedBridge && typeof proof.checkedBridge === 'object' && !Array.isArray(proof.checkedBridge)
    && proof.terminalStateHash === terminalReviewStateHash(compilation.bridge, scenes)
  const proofCoverage = proofCurrent ? coverageFor(proof!.checkedBridge) : null
  const proofAssessment = proofCoverage ? currentCompilerContinuityAssessment(validation, chapter, proofCoverage) : null
  return { assessment: proofAssessment, coverage: proofAssessment ? proofCoverage! : coverage,
    checkedBridge: proofAssessment ? proof!.checkedBridge : compilation.bridge }
}

/** A pure persisted-state read: no paid calls, reservations, repairs or counters.
 * Callers dispatch only the returned tools through the ordinary tool journal. */
export async function readChapterReviewReadiness(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, compilationId?: string,
  options?: { reviewBoundEvidence?: true; readScope?: ChapterReviewReadScope; terminalDraftScope?: import('./terminal-draft-authority.js').TerminalDraftReadScope }): Promise<ChapterReviewReadiness | null> {
  void options
  const original = await readOriginalTaskRequest(tx, subject), runIds = await originalTaskRunIds(tx, subject, original)
  const compilation = await tx.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds },
    ...(compilationId ? { id: compilationId } : {}), status: { in: ['active','completed'] } }, include: { bridge: true, chapter: true }, orderBy: { createdAt: 'desc' } })
  if (!compilation?.chapter || !compilation.bridge || !compilation.chapter.content.trim()) return null
  const chapter = compilation.chapter
  const { buildContinuitySnapshot, readContinuityReport } = await import('./continuity-review.js')
  const raw = compilation.validation && typeof compilation.validation === 'object' && !Array.isArray(compilation.validation) ? compilation.validation : {}
  const snapshot = await buildContinuitySnapshot({ ...subject, chapterId: chapter.id }, { compilationId: compilation.id, chapterId: chapter.id,
    ...(typeof raw.reviewFocus === 'string' ? { focus: raw.reviewFocus } : {}) }, tx)
  const report = readContinuityReport(raw, chapter, snapshot.contextHash), requirements = originalChapterReviewRequirements(original, chapter)
  const qualityReport = await tx.chapterQualityReport.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id,
    compilationId: compilation.id, runId: { in: runIds } }, include: { findings: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const metrics = qualityReport?.deterministicMetrics && typeof qualityReport.deterministicMetrics === 'object' && !Array.isArray(qualityReport.deterministicMetrics)
    ? qualityReport.deterministicMetrics : {}
  let qualityContextCurrent = false
  const qualityBodyCurrent = !!qualityReport && qualityReportCheckedCurrentContent(qualityReport, chapter.revision, chapter.content)
  if (qualityBodyCurrent && typeof metrics.qualityContextHash === 'string') {
    const { buildHumanityQualityContext, qualityReviewContextHash } = await import('./humanity-quality.js')
    qualityContextCurrent = metrics.qualityContextHash === qualityReviewContextHash(await buildHumanityQualityContext(subject.userId, subject.novelId, chapter.id, subject.runId, tx),
      metrics.criticPromptProtocol === 'humanity-context.v2' || metrics.criticPromptProtocol === 'humanity-context.v3'
        || metrics.criticPromptProtocol === 'humanity-context.v4' || metrics.criticPromptProtocol === 'humanity-context.v5'
        || metrics.criticPromptProtocol === 'humanity-context.v6' ? metrics.criticPromptProtocol : undefined)
  }
  // Historical delivery compatibility remains bound to the saved body.
  // Context matching is required below before deriving executable edit proof.
  const qualityComplete = qualityBodyCurrent
  const continuity: ReviewStatus = report ? report.complete && report.billingKnown ? 'complete' : 'incomplete' : raw.checkedRevision !== undefined ? 'stale' : 'missing'
  const quality: ReviewStatus = qualityComplete ? 'complete' : !qualityReport ? 'missing' : qualityReport.chapterRevision !== chapter.revision ? 'stale' : 'incomplete'
  const entries: ChapterReviewDecisionDetail[] = [
    ...(report?.complete ? report.findings.map(finding => ({ source: 'continuity' as const, reportId: report.id, findingId: finding.id,
      evidence: finding.evidence, explanation: finding.explanation, suggestion: finding.suggestion, severity: finding.severity, disposition: 'pending',
      startOffset: finding.startOffset, endOffset: finding.endOffset })) : []),
    ...(qualityComplete ? qualityReport!.findings.filter(finding => finding.disposition !== 'repaired').map(finding => ({
      source: 'quality' as const, reportId: qualityReport!.id, findingId: finding.id, evidence: finding.evidenceExcerpt, explanation: finding.explanation,
      suggestion: finding.suggestion, severity: finding.severity, disposition: finding.disposition, startOffset: finding.startOffset, endOffset: finding.endOffset })) : []),
  ]
  const prepared = compilation.preparedContext && typeof compilation.preparedContext === 'object' && !Array.isArray(compilation.preparedContext) ? compilation.preparedContext : {}
  const cycle = readReviewCycle(prepared, { taskId: original.taskId, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id })
  const retained = retainedReviewDecisionMatches(raw, chapter, compilation.id, qualityComplete ? qualityReport : null, [], cycle)
    ? (raw.retainedReviewDecision as { findings: RetainedChapterReviewDecision[] }).findings : []
  const spec: Record<string, unknown> = original.spec && typeof original.spec === 'object' && !Array.isArray(original.spec) ? original.spec as Record<string, unknown> : {}
  const scope: Record<string, unknown> = spec.scope && typeof spec.scope === 'object' && !Array.isArray(spec.scope) ? spec.scope as Record<string, unknown> : {}
  const strictQuality = !['stable', 'bold'].includes(String(spec.creativeFreedom))
  const completeStrictReview = scope.reviewProtocol === 1 && strictQuality
  const automaticQuality = qualityComplete ? selectAutomaticQualityFindings(qualityReport!.findings) : []
  const contentHash = runtimeJson({ content: chapter.content }).hash
  const lastReviewedEdit = cycle?.transitions.at(-1)?.after
  const verifyingEditedBody = !!cycle?.baseline && lastReviewedEdit?.revision === chapter.revision && lastReviewedEdit.contentHash === contentHash
  // A final check can discover fresh advice on an already revised draft.
  // Keep it in the real report without turning each new suggestion into
  // another mandatory edit/decision cycle. Errors and explicit hard-pass
  // requirements below remain delivery obligations.
  const requiredDecisions = entries.filter(entry => entry.source === 'continuity'
    ? entry.severity === 'error' || !verifyingEditedBody && completeStrictReview && requirements.continuity
    : (completeStrictReview || automaticQuality.some(finding => finding.id === entry.findingId))
      && (entry.severity === 'error' || requirements.quality && strictQuality) && (!verifyingEditedBody || entry.severity === 'error'))
    .map(({ source, reportId, findingId }) => ({ source, reportId, findingId }))
  const { requiresCompletedReview } = await import('./writing-delivery-limitations.js')
  const constraints = [original.prompt ?? '',
    ...(Array.isArray(spec.hardConstraints) ? spec.hardConstraints.flatMap(item => item && typeof item === 'object' && typeof item.text === 'string' ? [item.text] : []) : []),
    ...(Array.isArray(spec.postconditions) ? spec.postconditions.flatMap(item => item && typeof item === 'object' && item.severity === 'error' && typeof item.description === 'string' ? [item.description] : []) : []),
  ].flatMap(text => text.split(/[。！？!?；;\n，,]+/u)).filter(requiresCompletedReview)
  const qualityTerms = /质量|人类感|AI味|quality/iu, continuityTerms = /连续性|连贯性|一致性|continuity/iu
  const mustPassQuality = constraints.some(text => qualityTerms.test(text) || !continuityTerms.test(text))
  const mustPassContinuity = constraints.some(text => continuityTerms.test(text) || !qualityTerms.test(text))
  const mandatoryReviewPending = mustPassContinuity && !!report?.findings.some(finding => finding.severity === 'error')
    || mustPassQuality && qualityComplete && qualityReport!.status !== 'passed'
  const decisionPending = mandatoryReviewPending || requiredDecisions.some(entry => !retained.some(item =>
    item.source === entry.source && item.reportId === entry.reportId && item.findingId === entry.findingId))
  const requiredTools: ChapterReviewReadiness['requiredTools'] = []
  if (requirements.continuity && continuity !== 'complete') requiredTools.push({ name: 'continuity_validate', args: { compilationId: compilation.id } })
  if (requirements.quality && quality !== 'complete') requiredTools.push({ name: 'quality_analyze', args: { compilationId: compilation.id } })
  const ready = !requiredTools.length
  const semanticFindings = [
    ...(report?.complete ? report.findings.map(finding => ({ source: 'continuity', signal: finding.signal, severity: finding.severity,
      evidence: finding.evidence, suggestion: finding.suggestion })) : []),
    ...(qualityComplete ? qualityReport!.findings.map(finding => ({ source: 'quality', signal: finding.signal, severity: finding.severity,
      evidence: finding.evidenceExcerpt, explanation: finding.explanation, suggestion: finding.suggestion, start: finding.startOffset, end: finding.endOffset,
      disposition: finding.disposition, authorFeedback: finding.authorFeedback, feedbackReason: finding.feedbackReason })) : []),
  ].map(item => JSON.stringify(item)).sort()
  const decisionFeedback: ReviewDecisionFeedback | undefined = ready && decisionPending && continuity === 'complete' && qualityComplete && qualityContextCurrent
    ? { key: runtimeJson({ taskId: original.taskId, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, contentHash, findings: semanticFindings }).hash,
      taskId: original.taskId, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, orderIndex: chapter.orderIndex,
      compilationId: compilation.id, revision: chapter.revision, contentHash } : undefined
  const cycleFindings = entries.map(entry => {
    const finding = reviewCycleFinding({ source: entry.source, reportId: entry.reportId, findingId: entry.findingId,
      signal: entry.source === 'quality' ? qualityReport!.findings.find(row => row.id === entry.findingId)!.signal
        : report!.findings.find(row => row.id === entry.findingId)!.signal,
      severity: entry.severity, evidence: entry.evidence, explanation: entry.explanation, suggestion: entry.suggestion,
      startOffset: entry.startOffset, endOffset: entry.endOffset }, chapter.content)
    const qualityFinding = entry.source === 'quality' ? qualityReport!.findings.find(row => row.id === entry.findingId) : null
    if (qualityFinding && Number.isInteger(entry.startOffset) && Number.isInteger(entry.endOffset)
      && entry.startOffset !== undefined && entry.endOffset !== undefined && entry.startOffset >= 0 && entry.endOffset > entry.startOffset
      && chapter.content.slice(entry.startOffset, entry.endOffset) === entry.evidence
      && qualityFinding.evidenceHash === createHash('sha256').update(entry.evidence).digest('hex')) {
      finding.anchor = { start: entry.startOffset, end: entry.endOffset, text: entry.evidence }
    }
    return finding
  })
  const reviewCycle = { ...projectReviewCycle(cycle, { revision: chapter.revision, contentHash, ready, pending: decisionPending, findings: cycleFindings }),
    verificationStarted: observedReviewCycleVerification(cycle, raw, qualityReport, chapter) }
  const anchors: ReviewBoundEvidence['anchors'] = entries.flatMap(entry => (entry.source !== 'quality' || qualityContextCurrent
    && qualityReport!.findings.some(finding => finding.id === entry.findingId && finding.authorFeedback !== 'rejected'
      && finding.evidenceHash === createHash('sha256').update(entry.evidence).digest('hex')))
    && Number.isInteger(entry.startOffset) && Number.isInteger(entry.endOffset) && entry.startOffset !== undefined && entry.endOffset !== undefined
    && entry.startOffset >= 0 && entry.endOffset > entry.startOffset && entry.endOffset <= chapter.content.length
    && chapter.content.slice(entry.startOffset, entry.endOffset) === entry.evidence
    ? [{ start: entry.startOffset, end: entry.endOffset, text: entry.evidence, source: entry.source, reportId: entry.reportId, findingId: entry.findingId }] : [])
  const boundary = originalLocalEditBoundary(original.spec)
  const decisionBinding: ReviewCycleBinding = { contentHash, continuityBinding: report?.id ?? continuityDecisionBinding(compilation.id, chapter.revision, raw),
    qualityReportId: qualityComplete ? qualityReport!.id : null, qualityReportHashVersion: 2,
    qualityReportHash: qualityComplete ? qualityDecisionHash(qualityReport!.findings, 2) : null }
  const terminalCommitted = !!compilation.bridge.committedAt && compilation.bridge.targetRevision === chapter.revision
    && prepared.terminalContentHash === contentHash
  const phases: ChapterReviewProgressEvidence['phases'] = []
  if (requirements.continuity && continuity === 'complete') phases.push('continuity')
  if (requirements.quality && qualityComplete && qualityContextCurrent) phases.push('quality')
  if (ready && !decisionPending && requiredDecisions.length && (!requirements.quality || qualityContextCurrent)) phases.push('decision')
  if (terminalCommitted) phases.push('terminal')
  const readiness: ChapterReviewReadiness = { ready, checksRequired: requirements.continuity || requirements.quality, compilationId: compilation.id, chapterId: chapter.id, revision: chapter.revision,
    continuity, quality, continuityErrorCount: report?.complete ? report.findings.filter(finding => finding.severity === 'error').length : 0,
    qualityErrorCount: qualityComplete ? qualityReport!.findings.filter(finding => finding.severity === 'error' && finding.disposition !== 'repaired').length : 0,
    qualityCandidateCount: automaticQuality.length, qualityReportId: qualityComplete ? qualityReport!.id : null,
    requiredTools, decisionPending, requiredDecisions, retainedDecisions: retained, decisionDetails: entries, decisionEntries: entries,
    ...(qualityComplete ? { decisionFeedbackSnapshotHash: qualityDecisionSnapshotHash(qualityReport!.findings) } : {}),
    ...(decisionFeedback ? { decisionFeedback } : {}),
    decisionBinding, reviewCycle, reviewCycleFindings: cycleFindings, mustPassPending: mandatoryReviewPending, qualityPassRequired: mustPassQuality,
    ...(scope.reviewProtocol === 1 ? { reviewProtocol: 1 as const, completeStrictReview } : {}),
    ...(options?.reviewBoundEvidence ? { reviewBoundEvidence: { contentHash, anchors, cycle } } : {}),
    terminalCommitted, selectionOnly: !!boundary || !!originalSelectionBoundary(original.spec),
    progressEvidence: { taskId: original.taskId, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, orderIndex: chapter.orderIndex,
      contentHash, phases } }
  if (boundary?.version === 3) readiness.reviewBoundPlan = projectReviewBoundEditPlan(boundary, chapter,
    { ...readiness, reviewBoundEvidence: { contentHash, anchors, cycle } })
  return readiness
}

const decisionKey = (item: ChapterReviewDecision) => `${item.source}:${item.reportId}:${item.findingId}`

/** Progress from actually added current decisions, excluding audit IDs and reason wording. */
export function chapterReviewDecisionTransition(before: ChapterReviewReadiness, after: ChapterReviewReadiness) {
  const old = before.retainedDecisions ?? [], current = after.retainedDecisions ?? []
  if (!before.decisionBinding || runtimeJson(before.decisionBinding).hash !== runtimeJson(after.decisionBinding).hash
    || !current.some(item => !old.some(saved => decisionKey(item) === decisionKey(saved)) && before.requiredDecisions?.some(ref => decisionKey(ref) === decisionKey(item)))) return undefined
  const semantic = (entries: ChapterReviewDecision[]) => entries.flatMap(entry => {
    const detail = before.decisionDetails?.find(item => decisionKey(item) === decisionKey(entry))
    return detail ? [JSON.stringify({ source: detail.source, evidence: detail.evidence, explanation: detail.explanation,
      suggestion: detail.suggestion, severity: detail.severity, start: detail.startOffset ?? null, end: detail.endOffset ?? null })] : []
  }).sort()
  const beforeHash = runtimeJson({ contentHash: before.decisionBinding.contentHash, decisions: [...new Set(semantic(old))] }).hash
  const afterHash = runtimeJson({ contentHash: before.decisionBinding.contentHash, decisions: [...new Set(semantic(current))] }).hash
  return beforeHash !== afterHash ? { targetId: `review-decisions:${before.chapterId}`, beforeHash, afterHash } : undefined
}

export function chapterReviewDecisionGuidance(readiness: ChapterReviewReadiness) {
  const expression = readiness.requiredDecisions?.some(item => item.source === 'quality')
    ? ' 涉及解释负担时，保留理由应分别考虑事实必要性与当前表达必要性，比较保留事实而减少负担的方案；不能只用信息必要来证明原说法必要；正文修改仍以原作者授权为准。' : ''
  return currentReviewNextStepGuidance(projectCurrentReviewNextStep(readiness)) + expression
}

/** Shared exact-reference validation for manuscript and terminal decisions. */
function mergeReviewDecisions(entries: ChapterReviewDecision[], previous: RetainedChapterReviewDecision[], incoming: RetainedChapterReviewDecision[], errorCode: string) {
  if (new Set(incoming.map(decisionKey)).size !== incoming.length || incoming.some(item => !item.reason.trim()
    || !entries.some(entry => decisionKey(entry) === decisionKey(item)))) {
    throw new DataAccessError(409, errorCode, '留置必须引用当前版本真实报告；reportId是报告编号，quality findingId是意见真实ID，不能互换或使用索引。旧报告、跨章、重复引用或空原因均未保存。')
  }
  const merged = new Map(previous.map(item => [decisionKey(item), item]))
  for (const item of incoming) merged.set(decisionKey(item), { ...item, reason: item.reason.trim() })
  return [...merged.values()]
}

/** Feedback may update findings without the manuscript lock. Writers lock the
 * report and its existing findings before rereading the decision snapshot. */
export async function lockChapterReviewDecisions(tx: Prisma.TransactionClient, reportId: string) {
  await tx.$queryRaw`SELECT id FROM chapter_quality_reports WHERE id = ${reportId} FOR SHARE`
  await tx.$queryRaw`SELECT id FROM quality_findings WHERE report_id = ${reportId} ORDER BY id FOR SHARE`
}

/** Caller holds the manuscript/run/compilation locks and body CAS in its transaction.
 * This records a decision only, never a mutation, passed report or paid allowance. */
export async function recordChapterReviewDecisions(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, readiness: ChapterReviewReadiness,
  incoming: RetainedChapterReviewDecision[]) {
  if (readiness.qualityReportId) await lockChapterReviewDecisions(tx, readiness.qualityReportId)
  const current = await readChapterReviewReadiness(tx, subject, readiness.compilationId)
  if (!current?.decisionBinding || runtimeJson(current.decisionBinding).hash !== runtimeJson(readiness.decisionBinding).hash)
    throw new DataAccessError(409, 'REVIEW_DECISION_REQUIRED', '正文或报告意见已变化，未保存旧版本决定。')
  const findings = mergeReviewDecisions(readiness.decisionEntries ?? [], readiness.retainedDecisions ?? [], incoming, 'REVIEW_DECISION_REQUIRED')
  const original = await readOriginalTaskRequest(tx, subject), runIds = await originalTaskRunIds(tx, subject, original)
  const compilation = await tx.storyCompilation.findFirstOrThrow({ where: { id: readiness.compilationId, userId: subject.userId,
    novelId: subject.novelId, chapterId: readiness.chapterId, runId: { in: runIds } } })
  const chapter = await tx.chapter.findFirst({ where: { id: readiness.chapterId, revision: readiness.revision, authorId: subject.userId,
    ...activeChapterScope(subject.novelId) }, select: { content: true } })
  if (!chapter) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '正文已变化，未保存旧版本决定。')
  const validation = compilation.validation && typeof compilation.validation === 'object' && !Array.isArray(compilation.validation) ? compilation.validation : {}
  await tx.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation,
    retainedReviewDecision: { version: 1, chapterId: readiness.chapterId, revision: readiness.revision,
      ...readiness.decisionBinding, contentHash: runtimeJson({content: chapter.content}).hash, findings } }).value } })
  return { changed: runtimeJson(findings).hash !== runtimeJson(readiness.retainedDecisions ?? []).hash, findings }
}

export function continuityDecisionBinding(compilationId: string, revision: number, validation: unknown) {
  const current = validation && typeof validation === 'object' && !Array.isArray(validation) ? (validation as Record<string, unknown>).continuityReport as { version?: number; id?: string; revision?: number } | undefined : undefined
  if (current?.version === 1 && current.revision === revision && current.id) return current.id

  const value = validation && typeof validation === 'object' && !Array.isArray(validation) ? validation as Record<string, unknown> : {}
  return `${compilationId}:r${revision}:${runtimeJson({ coverage: value.coverage ?? null, findings: value.findings ?? [],
    checkedChapterId: value.checkedChapterId ?? null, checkedRevision: value.checkedRevision ?? null }).hash}`

}

export type ChapterReviewWriteProposal = { chapterId: string; revision: number; after: string;
  editRanges?: Array<{ start: number; end: number; newText: string }>; compilationId?: string }

/** Read-only coordination decision for the loop. It neither grants writing nor
 * consumes a finding; the ordinary effect transaction runs it again. */
export async function readChapterReviewWriteAdmission(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, proposal: ChapterReviewWriteProposal,
  readScope: ChapterReviewReadScope = createChapterReviewReadScope()) {
  void readScope
  const chapter = await tx.chapter.findFirst({ where: { id: proposal.chapterId, revision: proposal.revision, authorId: subject.userId, ...activeChapterScope(subject.novelId) }, select: { id: true, content: true } })
  if (!chapter) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '正文版本已变化，未写入旧方案。')
  return { kind: 'allow' as const, basis: proposal.after === chapter.content ? 'no_change' as const : 'original_writing' as const }
}

export async function assertChapterReviewWriteAdmission(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, proposal: ChapterReviewWriteProposal,
  readScope: ChapterReviewReadScope = createChapterReviewReadScope()) {
  return readChapterReviewWriteAdmission(tx, subject, proposal, readScope)
}

/** Ordinary manuscript tools use the original writing grant, not the paid
 * reviewer's repair allowance. Callers still fence the run, target and body CAS
 * in this transaction. Reviews certify only the body they actually checked. */
export async function assertChapterManuscriptRevision(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number },
  options: ChapterReviewRevisionOptions) {

  await lockNovelActiveScope(tx, subject.novelId)
  const conditionalAuthority = await assertSelectionBodyEffect(tx, subject, chapter, options)
  const original = await readOriginalTaskRequest(tx, subject)
  const parsedSpec = taskSpecSchema.safeParse(original.spec)
  // Consume only the authenticated answer projection for body authority. The
  // immutable original still supplies lineage, review requirements and budgets.
  const authoritySpec = parsedSpec.success && parsedSpec.data.scope.writingClarificationProtocol === 2
    ? await effectiveWritingTaskSpec(tx, subject, parsedSpec.data) : original.spec
  const runIds = await originalTaskRunIds(tx, subject, original)
  await tx.$queryRaw(Prisma.sql`SELECT id FROM story_compilations WHERE user_id = ${subject.userId}
    AND novel_id = ${subject.novelId} AND chapter_id = ${chapter.id} AND run_id IN (${Prisma.join(runIds)}) ORDER BY id FOR UPDATE`)
  const compilations = await tx.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId: chapter.id, runId: { in: runIds } }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const { readNewDraftWritingAuthority, prohibitsNewDraftRevision, chapterRevisionAuthorityText, frozenWritingRevisionAuthority } = await import('./writing-scope.js')
  const current = await tx.chapter.findFirst({ where: { id: chapter.id, revision: chapter.revision, authorId: subject.userId,
    ...activeChapterScope(subject.novelId) }, select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
  if (!current) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '章节已变化或不属于当前作者作品，正文未写入。')
  const authority = await readNewDraftWritingAuthority(tx, subject, current)
  let reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId: current.id, runId: { in: runIds } }, include: { findings: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (options.retainedFindings?.length) {
    for (const report of reports) await lockChapterReviewDecisions(tx, report.id)
    reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      chapterId: current.id, runId: { in: runIds } }, include: { findings: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  }
  const reviewed = reports.length > 0 || compilations.some(item => continuityCheckRounds(item.validation) > 0
    || !!item.validation && typeof item.validation === 'object' && !Array.isArray(item.validation) && typeof item.validation.checkedRevision === 'number')
  const spec = original.spec && typeof original.spec === 'object' && !Array.isArray(original.spec) ? original.spec as Record<string, unknown> : null
  const newReview = !!spec?.scope && typeof spec.scope === 'object' && !Array.isArray(spec.scope) && (spec.scope as Record<string, unknown>).reviewProtocol === 1
  const frozenAuthority = frozenWritingRevisionAuthority(authoritySpec, current.id, !!authority)
  const authorityText = (text: string | null) => chapterRevisionAuthorityText(localRevisionAuthorityText(text, authoritySpec), authoritySpec, current.id)
  const prohibited = conditionalAuthority ? false : frozenAuthority !== undefined ? !frozenAuthority : prohibitsNewDraftRevision(authorityText(original.prompt)) || Array.isArray(spec?.hardConstraints) && spec.hardConstraints.some(item =>
    !!item && typeof item === 'object' && 'text' in item && typeof item.text === 'string'
      && prohibitsNewDraftRevision(authorityText(item.text)))
  const localAuthority = conditionalAuthority || originalLocalEditBoundary(authoritySpec)?.kind === 'bounded'
  const freshAssessment = frozenAuthority === undefined && !!spec?.scope && typeof spec.scope === 'object' && !Array.isArray(spec.scope)
    && (spec.scope as Record<string, unknown>).localEditProtocol === 1 && hasReadOnlyRevisionAssessment(original.prompt)
  if (prohibited || freshAssessment || (!authority && !localAuthority && (reviewed || newReview && spec?.intent === 'review')
    && frozenAuthority !== true && !originalRepairAuthority(original))) {
    throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '原始作者请求未授权改写该正文；检查报告不能扩大写入权限。')
  }

  if (options.retainedFindings?.length) {
    const readiness = compilations[0] && await readChapterReviewReadiness(tx, subject, compilations[0].id, { readScope: options.readScope })
    if (!readiness) throw new DataAccessError(409, 'REVIEW_DECISION_REQUIRED', '没有当前版本可引用的真实报告，未保存留置或改稿。')
    await recordChapterReviewDecisions(tx, subject, readiness, options.retainedFindings)
  }

  const latest = compilations[0]
  // Humanity's existing repair transaction already records this same CAS.
  return !options.requireQualityChannel && latest && typeof options.after === 'string' && options.after !== current.content
    ? prepareReviewCycleTransition(tx, subject, current, latest.id, options.after, options.editRanges, options.readScope) : undefined
}

/** Automatic repair keeps the author's manuscript scope. Ordinary manuscript
 * tools and review tools share that scope; a report never grants new writes. */
export async function assertChapterReviewRevision(
  tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string },
  chapter: { id: string; revision: number },
  options?: ChapterReviewRevisionOptions,
) {
  return assertChapterManuscriptRevision(tx, subject, chapter, options ?? {})
}

/** Read-only projection of current manuscript authority before automatic repair.
 * It does not reserve a repair or alter the saved report. */
export async function probeChapterReviewRevision(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number },
  options?: ChapterReviewRevisionOptions): Promise<{ open: true } | { open: false; code: string; message: string }> {
  const readScope = options?.readScope ?? createChapterReviewReadScope()
  try {
    await assertChapterReviewRevision(tx, subject, chapter, { ...options, readScope })
    const original = await readOriginalTaskRequest(tx, subject)
    if (!originalRepairAuthority(original)) {
      // Closure evidence narrows automatic reachability only. It never adds
      // mutation authority, nor rejects a child merely for having a parent.
      const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId },
        select: { mode: true, taskRootId: true, session: { select: { userId: true, novelId: true, sandboxMode: true, toolPolicy: true } } } })
      if (run?.session && (run.session.userId !== subject.userId || run.session.novelId !== subject.novelId)) {
        throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前会话归属无法核实，不能推断正文修订通道已关闭。')
      }
      const policy = run?.session.toolPolicy && typeof run.session.toolPolicy === 'object' && !Array.isArray(run.session.toolPolicy)
        ? run.session.toolPolicy as Record<string, unknown> : null
      let closed = run?.session.sandboxMode === 'read_only' || policy?.contentWrite === 'deny' || !!run && run.mode !== 'act'
      if (run?.taskRootId) {
        const { readExecutionStateInTransaction } = await import('./runtime-state.js')
        const { configuration } = await readExecutionStateInTransaction(tx, run.taskRootId)
        const contentWritable = ['chapter_write', 'chapter_edit_range'].some(name => configuration.tools.some(tool => tool.function.name === name)
          && configuration.toolAuthority.some(grant => grant.name === name && grant.permission !== 'deny'))
        // quality_analyze can itself execute its existing bounded auto-repair.
        // An inline quality child only saves reports, while a child with an
        // actual inherited chapter-writing grant remains legitimately open.
        const qualityWritable = configuration.creativeFreedom === 'balanced'
          && configuration.tools.some(tool => tool.function.name === 'quality_analyze')
          && configuration.toolAuthority.some(grant => grant.name === 'quality_analyze' && grant.permission === 'allow' && !grant.alwaysConfirm)
          && (await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: subject.runId } }))?.kind !== 'inline'
          && (await readChapterReviewReadiness(tx, subject, undefined, { readScope }))?.continuityErrorCount === 0
        closed ||= configuration.mode !== 'build' || configuration.protectedChapterIds.includes(chapter.id)
          || (!contentWritable && !qualityWritable)
      }
      if (closed) return { open: false, code: 'REPAIR_NOT_AUTHORIZED', message: '当前服务端会话或原执行权限不允许自动写入此章；报告与真实剩余意见保留待审，正文未修改，不追加修订或宣称问题已解决。' }
    }
    return { open: true }
  } catch (error) {
    if (error instanceof DataAccessError && ['AUTHOR_LOCAL_SCOPE', 'AUTHOR_LOCAL_STALE', 'AUTHOR_SELECTION_SCOPE', 'AUTHOR_SELECTION_STALE', 'REPAIR_NOT_AUTHORIZED', 'REVIEW_AUTOMATION_STOPPED', 'REVIEW_REPAIR_RECHECK_REQUIRED', 'REVIEW_MERGED_REVISION_REQUIRED', 'REVIEW_CYCLE_DECISION_REQUIRED'].includes(error.code)) return { open: false, code: error.code, message: error.message }
    throw error
  }
}

/** Read-only tool feedback uses the same admission checks. The returned CAS
 * callback is deliberately never called here; feedback cannot consume a turn. */
export async function readChapterReviewRevisionGuidance(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number }) {
  try {
    const original = await readOriginalTaskRequest(tx, subject)
    const conditional = originalLocalEditBoundary(original.spec)
    if (conditional?.version === 3 && conditional.regions.some(region => region.chapterId === chapter.id)) return localEditGuidance(original.spec)!
    await assertChapterManuscriptRevision(tx, subject, chapter, {})
    const local = localEditGuidance((await readOriginalTaskRequest(tx, subject)).spec)
    if (local) return local
    if (originalSelectionBoundary((await readOriginalTaskRequest(tx, subject)).spec)) return '原任务只授权作者所选正文范围。读取当前正文，用 chapter_edit_range 的逐字唯一锚点或选区内坐标连续修改，所有补丁必须保留原选区外文本；每批最多8处，不限制原授权内批次数。不得 chapter_write、chapter_append、改名或通过其他工具扩大范围。最终所需检查须绑定最后保存版本。'
    return '在作者授权范围内依据当前正文连续修订。优先用 chapter_edit_range 的唯一原文片段合并安全修法；按实际剧情判断意见。需要保留的意见用当前报告 retainedFindings 引用并说明理由。修改后复查最终版的连续性和人类感质量，再提交章节。'
  } catch (error) {
    if (error instanceof DataAccessError && ['AUTHOR_LOCAL_SCOPE', 'AUTHOR_LOCAL_STALE', 'AUTHOR_SELECTION_SCOPE', 'AUTHOR_SELECTION_STALE', 'REPAIR_NOT_AUTHORIZED', 'REVIEW_AUTOMATION_STOPPED', 'REVIEW_REPAIR_RECHECK_REQUIRED'].includes(error.code)) {
      return `${error.message}保留事实错误及其证据，当前版本不能宣称通过。`
    }
    throw error
  }
}
