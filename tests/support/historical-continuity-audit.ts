import { prisma } from '../../api/lib/prisma.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput, advanceTerminalCoverage } from '../../api/lib/agent/terminal-fact-coverage.js'
import { currentTerminalReview, readTerminalCandidate, type TerminalCandidate } from '../../api/lib/agent/terminal-state-review.js'
import { prepareCompilerTerminalProposals } from '../../api/lib/agent/terminal-proposal-context.js'
import { advanceTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { CompilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { continuityStoryInput } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalReviewStateHash } from '../../api/lib/agent/chapter-review-guard.js'
import { buildTerminalFactProofs } from '../../api/lib/agent/terminal-inheritance-chain.js'

/** Build an already-saved synthetic legacy record for read-only history tests.
 * No reservation, dispatcher, current report or new authorization is created.
 * Current execution must subsequently use the registered shared runner. */
export async function persistHistoricalContinuityAudit(input: {
  userId: string; novelId: string; runId: string; compilationId: string;
  expectedChapterRevision?: number; independentCheck?: 'complete' | 'unavailable';
  findings: unknown[]; terminalCandidate: TerminalCandidate; coverage: CompilerContinuityCoverage;
  continuityCriticResponse: unknown;
}) {
  const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: input.compilationId }, include: { chapter: true, bridge: true } })
  const chapter = saved.chapter!
  if (saved.userId !== input.userId || saved.novelId !== input.novelId || saved.runId !== input.runId
    || input.expectedChapterRevision !== undefined && input.expectedChapterRevision !== chapter.revision) throw new Error('Historical fixture identity mismatch')
  const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, input))
  const source = await readCompilerContinuitySource(prisma, input, chapter, saved.bridge!.fromChapterId, 11)
  const prepared = saved.preparedContext && typeof saved.preparedContext === 'object' && !Array.isArray(saved.preparedContext) ? saved.preparedContext : {}
  const previous = saved.validation && typeof saved.validation === 'object' && !Array.isArray(saved.validation) ? saved.validation : {}
  const validation = { ...previous, checkedChapterId: chapter.id, checkedRevision: chapter.revision,
    checkedContent: chapter.content, checkedAt: new Date().toISOString(), independentCheck: input.independentCheck ?? 'unavailable',
    findings: input.findings, errorCount: 0, warningCount: 0, coverage: input.coverage,
    terminalCandidate: input.terminalCandidate, continuityCriticResponse: input.continuityCriticResponse }
  const audit = input.continuityCriticResponse as { terminalEvidence?: Parameters<typeof currentTerminalReview>[2] }
  const context = audit.terminalEvidence ?? terminalEvidenceContext(chapter, source, 2, 1,
    terminalCoverageInput(original.spec, prepared, chapter, input.terminalCandidate, 2), 5)
  const proposal = previous.terminalCandidate ? prepareCompilerTerminalProposals({ spec: original.spec,
    preparedContext: prepared, validation: previous, chapter, source, candidate: input.terminalCandidate, nextContext: context }) : undefined
  const review = currentTerminalReview(validation, chapter.content, context)
  const coverage = review ? advanceTerminalCoverage(original.spec, prepared, chapter, review, context.factCoverage) : undefined
  const proposals = proposal && review && proposal.changes ? advanceTerminalProposals(proposal.state, proposal.changes, review) : proposal?.state
  await prisma.storyCompilation.update({ where: { id: saved.id }, data: { validation: runtimeJson(validation).value,
    preparedContext: runtimeJson({ ...prepared, ...(coverage ? { terminalFactCoverage: coverage } : {}), ...(proposals ? { terminalProposalReview: proposals } : {}) }).value } })
  return validation
}

/** Seed an already-committed synthetic predecessor receipt. This preserves
 * coverage/proof reader tests without reviving the removed runtime mutator. */
export async function persistHistoricalCommittedBridge(compilationId: string) {
  const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { bridge: true, chapter: true, sceneTasks: true } })
  const chapter = saved.chapter!, candidate = readTerminalCandidate(saved.validation)!
  const validation = saved.validation as { continuityCriticResponse: { terminalEvidence: Parameters<typeof currentTerminalReview>[2] } }
  const context = validation.continuityCriticResponse.terminalEvidence!
  const review = currentTerminalReview(validation, chapter.content, context)
  if (!review?.supported) throw new Error('Historical predecessor requires an actually supported legacy report')
  const bridge = await prisma.chapterBridge.update({ where: { id: saved.bridge!.id }, data: { targetRevision: chapter.revision,
    committedAt: new Date(), objectState: candidate.exitState.objects, openLoops: candidate.exitState.openLoops } })
  await prisma.sceneTask.updateMany({ where: { compilationId }, data: { status: 'completed' } })
  const stateHash = terminalReviewStateHash(bridge, saved.sceneTasks)
  const prepared = saved.preparedContext as Record<string, unknown>
  await prisma.storyCompilation.update({ where: { id: compilationId }, data: { stage: 'commit', status: 'completed', completedAt: new Date(),
    preparedContext: runtimeJson({ ...prepared, terminalCandidateHash: review.candidateHash, terminalContentHash: review.contentHash,
      terminalReviewProof: { version: 2, checkedBridge: continuityStoryInput(saved.bridge), terminalStateHash: stateHash },
      terminalFactProofs: buildTerminalFactProofs({ compilationId, chapter, validation, stateHash, evidence: context, review }) }).value } })
}
