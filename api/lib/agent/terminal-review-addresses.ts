import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'
import { terminalCandidateSchema, type TerminalCandidate } from './terminal-candidate-contract.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'
import { terminalCandidateFacts } from './terminal-fact-identity.js'
import { terminalProofCatalog, terminalProofVerdictSchema } from './terminal-proof-verdict.js'
import { terminalSpanVerdictSchema } from './terminal-review-shapes.js'
import { terminalDispositionSchema } from './terminal-fact-coverage.js'
import { terminalProposalDispositionSchema } from './terminal-proposal-review.js'

/** Request-local addresses are reconstructed only from the frozen candidate and
 * evidence context. They are neither facts nor authority to change a judgment. */
export function terminalReviewAddressCatalog(candidate: TerminalCandidate, context: TerminalEvidenceContext) {
  // JSONB/canonical serialization may reorder object keys. Rebuild the same
  // schema-owned field order used at admission, without changing any claim.
  candidate = terminalCandidateSchema.parse(candidate)
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
export function terminalAddressResponseFields(candidate: TerminalCandidate, context: TerminalEvidenceContext, legalSegmentIds?: string[], conditionalDispositions = false, sourceIdsOnly = false) {
  const catalog = terminalReviewAddressCatalog(candidate, context)
  const source = legalSegmentIds ? terminalSpanVerdictSchema.shape.sourceEvidence.element.extend({ segmentId: legalSegmentIds.length
    ? z.enum(legalSegmentIds as [string, ...string[]]) : z.never() }) : terminalSpanVerdictSchema.shape.sourceEvidence.element
  const ordinaryAddress = catalog.ordinary.length ? z.union(catalog.ordinary.map(item => z.literal(item.claimIndex))) : z.never()
  const verdict = terminalSpanVerdictSchema.omit({ path: true, basis: true }).extend({ claimIndex: ordinaryAddress, sourceEvidence: z.array(sourceIdsOnly ? source.omit({ quote: true }).strict() : source).max(8) }).strict()
  const proof = terminalProofVerdictSchema.omit({ proofHash: true }).extend({ proofIndex: address(catalog.proofs.length) }).strict()
  const originalDispositionSource = terminalDispositionSchema.shape.sourceEvidence.element.extend({ quote: terminalDispositionSchema.shape.sourceEvidence.element.shape.quote.optional() })
  const dispositionSource = sourceIdsOnly ? originalDispositionSource.omit({ quote: true }).extend({ segmentId: legalSegmentIds?.filter(id => /^c[0-9]+$/u.test(id)).length ? z.enum(legalSegmentIds.filter(id => /^c[0-9]+$/u.test(id)) as [string, ...string[]]) : z.never() }).strict() : originalDispositionSource
  const disposition = terminalDispositionSchema.omit({ id: true, candidatePath: true, sourceEvidence: true }).extend({
    obligationIndex: address(catalog.obligations.length), candidateIndex: address(catalog.claims.length).optional(), sourceEvidence: z.array(dispositionSource).max(8),
  }).strict()
  const proposalBase = terminalProposalDispositionSchema.omit({ id: true, candidateFactId: true }).extend({
    proposalIndex: address(catalog.proposals.length), candidateIndex: address(catalog.claims.length).optional(),
  }).strict()
  const proposal = sourceIdsOnly ? z.discriminatedUnion('outcome', [
    proposalBase.omit({ outcome: true, candidateIndex: true, sourceEvidence: true }).extend({ outcome: z.literal('unknown'), candidateIndex: z.never().optional(), sourceEvidence: z.array(dispositionSource).max(8) }).strict(),
    proposalBase.omit({ outcome: true, candidateIndex: true, sourceEvidence: true }).extend({ outcome: z.literal('retracted'), candidateIndex: z.never().optional(), sourceEvidence: z.array(dispositionSource).min(1).max(8) }).strict(),
    proposalBase.omit({ outcome: true, candidateIndex: true, sourceEvidence: true }).extend({ outcome: z.literal('replaced'), candidateIndex: address(catalog.claims.length), sourceEvidence: z.array(dispositionSource).min(1).max(8) }).strict(),
  ]) : proposalBase
  // New requests expose exactly the same outcome/target constraints enforced
  // by inspectTerminalCoverage, rather than advertising values it must reject.
  const persistent = catalog.claims.filter(item => ['knowledge', 'body', 'objects', 'relationships', 'openLoops'].includes(item.field))
  const replacementAddress = persistent.length ? z.union(persistent.map(item => z.literal(item.claimIndex))) : z.never()
  const dispositionBase = disposition.omit({ outcome: true, candidateIndex: true })
  const legalDisposition: z.ZodType<z.infer<typeof disposition>> = conditionalDispositions ? z.discriminatedUnion('outcome', [
    dispositionBase.extend({ outcome: z.literal('replaced'), candidateIndex: replacementAddress }).strict(),
    dispositionBase.extend({ outcome: z.literal('ended'), sourceEvidence: z.array(dispositionSource).min(1).max(8) }).strict(),
    dispositionBase.extend({ outcome: z.literal('unknown') }).strict(),
  ]) : disposition
  const proofs = exhaustive(proof, catalog.proofs.length, 'proofIndex')
  const dispositions = exhaustive(legalDisposition, catalog.obligations.length, 'obligationIndex')
  return { terminalVerdicts: exhaustive(verdict, catalog.ordinary.length, 'claimIndex'),
    terminalProofVerdicts: catalog.proofs.length ? proofs : proofs.default([]),
    terminalDispositions: catalog.obligations.length ? dispositions : dispositions.default([]),
    proposalDispositions: context.proposalChanges ? exhaustive(proposal, catalog.proposals.length, 'proposalIndex') : z.never().optional() }
}

/** Protocol 3 only: repeating an identical addressed row does not create a
 * second independent judgment. Conflicting rows, missing addresses and unknown
 * keys survive unchanged and are rejected by the complete original contract. */
export function normalizeTerminalResponseRows(record: Record<string, unknown>) {
  try {
  const repeated: Array<{ field: string; index: number; originalIndex: number; address: number }> = []
  const normalized = { ...record }
  for (const [field, key] of [['terminalVerdicts', 'claimIndex'], ['terminalProofVerdicts', 'proofIndex'],
    ['terminalDispositions', 'obligationIndex'], ['proposalDispositions', 'proposalIndex']] as const) {
    const rows = record[field]
    if (!Array.isArray(rows)) continue
    const seen = new Map<string, number>()
    normalized[field] = rows.filter((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !Number.isInteger(row[key])) return true
      const identity = runtimeJson(row).hash, prior = seen.get(identity)
      if (prior === undefined) { seen.set(identity, index); return true }
      repeated.push({ field, index, originalIndex: prior, address: row[key] as number })
      return false
    })
  }
  return { record: repeated.length ? normalized : record, normalization: { version: 1 as const,
    originalHash: runtimeJson(record).hash, projectionHash: runtimeJson(repeated.length ? normalized : record).hash, repeated }, error: undefined }
  } catch { return { record, normalization: null, error: 'Response projection exceeds canonical input limits' } }
}

