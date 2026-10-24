import { continuitySparseRepairDiagnostics } from './continuity-response-repair.js'
import { continuityReassessmentDiagnostics } from './continuity-response-contract.js'
import { DataAccessError } from '../prisma.js'
import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'
import { readTerminalCandidate, currentTerminalReview, type TerminalCandidate, type TerminalDeliveryBinding } from './terminal-state-review.js'
import { terminalCandidateCorrection } from './terminal-candidate-feedback.js'
import { terminalFactId } from './terminal-fact-identity.js'
import { readTerminalProposalInput, readTerminalProposalState, stageTerminalProposals, type TerminalProposalState } from './terminal-proposal-review.js'
import { terminalEvidenceContext, terminalEvidenceVersion, terminalQuoteAddressVersion, terminalVerdictAuditVersion, terminalSpanAuditVersion, type TerminalEvidenceContext } from './terminal-evidence-context.js'
import { readTerminalCoverageState, terminalCoverageInput, terminalCoverageAuditVersion, terminalCoverageProofs } from './terminal-fact-coverage.js'
import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { continuitySourceScopeSchema } from './continuity-source-authority.js'

export type TerminalProposalPreparation = { state: TerminalProposalState; changes?: TerminalEvidenceContext['proposalChanges'] }

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const blocked = () => new DataAccessError(409, 'TERMINAL_STATE_REVIEW_REQUIRED', '当前候选提议缺少可重建的原失败或冻结输入；保留正文与待核事项，不跳过独立核验。')
export const terminalProposalIdentity = (taskId: string, context: TerminalEvidenceContext) => ({ taskId,
  chapterId: context.current.id, bodyHash: context.current.contentHash, sourceHash: runtimeJson({ previous: context.previous }).hash })

/** Like terminalFactCoverage, proposal identity belongs to the frozen spec;
 * storage bookkeeping never substitutes another task's identity. */
export function terminalProposalTaskId(spec: unknown, legacyFallback?: string) {
  const id = object(spec).id
  if (typeof id === 'string' && id) return id
  if (legacyFallback) return legacyFallback
  throw blocked()
}

export function verifiedTerminalProposalFactIds(context: TerminalEvidenceContext, spec?: unknown, preparedContext?: unknown) {
  return [...new Set([...(context.factCoverage?.obligations.map(item => item.id) ?? []),
    ...(readTerminalCoverageState(spec, preparedContext, context.current.id)?.facts.map(item => item.id) ?? []),
    ...(context.previous?.carried?.map(item => terminalFactId(item.field, item.claim)) ?? [])])]
}

/** Rebuild from server-owned pending state and the current report's marker.
 * Never trust a context copied from an audit without rebuilding legal sources.
 * Empty pending still retains the whole input used by the accepted report. */
export function attachTerminalProposalInput(context: TerminalEvidenceContext, input: {
  taskId: string; preparedContext: unknown; validation: unknown; candidate: TerminalCandidate
}): TerminalEvidenceContext {
  const identity = terminalProposalIdentity(input.taskId, context)
  const state = readTerminalProposalState(input.preparedContext, identity)
  const marker = object(object(input.validation).continuityCriticResponse).terminalEvidence
  const proposalMarker = object(marker).proposalChanges
  if (proposalMarker === undefined) {
    if (state?.pending.length) throw blocked()
    return context
  }
  const saved = readTerminalProposalInput(input.preparedContext, identity, input.candidate)
  if (!state || !saved || runtimeJson(saved).hash !== runtimeJson(proposalMarker).hash) throw blocked()
  return { ...context, proposalChanges: saved }
}

/** Construct the prospective input before dispatch. The caller persists it in
 * the existing frozen operation/artifact, including on failed/unknown requests;
 * the report transaction reconstructs it again before applying any result. */
