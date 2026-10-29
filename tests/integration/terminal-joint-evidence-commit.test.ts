import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { prepareStoryCompilation, saveSceneTasks, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as memory from '../../api/lib/agent/story-memory.js'

const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The main outputs thirty units and the reserve reads one unit.'] } })
const checks = Object.fromEntries(['action_direction', 'state_progression'].map(kind => [kind, { result: 'clear', reason: 'Independent synthetic full-body review.', findingIndexes: [] }]))

describe.runIf(available)('joint evidence survives actual save, readiness and commit', () => {
  it.each([5, 6] as const)('preserves v%i joint evidence while committing current reports and rejecting edited sources', protocol => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    const second = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2, revision: 1, content: 'The reserve now reads one unit.' } })
    const first = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: second.volumeId, title: 'Synthetic source', orderIndex: 1, orderInVolume: 1, revision: 1, content: 'The main circuit outputs thirty units.' } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null } })
    const histories: Array<Awaited<ReturnType<typeof prisma.agentArtifact.create>>> = []
    async function reviewAndCommit(runId: string, chapter: typeof second) {
      const subject = { userId: f.userId, novelId: f.novelId, runId }
      const { compilation } = await prepareStoryCompilation({ ...subject, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Review the synthetic chapter.' })
      await saveSceneTasks({ ...subject, compilationId: compilation.id, tasks: [{ purpose: 'Record resources', entryState: candidate.exitState, goal: 'Record', obstacle: 'Limited power', choice: 'Inventory', cost: 'Time', turn: 'Recorded', exitState: candidate.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
      const live = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
      const source = await readCompilerContinuitySource(prisma, subject, chapter, live.bridge!.fromChapterId, 11)
      const evidence = terminalEvidenceContext(chapter, source, 2, 1, undefined, protocol)
      const fact = terminalCandidateFacts(candidate)[0]
      if (chapter.id === second.id) {
        const raw = JSON.stringify({ findings: [], semanticChecks: checks, terminalVerdicts: [{ ...(protocol === 6 ? { claimIndex: 0 } : { factId: fact.id, path: fact.path }), verdict: 'supported',
          sourceEvidence: [{ segmentId: 'c0' }, { segmentId: 'p0' }], inheritance: { priorEndState: 'established', currentState: 'unchanged' } }], terminalProofVerdicts: [] })
        const inspected = inspectContinuityResponse(raw, { previous: source!.content, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
        expect(inspected.complete).toBe(true)
        histories.push(await prisma.agentArtifact.create({ data: { runId, artifactType: 'continuityReview', title: 'Frozen joint evidence', content: raw,
          metadata: runtimeJson({ protocol, audit: inspected.audit }).value } }))
      }
      const { snapshot, result } = await persistCurrentContinuityReport({ ...subject, compilationId: compilation.id, expectedChapterRevision: chapter.revision })
      expect(result.outcome).not.toBe('failed')
      expect(result.reviewCompleted).toBe(true)
      expect(snapshot.previous.map(item => item.id)).toEqual(chapter.id === second.id ? [first.id] : [second.id, first.id])
      await persistHumanityQualityReport({ ...subject, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      const ready = await prisma.$transaction(tx => readChapterReviewReadiness(tx, subject, compilation.id))
      expect(ready).toMatchObject({ ready: true, continuity: 'complete', quality: 'complete' })
      expect(ready).not.toHaveProperty('terminalReview')
      const before = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })
      await commitChapterBridge({ ...subject, compilationId: compilation.id, ...candidate, chapterSummary: 'Resources recorded.', hookDecision: '', delayedHookReason: '', openingStructure: 'Record', endingStructure: 'Continue' })
      const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
      expect(committed).toMatchObject({ status: 'completed', stage: 'commit', bridge: { targetRevision: chapter.revision, committedAt: expect.any(Date), knowledgeState: before.knowledgeState } })
      expect(committed.preparedContext).not.toHaveProperty('terminalFactProofs')
      return committed
    }
    const committed = await reviewAndCommit(f.runId, second)
    expect(committed.bridge!.committedAt).not.toBeNull()
    const third = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: second.volumeId, title: 'Synthetic continuation', orderIndex: 3, orderInVolume: 3, revision: 1, content: 'The officer closes the log.' } })
    const nextRun = randomUUID()
    await prisma.agentRun.create({ data: { id: nextRun, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: third.id, status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0,
      taskSpec: JSON.parse(JSON.stringify(buildTaskSpec({ runId: nextRun, novelId: f.novelId, chapterId: third.id, prompt: '修改本章', continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 }))) } })
    await prisma.agentMessage.create({ data: { runId: nextRun, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: '修改本章' }] } })
    const final = await reviewAndCommit(nextRun, third)
    expect(final).toMatchObject({ status: 'completed', stage: 'commit', bridge: { targetRevision: 1, committedAt: expect.any(Date) } })
    expect(await readTerminalInheritance(prisma, { userId: f.userId, novelId: f.novelId }, third)).toEqual([])
    await prisma.chapter.update({ where: { id: first.id }, data: { revision: 2 } })
    const stale = await prisma.$transaction(tx => readChapterReviewReadiness(tx, { userId: f.userId, novelId: f.novelId, runId: nextRun }, final.id))
    expect(stale).toMatchObject({ ready: false, continuity: 'stale' })
    const memoryBefore = await prisma.projectMemoryEntry.findMany({ where: { sourceChapterId: third.id }, orderBy: { id: 'asc' } })
    await expect(commitChapterBridge({ userId: f.userId, novelId: f.novelId, runId: nextRun, compilationId: final.id, ...candidate,
      chapterSummary: 'Resources recorded.', hookDecision: '', delayedHookReason: '', openingStructure: 'Record', endingStructure: 'Continue' })).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: final.id } })).toEqual(final.bridge)
    expect(await prisma.projectMemoryEntry.findMany({ where: { sourceChapterId: third.id }, orderBy: { id: 'asc' } })).toEqual(memoryBefore)
    for (const history of histories) expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: history.id } })).toEqual(history)
    expect(await readTerminalInheritance(prisma, { userId: f.userId, novelId: f.novelId }, third)).toEqual([])
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
  }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1 }), 30000)
})
