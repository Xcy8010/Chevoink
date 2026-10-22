import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts, terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { prepareCompilerTerminalProposals } from '../../api/lib/agent/terminal-proposal-context.js'
import { readTerminalProposalState } from '../../api/lib/agent/terminal-proposal-review.js'
import { freezeLegacyTerminalPatch, terminalCandidatePatchSchema } from '../../api/lib/agent/terminal-candidate-patch.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('proposal retraction at the real report and commit transaction', () => {
  it.each([false, true])('freezes before dispatch, retains invalid proposals through reprepare=%s, then commits independent dispositions', reprepare => fixture(async f => {
    const network = vi.fn(() => { throw Error('Unexpected provider request') })
    vi.stubGlobal('fetch', network)
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', runtimeProtocolVersion: 0, taskRootId: null } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 8,
      content: 'The gauge reads two. The output remains unchanged. The bent tool remains in the pocket.' } })
    const base = terminalCandidateSchema.parse({ exitState: { knowledge: ['The two gauges share a combined reading.'],
      emotion: ['The operator distrusts a distant event.'], objects: ['The bent tool remains in the pocket.'] } })
    const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The gauge reads two.', 'The output remains unchanged.'], objects: base.exitState.objects } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Review the saved synthetic chapter.' })
    let compilationId = compilation.id
    const buildScenes = () => saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: 'Inventory', entryState: base.exitState,
      goal: 'Read', obstacle: 'Uncertainty', choice: 'Inspect', cost: 'Time', turn: 'Recorded', exitState: base.exitState,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await buildScenes()
    const load = () => prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { bridge: true, sceneTasks: true, chapter: true } })
    const evidenceFor = (saved: Awaited<ReturnType<typeof load>>, selected: typeof base) => terminalEvidenceContext(chapter, null, 2, 1,
      terminalCoverageInput(f.spec, saved.preparedContext, chapter, selected, 2), 5, 2)
    const rawFor = (selected: typeof base, proposals?: ReturnType<typeof prepareCompilerTerminalProposals>, includeDispositions = false) => JSON.stringify({
      findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Independent synthetic full-body review.', findingIndexes: [] })),
      terminalVerdicts: terminalCandidateFacts(selected).map(fact => ({ path: fact.path, verdict: chapter.content.includes(fact.claim) ? 'supported' : 'unknown',
        sourceEvidence: chapter.content.includes(fact.claim) ? [{ segmentId: 'c0', quote: fact.claim }] : [] })),
      terminalProofVerdicts: [], terminalDispositions: [],
      ...(includeDispositions ? { proposalDispositions: proposals!.changes!.proposals.map(proposal => ({ id: proposal.id,
        outcome: proposal.field === 'emotion' ? 'retracted' : 'replaced', reason: 'The full saved body supports only the stated current readings.',
        sourceEvidence: [{ segmentId: 'c0', quote: chapter.content }],
        ...(proposal.field === 'knowledge' ? { candidateFactId: terminalFactId('knowledge', candidate.exitState.knowledge[0]) } : {}) })) } : {}),
    })
    const save = async (selected: typeof base, evidence: ReturnType<typeof evidenceFor>, raw: string, expectedTerminalCandidateHash?: string) => {
      const saved = await load(), inspected = inspectContinuityResponse(raw, { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, selected)
      await validateStoryContinuity({ ...f, compilationId, expectedChapterRevision: chapter.revision, expectedTerminalCandidateHash,
        independentCheck: inspected.complete ? 'complete' : 'unavailable', findings: inspected.findings, terminalCandidate: selected,
        coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null, terminalCandidate: selected }, 11),
        continuityCriticResponse: inspected.audit })
      return inspected
    }
    expect((await save(base, evidenceFor(await load(), base), rawFor(base))).complete).toBe(true)
    const old = await load(), context = evidenceFor(old, candidate)
    const proposals = prepareCompilerTerminalProposals({ spec: f.spec, preparedContext: old.preparedContext, validation: old.validation,
      chapter, source: null, candidate, nextContext: context })!
    expect(proposals.changes!.proposals.map(proposal => proposal.field).sort()).toEqual(['emotion', 'knowledge'])
    expect(proposals.changes!.verifiedFactIds).toContain(terminalFactId('objects', base.exitState.objects[0]))
    const patch = terminalCandidatePatchSchema.parse({ baseCandidateHash: runtimeJson(base).hash,
      removeFactIds: terminalCandidateFacts(base).filter(fact => fact.field !== 'objects').map(fact => fact.id),
      addFacts: candidate.exitState.knowledge.map(claim => ({ field: 'knowledge', claim })) })
    const ctx = { ...f, callId: 'synthetic-owned-delta', signal: new AbortController().signal }
    const frozen = await prisma.$transaction(tx => freezeLegacyTerminalPatch(tx, ctx, { ...old, chapter }, null, [], 2, patch, [], () => proposals))
    expect(frozen).toMatchObject({ proposalVersion: 2, proposalReview: proposals, candidate })
    expect((await load()).preparedContext).toEqual(old.preparedContext)
    expect((await load()).validation).toEqual(old.validation)
    const evidence = { ...context, proposalChanges: proposals.changes }
    expect((await save(candidate, evidence, rawFor(candidate), frozen.expectedBaseHash)).complete).toBe(false)
    const failed = await load()
    expect(readTerminalProposalState(failed.preparedContext, { taskId: f.spec.id, chapterId: chapter.id })?.pending).toHaveLength(2)
    expect(failed.validation).toMatchObject({ independentCheck: 'unavailable', terminalCandidate: candidate })
    expect(await prisma.$transaction(tx => freezeLegacyTerminalPatch(tx, ctx, { ...failed, chapter }, null, [], 2, patch, [], () => { throw Error('Do not recompute frozen input') })))
      .toMatchObject({ proposalReview: proposals, candidate, expectedBaseHash: runtimeJson(candidate).hash })
    if (reprepare) {
      const rebuilt = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Reprepare the same saved synthetic target.' })
      expect(rebuilt.compilation.id).not.toBe(compilationId)
      expect((await load()).status).toBe('abandoned')
      compilationId = rebuilt.compilation.id
      await buildScenes()
      const restored = await load()
      expect(readTerminalProposalState(restored.preparedContext, { taskId: f.spec.id, chapterId: chapter.id }))
        .toEqual(readTerminalProposalState(failed.preparedContext, { taskId: f.spec.id, chapterId: chapter.id }))
      expect(restored.validation).toMatchObject({ independentCheck: 'unavailable', terminalCandidate: candidate,
        continuityCriticResponse: (failed.validation as Record<string, unknown>).continuityCriticResponse })
      expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))).toMatchObject({
        continuity: 'incomplete', terminalCommitted: false, terminalReview: { state: 'unverified' },
      })
    }
    const current = await load()
    const renewed = prepareCompilerTerminalProposals({ spec: f.spec, preparedContext: current.preparedContext, validation: current.validation,
      chapter, source: null, candidate, nextContext: evidenceFor(current, candidate) })!
    expect(renewed.changes).toEqual(proposals.changes)
    expect((await save(candidate, { ...context, proposalChanges: renewed.changes }, rawFor(candidate, renewed, true))).complete).toBe(true)
    const passed = await load()
    expect(readTerminalProposalState(passed.preparedContext, { taskId: f.spec.id, chapterId: chapter.id })?.pending).toEqual([])
    await persistHumanityQualityReport({ ...f, compilationId, chapterId: chapter.id, chapterRevision: chapter.revision,
      mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilationId))).toMatchObject({ ready: true, terminalReview: { state: 'supported' } })
    await commitChapterBridge({ ...f, compilationId, ...candidate, chapterSummary: 'The current readings are recorded.', hookDecision: '', delayedHookReason: '', openingStructure: 'Read', endingStructure: 'Record' })
    expect((await load()).status).toBe('completed')
    expect((await readTerminalInheritance(prisma, f, chapter)).map(fact => fact.claim)).toContain(base.exitState.objects[0])
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ revision: 8, content: chapter.content })
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
    expect(network).not.toHaveBeenCalled()
  }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
