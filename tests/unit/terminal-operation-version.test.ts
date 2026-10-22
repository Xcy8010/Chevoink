import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import * as lifecycle from '../../api/lib/agent/assessment-response-lifecycle.js'
import * as completion from '../../api/lib/agent/review-completion.js'
import { runLegacyContinuityReview } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { legacyContinuityAssessmentKey, readFrozenLegacyContinuityInput, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput, terminalCoverageAuditVersion, advanceTerminalCoverage, readTerminalCoverageState } from '../../api/lib/agent/terminal-fact-coverage.js'
import { currentTerminalReview, terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const spec = { id: 'same-task', scope: { terminalCoverageProtocol: 1 } }
const chapter = { id: 'chapter', revision: 1, orderIndex: 5, content: 'The pump remains offline.' }
const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The pump remains offline.'] } })
const context = (version: 1 | 2, verdictProtocol?: 2 | 3 | 4 | 5) => terminalEvidenceContext(chapter, null, 2, 1, terminalCoverageInput(spec, {}, chapter, candidate, version), verdictProtocol)
const frozen: LegacyAssessmentInput = { chapterId: chapter.id, revision: 1, bodies: { previous: null, current: chapter.content, terminalEvidence: context(1) },
  system: 'original system', content: 'original full request', parserVersion: 8, sourceScope: { currentOrderIndex: 5, previous: [] }, targetType: 'story_compilation', targetId: 'compilation', terminalCandidate: candidate }
const ctx = { runId: 'same-run', callId: 'same-call', userId: 'author', novelId: 'novel' } as ToolContext
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('request-owned terminal response versions', () => {
  it.each([[1, undefined], [2, undefined], [2, 2], [2, 3], [2, 4], [2, 5]] as const)('rebuilds the exact saved coverage %i / verdict %s pair before restoring an owned call', async (coverageVersion, verdictProtocol) => {
    const saved = { ...structuredClone(frozen), bodies: { ...frozen.bodies, terminalEvidence: context(coverageVersion, verdictProtocol) } }
    const metadata = { input: saved, continuityAssessmentRequestKey: legacyContinuityAssessmentKey(ctx, saved) }
    const before = JSON.stringify(metadata)
    const tx = { agentArtifact: { findMany: vi.fn().mockResolvedValue([{ metadata }]) } } as unknown as Prisma.TransactionClient
    const recover = vi.fn((contract: lifecycle.FrozenTerminalContract) => ({ ...frozen.bodies, terminalEvidence: context(contract.coverageVersion, contract.verdictProtocol) }))
    expect(await readFrozenLegacyContinuityInput(tx, ctx, { ...frozen, bodies: { ...frozen.bodies, terminalEvidence: context(2, 2) } }, recover)).toEqual(saved)
    expect(recover).toHaveBeenCalledWith({ coverageVersion, ...(verdictProtocol ? { verdictProtocol } : {}) })
    expect(JSON.stringify(metadata)).toBe(before)
    await expect(readFrozenLegacyContinuityInput(tx, ctx, { ...frozen, bodies: { ...frozen.bodies, terminalEvidence: context(2, 2) } },
      () => ({ ...frozen.bodies, current: 'Changed current body', terminalEvidence: context(coverageVersion, verdictProtocol) }))).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
  })
  it.each(['replay', 'duplicate', 'bad-hash', 'changed-body', 'changed-candidate', 'changed-target', 'changed-chapter', 'new-call'] as const)('recovers whole frozen input before choosing a new request contract: %s', scenario => {
    const proposed = structuredClone(frozen)
    proposed.bodies.terminalEvidence = context(2)
    proposed.system = 'new implementation prompt'
    proposed.content = 'new compact evidence rendering'
    const metadata = { input: frozen, callId: ctx.callId, assessmentChapterId: chapter.id,
      continuityAssessmentRequestKey: legacyContinuityAssessmentKey(ctx, frozen) }
    const before = JSON.stringify(metadata)
    const rows = scenario === 'new-call' ? [] : [{ metadata }, ...(scenario === 'duplicate' ? [{ metadata }] : [])]
    if (scenario === 'bad-hash') metadata.continuityAssessmentRequestKey = '0'.repeat(64)
    if (scenario === 'changed-body') proposed.bodies.current += 'changed'
    if (scenario === 'changed-candidate') proposed.terminalCandidate = terminalCandidateSchema.parse({ exitState: {} })
    if (scenario === 'changed-target') proposed.targetId = 'other'
    if (scenario === 'changed-chapter') proposed.chapterId = 'other-chapter'
    const tx = { agentArtifact: { findMany: vi.fn().mockResolvedValue(rows) } } as unknown as Prisma.TransactionClient
    const promise = readFrozenLegacyContinuityInput(tx, ctx, proposed)
    if (scenario === 'new-call') return expect(promise).resolves.toBeNull()
    if (scenario !== 'replay') return expect(promise).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
    return promise.then(restored => {
      expect(restored).toEqual(frozen)
      expect(restored?.bodies.terminalEvidence?.factCoverage?.version).toBe(1)
      expect(JSON.stringify(metadata)).toBe(before)
      expect(spec.scope.terminalCoverageProtocol).toBe(1)
      expect(tx.agentArtifact.findMany).toHaveBeenCalledWith({ where: { runId: ctx.runId, run: { userId: ctx.userId, novelId: ctx.novelId },
        artifactType: 'continuityReview', metadata: { path: ['callId'], equals: ctx.callId } } })
    })
  })

  it('persists a newly bound v2 review inside the original v1 task without upgrading cached v1 inputs', () => {
    const response = JSON.stringify({ findings: [], semanticChecks: { action_direction: 'not_applicable', state_progression: 'clear', reason: 'Checked the actual body.' },
      terminalVerdicts: [{ path: 'exitState.objects.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: chapter.content }] }] })
    const originalSpec = structuredClone(spec), evidence = context(2)
    const inspected = inspectContinuityResponse(response, { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
    const validation = { terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspected.audit }
    expect(terminalCoverageAuditVersion(validation)).toBe(2)
    const review = currentTerminalReview(validation, chapter.content, evidence)!
    const saved = { terminalFactCoverage: advanceTerminalCoverage(spec, {}, chapter, review) }
    expect(readTerminalCoverageState(spec, saved, chapter.id)?.lastReview.input.version).toBe(2)
    expect(terminalCoverageInput(spec, saved, chapter, candidate, 1)?.version).toBe(1)
    expect(terminalCoverageInput(spec, saved, chapter, candidate, 2)).toEqual(evidence.factCoverage)
    expect(spec).toEqual(originalSpec)
    expect(currentTerminalReview(validation, chapter.content, context(1))).toBeNull()
  })

  it.each([[1, undefined], [2, undefined], [2, 2], [2, 3], [2, 4], [2, 5]] as const)('restores the producer entire saved coverage %i / verdict %s request before any reserve or provider dispatch', async (version, verdictProtocol) => {
    const saved = { ...structuredClone(frozen), bodies: { ...frozen.bodies, terminalEvidence: context(version, verdictProtocol) } }
    const response = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
      ({ kind, result: 'clear', reason: 'Checked.', findingIndexes: [] })), terminalVerdicts: [{ path: 'exitState.objects.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: chapter.content }] }] })
    const inspected = inspectContinuityResponse(response, saved.bodies, true, 8, candidate)
    const bound = lifecycle.bindLegacyContinuityAssessment(inspected, ctx, saved)
    const tx = {} as Prisma.TransactionClient
    vi.spyOn(prisma, '$transaction').mockImplementation((async (callback: unknown) =>
      (callback as (db: Prisma.TransactionClient) => Promise<unknown>)(tx)) as typeof prisma.$transaction)
    const restore = vi.spyOn(lifecycle, 'readFrozenLegacyContinuityInput').mockResolvedValue(saved)
    const reuse = vi.spyOn(lifecycle, 'readReusableLegacyContinuityAssessment').mockImplementation(async (_db, _ctx, actual) => {
      expect(actual).toEqual(saved)
      return bound
    })
    const reserve = vi.spyOn(lifecycle, 'reserveLegacyContinuityAssessment')
    const provider = vi.spyOn(completion, 'generateReviewCompletion')
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected provider dispatch'))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController(), recover = vi.fn((requested: lifecycle.FrozenTerminalContract) => ({ ...frozen.bodies, terminalEvidence: { ...context(requested.coverageVersion), ...(requested.verdictProtocol ? { verdictProtocol: requested.verdictProtocol } : {}) } }))
    const result = await runLegacyContinuityReview({ ...ctx, signal: controller.signal }, {
      ...frozen, bodies: { ...frozen.bodies, terminalEvidence: context(2, 2) }, system: 'new system', content: 'new compact input',
      recoverBodies: recover, assertCurrent: async () => {}, options: { targetType: frozen.targetType, targetId: frozen.targetId },
    })
    expect(result).toEqual(bound)
    expect(restore).toHaveBeenCalledWith(tx, expect.objectContaining({ runId: ctx.runId, callId: ctx.callId }), expect.any(Object), recover)
    expect(reuse).toHaveBeenCalledOnce()
    expect(reserve).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(response)
    expect(spec.scope.terminalCoverageProtocol).toBe(1)
  })

  it.each([1, 2] as const)('reconstructs resolved ledger snapshots using the saved operation v%i', async version => {
    const makeFact = (claim: string) => ({ id: runtimeJson({ field: 'objects', claim }).hash, field: 'objects', claim })
    const old = makeFact('The old pump was awaiting repair.'), retained = makeFact(candidate.exitState.objects[0])
    const oldInput = { version, taskId: spec.id, chapterId: chapter.id, obligations: [old] }
    const state = { terminalFactCoverage: { version: 1, taskId: spec.id, chapterId: chapter.id, facts: [retained],
      lastReview: { bodyHash: runtimeJson({ content: chapter.content }).hash, candidateHash: runtimeJson(candidate).hash, input: oldInput } } }
    const recover = (requested: lifecycle.FrozenTerminalContract) => ({ previous: null, current: chapter.content,
      terminalEvidence: terminalEvidenceContext(chapter, null, 2, 1, terminalCoverageInput(spec, state, chapter, candidate, requested.coverageVersion), requested.verdictProtocol) })
    const saved = { ...structuredClone(frozen), bodies: recover({ coverageVersion: version }) }
    const metadata = { input: saved, continuityAssessmentRequestKey: legacyContinuityAssessmentKey(ctx, saved) }
    const tx = { agentArtifact: { findMany: vi.fn().mockResolvedValue([{ metadata }]) } } as unknown as Prisma.TransactionClient
    const restored = await readFrozenLegacyContinuityInput(tx, ctx, { ...frozen, bodies: recover({ coverageVersion: 2 }) }, recover)
    expect(restored).toEqual(saved)
    expect(restored?.bodies.terminalEvidence?.factCoverage?.obligations).toEqual([old])
    if (version === 1) expect(terminalCoverageInput(spec, state, chapter, candidate, 2)?.obligations).toEqual([])
  })
})