export function prepareTerminalProposalInput(input: { spec: unknown; preparedContext: unknown; validation: unknown;
  content: string; originalContent?: string; previousContent?: string | null; candidate: TerminalCandidate; originalContext: TerminalEvidenceContext; nextContext: TerminalEvidenceContext
}): TerminalProposalPreparation | undefined {
  const previous = readTerminalCandidate(input.validation)
  const audit = object(input.validation).continuityCriticResponse
  // A first candidate has no old proposal to retract. Historical callers need
  // no new identity fields merely to keep their unchanged initial contract.
  if ((!previous || audit === undefined) && object(input.preparedContext).terminalProposalReview === undefined) return undefined
  const taskId = terminalProposalTaskId(input.spec)
  const identity = terminalProposalIdentity(taskId, input.nextContext)
  const originalContent = input.originalContent ?? input.content
  if (identity.bodyHash !== runtimeJson({ content: input.content }).hash
    || input.originalContext.current.id !== identity.chapterId
    || input.originalContext.current.contentHash !== runtimeJson({ content: originalContent }).hash) throw blocked()
  const state = readTerminalProposalState(input.preparedContext, identity)
  if (!previous || audit === undefined) {
    if (state?.pending.length) throw blocked()
    return undefined
  }
  const original = attachTerminalProposalInput(input.originalContext, { ...input, taskId, candidate: previous })
  if (!currentTerminalReview(input.validation, originalContent, original)
    && !terminalCandidateCorrection(input.validation, originalContent, original)
    && !(input.previousContent !== undefined
      && (state?.pending.length ? original.proposalChanges : object(audit).classification === 'terminal_invalid')
      && authenticFailedReport(input.validation, originalContent, input.previousContent, original, previous))) throw blocked()
  const verified = verifiedTerminalProposalFactIds(input.nextContext, input.spec, input.preparedContext)
  const staged = stageTerminalProposals({ preparedContext: input.preparedContext, identity,
    auditHash: runtimeJson(audit).hash, base: previous, candidate: input.candidate, verifiedFactIds: verified,
    origin: { bodyHash: original.current.contentHash, sourceHash: terminalProposalIdentity(taskId, original).sourceHash } })
  return staged
}

/** Shared by the request producer and the report transaction. Reconstruct the
 * old report with its own versions; only the new request gets nextContext. */
export function prepareCompilerTerminalProposals(input: { spec: unknown; preparedContext: unknown; validation: unknown;
  chapter: Parameters<typeof terminalEvidenceContext>[0]; source: Parameters<typeof terminalEvidenceContext>[1];
  candidate: TerminalCandidate; nextContext: TerminalEvidenceContext
}): TerminalProposalPreparation | undefined {
  const version = terminalEvidenceVersion(input.spec)
  if (!version) return undefined
  const previous = readTerminalCandidate(input.validation)
  const span = terminalSpanAuditVersion(input.validation)
  const saved = object(input.validation), audit = object(saved.continuityCriticResponse)
  const frozenChapter = object(object(audit.terminalEvidence).current)
  const changedInput = audit.terminalContentHash !== undefined && (audit.terminalContentHash !== input.nextContext.current.contentHash
    || frozenChapter.revision !== undefined && frozenChapter.revision !== input.chapter.revision)
  if (changedInput && (saved.checkedChapterId !== input.chapter.id || typeof saved.checkedContent !== 'string'
    || !Number.isSafeInteger(saved.checkedRevision) || Number(saved.checkedRevision) > input.chapter.revision)) throw blocked()
  const originalChapter = changedInput ? { ...input.chapter, revision: Number(saved.checkedRevision), content: String(saved.checkedContent) } : input.chapter
  const originalContext = terminalEvidenceContext(originalChapter, input.source, version, terminalQuoteAddressVersion(input.spec),
    terminalCoverageInput(input.spec, input.preparedContext, originalChapter, previous, terminalCoverageAuditVersion(input.validation),
      terminalCoverageProofs(input.source, span)), terminalVerdictAuditVersion(input.validation), span)
  return prepareTerminalProposalInput({ ...input, content: input.chapter.content, originalContent: originalChapter.content,
    previousContent: input.source?.content ?? null, originalContext })
}

/** An unresolved proposal upgraded to a verified obligation changes the input
 * even when the manuscript and candidate are identical. Resolved reports keep
 * their original full input and remain reusable without another request. */
export function terminalProposalCacheMatches(input: Parameters<typeof prepareCompilerTerminalProposals>[0], deliveryBinding?: TerminalDeliveryBinding) {
  if (object(input.preparedContext).terminalProposalReview === undefined) return true
  const taskId = terminalProposalTaskId(input.spec)
  const state = readTerminalProposalState(input.preparedContext, { taskId, chapterId: input.chapter.id })
  if (!state?.pending.length) return true
  const current = currentTerminalReview(input.validation, input.chapter.content, input.nextContext,
    deliveryBinding ?? { taskId, preparedContext: input.preparedContext })
  if (current?.deliveryEligibility.basis === 'current_supported_with_preserved_drafts') return true
  const proposed = prepareCompilerTerminalProposals(input)
  return runtimeJson({ changes: proposed?.changes ?? null }).hash === runtimeJson({ changes: input.nextContext.proposalChanges ?? null }).hash
}

