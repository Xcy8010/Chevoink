import { z } from 'zod'
import type { TerminalCandidate } from './terminal-state-review.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'
import { terminalCandidateFacts } from './terminal-fact-identity.js'
import { terminalProofCatalog, terminalProofVerdictSchema } from './terminal-proof-verdict.js'
import { terminalSpanVerdictSchema } from './terminal-review-shapes.js'
import { terminalDispositionSchema } from './terminal-fact-coverage.js'
import { terminalProposalDispositionSchema } from './terminal-proposal-review.js'

/** Request-local addresses are reconstructed only from the frozen candidate and
 * evidence context. They are neither facts nor authority to change a judgment. */
export function terminalReviewAddressCatalog(candidate: TerminalCandidate, context: TerminalEvidenceContext) {
  const grouped = new Map<string, { id: string; field: string; claim: string; paths: string[] }>()
  for (const fact of terminalCandidateFacts(candidate)) {
    const prior = grouped.get(fact.id)
    if (prior) prior.paths.push(fact.path)
    else grouped.set(fact.id, { id: fact.id, field: fact.field, claim: fact.claim, paths: [fact.path] })
  }
  const claims = [...grouped.values()].map((fact, claimIndex) => ({ ...fact, claimIndex }))
  const proofs = terminalProofCatalog(candidate, context).map((entry, proofIndex) => ({ ...entry, proofIndex }))
  const ordinary = claims.filter(fact => !proofs.some(entry => entry.paths.some(path => fact.paths.includes(path))))
  const obligations = (context.factCoverage?.obligations ?? []).map((fact, obligationIndex) => ({ ...fact, obligationIndex }))
  const proposals = (context.proposalChanges?.proposals ?? []).map((fact, proposalIndex) => ({ ...fact, proposalIndex }))
  return { claims, ordinary, proofs, obligations, proposals }
}

const address = (count: number) => count ? z.number().int().nonnegative().max(count - 1) : z.never()
const exhaustive = <T extends z.ZodType>(row: T, count: number, key: string) => z.array(row).length(count).superRefine((rows, ctx) => {
  const addresses = rows.map(item => (item as Record<string, unknown>)[key])
  if (new Set(addresses).size !== rows.length) ctx.addIssue({ code: 'custom', message: 'Each frozen address must occur exactly once' })
})

/** The wire has no claim/proof/proposal hashes to transcribe. Complete sets,
 * strict row shapes and all semantic/evidence checks remain mandatory. */
export function terminalAddressResponseFields(candidate: TerminalCandidate, context: TerminalEvidenceContext, legalSegmentIds?: string[]) {
  const catalog = terminalReviewAddressCatalog(candidate, context)
  const source = legalSegmentIds ? terminalSpanVerdictSchema.shape.sourceEvidence.element.extend({ segmentId: legalSegmentIds.length
    ? z.enum(legalSegmentIds as [string, ...string[]]) : z.never() }) : terminalSpanVerdictSchema.shape.sourceEvidence.element
  const ordinaryAddress = catalog.ordinary.length ? z.union(catalog.ordinary.map(item => z.literal(item.claimIndex))) : z.never()
  const verdict = terminalSpanVerdictSchema.omit({ path: true, basis: true }).extend({ claimIndex: ordinaryAddress, sourceEvidence: z.array(source).max(8) }).strict()
  const proof = terminalProofVerdictSchema.omit({ proofHash: true }).extend({ proofIndex: address(catalog.proofs.length) }).strict()
  const dispositionSource = terminalDispositionSchema.shape.sourceEvidence.element.extend({ quote: terminalDispositionSchema.shape.sourceEvidence.element.shape.quote.optional() })
  const disposition = terminalDispositionSchema.omit({ id: true, candidatePath: true, sourceEvidence: true }).extend({
    obligationIndex: address(catalog.obligations.length), candidateIndex: address(catalog.claims.length).optional(), sourceEvidence: z.array(dispositionSource).max(8),
  }).strict()
  const proposal = terminalProposalDispositionSchema.omit({ id: true, candidateFactId: true }).extend({
    proposalIndex: address(catalog.proposals.length), candidateIndex: address(catalog.claims.length).optional(),
  }).strict()
  const proofs = exhaustive(proof, catalog.proofs.length, 'proofIndex')
  const dispositions = exhaustive(disposition, catalog.obligations.length, 'obligationIndex')
  return { terminalVerdicts: exhaustive(verdict, catalog.ordinary.length, 'claimIndex'),
    terminalProofVerdicts: catalog.proofs.length ? proofs : proofs.default([]),
    terminalDispositions: catalog.obligations.length ? dispositions : dispositions.default([]),
    proposalDispositions: context.proposalChanges ? exhaustive(proposal, catalog.proposals.length, 'proposalIndex') : z.never().optional() }
}