/** Resolve exact local addresses before the existing independent semantic
 * review. No approximate hash matching, missing-row inference or verdict repair. */
export function bindTerminalReviewAddresses(record: Record<string, unknown>, candidate: TerminalCandidate, context: TerminalEvidenceContext, responseContract?: 3) {
  if (responseContract === 3) {
    const projection = normalizeTerminalResponseRows(record)
    if (projection.error) return { success: false as const, issues: [{ code: 'custom' as const, path: [], message: projection.error }] }
    record = projection.record
  }
  const parsed = z.object(terminalAddressResponseFields(candidate, context, undefined, responseContract === 3)).passthrough().safeParse(record)
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


/** Candidate evidence can be checked independently of failed disposition
 * tables. This binds ONLY candidate/proof rows; it supplies no empty tables,
 * obligation outcomes, completed report or authority to dispatch. */
export function bindTerminalCandidateAddresses(record: Record<string, unknown>, candidate: TerminalCandidate, context: TerminalEvidenceContext) {
  const projection = normalizeTerminalResponseRows(record)
  if (projection.error) return null
  const fields = terminalAddressResponseFields(candidate, context, undefined, true)
  const parsed = z.object({ terminalVerdicts: fields.terminalVerdicts, terminalProofVerdicts: fields.terminalProofVerdicts }).passthrough().safeParse(projection.record)
  if (!parsed.success) return null
  const catalog = terminalReviewAddressCatalog(candidate, context)
  return { ...record,
    terminalVerdicts: parsed.data.terminalVerdicts.flatMap(({ claimIndex, ...judgment }) => {
      const fact = catalog.ordinary.find(row => row.claimIndex === claimIndex)
      return fact ? fact.paths.map(path => ({ ...judgment, path })) : []
    }),
    terminalProofVerdicts: parsed.data.terminalProofVerdicts.map(({ proofIndex, ...judgment }) => ({ ...judgment, proofHash: catalog.proofs[proofIndex].fact.proofHash })) }
}
