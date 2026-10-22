import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { commitChapterBridge, prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { observeChapterReviewProgress } from '../../api/lib/agent/semantic-progress.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('request-owned evidence at the real commit boundary', () => {
  it.each([['supported', undefined], ['unknown', undefined], ['supported', 2], ['unknown', 2]] as const)('keeps the same original v1 task and commits only a complete review: %s / verdict protocol %s', (status, verdictProtocol) => fixture(async f => {
    const network = vi.fn(() => { throw Error('Offline report application cannot dispatch') })
    vi.stubGlobal('fetch', network)
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const initialBody = 'The sensor remains offline.'
    let current = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: initialBody, revision: 1 } })
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: 'Review the existing chapter.' })
    const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Record repair', entryState: empty, goal: 'Check sensor', obstacle: 'Offline',
      choice: 'Record', cost: 'Time', turn: 'Repair needed', exitState: empty, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const oldCandidate = terminalCandidateSchema.parse({ exitState: { knowledge: [initialBody] } })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    const source = await readCompilerContinuitySource(prisma, f, current, saved.bridge!.fromChapterId, 11)
    const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'not_applicable', reason: 'Synthetic protocol judgment.', findingIndexes: [] }))
    const oldEvidence = terminalEvidenceContext(current, source, 2, 1, terminalCoverageInput(f.spec, {}, current, oldCandidate, 1))
    const oldRaw = JSON.stringify({ findings: [], semanticChecks: checks, terminalVerdicts: [{ path: 'exitState.knowledge.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: initialBody }] }] })
    const oldAudit = inspectContinuityResponse(oldRaw, { previous: null, current: current.content, terminalEvidence: oldEvidence }, true, 8, oldCandidate).audit
    await validateStoryContinuity({ ...f, compilationId: compilation.id, findings: [], independentCheck: 'complete', terminalCandidate: oldCandidate,
      coverage: compilerContinuityCoverage({ chapter: current, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: oldCandidate }, 11), continuityCriticResponse: oldAudit })
    const artifact = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Frozen synthetic v1 response', content: 'Test only', metadata: oldAudit } })
    const originalSpec = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).taskSpec
    const quote = 'Sensor remains offline.', content = 'x'.repeat(594) + quote + 'y'.repeat(932 - 594 - quote.length)
    current = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 2 } })
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    const next = terminalCandidateSchema.parse({ exitState: { openLoops: ['Repair the offline sensor.'] } })
    const input = terminalCoverageInput(f.spec, before.preparedContext, current, next, 2)!
    const evidence = terminalEvidenceContext(current, source, 2, 1, input, verdictProtocol)
    const response = JSON.stringify({ findings: [], semanticChecks: Object.fromEntries(checks.map(check => [check.kind, check])),
      terminalVerdicts: [{ path: 'exitState.openLoops.0', verdict: 'supported', ...(verdictProtocol ? {} : { basis: 'current' }), sourceEvidence: [{ segmentId: 'c2', quote }] }],
      terminalDispositions: [{ id: input.obligations[0].id, outcome: status === 'supported' ? 'replaced' : 'unknown', reason: 'The entire same repair obligation remains.',
        ...(status === 'supported' ? { candidatePath: 'exitState.openLoops.0' } : {}), sourceEvidence: [{ segmentId: 'c2', quote }] }] })
    const bodies = { previous: null, current: content, terminalEvidence: evidence }
    const first = inspectContinuityResponse(JSON.stringify({ findings: [], semanticChecks: checks, terminalVerdicts: [] }), bodies, true, 8, next)
    expect(first.complete).toBe(false)
    const frozen = JSON.stringify(first)
    const inspected = applyContinuityReassessment(first, response, bodies, 2)
    expect(inspected.complete).toBe(true)
    expect(JSON.stringify(first)).toBe(frozen)
    expect(inspected.audit).toMatchObject({ reassessment: { rawResponse: { content: JSON.stringify(response) },
      mechanicalRecovery: { kind: 'empty_original_dispositions', derived: { decisions: [] } } } })
    await validateStoryContinuity({ ...f, compilationId: compilation.id, findings: [], independentCheck: 'complete', terminalCandidate: next,
      coverage: compilerContinuityCoverage({ chapter: current, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: next }, 11), continuityCriticResponse: inspected.audit })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: current.id, chapterRevision: 2, mode: 'balanced',
      criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
    expect(readiness?.progressEvidence?.phases).toContain('terminal')
    expect(readiness?.terminalReview?.state).toBe(status === 'supported' ? 'supported' : 'unverified')
    expect(readiness?.progressEvidence?.phases.includes('terminal_supported')).toBe(status === 'supported')
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const subject = { ...f, expectedOriginalTaskId: original.taskId, taskSpec: original.spec as typeof f.spec }
    const seen = new Set<string>()
    expect(observeChapterReviewProgress(seen, { ...readiness!.progressEvidence!, phases: ['continuity', 'quality'] }, subject)).toBe(true)
    expect(observeChapterReviewProgress(seen, readiness?.progressEvidence, subject)).toBe(true)
    expect(observeChapterReviewProgress(new Set(seen), readiness?.progressEvidence, subject)).toBe(false)
    const terminal = { ...f, compilationId: compilation.id, ...next, chapterSummary: 'Repair still required.', hookDecision: '', delayedHookReason: '', openingStructure: 'Continue', endingStructure: 'Record' }
    if (status === 'supported') {
      await commitChapterBridge(terminal)
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).committedAt).not.toBeNull()
      const prepared = (await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).preparedContext as { terminalFactProofs: Array<{ anchors: Array<{ start: number; end: number; quote: string }> }> }
      expect(prepared.terminalFactProofs[0].anchors).toMatchObject([{ start: 594, end: 594 + quote.length, quote }])
    } else {
      await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'TERMINAL_STATE_REVIEW_REQUIRED' })
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).committedAt).toBeNull()
    }
    expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: artifact.id } })).metadata).toEqual(artifact.metadata)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).taskSpec).toEqual(originalSpec)
    expect((originalSpec as { scope: { terminalCoverageProtocol: number } }).scope.terminalCoverageProtocol).toBe(1)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })).toBe(0)
    expect(network).not.toHaveBeenCalled()
  }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 1 }))
})
