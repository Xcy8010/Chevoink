import { z } from 'zod'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import { terminalCandidateFacts, terminalFactId } from './terminal-fact-identity.js'
import { terminalQuoteRange } from './terminal-quote-range.js'
import type { TerminalCandidate } from './terminal-state-review.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const field = z.enum(['action', 'location', 'storyTime', 'emotion', 'knowledge', 'body', 'objects', 'relationships', 'openLoops', 'lastUnfinishedAction'])
const identitySchema = z.object({ taskId: z.string().min(1), chapterId: z.string().min(1), bodyHash: hash, sourceHash: hash }).strict()
const proposalSchema = z.object({ id: hash, field, claim: z.string().min(1).max(1000),
  origin: z.object({ auditHash: hash, bodyHash: hash, sourceHash: hash, candidateHash: hash }).strict() }).strict()
export const terminalProposalChangesSchema = identitySchema.extend({ version: z.literal(1), candidateHash: hash,
  verifiedFactIds: z.array(hash).max(200), proposals: z.array(proposalSchema).min(1).max(200) }).strict()
export type TerminalProposalChanges = z.infer<typeof terminalProposalChangesSchema>
export const terminalProposalStateSchema = z.object({ version: z.literal(1), taskId: z.string().min(1), chapterId: z.string().min(1),
  pending: z.array(proposalSchema).max(200),
  // Preserve the whole reviewed input after dispositions shrink pending. This
  // is an input receipt, never a claim that a critic dispatched or completed.
  lastInput: z.object({ input: terminalProposalChangesSchema, pendingHash: hash }).strict(),
}).strict()
export type TerminalProposalState = z.infer<typeof terminalProposalStateSchema>
const blocked = () => new DataAccessError(409, 'TERMINAL_STATE_REVIEW_REQUIRED', '候选提议的待核记录缺失、变化或超限；正文与原失败保留，未省略待核事项。')
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const validProposals = (proposals: TerminalProposalChanges['proposals']) => new Set(proposals.map(item => item.id)).size === proposals.length
  && proposals.every(item => item.id === terminalFactId(item.field, item.claim))

export function readTerminalProposalState(preparedContext: unknown, subject: { taskId: string; chapterId: string }): TerminalProposalState | undefined {
  const raw = object(preparedContext).terminalProposalReview
  if (raw === undefined) return undefined
  const parsed = terminalProposalStateSchema.safeParse(raw)
  if (!parsed.success || parsed.data.taskId !== subject.taskId || parsed.data.chapterId !== subject.chapterId
    || parsed.data.lastInput.input.taskId !== subject.taskId || parsed.data.lastInput.input.chapterId !== subject.chapterId
    || !validProposals(parsed.data.pending) || !validProposals(parsed.data.lastInput.input.proposals)
    || runtimeJson(parsed.data.pending).hash !== parsed.data.lastInput.pendingHash
    || parsed.data.pending.some(item => !parsed.data.lastInput.input.proposals.some(original => runtimeJson(original).hash === runtimeJson(item).hash))) throw blocked()
  return parsed.data
}

/** Called only after the producer authenticates the original failed audit and
 * current owned body/source. This records a proposal, not a semantic verdict.
 * Main-model args cannot supply state, origins or the verified-fact catalogue. */
export function stageTerminalProposals(input: {
  preparedContext: unknown; identity: z.infer<typeof identitySchema>; auditHash: string;
  base: TerminalCandidate; candidate: TerminalCandidate; verifiedFactIds: readonly string[];
  origin?: { bodyHash: string; sourceHash: string }
}): { state: TerminalProposalState; changes?: TerminalProposalChanges } | undefined {
  const identity = identitySchema.parse(input.identity), auditHash = hash.parse(input.auditHash)
  const old = readTerminalProposalState(input.preparedContext, identity)
  const before = terminalCandidateFacts(input.base), after = terminalCandidateFacts(input.candidate)
  const verified = new Set(input.verifiedFactIds)
  const pending = new Map((old?.pending ?? []).filter(item => !verified.has(item.id)).map(item => [item.id, item]))
  for (const fact of before) {
    if (verified.has(fact.id) || after.some(item => item.id === fact.id) || pending.has(fact.id)) continue
    pending.set(fact.id, { id: fact.id, field: field.parse(fact.field), claim: fact.claim,
      origin: { auditHash, bodyHash: input.origin?.bodyHash ?? identity.bodyHash,
        sourceHash: input.origin?.sourceHash ?? identity.sourceHash, candidateHash: runtimeJson(input.base).hash } })
  }
  if (!pending.size) return old ? { state: { ...old, pending: [],
    lastInput: { ...old.lastInput, pendingHash: runtimeJson([]).hash } } } : undefined
  if (pending.size + verified.size > 200) throw blocked()
  const changes = terminalProposalChangesSchema.parse({ version: 1, ...identity, candidateHash: runtimeJson(input.candidate).hash,
    verifiedFactIds: [...verified], proposals: [...pending.values()] })
  const state = terminalProposalStateSchema.parse({ version: 1, taskId: identity.taskId, chapterId: identity.chapterId,
    pending: changes.proposals, lastInput: { input: changes, pendingHash: runtimeJson(changes.proposals).hash } })
  return { state, changes }
}

/** Reconstruct the producer-owned input, including already resolved proposals.
 * The caller also rebuilds legal evidence and verifies the independent audit;
 * a match here alone is never proof of a passed report. */
