import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import * as memory from '../../api/lib/agent/story-memory.js'

const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The main outputs thirty units and the reserve reads one unit.'] } })
const checks = Object.fromEntries(['action_direction', 'state_progression'].map(kind => [kind, { result: 'clear', reason: 'Independent synthetic full-body review.', findingIndexes: [] }]))

describe.runIf(available)('joint evidence survives actual save, readiness and commit', () => {
  it('commits a c/p fact, carries it unchanged into a third chapter and rejects an edited historical anchor', () => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    const second = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2, revision: 1, content: 'The reserve now reads one unit.' } })
    const first = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: second.volumeId, title: 'Synthetic source', orderIndex: 1, orderInVolume: 1, revision: 1, content: 'The main circuit outputs thirty units.' } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null } })
    async function reviewAndCommit(runId: string, chapter: typeof second, proofHash?: string) {
      const subject = { userId: f.userId, novelId: f.novelId, runId }
      const { compilation } = await prepareStoryCompilation({ ...subject, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Review the synthetic chapter.' })
      await saveSceneTasks({ ...subject, compilationId: compilation.id, tasks: [{ purpose: 'Record resources', entryState: candidate.exitState, goal: 'Record', obstacle: 'Limited power', choice: 'Inventory', cost: 'Time', turn: 'Recorded', exitState: candidate.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
      const live = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
      const source = await readCompilerContinuitySource(prisma, subject, chapter, live.bridge!.fromChapterId, 11)
      const evidence = terminalEvidenceContext(chapter, source, 2, 1, undefined, 5)
      const fact = terminalCandidateFacts(candidate)[0]
      const raw = JSON.stringify({ findings: [], semanticChecks: checks, terminalVerdicts: proofHash ? [] : [{ factId: fact.id, path: fact.path, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }, { segmentId: 'p0' }], inheritance: { priorEndState: 'established', currentState: 'unchanged' } }],
        terminalProofVerdicts: proofHash ? [{ proofHash, currentState: 'unchanged', reason: 'The complete new body does not change these persistent resources.' }] : [] })
      const inspected = inspectContinuityResponse(raw, { previous: source!.content, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
      expect(inspected.complete).toBe(true)
      await validateStoryContinuity({ ...subject, compilationId: compilation.id, expectedChapterRevision: chapter.revision, independentCheck: 'complete', findings: [], terminalCandidate: candidate,
        coverage: compilerContinuityCoverage({ chapter, bridge: live.bridge, sceneTasks: live.sceneTasks, source, terminalCandidate: candidate }, 11), continuityCriticResponse: inspected.audit })
      await persistHumanityQualityReport({ ...subject, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      const ready = await prisma.$transaction(tx => readChapterReviewReadiness(tx, subject, compilation.id))
      expect(ready).toMatchObject({ ready: true, terminalReview: { state: 'supported' } })
      await commitChapterBridge({ ...subject, compilationId: compilation.id, ...candidate, chapterSummary: 'Resources recorded.', hookDecision: '', delayedHookReason: '', openingStructure: 'Record', endingStructure: 'Continue' })
      return prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    }
    const committed = await reviewAndCommit(f.runId, second)
    const proofs = (committed.preparedContext as { terminalFactProofs: Array<{ proofHash: string; anchors: Array<{ chapterId: string }> }> }).terminalFactProofs
    expect(proofs[0].anchors.map(anchor => anchor.chapterId)).toEqual([second.id, first.id])
    const third = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: second.volumeId, title: 'Synthetic continuation', orderIndex: 3, orderInVolume: 3, revision: 1, content: 'The officer closes the log.' } })
    const nextRun = randomUUID()
    await prisma.agentRun.create({ data: { id: nextRun, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: third.id, status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0,
      taskSpec: JSON.parse(JSON.stringify(buildTaskSpec({ runId: nextRun, novelId: f.novelId, chapterId: third.id, prompt: '修改本章', continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 }))) } })
    await prisma.agentMessage.create({ data: { runId: nextRun, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: '修改本章' }] } })
    const final = await reviewAndCommit(nextRun, third, proofs[0].proofHash)
    expect(final).toMatchObject({ status: 'completed', stage: 'commit', bridge: { targetRevision: 1, committedAt: expect.any(Date) }, preparedContext: { terminalFactProofs: [expect.objectContaining({ depth: 2 })] } })
    await prisma.chapter.update({ where: { id: first.id }, data: { revision: 2 } })
    expect(await readTerminalInheritance(prisma, { userId: f.userId, novelId: f.novelId }, third)).toEqual([])
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
  }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 }), 30000)
})
