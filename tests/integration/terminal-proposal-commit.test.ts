import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { persistHistoricalContinuityAudit } from '../support/historical-continuity-audit.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts, terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { prepareCompilerTerminalProposals } from '../../api/lib/agent/terminal-proposal-context.js'
import { readTerminalProposalState, advanceTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'
import { applyTerminalCandidatePatch, readFrozenLegacyTerminalPatch, terminalCandidatePatchSchema } from '../../api/lib/agent/terminal-candidate-patch.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('frozen proposal history and ordinary current report commit', () => {
  it.each([[5, false, false], [5, true, false], [6, false, false], [6, true, false], [5, false, true], [6, false, true]] as const)(
    'preserves parser%i raw and proposal uncertainty across reprepare=%s, retained draft=%s without a candidate gate',
    (protocol, reprepare, preserveDraft) => fixture(async f => {
      const network = vi.fn(() => { throw Error('Unexpected live provider') }); vi.stubGlobal('fetch', network)
      vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: false })
      await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', runtimeProtocolVersion: 0, taskRootId: null } })
      const objects = Array.from({ length: 18 }, (_, index) => 'Tool' + index + ' stays.')
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 8,
        content: 'The gauge reads two. The output remains unchanged. ' + objects.join(' ') } })
      const base = terminalCandidateSchema.parse({ exitState: { knowledge: ['The two gauges share a combined reading.'],
        emotion: ['The operator distrusts a distant event.'], objects } })
      const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The gauge reads two.', 'The output remains unchanged.'], objects } })
      const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Review the current saved chapter.' })
      let compilationId = compilation.id
      const scenes = () => saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: 'Inventory', entryState: base.exitState, goal: 'Read', obstacle: 'Uncertainty',
        choice: 'Inspect', cost: 'Time', turn: 'Recorded', exitState: base.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
      await scenes()
      const load = () => prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { bridge: true, sceneTasks: true, chapter: true } })
      const context = (saved: Awaited<ReturnType<typeof load>>, selected: typeof base) => terminalEvidenceContext(chapter, null, 2, 1,
        terminalCoverageInput(f.spec, saved.preparedContext, chapter, selected, 2), protocol, 2)
      const raw = (selected: typeof base, proposals?: ReturnType<typeof prepareCompilerTerminalProposals>, include = false) => JSON.stringify({
        findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Original full-body review.', findingIndexes: [] })),
        terminalVerdicts: terminalCandidateFacts(selected).map((fact, claimIndex) => ({ ...(protocol === 6 ? { claimIndex } : { path: fact.path }),
          verdict: chapter.content.includes(fact.claim) ? 'supported' : 'unknown', sourceEvidence: chapter.content.includes(fact.claim) ? [{ segmentId: 'c0', quote: fact.claim }] : [] })),
        terminalProofVerdicts: [], terminalDispositions: [],
        ...(include ? { proposalDispositions: proposals!.changes!.proposals.map((proposal, proposalIndex) => ({ ...(protocol === 6 ? { proposalIndex } : { id: proposal.id }),
          outcome: proposal.field === 'emotion' ? preserveDraft ? 'unknown' : 'retracted' : 'replaced',
          reason: 'The original body establishes only the stated current readings.', sourceEvidence: proposal.field === 'emotion' && preserveDraft ? [] : [{ segmentId: 'c0', quote: chapter.content }],
          ...(proposal.field === 'knowledge' ? protocol === 6
            ? { candidateIndex: terminalCandidateFacts(candidate).findIndex(fact => fact.id === terminalFactId('knowledge', candidate.exitState.knowledge[0])) }
            : { candidateFactId: terminalFactId('knowledge', candidate.exitState.knowledge[0]) } : {}) })) } : {}),
      })
      const saveHistory = async (selected: typeof base, evidence: ReturnType<typeof context>, bytes: string) => {
        const saved = await load(), inspected = inspectContinuityResponse(bytes, { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, selected)
        await persistHistoricalContinuityAudit({ ...f, compilationId, expectedChapterRevision: 8, terminalCandidate: selected,
          independentCheck: inspected.complete ? 'complete' : 'unavailable', findings: inspected.findings,
          coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null, terminalCandidate: selected }, 11), continuityCriticResponse: inspected.audit })
        return inspected
      }
      expect((await saveHistory(base, context(await load(), base), raw(base))).complete).toBe(true)
      const old = await load(), evidence = context(old, candidate)
      const proposals = prepareCompilerTerminalProposals({ spec: f.spec, preparedContext: old.preparedContext, validation: old.validation,
        chapter, source: null, candidate, nextContext: evidence })!
      expect(proposals.changes!.proposals.map(proposal => proposal.field).sort()).toEqual(['emotion', 'knowledge'])
      expect(proposals.changes!.verifiedFactIds).toContain(terminalFactId('objects', objects[0]))
      const patch = terminalCandidatePatchSchema.parse({ baseCandidateHash: runtimeJson(base).hash,
        removeFactIds: terminalCandidateFacts(base).filter(fact => fact.field !== 'objects').map(fact => fact.id),
        addFacts: candidate.exitState.knowledge.map(claim => ({ field: 'knowledge', claim })) })
      const ctx = { ...f, callId: 'original-proposal-delta', signal: new AbortController().signal }, original = await readOriginalTaskRequest(prisma, f)
      const snapshot = { version: 2, kind: 'terminalCandidatePatch', identity: { ...f, taskId: original.taskId, callId: ctx.callId,
        compilationId, chapterId: chapter.id, revision: 8, bodyHash: runtimeJson({ content: chapter.content }).hash, sourceHash: runtimeJson({ source: null }).hash },
        request: { patch, inheritedProofs: [] }, base, candidate: applyTerminalCandidatePatch(base, patch), proposalReview: proposals }
      // Historical identity stores only its original fields, not fixture objects.
      const identity = { userId: f.userId, novelId: f.novelId, taskId: original.taskId, runId: f.runId, callId: ctx.callId,
        compilationId, chapterId: chapter.id, revision: 8, bodyHash: runtimeJson({ content: chapter.content }).hash, sourceHash: runtimeJson({ source: null }).hash }
      const historical = await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', id: runtimeJson({ kind: 'terminalCandidatePatch', runId: f.runId, callId: ctx.callId, compilationId }).hash,
        runId: f.runId, artifactType: 'continuityReview', title: 'Fixed original proposal snapshot', metadata: runtimeJson({ ...snapshot, identity }).value } })
      const read = () => prisma.$transaction(async tx => {
        const saved = await tx.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { chapter: true } })
        return readFrozenLegacyTerminalPatch(tx, ctx, { ...saved, chapter: saved.chapter! }, null, [], 2, patch)
      })
      expect(await read()).toMatchObject({ proposalVersion: 2, proposalReview: proposals, candidate })
      const oldContext = { ...evidence, proposalChanges: proposals.changes }
      const incomplete = await saveHistory(candidate, oldContext, raw(candidate))
      expect(incomplete.complete).toBe(false)
      expect(readTerminalProposalState((await load()).preparedContext, { taskId: original.taskId, chapterId: chapter.id })?.pending).toHaveLength(2)
      expect(await read()).toMatchObject({ candidate, expectedBaseHash: runtimeJson(candidate).hash })
      const finalRaw = raw(candidate, proposals, true), inspected = inspectContinuityResponse(finalRaw,
        { previous: null, current: chapter.content, terminalEvidence: oldContext }, true, 8, candidate)
      expect(inspected.complete).toBe(true)
      const reviewed = currentTerminalReview({ independentCheck: 'complete', terminalCandidate: candidate, continuityCriticResponse: inspected.audit }, chapter.content, oldContext)!
      expect(advanceTerminalProposals(proposals.state, proposals.changes!, reviewed).pending).toEqual(preserveDraft ? proposals.state.pending : [])
      const originalBytes = await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId, artifactType: 'continuityReview',
        title: 'Original parser8 report', metadata: runtimeJson({ raw: finalRaw, audit: inspected.audit, candidate, proposals }).value } })
      if (reprepare) {
        const before = compilationId
        const rebuilt = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Current saved target, freshly prepared.' })
        expect(rebuilt.compilation.id).not.toBe(before)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: before } })).status).toBe('abandoned')
        compilationId = rebuilt.compilation.id; await scenes()
        expect((await load()).preparedContext).not.toHaveProperty('terminalProposalReview')
      }
      await persistCurrentContinuityReport({ ...f, compilationId, expectedChapterRevision: 8 })
      await persistHumanityQualityReport({ ...f, compilationId, chapterId: chapter.id, chapterRevision: 8, mode: 'balanced',
        criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))).toMatchObject({ ready: true, decisionPending: false })
      const beforeBridge = (await load()).bridge!
      await commitChapterBridge({ ...f, compilationId, ...candidate, chapterSummary: 'The current readings are recorded.',
        hookDecision: '', delayedHookReason: '', openingStructure: 'Read', endingStructure: 'Record' })
      expect(await load()).toMatchObject({ status: 'completed', bridge: { committedAt: expect.any(Date), targetRevision: 8,
        knowledgeState: beforeBridge.knowledgeState, objectState: beforeBridge.objectState, emotionAftermath: beforeBridge.emotionAftermath } })
      expect((await load()).preparedContext).not.toHaveProperty('terminalFactProofs')
      expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
      expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: originalBytes.id } })).toEqual(originalBytes)
      if (preserveDraft) {
        const next = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: 'Next inventory',
          orderIndex: 2, orderInVolume: 2, revision: 1, content: 'The operator closes the inventory.' } })
        const runId = randomUUID(), prompt = '修改第二章', spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: next.id, prompt })
        await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: next.id,
          status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0,
          taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value, startRequest: { prompt } } })
        await prisma.agentMessage.create({ data: { runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
        const subject = { userId: f.userId, novelId: f.novelId, runId }, prepared = await prepareStoryCompilation({ ...subject, chapterId: next.id, mode: 'balanced', intentSummary: prompt })
        await saveSceneTasks({ ...subject, compilationId: prepared.compilation.id, tasks: [{ purpose: 'Close', entryState: state, goal: 'Record', obstacle: 'Time', choice: 'Close',
          cost: 'Time', turn: 'Recorded', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
        const source = await readCompilerContinuitySource(prisma, subject, next, chapter.id, 11)
        expect(source).toMatchObject({ id: chapter.id, revision: 8 })
        await persistCurrentContinuityReport({ ...subject, compilationId: prepared.compilation.id, expectedChapterRevision: 1 })
        await prisma.chapter.update({ where: { id: chapter.id }, data: { content: chapter.content + ' An author correction.' } })
        await expect(commitChapterBridge({ ...subject, compilationId: prepared.compilation.id, chapterSummary: 'Next record.',
          hookDecision: '', delayedHookReason: '', openingStructure: 'Close', endingStructure: 'Record' })).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
        expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: originalBytes.id } })).toEqual(originalBytes)
      }
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      expect(network).not.toHaveBeenCalled()
    }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
