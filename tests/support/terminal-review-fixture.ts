import { prisma } from '../../api/lib/prisma.js'
import { terminalCandidateSchema, terminalClaims, type TerminalCandidate } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { persistCurrentContinuityReport } from './current-continuity-report.js'

/** Retain a fixed historical parser6 record, then obtain the actual current
 * report through the shared runner with synthetic provider bytes only. */
export async function saveSyntheticTerminalReview(subject: { userId: string; novelId: string }, compilationId: string,
  input: TerminalCandidate, verdict: 'supported' | 'unknown' = 'supported') {
  const candidate = terminalCandidateSchema.parse({ exitState: input.exitState, lastUnfinishedAction: input.lastUnfinishedAction })
  const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { id: compilationId, userId: subject.userId, novelId: subject.novelId }, include: { chapter: true } })
  if (!compilation.runId) throw new Error('Synthetic terminal history requires its original run owner')
  const raw = JSON.stringify({ findings: [], terminalVerdicts: terminalClaims(candidate).map(item => ({ path: item.path, verdict, segmentIds: ['c0'] })) })
  const audit = inspectContinuityResponse(raw, { previous: null, current: compilation.chapter!.content }, true, 6, candidate).audit
  await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: compilation.runId, artifactType: 'continuityReview', title: 'Fixed parser6 history', metadata: runtimeJson({ audit, raw, candidate }).value } })
  return persistCurrentContinuityReport({ ...subject, runId: compilation.runId, compilationId, expectedChapterRevision: compilation.chapter!.revision })
}