/** A first malformed report can precede proposal state. Authenticate the
 * entire saved response against its original input without certifying it as a
 * pass. Unknown/truncated observations cannot authorize a replacement request. */
function authenticFailedReport(validation: unknown, content: string, previous: string | null,
  terminalEvidence: TerminalEvidenceContext, candidate: TerminalCandidate) {
  const saved = object(validation), audit = object(saved.continuityCriticResponse), raw = object(audit.rawResponse)
  if (saved.independentCheck !== 'unavailable' || audit.parserVersion !== 8 || raw.complete !== true
    || raw.encoding !== 'json-string' || typeof raw.content !== 'string' || audit.classification === 'response_incomplete') return false
  try {
    const response: unknown = JSON.parse(raw.content)
    if (typeof response !== 'string') return false
    const scope = continuitySourceScopeSchema.optional().safeParse(audit.sourceScope)
    if (!scope.success) return false
    // Match the entire actual failure under either its current or frozen
    // metadata rule. Never relabel a failure or rewrite a stored audit.
    const bodies = { previous, current: content, terminalEvidence }
    if (audit.responseContract !== undefined && audit.responseContract !== 3) return false
    const responseOptions = audit.responseContract === 3 ? { responseContract: 3 as const } : {}
    const reports = [inspectContinuityResponse(response, bodies, true, 8, candidate, scope.data, responseOptions),
      inspectContinuityResponse(response, bodies, true, 8, candidate, scope.data, { frozenCurrentMetadata: true, ...responseOptions })]
    // The lifecycle adds this dispatch identity after parsing. It is retained
    // and checked by the reservation layer, not part of the parser's audit.
    const { reassessment, assessmentRequest, ...first } = audit
    if (assessmentRequest !== undefined && !z.object({ version: z.literal(1),
      key: z.string().regex(/^[a-f0-9]{64}$/u), inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
    }).strict().safeParse(assessmentRequest).success) return false
    const matches = () => reports.some(report => !report.complete && runtimeJson(report.audit).hash === runtimeJson(first).hash)
    if (reassessment === undefined) return matches()
    // The existing lifecycle preserves the first invalid audit and appends a
    // failed second response. Validate that exact wrapper, keeping it failed;
    // an incomplete second response is still unknown and cannot enter here.
    const second = z.object({ version: z.literal(1), classification: z.literal('invalid'),
      kind: z.literal('sparse_table_repair_failed').optional(), protocol: z.union([z.literal(4), z.literal(5)]).optional(), rawResponse: z.object({
      version: z.literal(1), encoding: z.literal('json-string'), content: z.string(), complete: z.literal(true),
    }).strict(), ...(audit.responseContract === 3 ? { diagnostics: z.object({ classification: z.string(),
      fixedFieldError: z.string().optional(), terminalReviewDiagnostics: z.array(z.object({ code: z.string(), path: z.string().optional(),
        referenceIndex: z.number().optional(), segmentId: z.string().optional(), message: z.string().optional(), expectedCount: z.number().optional(), actualCount: z.number().optional(), expectedFact: z.object({ field: z.string(), claim: z.string() }).optional() }).strict()) }).strict().optional() } : {}) }).strict().safeParse(reassessment)
    if (!second.success || typeof JSON.parse(second.data.rawResponse.content) !== 'string'
      || (second.data.kind === 'sparse_table_repair_failed') !== (second.data.protocol === 4 || second.data.protocol === 5)) return false
    if (audit.responseContract === 3 && 'diagnostics' in second.data && second.data.diagnostics !== undefined) {
      const original = reports.find(report => !report.complete && runtimeJson(report.audit).hash === runtimeJson(first).hash)
      if (!original) return false
      const diagnostics = second.data.protocol === 4 || second.data.protocol === 5 ? continuitySparseRepairDiagnostics(original, JSON.parse(second.data.rawResponse.content) as string, bodies, second.data.protocol === 5 ? 2 : 1)
        : continuityReassessmentDiagnostics(original, JSON.parse(second.data.rawResponse.content) as string, bodies)
      if (!diagnostics || runtimeJson(second.data.diagnostics).hash !== runtimeJson(diagnostics).hash) return false
    }
    return matches()
  } catch { return false }
}
