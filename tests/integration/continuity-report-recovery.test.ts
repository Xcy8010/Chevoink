import { describe, expect, it, vi } from 'vitest'
import { fixture, available } from '../support/agent-durable-runtime-fixture.js'
import { continuityRecoveryFixture } from '../helpers/continuity-recovery-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import { runLegacyContinuityReview } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { readLegacyContinuityAssessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { continuityResponseRepairPlan } from '../../api/lib/agent/continuity-response-repair.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only',
  reasoningEffort: 'high', reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const completion = (content: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })

describe.runIf(available)('new continuity sparse repair uses real PostgreSQL receipts and unknown-result fences', () => {
  it.each(['repaired', 'still-invalid', 'unknown-second', 'missing-second-frame'] as const)('preserves both paid replies without redispatch: %s', scenario => fixture(async f => {
    const shape = continuityRecoveryFixture()
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: shape.content, revision: 4, wordCount: shape.content.length } })
    const context = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: f.spec.id, chapterId: chapter.id, obligations: shape.context.factCoverage!.obligations }, 6, 2)
    const bodies = { previous: null, current: chapter.content, terminalEvidence: context }
    const bad = { ...shape.bad, proposalDispositions: undefined }
    const original = inspectContinuityResponse(JSON.stringify(bad), bodies, true, 8, shape.candidate, compilerEvidenceScope(chapter, null), { responseContract: 3 })
    const plan = continuityResponseRepairPlan(original, bodies)!
    expect(plan.bad.map(row => row.address)).toEqual([1, 3, 9])
    const patch = { baseResponseHash: original.audit.contentHash, corrections: [1, 3, 9].map(address => ({ table: 'terminalDispositions', address, replacement: shape.wire.terminalDispositions[address] })) }
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const ctx: ToolContext = { ...f, callId: 'sparse-review', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime, signal: new AbortController().signal, emit: () => {} }
    const input = { chapterId: chapter.id, revision: chapter.revision, bodies, system: 'Synthetic full continuity check.', content: chapter.content,
      parserVersion: 8 as const, terminalCandidate: shape.candidate, sourceScope: compilerEvidenceScope(chapter, null), options: { modelRuntime: runtime, explicitModelSelection: true,
        signal: ctx.signal, userId: f.userId, novelId: f.novelId, chapterId: chapter.id, action: 'agent3ContinuityCritic', targetType: 'chapter' as const, targetId: chapter.id }, assertCurrent: async () => {} }
    const network = vi.fn(async () => completion(network.mock.calls.length === 1 || scenario !== 'repaired' ? JSON.stringify(bad) : JSON.stringify(patch)))
    vi.stubGlobal('fetch', network)
    const result = await runLegacyContinuityReview(ctx, input)
    expect(result.complete).toBe(scenario === 'repaired')
    if (scenario === 'repaired') expect(currentTerminalReview({ independentCheck: 'complete', terminalCandidate: shape.candidate, continuityCriticResponse: result.audit }, chapter.content, context))
      .toMatchObject({ supported: false, factCoverage: { complete: false } })
    else expect(result.recoveryReady).toBe(true)
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId } })
    const reservation = artifacts.map(row => row.metadata as Record<string, unknown>).find(meta => meta.continuityAssessmentRequestKey)!
    expect(reservation.input).toMatchObject({ reassessmentProtocol: 4 })
    const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(paid).toHaveLength(2)
    expect(paid.every(row => row.billingStatus === 'settled' && row.usageSource === 'reported' && row.reservedCreditMilli === 0)).toBe(true)
    if (scenario === 'unknown-second') await prisma.aiUsageLog.update({ where: { id: paid.find(row => row.action === 'agent3ContinuityCriticSecondPass')!.id }, data: { billingStatus: 'pending_usage', usageSource: 'unknown' } })
    if (scenario === 'missing-second-frame') await prisma.agentArtifact.delete({ where: { id: artifacts.find(row => { const meta = row.metadata as Record<string, unknown>; return meta.assessmentResponseKey && meta.stage === 'reassessment' })!.id } })
    const before = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    if (scenario === 'unknown-second' || scenario === 'missing-second-frame') {
      expect(await prisma.$transaction(tx => readLegacyContinuityAssessment(tx, ctx, reservation.input as LegacyAssessmentInput))).toMatchObject({ recoveryReady: false })
      await expect(runLegacyContinuityReview(ctx, input)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    } else expect(await runLegacyContinuityReview(ctx, input)).toMatchObject({ complete: scenario === 'repaired' })
    expect(network).toHaveBeenCalledTimes(2)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(before)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ content: shape.content, revision: 4 })
  }, undefined, '修改本章', { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }))
})
