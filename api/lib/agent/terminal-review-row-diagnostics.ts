import { z } from 'zod'
import { terminalAddressResponseFields, terminalReviewAddressCatalog, bindTerminalCandidateAddresses } from './terminal-review-addresses.js'
import { inspectTerminalCandidateEvidence, type TerminalCandidate, type TerminalReviewDiagnostic } from './terminal-state-review.js'
import { terminalCoverageRowIssue, terminalDispositionSchema } from './terminal-fact-coverage.js'
import { terminalProposalRowIssue, terminalProposalDispositionSchema } from './terminal-proposal-review.js'
import { readTerminalProofVerdicts } from './terminal-proof-verdict.js'
import { continuitySourceSegments, type ContinuityBodies } from './continuity-review-context.js'

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
export type ReviewTable = 'terminalVerdicts' | 'terminalProofVerdicts' | 'terminalDispositions' | 'proposalDispositions'

/** Diagnostics only. Every table retains its full frozen catalogue. The exact
 * same strict row rules run at final acceptance; no missing judgment is filled. */
export function terminalReviewRowDiagnostics(candidate: TerminalCandidate, bodies: ContinuityBodies, record: Record<string, unknown>) {
  const context = bodies.terminalEvidence
  if (!context || context.verdictProtocol !== 6) return null
  const fields = terminalAddressResponseFields(candidate, context, undefined, true), catalog = terminalReviewAddressCatalog(candidate, context)
  const candidateBound = bindTerminalCandidateAddresses(record, candidate, context)
  if (!candidateBound) return null
  const diagnostics: TerminalReviewDiagnostic[] = [], bad = new Map<ReviewTable, Set<number>>()
  const add = (table: ReviewTable, index: number) => { const set = bad.get(table) ?? new Set<number>(); set.add(index); bad.set(table, set) }
  inspectTerminalCandidateEvidence(candidate, bodies.current, record, context, diagnostics, true)
  const ordinary = record.terminalVerdicts as Array<Record<string, unknown>>
  const badClaims = new Set<number>()
  for (const d of diagnostics) {
    const claim = catalog.claims.find(row => d.path && row.paths.includes(d.path))
    if (!claim) return null
    badClaims.add(claim.claimIndex)
    const index = ordinary.findIndex(row => row.claimIndex === claim.claimIndex)
    if (index >= 0) add('terminalVerdicts', index)
    else { const proof = catalog.proofs.find(row => row.paths.some(path => claim.paths.includes(path))); const i = Array.isArray(record.terminalProofVerdicts) ? record.terminalProofVerdicts.findIndex(row => object(row)?.proofIndex === proof?.proofIndex) : -1; if (i < 0) return null; add('terminalProofVerdicts', i) }
  }
  const proofs = readTerminalProofVerdicts(candidateBound.terminalProofVerdicts, candidate, context)
  if (!proofs) return null
  const verdicts = [...(candidateBound.terminalVerdicts as Array<{ path: string; verdict: string }>), ...proofs.verdicts]
  const current = continuitySourceSegments({ previous: null, current: bodies.current })
  for (const [table, key] of [['terminalDispositions', 'obligationIndex'], ['proposalDispositions', 'proposalIndex']] as const) {
    const schema = fields[table], array = schema instanceof z.ZodDefault ? schema.unwrap() : schema
    if (!(array instanceof z.ZodArray)) { if (record[table] !== undefined) return null; continue }
    const rows = record[table] ?? []
    if (!Array.isArray(rows)) return null
    for (const [index, row] of rows.entries()) {
      const parsed = array.element.safeParse(row)
      if (!parsed.success) { add(table, index); continue }
      const value = object(parsed.data)!, address = value[key] as number
      const target = value.candidateIndex === undefined ? undefined : catalog.claims[value.candidateIndex as number]
      const refs = (value.sourceEvidence as Array<{ segmentId: string; quote?: string }>).map(ref => ({ ...ref, quote: ref.quote ?? current.find(part => part.segmentId === ref.segmentId)?.quote ?? '' }))
      let issue: { code: string; suffix: string } | null | false
      if (table === 'terminalDispositions') {
        const obligation = catalog.obligations[address]
        const item = terminalDispositionSchema.safeParse({ id: obligation?.id, outcome: value.outcome, reason: value.reason, sourceEvidence: refs, ...(target ? { candidatePath: target.paths[0] } : {}) })
        issue = !item.success || !context.factCoverage ? { code: 'fact_disposition_schema_invalid', suffix: '' }
          : terminalCoverageRowIssue(context.factCoverage, item.data, candidate, verdicts, current)
      } else {
        const proposal = catalog.proposals[address]
        const item = terminalProposalDispositionSchema.safeParse({ id: proposal?.id, outcome: value.outcome, reason: value.reason, sourceEvidence: refs, ...(target ? { candidateFactId: target.id } : {}) })
        issue = !item.success || !context.proposalChanges ? { code: 'proposal_disposition_schema_invalid', suffix: '' }
          : terminalProposalRowIssue(context.proposalChanges, item.data, candidate, verdicts, current)
      }
      if (issue) { diagnostics.push({ code: issue.code, path: `${table}.${index}${issue.suffix}` }); add(table, index) }
      if (target && badClaims.has(target.claimIndex)) add(table, index)
    }
  }
  // A candidate error cannot freeze a dependent positive disposition as valid.
  return { diagnostics, bad, candidateEvidenceValid: badClaims.size === 0 }
}