/** Resolve exact local addresses before the existing independent semantic
 * review. No approximate hash matching, missing-row inference or verdict repair. */
export function bindTerminalReviewAddresses(record: Record<string, unknown>, candidate: TerminalCandidate, context: TerminalEvidenceContext) {
  const parsed = z.object(terminalAddressResponseFields(candidate, context)).passthrough().safeParse(record)
  if (!parsed.success) return { success: false as const, issues: parsed.error.issues }
  const catalog = terminalReviewAddressCatalog(candidate, context), value = parsed.data
  const ordinary = value.terminalVerdicts.flatMap(({ claimIndex, ...judgment }) => {
    const fact = catalog.ordinary.find(item => item.claimIndex === claimIndex)
    return fact ? fact.paths.map(path => ({ ...judgment, path })) : []
  })
  // A carried claim cannot enter the ordinary table even when its numeric
  // address lies inside the complete candidate range.
  if (value.terminalVerdicts.some(item => !catalog.ordinary.some(fact => fact.claimIndex === item.claimIndex))) {
    return { success: false as const, issues: [{ code: 'custom' as const, path: ['terminalVerdicts'], message: 'Address belongs to the frozen proof table' }] }
  }
  const proofs = value.terminalProofVerdicts.map(({ proofIndex, ...judgment }) => ({ ...judgment, proofHash: catalog.proofs[proofIndex].fact.proofHash }))
  const dispositions = value.terminalDispositions.map(({ obligationIndex, candidateIndex, ...judgment }) => ({ ...judgment,
    // A grouped literal claim has the same independent judgment at every
    // original path. Use its canonical first path instead of introducing the
    // legacy factId-to-unique-path ambiguity for repeated literal claims.
    id: catalog.obligations[obligationIndex].id, ...(candidateIndex !== undefined ? { candidatePath: catalog.claims[candidateIndex].paths[0] } : {}) }))
  const proposals = value.proposalDispositions?.map(({ proposalIndex, candidateIndex, ...judgment }) => ({ ...judgment,
    id: catalog.proposals[proposalIndex].id, ...(candidateIndex !== undefined ? { candidateFactId: catalog.claims[candidateIndex].id } : {}) }))
  return { success: true as const, record: { ...record, terminalVerdicts: ordinary, terminalProofVerdicts: proofs,
    ...(context.factCoverage ? { terminalDispositions: dispositions } : {}), ...(context.proposalChanges ? { proposalDispositions: proposals } : {}) } }
}

/** Model-facing projection only. Full identity/proof receipts stay frozen on
 * the server; every claim, obligation and semantic source remains visible. */
export function terminalReviewAddressInput(candidate: TerminalCandidate, context: TerminalEvidenceContext) {
  const catalog = terminalReviewAddressCatalog(candidate, context)
  return { ordinary: catalog.ordinary.map(({ claimIndex, field, claim }) => ({ claimIndex, field, claim })),
    proofs: catalog.proofs.map(({ proofIndex, fact, paths }) => ({ proofIndex, field: fact.field, claim: fact.claim, paths, depth: fact.depth,
      anchors: fact.anchors.map(({ quote }) => ({ quote })) })),
    obligations: catalog.obligations.map(({ obligationIndex, field, claim }) => ({ obligationIndex, field, claim })),
    proposals: catalog.proposals.map(({ proposalIndex, field, claim }) => ({ proposalIndex, field, claim })),
    candidates: catalog.claims.map(({ claimIndex, field, claim }) => ({ claimIndex, field, claim })),
    current: { orderIndex: context.current.orderIndex },
    previous: context.previous ? { orderIndex: context.previous.orderIndex, segments: context.previous.segments.map(({ segmentId, start, end, quote }) => ({ segmentId, start, end, quote })) } : null }
}
