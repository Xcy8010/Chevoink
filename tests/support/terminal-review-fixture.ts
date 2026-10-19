import { prisma } from '../../api/lib/prisma.js'
import { validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { terminalCandidateSchema, terminalClaims, type TerminalCandidate } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'

/** Synthetic independent response for protocol/transaction tests only. This is
 * not a semantic model evaluation and never dispatches a provider request. */
export async function saveSyntheticTerminalReview(subject: { userId: string; novelId: string }, compilationId: string,
  input: TerminalCandidate, verdict: 'supported' | 'unknown' = 'supported') {
  const candidate = terminalCandidateSchema.parse({ exitState: input.exitState, lastUnfinishedAction: input.lastUnfinishedAction })
  const result = await validateStoryContinuity({ ...subject, compilationId, findings: [], independentCheck: 'complete', terminalCandidate: candidate })
  const raw = JSON.stringify({ findings: [], terminalVerdicts: terminalClaims(candidate).map(item => ({ path: item.path, verdict, segmentIds: ['c0'] })) })
  const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { chapter: true } })
  const audit = inspectContinuityResponse(raw, { previous: null, current: compilation.chapter!.content }, true, 6, candidate).audit
  await prisma.storyCompilation.update({ where: { id: compilationId }, data: { validation: { ...result, continuityCriticResponse: audit } } })
}
