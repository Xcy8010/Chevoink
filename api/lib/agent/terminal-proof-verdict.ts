import { z } from 'zod'
import type { TerminalCandidate } from './terminal-state-review.js'
import type { TerminalCarriedFact, TerminalEvidenceContext } from './terminal-evidence-context.js'

const fields = ['knowledge', 'body', 'objects', 'relationships', 'openLoops'] as const
export const terminalProofVerdictSchema = z.object({ proofHash: z.string().regex(/^[a-f0-9]{64}$/u),
  currentState: z.enum(['unchanged', 'changed', 'uncertain']), reason: z.string().trim().min(1).max(1000),
}).strict()

/** Exact typed claims are explicit selections too. Never add omitted facts,
 * match aliases, change fields or use the coverage ledger as proof. */
export function terminalProofCatalog(candidate: TerminalCandidate, context: TerminalEvidenceContext) {
  const catalog: Array<{ fact: TerminalCarriedFact; paths: string[] }> = []
  for (const field of fields) for (const [index, claim] of candidate.exitState[field].entries()) {
    const matches = context.previous?.carried?.filter(fact => fact.field === field && fact.claim === claim && fact.depth < 16) ?? []
    if (matches.length !== 1) continue
    const fact = matches[0], entry = catalog.find(item => item.fact.proofHash === fact.proofHash)
    if (entry) entry.paths.push(`exitState.${field}.${index}`)
    else catalog.push({ fact, paths: [`exitState.${field}.${index}`] })
  }
  return catalog.sort((a, b) => a.fact.proofHash.localeCompare(b.fact.proofHash))
}

/** Only a new independent unchanged judgment supplies support. Changed does
 * not mean ended/negated; both other judgments remain unknown. */
export function readTerminalProofVerdicts(value: unknown, candidate: TerminalCandidate, context: TerminalEvidenceContext) {
  const catalog = terminalProofCatalog(candidate, context)
  const parsed = z.array(terminalProofVerdictSchema).max(200).safeParse(value ?? (catalog.length ? undefined : []))
  if (!parsed.success || parsed.data.length !== catalog.length || new Set(parsed.data.map(item => item.proofHash)).size !== parsed.data.length
    || parsed.data.some(item => !catalog.some(entry => entry.fact.proofHash === item.proofHash))) return null
  const verdicts = parsed.data.flatMap(item => {
    const { fact, paths } = catalog.find(entry => entry.fact.proofHash === item.proofHash)!
    return paths.map(path => ({ path, verdict: item.currentState === 'unchanged' ? 'supported' as const : 'unknown' as const,
      basis: 'inherited' as const, sourceEvidence: [{ segmentId: fact.segmentId, quote: fact.anchors[0].quote }],
      inheritance: { priorEndState: 'established' as const, currentState: item.currentState } }))
  })
  return { checks: parsed.data, verdicts }
}
