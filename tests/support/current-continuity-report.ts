import { randomUUID } from 'node:crypto'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import { buildContinuitySnapshot, reviewContinuity, type ContinuityOpinion } from '../../api/lib/agent/continuity-review.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

/** Fixture only: synthetic provider bytes, real owned source reads and report
 * persistence. This does not seed a phase, a grant, a fee or a terminal proof. */
export async function persistCurrentContinuityReport(input: { userId: string; novelId: string; runId: string; compilationId: string;
  focus?: string; expectedChapterRevision?: number; independentCheck?: 'complete' | 'unavailable'; opinions?: ContinuityOpinion[] | ((snapshot: Awaited<ReturnType<typeof buildContinuitySnapshot>>) => ContinuityOpinion[]) }) {
  const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { id: input.compilationId, userId: input.userId, novelId: input.novelId }, include: { chapter: true } })
  const run = await prisma.agentRun.findFirstOrThrow({ where: { id: input.runId, userId: input.userId, novelId: input.novelId }, select: { sessionId: true } })
  const ctx: ToolContext = { userId: input.userId, novelId: input.novelId, runId: input.runId, sessionId: run.sessionId,
    chapterId: compilation.chapterId, callId: randomUUID(), mode: 'build', creativeFreedom: 'balanced', qualityMode: compilation.mode,
    signal: new AbortController().signal, emit: () => {} }
  const args = { compilationId: compilation.id, ...(input.focus ? { focus: input.focus } : {}) }, snapshot = await buildContinuitySnapshot(ctx, args)
  if (input.expectedChapterRevision !== undefined && input.expectedChapterRevision !== snapshot.chapter.revision)
    throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '合成报告的预期版本与真实当前正文不一致。')
  const opinions = typeof input.opinions === 'function' ? input.opinions(snapshot) : input.opinions ?? []
  const result = await reviewContinuity(ctx, args, { snapshot, allowRepair: false,
    dispatch: async request => ({ content: input.independentCheck === 'unavailable' ? '{incomplete' : request.action === 'agent3ContinuityEvidenceCorrection'
      ? '{"corrections":[]}' : JSON.stringify({ findings: opinions }), usageIds: [], billingKnown: true }) })
  const stored = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
  return { result, validation: stored.validation, snapshot }
}
/** Convert only fixture opinions whose quoted evidence maps to one real source
 * entry. Missing/ambiguous/cross-entry quotes cannot invent a model address. */
export function continuityOpinionsFromSourceQuotes(findings: Array<{ signal: ContinuityOpinion['signal']; severity: ContinuityOpinion['severity']; evidence: string;
  suggestion: string; sourceEvidence?: Array<{ source: 'current' | 'previous'; quote: string }> }>, snapshot: Awaited<ReturnType<typeof buildContinuitySnapshot>>): ContinuityOpinion[] {
  return findings.map(finding => ({ signal: finding.signal, severity: finding.severity, explanation: finding.evidence, suggestion: finding.suggestion,
    evidence: (finding.sourceEvidence?.length ? finding.sourceEvidence : [{ source: 'current' as const, quote: finding.evidence }]).map(reference => {
      const matches = snapshot.sources.filter(source => source.source === reference.source).flatMap(source => source.table.entries.filter(entry => entry.text.includes(reference.quote)))
      if (!reference.quote || matches.length !== 1) throw new Error('Fixture opinion must quote exactly one owned source entry: ' + reference.quote)
      return { sourceId: matches[0].id.slice(0, 13) }
    }) }))
}