export function readTerminalProposalInput(preparedContext: unknown, identity: z.infer<typeof identitySchema>, candidate: TerminalCandidate) {
  const state = readTerminalProposalState(preparedContext, identity)
  if (!state) return undefined
  const input = state.lastInput.input
  return input.bodyHash === identity.bodyHash && input.sourceHash === identity.sourceHash
    && input.candidateHash === runtimeJson(candidate).hash ? input : undefined
}

export const terminalProposalDispositionSchema = z.object({ id: hash, outcome: z.enum(['replaced', 'retracted', 'unknown']),
  reason: z.string().trim().min(1).max(1000), candidateFactId: hash.optional(),
  sourceEvidence: z.array(z.object({ segmentId: z.string().regex(/^c[0-9]+$/u), quote: z.string().min(2).max(300) }).strict()).max(8),
}).strict()
export type TerminalProposalDisposition = z.infer<typeof terminalProposalDispositionSchema>

/** Single-row validation shared with bounded report-field repair. */
export function terminalProposalRowIssue(input: TerminalProposalChanges, item: TerminalProposalDisposition, candidate: TerminalCandidate,
  verdicts: readonly { path: string; verdict: string }[], current: Array<{ segmentId: string; quote: string }>) {
  if (!input.proposals.some(proposal => proposal.id === item.id)) return { code: 'proposal_address_invalid', suffix: '.id' }
  if (item.sourceEvidence.some(ref => !terminalQuoteRange(ref, current))) return { code: 'proposal_evidence_invalid', suffix: '.sourceEvidence' }
  if (item.outcome === 'unknown') return item.candidateFactId !== undefined ? { code: 'unknown_proposal_has_target', suffix: '.candidateFactId' } : null
  if (!item.sourceEvidence.length) return { code: 'proposal_evidence_missing', suffix: '.sourceEvidence' }
  if (item.outcome === 'retracted') return item.candidateFactId !== undefined ? { code: 'retracted_proposal_has_target', suffix: '.candidateFactId' } : null
  const target = terminalCandidateFacts(candidate).find(fact => fact.id === item.candidateFactId)
  return !target || !verdicts.some(verdict => verdict.path === target.path && verdict.verdict === 'supported')
    ? { code: 'proposal_target_not_supported', suffix: '.candidateFactId' } : null
}

/** Exact evidence binding and completeness only. The independent critic owns
 * whether a proposal was unfounded or a replacement preserves its full claim.
 * Retraction cannot discharge any verified fact obligation. */
export function inspectTerminalProposalDispositions(input: TerminalProposalChanges | undefined, raw: unknown,
  candidate: TerminalCandidate, verdicts: readonly { path: string; verdict: string }[],
  segments: Array<{ segmentId: string; quote: string }>, verifiedFactIds: readonly string[]) {
  if (!input) return raw === undefined ? undefined : null
  const parsedInput = terminalProposalChangesSchema.safeParse(input)
  if (!parsedInput.success) return null
  const verified = new Set([...verifiedFactIds, ...input.verifiedFactIds])
  if (!validProposals(input.proposals) || input.candidateHash !== runtimeJson(candidate).hash
    || new Set(input.verifiedFactIds).size !== input.verifiedFactIds.length
    || input.proposals.some(item => verified.has(item.id))
    || new Set([...verified, ...input.proposals.map(item => item.id)]).size > 200) return null
  const parsed = z.array(terminalProposalDispositionSchema).max(200).safeParse(raw)
  if (!parsed.success || parsed.data.length !== input.proposals.length
    || new Set(parsed.data.map(item => item.id)).size !== parsed.data.length) return null
  const current = segments.filter(segment => /^c[0-9]+$/u.test(segment.segmentId))
  if (parsed.data.some(item => terminalProposalRowIssue(input, item, candidate, verdicts, current))) return null
  return { inputHash: runtimeJson(input).hash, complete: parsed.data.every(item => item.outcome !== 'unknown'), dispositions: parsed.data }
}

/** Apply only a complete independent terminal review in the report transaction.
 * Failed/incomplete reports do not shrink pending or enter trusted memory. */
export function advanceTerminalProposals(state: TerminalProposalState, input: TerminalProposalChanges,
  review: { supported: boolean; proposals?: NonNullable<ReturnType<typeof inspectTerminalProposalDispositions>> }) {
  if (runtimeJson(state.lastInput.input).hash !== runtimeJson(input).hash) throw blocked()
  if (!review.supported || !review.proposals?.complete) return state
  if (review.proposals.inputHash !== runtimeJson(input).hash) throw blocked()
  const resolved = new Set(review.proposals.dispositions.map(item => item.id))
  const pending = state.pending.filter(item => !resolved.has(item.id))
  return terminalProposalStateSchema.parse({ ...state, pending,
    lastInput: { input, pendingHash: runtimeJson(pending).hash } })
}

export function terminalProposalGuidance(input?: TerminalProposalChanges) {
  return input ? '\nproposalChanges是未证实的旧候选提议，不是已知事实。逐id恰好返回proposalDispositions={id,outcome,reason,sourceEvidence:[{segmentId,quote}],candidateFactId?}。replaced指向本次supported的完整替代主张；retracted须独立核对本章真实原文，说明原提议为何不成立或不应作为事实承接，不等于认定原世界事实为假；不能仅因证据地址错误或未提及就撤回。不能确定用unknown并保留未解决事项。非unknown都须当前cN可定位证据。此目录不能解除factCoverage中的已验证事实。' : ''
}
