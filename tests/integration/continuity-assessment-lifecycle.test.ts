import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import { tokenPriceSchema } from '../../api/lib/billing/token-price.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { chapterBridgeCommitTool, continuityValidateTool, runLegacyContinuityReview } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { readContinuedContinuityRecovery } from '../../api/lib/agent/legacy-continuity-recovery.js'
import { readContinuedReviewRecovery } from '../../api/lib/agent/continued-review-recovery.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { fixture } from '../support/agent-durable-runtime-fixture.js'
import * as lifecycle from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readOwnedContinuityReassessment } from '../../api/lib/agent/continuity-reassessment-witness.js'
import { generateReviewCompletion } from '../../api/lib/agent/review-completion.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import * as continuityParser from '../../api/lib/agent/continuity-format-recovery.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readContinuedContinuityEvidence } from '../../api/lib/agent/continued-continuity-evidence.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { readTerminalDraftBinding } from '../../api/lib/agent/terminal-draft-authority.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { readQualityReviewAdmission } from '../../api/lib/agent/quality-review-admission.js'
import { recoverExplicitSourceEvidence } from '../../api/lib/agent/continuity-explicit-source-projection.js'

const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1',
  apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const body = '门先锁着。随后门打开，人物走进门。'
const proof = [{ source: 'current', segmentId: 'c0' }]
const finding = { signal: 'object', severity: 'error', evidence: '当前正文“杜撰引用”证明门状态互斥。', suggestion: '统一门状态。', sourceEvidence: proof }
const retraction = JSON.stringify({ decisions: [{ index: 0, action: 'retract', reason: '原判断混淆事件先后，实际原文先锁门随后开门。', sourceEvidence: proof }], findings: [] })

const completion = (content: string, finishReason = 'stop') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }],
  usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const rateLimited = (usage?: object) => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'RPM exceeded' },
  ...(usage === undefined ? {} : { usage }) }), { status: 429 })

// Intercept only the route's 60-second retry timer. Date, PostgreSQL transaction
// timers and the production 360-second AbortSignal deadline remain real.
// The hook runs before releasing the wait so cancellation/staleness is observed
// by the actual before-dispatch guards, rather than by a mocked provider call.
function interceptRetryWait(controller: AbortController, onWait: () => Promise<void> = async () => {}) {
  const realTimeout = globalThis.setTimeout
  const waits: number[] = [], errors: unknown[] = []
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 60_000) return realTimeout(callback, ms, ...args)
    waits.push(ms)
    return realTimeout(() => { void onWait().then(() => callback(...args)).catch(error => { errors.push(error); controller.abort(error) }) }, 0)
  }) as typeof setTimeout)
  return { waits, errors }
}

async function retryFixture(f: Parameters<Parameters<typeof fixture>[0]>[0], controller: AbortController, orderIndex = 1) {
  await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
  await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length, orderIndex, orderInVolume: orderIndex } })
  const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '限流后完整复核' })
  const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
  await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '过门', entryState: state, goal: '进门', obstacle: '门锁', choice: '等待', cost: '时间', turn: '门打开', exitState: state,
    styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
  const window = credits.getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
  const ctx: ToolContext = { ...f, callId: 'retry-check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime,
    signal: controller.signal, emit: () => {} }
  return { ctx, compilation }
}

describe('legacy continuity zero-fee 429 actual tool lifecycle in PostgreSQL', () => {
  it('reuses a settled v6 report rejected by the old current-metadata rule after JSONB persistence, with no new request or audit rewrite', () => fixture(async f => {
    const { ctx } = await retryFixture(f, new AbortController())
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const candidate = terminalCandidateSchema.parse({ exitState: { action: '人物走进门。' } })
    const evidence = terminalEvidenceContext(chapter, null, 2, 1,
      { version: 2, taskId: f.spec.id, chapterId: chapter.id, obligations: [] }, 6, 2)
    const raw = JSON.stringify({ findings: [], terminalVerdicts: [{ claimIndex: 0, verdict: 'supported',
      sourceEvidence: [{ segmentId: 'c0', quote: '人物走进门' }], inheritance: { priorEndState: 'uncertain', currentState: 'changed' } }],
    terminalProofVerdicts: [], terminalDispositions: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
      ({ kind, result: 'clear', reason: 'The current body records the action in this direction.', findingIndexes: [] })) })
    const input = { chapterId: chapter.id, revision: chapter.revision, bodies: { previous: null, current: body, terminalEvidence: evidence },
      system: 'Synthetic full continuity review.', content: body, terminalCandidate: candidate, parserVersion: 8 as const, sourceScope: compilerEvidenceScope(chapter, null),
      options: { modelRuntime: runtime, explicitModelSelection: true, userId: f.userId, novelId: f.novelId, chapterId: chapter.id,
        action: 'agent3ContinuityCritic', targetType: 'chapter' as const, targetId: chapter.id, signal: ctx.signal },
      assertCurrent: async () => { expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(body) } }
    // The fixture must be a valid received report under the corrected contract;
    // only the historical redundant-metadata rule may reject it initially.
    expect(inspectContinuityResponse(raw, input.bodies, true, 8, candidate, input.sourceScope).complete).toBe(true)
    const fetcher = vi.fn(async () => completion(raw))
    vi.stubGlobal('fetch', fetcher)
    const parse = continuityParser.inspectContinuityResponse
    const oldParser = vi.spyOn(continuityParser, 'inspectContinuityResponse').mockImplementation((...args) =>
      parse(args[0], args[1], args[2], args[3], args[4], args[5], { frozenCurrentMetadata: true }))
    const callAt = new Date()
    // Reproduce an actually frozen old request. New v6 requests now use 3;
    // changing that producer must not silently upgrade an existing reservation.
    const frozen: lifecycle.LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies: input.bodies,
      system: input.system, content: input.content, parserVersion: 8, sourceScope: input.sourceScope, terminalCandidate: candidate,
      reassessmentProtocol: 2, targetType: 'chapter', targetId: chapter.id }
    expect(await prisma.$transaction(tx => lifecycle.reserveLegacyContinuityAssessment(tx, ctx, frozen, input.assertCurrent))).toBe('new')
    await generateReviewCompletion(input.system, input.content, { ...input.options, agentRunId: ctx.runId,
      beforeProviderDispatch: async id => { await prisma.$transaction(tx => lifecycle.bindLegacyContinuityRequest(tx, ctx, frozen, id, 'primary', input.assertCurrent)) },
    })
    const primaryUsage = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, action: 'agent3ContinuityCritic' } })
    await prisma.$transaction(tx => lifecycle.observeLegacyContinuityAssessment(tx, ctx, frozen,
      { content: raw, finishReason: 'stop', toolCalls: [] }, [primaryUsage.id], 'primary'))
    const old = await runLegacyContinuityReview(ctx, input)
    oldParser.mockRestore()
    expect(old.complete).toBe(false)
    expect(old.audit).toMatchObject({ classification: 'terminal_invalid', terminalReviewDiagnostics: [{ code: 'inheritance_invalid' }] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(payments).toHaveLength(2)
    expect(await prisma.$transaction(tx => readOwnedContinuityReassessment(tx, f, { runId: f.runId, callId: ctx.callId!, chapterId: chapter.id, revision: chapter.revision, callAt, resultAt: new Date(), payments })))
      .toMatchObject({ primary: { id: payments.find(row => row.action === 'agent3ContinuityCritic')!.id }, second: { id: payments.find(row => row.action === 'agent3ContinuityCriticSecondPass')!.id } })
    for (const payment of payments) expect(payment).toMatchObject({ billingStatus: 'settled', usageSource: 'reported', reservedCreditMilli: 0 })
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const oldHash = runtimeJson(old.audit).hash
    const restored = await runLegacyContinuityReview({ ...ctx, callId: 'continue-reuse-v6' }, input)
    expect(restored).toMatchObject({ complete: true, findings: [], audit: { assessmentRequest: (old.audit as unknown as { assessmentRequest: unknown }).assessmentRequest } })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(payments)
    expect(await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })).toEqual(artifacts)
    expect(runtimeJson(old.audit).hash).toBe(oldHash)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(body)
    const reservation = artifacts.map(row => row.metadata as Record<string, unknown>).find(row => row.continuityAssessmentRequestKey)!
    await prisma.aiUsageLog.update({ where: { id: payments[1].id }, data: { billingStatus: 'pending_usage', usageSource: 'unknown' } })
    expect(await prisma.$transaction(tx => lifecycle.readReusableLegacyContinuityAssessment(tx, { ...ctx, callId: 'unknown-must-not-reuse' },
      reservation.input as lifecycle.LegacyAssessmentInput))).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await prisma.aiUsageLog.update({ where: { id: payments[1].id }, data: { billingStatus: 'settled', usageSource: 'reported' } })
    const responseFrame = artifacts.find(row => { const meta = row.metadata as Record<string, unknown>; return meta.assessmentResponseKey && meta.stage === 'reassessment' })!
    await prisma.agentArtifact.delete({ where: { id: responseFrame.id } })
    expect(await prisma.$transaction(tx => lifecycle.readReusableLegacyContinuityAssessment(tx, { ...ctx, callId: 'bound-second-without-response' },
      reservation.input as lifecycle.LegacyAssessmentInput))).toBeNull()
    await expect(prisma.$transaction(tx => lifecycle.readLegacyContinuityAssessment(tx, ctx, reservation.input as lifecycle.LegacyAssessmentInput)))
      .rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  }))
  it('keeps a closed old2 failure frozen without treating author Continue as a new contract grant', () => fixture(async f => {
    const { ctx } = await retryFixture(f, new AbortController())
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const candidate = terminalCandidateSchema.parse({ exitState: { action: '人物走进门。' } })
    const bodies = { previous: null, current: body, terminalEvidence: terminalEvidenceContext(chapter, null, 2, 1,
      { version: 2, taskId: f.spec.id, chapterId: chapter.id, obligations: [] }, 6, 2) }
    const verdict = { claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0', quote: '人物走进门' }] }
    const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
      ({ kind, result: 'clear', reason: 'Synthetic complete body check.', findingIndexes: [] })),
      terminalVerdicts: [verdict, verdict], terminalProofVerdicts: [], terminalDispositions: [] })
    const input = { chapterId: chapter.id, revision: chapter.revision, bodies, system: 'Synthetic complete continuity check.', content: body,
      parserVersion: 8 as const, terminalCandidate: candidate, sourceScope: compilerEvidenceScope(chapter, null),
      options: { modelRuntime: runtime, explicitModelSelection: true, userId: f.userId, novelId: f.novelId, chapterId: chapter.id,
        action: 'agent3ContinuityCritic', targetType: 'chapter' as const, targetId: chapter.id, signal: ctx.signal },
      assertCurrent: async () => { expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(body) } }
    const frozen: lifecycle.LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies,
      system: input.system, content: input.content, parserVersion: 8, sourceScope: input.sourceScope, terminalCandidate: candidate,
      reassessmentProtocol: 2, targetType: 'chapter', targetId: chapter.id }
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', payload: { callId: ctx.callId, toolName: 'continuity_validate', args: { chapterId: chapter.id } } } })
    expect(await prisma.$transaction(tx => lifecycle.reserveLegacyContinuityAssessment(tx, ctx, frozen, input.assertCurrent))).toBe('new')
    const fetcher = vi.fn(async () => completion(raw)); vi.stubGlobal('fetch', fetcher)
    await generateReviewCompletion(input.system, input.content, { ...input.options, agentRunId: ctx.runId,
      beforeProviderDispatch: async id => { await prisma.$transaction(tx => lifecycle.bindLegacyContinuityRequest(tx, ctx, frozen, id, 'primary', input.assertCurrent)) },
    })
    const primary = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, action: 'agent3ContinuityCritic' } })
    await prisma.$transaction(tx => lifecycle.observeLegacyContinuityAssessment(tx, ctx, frozen, { content: raw, finishReason: 'stop', toolCalls: [] }, [primary.id], 'primary'))
    const old = await runLegacyContinuityReview(ctx, input)
    expect(old.complete).toBe(false); expect(old.audit).not.toHaveProperty('responseContract')
    expect(fetcher).toHaveBeenCalledTimes(2)
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', payload: { callId: ctx.callId,
      toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' } } })
    const oldPayments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const oldArtifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    expect(oldPayments).toHaveLength(2)
    for (const payment of oldPayments) expect(payment).toMatchObject({ billingStatus: 'settled', usageSource: 'reported', reservedCreditMilli: 0 })
    const continued = { ...ctx, callId: 'new-contract-after-continue' }
    await expect(runLegacyContinuityReview(continued, input)).rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', payload: {} } })
    const start = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', payload: { authorContinue: { eventId: pause.id, afterSeq: 3 } } } })
    expect(start.createdAt.getTime()).toBeGreaterThan(Math.max(...oldArtifacts.map(row => row.createdAt.getTime())))
    expect(await prisma.$transaction(async tx => readQualityReviewAdmission(tx, await tx.agentRun.findUniqueOrThrow({ where: { id: f.runId } }))))
      .toEqual({ id: `author-continue:${pause.id}`, at: start.createdAt })
    await expect(runLegacyContinuityReview(continued, input)).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    await expect(runLegacyContinuityReview(continued, input)).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await prisma.aiUsageLog.findMany({ where: { id: { in: oldPayments.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(oldPayments)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: oldArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(oldArtifacts)
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId, metadata: { path: ['callId'], equals: continued.callId } } })).toBe(0)
  }))
  it.each(['fresh4', 'frozen3'] as const)('persists %s and commits the same reviewed chapter without buying another check', variant => fixture(async f => {
    const { ctx, compilation } = await retryFixture(f, new AbortController())
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const candidate = terminalCandidateSchema.parse({ exitState: { action: '人物走进门。' } })
    const verdict = { claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }
    const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
      ({ kind, result: 'clear', reason: 'Synthetic current-body action check.', ...(variant === 'fresh4' ? { findingIds: [] } : { findingIndexes: [] }) })),
      terminalVerdicts: variant === 'fresh4' ? [verdict] : [verdict, verdict], terminalProofVerdicts: [], terminalDispositions: [] })
    const fetcher = vi.fn(async () => completion(raw))
    vi.stubGlobal('fetch', fetcher)
    if (variant === 'frozen3') {
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
      const coverage = compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source: null, terminalCandidate: candidate }, 11)
      const bodies = { previous: null, current: body, terminalEvidence: terminalEvidenceContext(chapter, null, 2, 1, terminalCoverageInput(f.spec, saved.preparedContext, chapter, candidate, 2), 6, 2) }
      const frozen: lifecycle.LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies, system: 'Synthetic frozen parser8 contract.', content: body,
        parserVersion: 8, reassessmentProtocol: 5, terminalCandidate: candidate, sourceScope: compilerEvidenceScope(chapter, null), bindingHash: runtimeJson(coverage).hash,
        targetType: 'story_compilation', targetId: compilation.id }
      expect(await prisma.$transaction(tx => lifecycle.reserveLegacyContinuityAssessment(tx, ctx, frozen, async () => {}))).toBe('new')
      await generateReviewCompletion(frozen.system, frozen.content, { modelRuntime: runtime, explicitModelSelection: true, userId: f.userId, novelId: f.novelId, agentRunId: f.runId,
        chapterId: chapter.id, targetType: 'story_compilation', targetId: compilation.id, action: 'agent3ContinuityCritic', signal: ctx.signal,
        beforeProviderDispatch: async usageId => { await prisma.$transaction(tx => lifecycle.bindLegacyContinuityRequest(tx, ctx, frozen, usageId, 'primary', async () => {})) } })
      const usage = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, action: 'agent3ContinuityCritic' } })
      await prisma.$transaction(tx => lifecycle.observeLegacyContinuityAssessment(tx, ctx, frozen, { content: raw, finishReason: 'stop', toolCalls: [] }, [usage.id], 'primary'))
    }
    const result = await continuityValidateTool.execute(ctx, { compilationId: compilation.id, terminalState: candidate })
    expect(result, JSON.stringify(result)).not.toMatchObject({ outcome: 'failed' })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    if (variant === 'fresh4') expect(saved.validation).toMatchObject({ independentCheck: 'complete', continuityCriticResponse: { parserVersion: 9, responseContract: 4,
      rawResponse: { content: JSON.stringify(raw) }, continuityV4: { version: 1, projections: { prose: { valid: true }, currentTerminal: { valid: true }, historicalCoverage: { valid: true }, draftProposals: { valid: true } } } } })
    else expect(saved.validation).toMatchObject({ independentCheck: 'complete', continuityCriticResponse: { parserVersion: 8, responseContract: 3,
      rawResponse: { content: JSON.stringify(raw) }, responseNormalization: { repeated: [{ field: 'terminalVerdicts', index: 1, originalIndex: 0, address: 0 }] } } })
    const audit = (saved.validation as { continuityCriticResponse: { terminalEvidence: Parameters<typeof currentTerminalReview>[2] } }).continuityCriticResponse
    if (variant === 'fresh4') expect(currentTerminalReview(saved.validation, body, audit.terminalEvidence)).toBeNull()
    const deliveryBinding = await readTerminalDraftBinding(prisma, { ...ctx, compilationId: compilation.id }, { taskId: f.spec.id, preparedContext: saved.preparedContext }, chapter, saved.validation, audit.terminalEvidence)
    expect(currentTerminalReview(saved.validation, body, audit.terminalEvidence, deliveryBinding)).toMatchObject({ supported: true })
    await persistHumanityQualityReport({ ...ctx, chapterId: chapter.id, compilationId: compilation.id, chapterRevision: chapter.revision, mode: 'balanced',
      criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    expect(await chapterBridgeCommitTool.execute(ctx, { compilationId: compilation.id })).not.toMatchObject({ outcome: 'failed' })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } }))
      .toMatchObject({ status: 'completed', bridge: { targetRevision: chapter.revision } })
    const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const reservation = artifacts.map(row => row.metadata as Record<string, unknown>).find(row => row.continuityAssessmentRequestKey)!
    expect(reservation.input).toMatchObject(variant === 'fresh4' ? { parserVersion: 9, reassessmentProtocol: 6, continuityManifest: { version: 1 } } : { parserVersion: 8, reassessmentProtocol: 5 })
    expect(await prisma.$transaction(tx => lifecycle.readReusableLegacyContinuityAssessment(tx, ctx, reservation.input as lifecycle.LegacyAssessmentInput)))
      .toMatchObject({ complete: true, audit: { parserVersion: variant === 'fresh4' ? 9 : 8, responseContract: variant === 'fresh4' ? 4 : 3 } })
    expect(await chapterBridgeCommitTool.execute(ctx, { compilationId: compilation.id })).not.toMatchObject({ outcome: 'failed' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(paid).toHaveLength(1); expect(ledger).toHaveLength(1)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(paid)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
    expect(await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })).toEqual(artifacts)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ content: body, revision: chapter.revision })
  }, undefined, '写本章', { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2,
    terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }))

  it.each(['unknown-second', 'missing-second-frame', 'wrong-contract-marker'] as const)('contract3 field recovery refuses reuse and resend after %s', scenario => fixture(async f => {
    const { ctx, compilation } = await retryFixture(f, new AbortController())
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const candidate = terminalCandidateSchema.parse({ exitState: { action: '人物走进门。' } })
    const bodies = { previous: null, current: body, terminalEvidence: terminalEvidenceContext(chapter, null, 2, 1,
      { version: 2, taskId: f.spec.id, chapterId: chapter.id, obligations: [] }, 6, 2) }
    const wire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
      ({ kind, result: 'clear', reason: 'Synthetic complete current-body check.', findingIndexes: [] })),
      terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0', quote: '人物走进门' }] }],
      terminalProofVerdicts: [], terminalDispositions: [] }
    const raw = JSON.stringify(wire), bad = JSON.stringify({ ...wire, terminalProofVerdicts: [{ proofIndex: 0, currentState: 'unchanged', reason: 'Wrong historical table.' }] })
    const fetcher = vi.fn(async () => completion(fetcher.mock.calls.length === 1 ? bad : raw))
    vi.stubGlobal('fetch', fetcher)
    const input = { chapterId: chapter.id, revision: chapter.revision, bodies, system: 'Synthetic complete continuity check.', content: body,
      parserVersion: 8 as const, terminalCandidate: candidate, sourceScope: compilerEvidenceScope(chapter, null),
      options: { modelRuntime: runtime, explicitModelSelection: true, userId: f.userId, novelId: f.novelId, chapterId: chapter.id,
        action: 'agent3ContinuityCritic', targetType: 'chapter' as const, targetId: chapter.id, signal: ctx.signal },
      assertCurrent: async () => { expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(body) } }
    const first = await runLegacyContinuityReview(ctx, input)
    expect(first).toMatchObject({ complete: true, audit: { parserVersion: 8, responseContract: 3, reassessment: { kind: 'field_repair' } } })
    expect(JSON.parse(first.audit.rawResponse.content)).toBe(raw)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(payments).toHaveLength(2)
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId } })
    const reservation = artifacts.map(row => row.metadata as Record<string, unknown>).find(row => row.continuityAssessmentRequestKey)!
    if (scenario === 'unknown-second') await prisma.aiUsageLog.update({ where: { id: payments.find(row => row.action === 'agent3ContinuityCriticSecondPass')!.id },
      data: { billingStatus: 'pending_usage', usageSource: 'unknown' } })
    else if (scenario === 'missing-second-frame') await prisma.agentArtifact.delete({ where: { id: artifacts.find(row => { const meta = row.metadata as Record<string, unknown>; return meta.assessmentResponseKey && meta.stage === 'reassessment' })!.id } })
    else {
      const frame = artifacts.find(row => { const meta = row.metadata as Record<string, unknown>; return meta.assessmentResponseKey && meta.stage === 'first' })!
      const meta = structuredClone(frame.metadata) as Record<string, unknown>
      delete (meta.audit as Record<string, unknown>).responseContract
      await prisma.agentArtifact.update({ where: { id: frame.id }, data: { metadata: runtimeJson(meta).value } })
    }
    const before = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(await prisma.$transaction(tx => lifecycle.readReusableLegacyContinuityAssessment(tx, ctx, reservation.input as lifecycle.LegacyAssessmentInput))).toBeNull()
    if (scenario === 'wrong-contract-marker') await expect(runLegacyContinuityReview(ctx, input)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    else await expect(runLegacyContinuityReview(ctx, input)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(before)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).toBeNull()
  }))
  it.each(['known-new-body', 'known-new-body-no-candidate', 'known-new-candidate', 'delayed-call-persistence', 'no-author-admission', 'unknown-first', 'unknown-second', 'incomplete-second', 'focus-only', 'revision-only'] as const)(
    'a known completed failure fences its reviewed input without resetting the original contract or fees: %s', scenario => fixture(async f => {
      try {
        const { ctx, compilation } = await retryFixture(f, new AbortController())
        if (scenario !== 'no-author-admission') await prisma.agentRun.update({ where: { id: f.runId }, data: {
          startRequest: withHumanAdmission({ sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, mode: 'build', prompt: '写本章' }),
        } })
        const admission = await prisma.$transaction(async tx => readQualityReviewAdmission(tx, await tx.agentRun.findUniqueOrThrow({ where: { id: f.runId } })))
        expect(admission).toEqual(scenario === 'no-author-admission' ? null : { id: `author-message:${f.sourceMessageId}`, at: expect.any(Date) })
        const candidate = scenario === 'known-new-body-no-candidate' ? undefined : terminalCandidateSchema.parse({ exitState: { action: '门打开' } })
        const fetcher = vi.fn(async () => {
          if (scenario === 'unknown-first') throw new TypeError('synthetic unknown first request')
          if (fetcher.mock.calls.length === 1) return completion(JSON.stringify({ findings: [finding] }))
          if (scenario === 'unknown-second') throw new TypeError('synthetic unknown second request')
          return completion('{"decisions":[],"findings":[]}', scenario === 'incomplete-second' ? 'length' : 'stop')
        })
        vi.stubGlobal('fetch', fetcher)
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call',
          ...(scenario === 'delayed-call-persistence' ? { createdAt: new Date(Date.now() + 60_000) } : {}),
          payload: { seq: 1, type: 'tool.call', ts: new Date().toISOString(), callId: ctx.callId, toolName: 'continuity_validate', args: { compilationId: compilation.id, terminalState: candidate } } } })
        const first = await continuityValidateTool.execute(ctx, { compilationId: compilation.id, terminalState: candidate })
          .catch(error => ({ outcome: 'failed', failureCode: error.code }))
        expect(first.outcome).toBe('failed')
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result',
          payload: { seq: 2, type: 'tool.result', ts: new Date().toISOString(), callId: ctx.callId, toolName: 'continuity_validate', ok: false, failureCode: first.failureCode } } })
        const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        const frozen = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).taskSpec
        const sends = fetcher.mock.calls.length
        expect(sends).toBe(scenario === 'unknown-first' ? 1 : 2)
        await expect(continuityValidateTool.execute({ ...ctx, callId: 'same-input' }, { compilationId: compilation.id, terminalState: candidate }))
          .rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
        const changedBody = scenario.startsWith('known-new-body') || scenario === 'delayed-call-persistence' || scenario === 'no-author-admission' || scenario.startsWith('unknown') || scenario === 'incomplete-second'
        if (changedBody || scenario === 'revision-only') await prisma.chapter.update({ where: { id: f.chapterId },
          data: { revision: { increment: 1 }, ...(changedBody ? { content: body + '人物放下钥匙。', wordCount: body.length + 7 } : {}) } })
        fetcher.mockImplementation(async () => completion(JSON.stringify({ findings: [], terminalVerdicts: [
          { path: 'exitState.action', verdict: 'supported', segmentIds: ['c0'] }] })))
        const next = await continuityValidateTool.execute({ ...ctx, callId: 'changed-input' }, { chapterId: f.chapterId,
          terminalState: scenario === 'known-new-candidate' ? terminalCandidateSchema.parse({ exitState: { action: '人物走进门' } }) : candidate,
          ...(scenario === 'focus-only' ? { focus: '核对当前正文' } : {}) }).catch(error => ({ outcome: 'failed', failureCode: error.code, output: error.message }))
        // These inputs have no authenticated original review-cycle revision.
        // A direct DB body edit, candidate change or Continue is no fee grant.
        expect(next.outcome).toBe('failed')
        expect(fetcher).toHaveBeenCalledTimes(sends)
        const after = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        expect(after.filter(row => payments.some(old => old.id === row.id))).toEqual(payments)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).taskSpec).toEqual(frozen)
        expect(after).toHaveLength(payments.length)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(after.filter(row => row.billingStatus === 'settled').length)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }, undefined, '写本章'))
  it('keeps a changed candidate blocked between the observed primary response and the old second-pass claim', () => fixture(async f => {
    let release = () => {}, entered = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    let first: Promise<unknown> | undefined
    try {
      const { ctx, compilation } = await retryFixture(f, new AbortController())
      const claim = lifecycle.claimLegacyContinuityReassessment
      vi.spyOn(lifecycle, 'claimLegacyContinuityReassessment').mockImplementationOnce(async (...args) => {
        entered(); await held; return claim(...args)
      })
      const fetcher = vi.fn(async () => completion(JSON.stringify({ findings: [finding] })))
      vi.stubGlobal('fetch', fetcher)
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call',
        payload: { callId: ctx.callId, toolName: 'continuity_validate', args: { compilationId: compilation.id } } } })
      first = continuityValidateTool.execute(ctx, { compilationId: compilation.id, terminalState: terminalCandidateSchema.parse({ exitState: { action: '门打开' } }) }).catch(error => error)
      await waiting
      const before = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({ billingStatus: 'settled', reservedCreditMilli: 0 })
      await expect(continuityValidateTool.execute({ ...ctx, callId: 'candidate-during-primary' },
        { compilationId: compilation.id, terminalState: terminalCandidateSchema.parse({ exitState: { action: '人物走进门' } }) }))
        .rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
      expect(fetcher).toHaveBeenCalledOnce()
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(before)
      release(); await first
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(body)
    } finally { release(); await first; await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))
  it.each(['settled-with-continue', 'unknown-same-admission'] as const)(
    'protocol 7 to 8 preserves actual reservations and billing: %s', scenario => fixture(async f => {
      try {
        const { ctx, compilation } = await retryFixture(f, new AbortController(), 4)
        const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        const previous = await Promise.all([1, 2, 3].map(orderIndex => prisma.chapter.create({ data: {
          authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, orderIndex, orderInVolume: orderIndex,
          title: `前文${orderIndex}`, content: `前文${orderIndex}约束：补充燃料前不能重新点灯。`, revision: 1,
        } })))
        await prisma.chapterBridge.update({ where: { compilationId: compilation.id }, data: { fromChapterId: previous[2].id, sourceRevision: 1 } })
        const current = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
        const source = { id: previous[2].id, revision: 1, content: previous[2].content }
        const coverage = compilerContinuityCoverage({ chapter, bridge: current.bridge, sceneTasks: current.sceneTasks, source }, 7)
        const oldInput: lifecycle.LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision,
          bodies: { previous: source.content, current: body }, bindingHash: runtimeJson(coverage).hash,
          system: '合成升级前单章检查。只输出 findings JSON。', content: source.content + '\n' + body,
          targetType: 'story_compilation', targetId: compilation.id }
        const assertCurrent = async () => { expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(body) }
        const callAt = new Date()
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: callAt,
          payload: { toolName: 'continuity_validate', callId: ctx.callId, args: { compilationId: compilation.id } } } })
        expect(await prisma.$transaction(tx => lifecycle.reserveLegacyContinuityAssessment(tx, ctx, oldInput, assertCurrent))).toBe('new')
        const raw = JSON.stringify({ findings: [{ ...finding, sourceEvidence: [{ source: 'current', segmentId: 'c999', quote: '根本不存在的旧引用' }] }] })
        const fetcher = vi.fn(async () => {
          if (scenario === 'unknown-same-admission') throw new TypeError('synthetic transport failed after dispatch')
          return completion(raw)
        })
        vi.stubGlobal('fetch', fetcher)
        await generateReviewCompletion(oldInput.system, oldInput.content, { modelRuntime: runtime, explicitModelSelection: true,
          userId: f.userId, novelId: f.novelId, chapterId: chapter.id, agentRunId: f.runId, action: 'agent3ContinuityCritic',
          targetType: 'story_compilation', targetId: compilation.id, signal: ctx.signal,
          beforeProviderDispatch: async id => { await prisma.$transaction(tx => lifecycle.bindLegacyContinuityRequest(tx, ctx, oldInput, id, 'primary', assertCurrent)) },
        }).catch(error => { if (scenario !== 'unknown-same-admission') throw error })
        const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })
        expect(payments).toHaveLength(1)
        const known = scenario === 'settled-with-continue'
        expect(payments[0]).toMatchObject({ billingStatus: known ? 'settled' : 'pending_usage', usageSource: known ? 'reported' : 'unknown' })
        await prisma.$transaction(tx => lifecycle.observeLegacyContinuityAssessment(tx, ctx, oldInput,
          { content: known ? raw : null, finishReason: known ? 'stop' : null, toolCalls: [], ...(known ? {} : { transportComplete: false as const }) }, [payments[0].id], 'primary'))
        const old = await validateStoryContinuity({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision,
          independentCheck: 'unavailable', coverage, findings: [] })
        if (known) {
          const audit = inspectContinuityResponse(raw, oldInput.bodies, true, 5).audit
          expect(audit.classification).toBe('source_invalid')
          await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...old, continuityCriticResponse: audit }).value } })
        }
        const resultAt = new Date(Date.now() + 10)
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', createdAt: resultAt, payload: {
          toolName: 'continuity_validate', callId: ctx.callId, ok: false, failureCode: known ? 'CONTINUITY_EVIDENCE_UNLOCATED' : 'AI_PROVIDER_UNKNOWN',
        } } })
        if (known) {
          const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', createdAt: new Date(resultAt.getTime() + 10), payload: {} } })
          await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', createdAt: new Date(resultAt.getTime() + 20), payload: { authorContinue: { eventId: pause.id, afterSeq: 3 } } } })
        }
        fetcher.mockImplementation(async (_url?: unknown, init?: RequestInit) => {
          const input = JSON.parse(String(init?.body))
          for (const row of previous) expect(input.messages[1].content).toContain(row.content)
          return completion('{"findings":[]}')
        })
        const fresh = { ...ctx, callId: 'protocol8-author-check' }
        if (known) expect(await prisma.$transaction(tx => readContinuedContinuityEvidence(tx, fresh, { compilationId: compilation.id })))
          .toMatchObject({ coverage: { protocolVersion: 7 } })
        const result = await continuityValidateTool.execute(fresh, { compilationId: compilation.id }).catch(error => ({ outcome: 'failed', failureCode: error.code }))
        expect(result.outcome).toBe('failed')
        if (!known) expect(result).toMatchObject({ failureCode: 'CONTINUITY_REPORT_INCOMPLETE' })
        expect(fetcher).toHaveBeenCalledTimes(1)
        const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
        expect(saved.validation).toMatchObject({ independentCheck: 'unavailable', coverage: { protocolVersion: 7 } })
        const reservations = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' } })
        const allPayments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        await continuityValidateTool.execute(fresh, { compilationId: compilation.id }).catch(() => {})
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(allPayments)
        expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'continuityReview' } })).toBe(reservations.length)
        expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: payments[0].id } })).toEqual(payments[0])
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(body)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))

  it('preserves an unknown second pass after a known-zero primary retry without retiring it on Continue', () => fixture(async f => {
    try {
      const controller = new AbortController(), { ctx, compilation } = await retryFixture(f, controller)
      const timers = interceptRetryWait(controller)
      const callAt = new Date()
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: callAt,
        payload: { toolName: 'continuity_validate', callId: ctx.callId, args: { compilationId: compilation.id } } } })
      let sends = 0
      const fetcher = vi.fn(async () => {
        sends++
        if (sends === 1) return rateLimited()
        if (sends === 2) return completion(JSON.stringify({ findings: [finding] }))
        if (sends === 3) return new Response(new ReadableStream({
          start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"decisions\\":["}}]}\n\n')) },
          pull(stream) { stream.error(new TypeError('fetch failed during second pass response')) },
        }), { headers: { 'content-type': 'text/event-stream' } })
        return completion('{"findings":[]}')
      })
      vi.stubGlobal('fetch', fetcher)
      const first = await continuityValidateTool.execute(ctx, { compilationId: compilation.id }).catch(error => ({ outcome: 'failed', failureCode: error.code ?? error.name }))
      expect(first.outcome).toBe('failed')
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(timers.waits).toEqual([60_000]); expect(timers.errors).toEqual([])
      const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: { startsWith: 'agent3ContinuityCritic' } }, orderBy: { createdAt: 'asc' } })
      expect(payments).toHaveLength(3)
      expect(payments[0]).toMatchObject({ action: 'agent3ContinuityCritic', usageSource: 'prepared', billingStatus: 'provider_rejected', reservedCreditMilli: 0, creditChargeMilli: 0 })
      expect(payments[1]).toMatchObject({ action: 'agent3ContinuityCritic', usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0 })
      expect(payments[1].creditChargeMilli).toBe(priceTokenEvidence(tokenPriceSchema.parse(payments[1].billingSnapshot), 12, 8, payments[1].promptCacheHitTokens))
      expect(payments[2]).toMatchObject({ action: 'agent3ContinuityCriticSecondPass', usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null, creditChargeMilli: 0 })
      expect(payments[2].reservedCreditMilli).toBeGreaterThan(0)
      await continuityValidateTool.execute({ ...ctx, callId: 'same-admission' }, { compilationId: compilation.id }).catch(() => {})
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).not.toMatchObject({ independentCheck: 'complete' })
      const resultAt = new Date()
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', createdAt: resultAt,
        payload: { toolName: 'continuity_validate', callId: ctx.callId, ok: false, failureCode: first.failureCode } } })
      const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', createdAt: new Date(resultAt.getTime() + 10), payload: {} } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', createdAt: new Date(resultAt.getTime() + 20),
        payload: { authorContinue: { eventId: pause.id, afterSeq: 3 } } } })
      const fresh = { ...ctx, callId: 'new-human-admission' }
      await continuityValidateTool.execute(fresh, { compilationId: compilation.id }).catch(() => {})
      expect(fetcher).toHaveBeenCalledTimes(3)
      const pending = { compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName: 'continuity_validate' as const, callId: ctx.callId! }
      const native = await prisma.$transaction(tx => readContinuedReviewRecovery(tx, f, [pending]))
      expect(native).toHaveLength(0)
      await expect(continuityValidateTool.execute(fresh, { compilationId: compilation.id })).rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
      await continuityValidateTool.execute(fresh, { compilationId: compilation.id }).catch(() => {})
      expect(fetcher).toHaveBeenCalledTimes(3)
      for (const payment of payments) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment)
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(body)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))

  it.each(['first-absent', 'first-zero', 'second-absent', 'second-zero', 'both', 'first-then-source-invalid', 'first-then-output-limit'] as const)(
    '%s preserves all attempts and applies/reuses the complete report without another HTTP request', scenario => fixture(async f => {
      try {
        const controller = new AbortController(), { ctx, compilation } = await retryFixture(f, controller)
        const callAt = new Date()
        const timers = interceptRetryWait(controller)
        const reassesses = ['second-absent', 'second-zero', 'both', 'first-then-source-invalid'].includes(scenario)
        const rejectsFirst = !['second-absent', 'second-zero'].includes(scenario)
        const rejectsSecond = ['second-absent', 'second-zero', 'both'].includes(scenario)
        const first = reassesses ? JSON.stringify({ findings: [finding] }) : '{"findings":[]}'
        const queue: Response[] = []
        if (rejectsFirst) queue.push(rateLimited(scenario === 'first-zero' ? { prompt_tokens: 0, completion_tokens: 0 } : undefined))
        queue.push(completion(first, scenario === 'first-then-output-limit' ? 'length' : 'stop'))
        if (rejectsSecond) queue.push(rateLimited(scenario === 'second-zero' ? { prompt_tokens: 0, completion_tokens: 0 } : undefined))
        if (reassesses) queue.push(completion(retraction))
        else if (scenario === 'first-then-output-limit') queue.push(completion('{"findings":[]}'))
        const expectedSends = queue.length
        const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
          const request = JSON.parse(String(init.body))
          expect(request.model).toBe(runtime.modelName)
          expect(request.messages[1].content).toContain(body)
          expect(request.reasoning_effort).toBe('none')
          expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${runtime.apiKey}`)
          const response = queue.shift()
          if (!response) throw new Error('unexpected additional HTTP request')
          return response
        })
        vi.stubGlobal('fetch', fetcher)
        const result = await continuityValidateTool.execute(ctx, { compilationId: compilation.id })
        expect(result.outcome).not.toBe('failed')
        expect(fetcher).toHaveBeenCalledTimes(expectedSends)
        expect(timers.waits).toEqual(Array.from({ length: Number(rejectsFirst) + Number(rejectsSecond) }, () => 60_000))
        expect(timers.errors).toEqual([])
        const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: { startsWith: 'agent3ContinuityCritic' } }, orderBy: { createdAt: 'asc' } })
        expect(payments).toHaveLength(expectedSends)
        const firstAttempts = payments.filter(row => row.action === 'agent3ContinuityCritic')
        expect(firstAttempts).toHaveLength(rejectsFirst ? 2 : 1)
        expect(payments.filter(row => row.action === 'agent3ContinuityCriticSecondPass')).toHaveLength(reassesses ? rejectsSecond ? 2 : 1 : 0)
        expect(payments.filter(row => row.action === 'agent3ContinuityCriticOutputRecovery')).toHaveLength(scenario === 'first-then-output-limit' ? 1 : 0)
        for (const payment of payments) {
          expect(payment.modelName).toBe(runtime.modelName); expect(payment.multiplierBps).toBe(runtime.multiplierBps)
          expect(payment.reservedCreditMilli).toBe(0)
          if (payment.billingStatus === 'provider_rejected') expect(payment).toMatchObject({ usageSource: 'prepared', requestTokens: null, responseTokens: null, creditChargeMilli: 0 })
          else {
            expect(payment).toMatchObject({ usageSource: 'reported', billingStatus: 'settled' })
            expect(payment.creditChargeMilli).toBe(priceTokenEvidence(tokenPriceSchema.parse(payment.billingSnapshot), payment.requestTokens!, payment.responseTokens!, payment.promptCacheHitTokens))
            if (payment.requestTokens === 0 && payment.responseTokens === 0) expect(payment.billingEvidence).toMatchObject({ providerRejection: { status: 429 } })
          }
        }
        const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' } })
        const frames = artifacts.map(row => row.metadata as Record<string, unknown>)
        const observations = frames.filter(row => typeof row.assessmentResponseKey === 'string')
        expect(observations).toHaveLength(expectedSends)
        expect(observations.flatMap(row => row.usageIds).sort()).toEqual(payments.map(row => row.id).sort())
        for (const payment of payments) {
          const observation = observations.find(row => (row.usageIds as string[]).includes(payment.id))!
          expect(observation.stage).toBe(payment.action === 'agent3ContinuityCriticSecondPass' ? 'reassessment'
            : payment.action === 'agent3ContinuityCriticOutputRecovery' ? 'output_recovery' : 'first')
          if (payment.billingStatus === 'provider_rejected' || payment.responseTokens === 0) expect(observation.response).toMatchObject({ content: null, transportComplete: false })
        }
        const applications = frames.filter(row => typeof row.assessmentApplicationKey === 'string')
        expect(applications).toHaveLength(1)
        expect((applications[0].usageIds as string[]).sort()).toEqual(payments.map(row => row.id).sort())
        expect(frames.filter(row => typeof row.fullReassessmentKey === 'string')).toHaveLength(reassesses ? 1 : 0)
        if (reassesses) {
          const witness = await prisma.$transaction(tx => readOwnedContinuityReassessment(tx, f, { runId: f.runId, callId: ctx.callId!, chapterId: f.chapterId,
            revision: 1, compilationId: compilation.id, callAt, resultAt: new Date(), payments }))
          expect(witness).not.toBeNull()
          expect(witness?.primary.id).toBe(firstAttempts.at(-1)!.id)
          expect(witness?.second.id).toBe(payments.filter(row => row.action === 'agent3ContinuityCriticSecondPass').at(-1)!.id)
        }
        const reservation = frames.find(row => typeof row.continuityAssessmentRequestKey === 'string')!
        const replay = await prisma.$transaction(tx => lifecycle.readLegacyContinuityAssessment(tx, ctx, reservation.input as lifecycle.LegacyAssessmentInput))
        expect(replay).toMatchObject({ billingKnown: true, providerComplete: true, inspected: { complete: true, findings: [] },
          slotUsed: reassesses || scenario === 'first-then-output-limit' })
        const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
        expect(saved.validation).toMatchObject({ independentCheck: 'complete', findings: [], continuityCriticResponse: { parserVersion: 6 } })
        await continuityValidateTool.execute(ctx, { compilationId: compilation.id })
        await continuityValidateTool.execute({ ...ctx, callId: 'replay-current-input' }, { compilationId: compilation.id })
        expect(fetcher).toHaveBeenCalledTimes(expectedSends)
        for (const payment of payments) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(body)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))

  it.each(['empty-usage', 'partial-usage', 'transport-unknown', 'pending-settlement', 'cancel-during-wait', 'stale-during-wait',
    'second-empty-usage', 'second-partial-usage', 'second-transport-unknown', 'second-pending-settlement', 'second-cancel-during-wait', 'second-stale-during-wait'] as const)(
    '%s preserves unresolved billing and does not retry or certify completion', scenario => fixture(async f => {
      try {
        const controller = new AbortController(), { ctx, compilation } = await retryFixture(f, controller)
        const second = scenario.startsWith('second-'), failure = scenario.replace(/^second-/, '')
        const timers = interceptRetryWait(controller, async () => {
          const attempts = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: second ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic' } })
          expect(attempts).toHaveLength(1)
          expect(attempts[0]).toMatchObject({ billingStatus: 'provider_rejected', reservedCreditMilli: 0, creditChargeMilli: 0 })
          if (failure === 'cancel-during-wait') controller.abort(new Error('author cancelled during rate-limit wait'))
          if (failure === 'stale-during-wait') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body + '作者另行保存。', revision: { increment: 1 } } })
        })
        if (failure === 'pending-settlement') {
          const consume = credits.consumeTokenCredits
          vi.spyOn(credits, 'consumeTokenCredits').mockImplementation(async args => {
            const payment = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: args.usageLogId } })
            if (payment.action === (second ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic')) throw new Error('fixture settlement unavailable')
            return consume(args)
          })
        }
        let sends = 0
        const fetcher = vi.fn(async () => {
          sends++
          if (second && sends === 1) return completion(JSON.stringify({ findings: [finding] }))
          if (failure === 'transport-unknown') throw new TypeError('fetch failed after dispatch')
          return rateLimited(failure === 'empty-usage' ? {} : failure === 'partial-usage' ? { prompt_tokens: 12 }
            : failure === 'pending-settlement' ? { prompt_tokens: 0, completion_tokens: 0 } : undefined)
        })
        vi.stubGlobal('fetch', fetcher)
        const result = await continuityValidateTool.execute(ctx, { compilationId: compilation.id }).catch(error => ({ outcome: 'failed', failureCode: error.code ?? error.name }))
        expect(result.outcome).toBe('failed')
        expect(fetcher).toHaveBeenCalledTimes(second ? 2 : 1)
        expect(timers.waits).toHaveLength(scenario.endsWith('during-wait') ? 1 : 0)
        expect(timers.errors).toEqual([])
        const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: { startsWith: 'agent3ContinuityCritic' } } })
        const guarded = scenario.endsWith('during-wait')
        // Stale input fails the second before-send guard after creating its ledger
        // row. Cancellation exits the retry wait before any second row is made.
        expect(payments).toHaveLength(Number(second) + (failure === 'stale-during-wait' ? 2 : 1))
        for (const payment of payments) {
          expect(payment.modelName).toBe(runtime.modelName); expect(payment.multiplierBps).toBe(runtime.multiplierBps)
          if (second && payment.action === 'agent3ContinuityCritic') {
            expect(payment).toMatchObject({ billingStatus: 'settled', usageSource: 'reported', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0 })
            expect(payment.creditChargeMilli).toBe(priceTokenEvidence(tokenPriceSchema.parse(payment.billingSnapshot), 12, 8, payment.promptCacheHitTokens))
          } else if (guarded) {
            expect(['provider_rejected', 'not_dispatched']).toContain(payment.billingStatus)
            expect(payment).toMatchObject({ reservedCreditMilli: 0, creditChargeMilli: 0 })
          } else expect(payment.billingStatus).toBe(failure === 'pending-settlement' ? 'pending_settlement' : 'pending_usage')
        }
        const failedPayment = payments.find(row => row.action === (second ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic'))!
        if (failure === 'partial-usage') expect(failedPayment).toMatchObject({ requestTokens: 12, responseTokens: null })
        if (failure === 'pending-settlement') expect(failedPayment).toMatchObject({ requestTokens: 0, responseTokens: 0 })
        const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' } })
        const frames = artifacts.map(row => row.metadata as Record<string, unknown>)
        expect(frames.filter(row => row.independentCheck === 'complete' || typeof row.assessmentApplicationKey === 'string')).toEqual([])
        expect(frames.filter(row => typeof row.fullReassessmentKey === 'string')).toHaveLength(second ? 1 : 0)
        expect(frames.filter(row => typeof row.assessmentResponseKey === 'string').flatMap(row => row.usageIds).sort()).toEqual(payments.map(row => row.id).sort())
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).not.toMatchObject({ independentCheck: 'complete' })
        if (!guarded) {
          await continuityValidateTool.execute({ ...ctx, callId: 'same-admission-replay' }, { compilationId: compilation.id }).catch(() => {})
          expect(fetcher).toHaveBeenCalledTimes(second ? 2 : 1)
        }
        for (const payment of payments) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
})

describe('complete continuity assessment lifecycle in actual PostgreSQL', () => {
  it('standalone source-invalid judgments and an invalid known second response never certify an empty report', () => fixture(async f => {
    try {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length } })
      const window = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const first = JSON.stringify({ findings: [finding] }), second = '{"decisions":[],"findings":[]}'
      const responses = [first, second]
      const fetcher = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: responses.shift() }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
      vi.stubGlobal('fetch', fetcher)
      const ctx: ToolContext = { ...f, callId: 'standalone', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime,
        signal: new AbortController().signal, emit: () => {} }
      expect(await continuityValidateTool.execute(ctx, { chapterId: f.chapterId })).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' })
      expect(fetcher).toHaveBeenCalledTimes(2)
      const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' } })
      const metadata = artifacts.map(row => row.metadata as Record<string, unknown>)
      expect(metadata.filter(row => row.independentCheck === 'complete' || typeof row.assessmentApplicationKey === 'string')).toEqual([])
      expect(metadata.find(row => row.independentCheck === 'unavailable')).toMatchObject({ criticResponse: {
        parserVersion: 6, classification: 'source_invalid', candidateFindings: [finding], rawResponse: { content: JSON.stringify(first) },
        reassessment: { classification: 'invalid', rawResponse: { content: JSON.stringify(second) } },
      } })
      expect(metadata.filter(row => typeof row.assessmentResponseKey === 'string')).toHaveLength(2)
      const usage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: { startsWith: 'agent3ContinuityCritic' } } })
      expect(usage).toHaveLength(2)
      for (const row of usage) {
        expect(row).toMatchObject({ usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, multiplierBps: 10000 })
        expect(row.creditChargeMilli).toBe(priceTokenEvidence(tokenPriceSchema.parse(row.billingSnapshot), 12, 8, row.promptCacheHitTokens))
      }
      expect((await continuityValidateTool.execute({ ...ctx, callId: 'same-admission' }, { chapterId: f.chapterId }).catch(() => ({ outcome: 'failed' }))).outcome).toBe('failed')
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(body)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))
  it.each(['syntax', 'fields', 'judgment', 'pair', 'failed-second', 'unknown-first', 'unknown-second', 'cancelled-second', 'stale-second', 'abort-after-claim', 'stale-after-claim', 'abort-first-reserved', 'credit-first-reserved', 'abort-first-bound', 'abort-second-bound', 'stale-second-bound', 'credit-second-reserved'] as const)(
    '%s preserves every actual request and consumes one recovery slot', scenario => fixture(async f => {
      try {
        await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length } })
        const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '完整复核' })
        const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
        await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '过门', entryState: state, goal: '进门', obstacle: '门锁', choice: '等待', cost: '时间', turn: '门打开', exitState: state,
          styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
        const window = credits.getCreditWindow()
        await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
        const controller = new AbortController()
        const ctx: ToolContext = { ...f, callId: 'first', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime, signal: controller.signal, emit: () => {} }
        const first = scenario === 'syntax' ? '{invalid JSON' : JSON.stringify({ findings: [{ ...finding,
          ...(scenario === 'fields' ? { severity: 'unsupported' } : {}), ...(scenario === 'pair' ? { evidence: '门在同一时刻互斥。' } : {}) }] })
        const firstAt = new Date()
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: firstAt,
          payload: { toolName: 'continuity_validate', callId: ctx.callId, args: { compilationId: compilation.id } } } })
        let sends = 0
        const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
          sends++
          const request = JSON.parse(String(init.body))
          expect(request.model).toBe(runtime.modelName)
          expect(request.messages[1].content).toContain(body)
          if (scenario === 'unknown-first') throw new TypeError('fetch failed after send')
          if (sends === 2) {
            expect(request.messages[0].content).toContain('一次完整复评')
            const observation = await prisma.agentArtifact.findFirstOrThrow({ where: { runId: f.runId, artifactType: 'continuityReview', AND: [
              { metadata: { path: ['stage'], equals: 'first' } }, { metadata: { path: ['assessmentResponseKey'], string_contains: '' } },
            ] } })
            expect(observation.metadata).toMatchObject({ input: { bodies: { current: body } }, response: { content: JSON.stringify(first), transportComplete: true } })
            expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'continuityReview', metadata: { path: ['fullReassessmentKey'], string_contains: '' } } })).toBe(1)
            if (scenario === 'cancelled-second') controller.abort()
            if (scenario === 'stale-second') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者另行保存的新正文', revision: { increment: 1 } } })
            if (scenario === 'unknown-second') return new Response(new ReadableStream({
              start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"decisions\\":["}}]}\n\n')) },
              pull(stream) { stream.error(new TypeError('fetch failed during response stream')) },
            }), { headers: { 'content-type': 'text/event-stream' } })
          }
          const content = sends === 1 ? first : sends > 2 ? '{"findings":[]}' : scenario === 'failed-second' ? '{"decisions":[],"findings":[]}'
            : scenario === 'syntax' ? '{"decisions":[],"findings":[]}' : retraction
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        })
        vi.stubGlobal('fetch', fetcher)
        if (scenario === 'abort-after-claim' || scenario === 'stale-after-claim') {
          const claim = lifecycle.claimLegacyContinuityReassessment
          vi.spyOn(lifecycle, 'claimLegacyContinuityReassessment').mockImplementationOnce(async (...args) => {
            const claimed = await claim(...args)
            if (scenario === 'abort-after-claim') controller.abort()
            else await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body + '作者补充真实事实。', revision: { increment: 1 } } })
            return claimed
          })
        }
        if (scenario === 'abort-first-reserved') {
          const reserve = lifecycle.reserveLegacyContinuityAssessment
          vi.spyOn(lifecycle, 'reserveLegacyContinuityAssessment').mockImplementationOnce(async (...args) => { const value = await reserve(...args); controller.abort(); return value })
        }
        if (scenario === 'credit-first-reserved') vi.spyOn(credits, 'assertCreditAccess').mockRejectedValueOnce(new (await import('../../api/lib/prisma.js')).DataAccessError(402, 'CREDITS_EXHAUSTED', 'credit preflight rejected before provider'))
        if (scenario === 'credit-second-reserved') {
          const claim = lifecycle.claimLegacyContinuityReassessment
          vi.spyOn(lifecycle, 'claimLegacyContinuityReassessment').mockImplementationOnce(async (...args) => {
            const value = await claim(...args)
            vi.spyOn(credits, 'assertCreditAccess').mockRejectedValueOnce(new (await import('../../api/lib/prisma.js')).DataAccessError(402, 'CREDITS_EXHAUSTED', 'second credit preflight rejected before provider'))
            return value
          })
        }
        if (scenario === 'abort-first-bound' || scenario === 'abort-second-bound' || scenario === 'stale-second-bound') {
          const bind = lifecycle.bindLegacyContinuityRequest
          vi.spyOn(lifecycle, 'bindLegacyContinuityRequest').mockImplementation(async (...args) => {
            if (scenario === 'stale-second-bound' && args[4] === 'reassessment') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body + '作者另行补充。', revision: { increment: 1 } } })
            const value = await bind(...args)
            if (value === (scenario === 'abort-first-bound' ? 'first' : 'reassessment')) controller.abort()
            return value
          })
        }
        const result = await continuityValidateTool.execute(ctx, { compilationId: compilation.id }).catch(error => ({ outcome: 'failed', failureCode: error.code ?? error.name }))
        const beforeFirst = ['abort-first-reserved', 'credit-first-reserved', 'abort-first-bound'].includes(scenario)
        const beforeSecond = ['abort-after-claim', 'stale-after-claim', 'abort-second-bound', 'stale-second-bound', 'credit-second-reserved'].includes(scenario)
        expect(result.outcome === 'failed').toBe(['failed-second', 'unknown-first', 'unknown-second', 'cancelled-second', 'stale-second'].includes(scenario) || beforeFirst || beforeSecond)
        expect(sends).toBe(beforeFirst ? 0 : beforeSecond || scenario === 'unknown-first' ? 1 : 2)
        const observations = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentKey'], string_contains: '' } } })
        const unsentRequest = ['abort-first-bound', 'abort-second-bound', 'stale-second-bound'].includes(scenario) ? 1 : 0
        expect(observations).toHaveLength(sends + unsentRequest + (scenario === 'credit-second-reserved' ? 1 : 0))
        if (scenario !== 'unknown-first' && !beforeFirst) expect(observations.some(row => (row.metadata as Record<string, unknown>).stage === 'first'
          && ((row.metadata as Record<string, unknown>).response as Record<string, unknown>).content === JSON.stringify(first))).toBe(true)
        const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId, action: { startsWith: 'agent3ContinuityCritic' } }, orderBy: { createdAt: 'asc' } })
        expect(payments).toHaveLength(sends + unsentRequest)
        for (const payment of payments) {
          expect(payment.modelName).toBe(runtime.modelName); expect(payment.multiplierBps).toBe(runtime.multiplierBps)
          if (payment.usageSource === 'reported') {
            expect(payment).toMatchObject({ requestTokens: 12, responseTokens: 8, billingStatus: 'settled', reservedCreditMilli: 0 })
            expect(payment.creditChargeMilli).toBe(priceTokenEvidence(tokenPriceSchema.parse(payment.billingSnapshot), 12, 8, payment.promptCacheHitTokens))
          } else expect(payment).toMatchObject({ requestTokens: null, responseTokens: null, usageSource: 'unknown',
            billingStatus: unsentRequest ? 'not_dispatched' : 'pending_usage', creditChargeMilli: 0 })
        }
        const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
        if (!['unknown-first', 'unknown-second', 'cancelled-second', 'stale-second'].includes(scenario) && !beforeFirst && !beforeSecond) expect(saved.validation).toMatchObject({ continuityCriticResponse: { parserVersion: 6 } })
        if (!['cancelled-second', 'stale-second'].includes(scenario) && !beforeFirst && !beforeSecond) {
          await continuityValidateTool.execute(ctx, { compilationId: compilation.id }).catch(() => {})
          expect(fetcher).toHaveBeenCalledTimes(scenario === 'unknown-first' ? 1 : 2)
        }
        if (['failed-second', 'unknown-first', 'unknown-second'].includes(scenario) || beforeFirst || beforeSecond) {
          if (beforeFirst || beforeSecond) {
            expect((await continuityValidateTool.execute({ ...ctx, callId: 'same-admission', signal: new AbortController().signal }, { compilationId: compilation.id })
              .catch(() => ({ outcome: 'failed' }))).outcome).toBe('failed')
            expect(sends).toBe(beforeFirst ? 0 : 1)
          }
          const resultAt = new Date()
          await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', createdAt: resultAt,
            payload: { toolName: 'continuity_validate', callId: ctx.callId, ok: false, failureCode: result.failureCode } } })
          const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', createdAt: new Date(resultAt.getTime() + 10), payload: {} } })
          await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', createdAt: new Date(resultAt.getTime() + 20), payload: { authorContinue: { eventId: pause.id, afterSeq: 3 } } } })
          const fresh = { ...ctx, callId: 'new-author', signal: new AbortController().signal }
          if (['unknown-first', 'unknown-second'].includes(scenario)) {
            expect((await continuityValidateTool.execute(fresh, { compilationId: compilation.id }).catch(() => ({ outcome: 'failed' }))).outcome).toBe('failed')
            expect(sends).toBe(scenario === 'unknown-first' ? 1 : 2)
            const pending = { compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName: 'continuity_validate' as const, callId: ctx.callId }
            // Generic Continue retains the unresolved operation and cannot
            // retire unknown continuity usage into a current paid plan.
            const native = await prisma.$transaction(tx => readContinuedReviewRecovery(tx, f, [pending]))
            expect(native).toHaveLength(0)
          } else if (!['stale-after-claim', 'stale-second-bound'].includes(scenario)) expect(await prisma.$transaction(tx => readContinuedContinuityRecovery(tx, f))).toHaveLength(beforeFirst ? 1 : 0)
          fetcher.mockImplementation(async () => { sends++; return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) })
          if (beforeFirst) {
            expect((await continuityValidateTool.execute(fresh, { compilationId: compilation.id })).outcome).not.toBe('failed')
            await continuityValidateTool.execute(fresh, { compilationId: compilation.id })
            expect(sends).toBe(1)
          } else {
            const resumed = await continuityValidateTool.execute(fresh, { compilationId: compilation.id })
              .catch(error => ({ outcome: 'failed', failureCode: error.code, output: error.message }))
            expect(resumed.outcome).toBe('failed')
            if (beforeSecond && !['stale-after-claim', 'stale-second-bound'].includes(scenario)) {
              expect(resumed).toMatchObject({ failureCode: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED',
                output: expect.stringContaining('原第二阶段已确认未发送') })
              expect(resumed.output).toContain('不能安全重建冻结执行配置')
            }
            await continuityValidateTool.execute(fresh, { compilationId: compilation.id }).catch(() => {})
            expect(sends).toBe(scenario === 'unknown-first' || beforeSecond ? 1 : 2)
          }
          for (const payment of payments) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment)
        }
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
})

// These are already received historical requests, not fresh paid retries.
// Exercise JSONB persistence, authentic billing/claim lineage and application
// idempotence against the isolated PostgreSQL fixture used by the full CI.
describe('body-only explicit-source paid-result recovery', () => {
  it('returns the authenticated complete second report in the original call without another purchase', () => fixture(async f => {
    const { ctx } = await retryFixture(f, new AbortController())
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const sourceEvidence = [{ source: 'current', segmentId: 'c0', quote: '门先锁着' }, { source: 'current', segmentId: 'c0', quote: '门打开' }]
    const semanticChecks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: '核对实际事件顺序。', findingIndexes: [] }))
    const firstRaw = JSON.stringify({ findings: [{ signal: 'object', severity: 'warning', evidence: '旧意见“人物始终在门外”需要与当前正文核对。',
      suggestion: '确认先锁门后开门。', sourceEvidence: [{ ...sourceEvidence[0], quote: '正文不存在的旧指控' }, sourceEvidence[1]] }], semanticChecks, terminalVerdicts: [] })
    const secondRaw = JSON.stringify({ findings: [], semanticChecks, terminalVerdicts: [], decisions: [{ index: 0, action: 'retract',
      reason: '旧意见“人物始终在门外”超出了实际原文，撤回这条意见。', sourceEvidence }] })
    const bodies = { current: body, previous: null, terminalEvidence: terminalEvidenceContext(chapter, null, 2, undefined, undefined, 5) }
    const sourceScope = compilerEvidenceScope(chapter, null)
    const first = inspectContinuityResponse(firstRaw, bodies, true, 8, undefined, sourceScope)
    expect(first.audit.classification).toBe('source_invalid')
    expect(recoverExplicitSourceEvidence(first, bodies)).toBeNull()
    expect(inspectContinuityResponse(secondRaw, bodies, true, 8, undefined, sourceScope).audit.classification).toBe('complete')
    const fetcher = vi.fn().mockImplementationOnce(async () => completion(firstRaw)).mockImplementationOnce(async () => completion(secondRaw))
    vi.stubGlobal('fetch', fetcher)
    const input = { chapterId: chapter.id, revision: chapter.revision, bodies, sourceScope, parserVersion: 8 as const,
      system: 'Frozen body-only review.', content: body, bindingHash: 'a'.repeat(64),
      options: { modelRuntime: runtime, explicitModelSelection: true, signal: ctx.signal, userId: f.userId, novelId: f.novelId,
        chapterId: chapter.id, action: 'agent3ContinuityCritic', targetType: 'chapter' as const, targetId: chapter.id },
      assertCurrent: async () => {} }
    const result = await runLegacyContinuityReview(ctx, input)
    expect(result).toMatchObject({ complete: true, findings: [], recoveryReady: true, audit: { sourceProjection: {
      scope: 'unapplied_body_only_final_report', dispositionDiagnostics: [{ index: 0, code: 'retract_source_proof_invalid' }],
    } } })
    expect(result.audit.rawResponse.content).toBe(JSON.stringify(secondRaw))
    expect(result.audit).not.toHaveProperty('terminalCandidate')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    expect(payments).toHaveLength(2)
    expect(payments.every(row => row.billingStatus === 'settled' && row.usageSource === 'reported')).toBe(true)
    expect(await runLegacyContinuityReview({ ...ctx, callId: 'same-report-replay' }, input)).toMatchObject({ complete: true, findings: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(payments)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
    expect(await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })).toEqual(artifacts)
  }))
  it('keeps a bad retract proof as audit data, retains the real finding and never repurchases either report', () => fixture(async f => {
    const { ctx } = await retryFixture(f, new AbortController())
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const retained = { signal: 'object', severity: 'error', evidence: '所述物品状态需要统一。', suggestion: '核对同一时刻的物品状态。',
      sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '门先锁着' }, { source: 'current', segmentId: 'c0', quote: '门打开' }] }
    const old = { ...retained, evidence: '旧意见尚未得到完整认证。', suggestion: '核对事件先后。' }
    const semanticChecks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: kind === 'state_progression' ? 'conflict' : 'clear',
      reason: 'Synthetic complete manuscript review.', findingIndexes: kind === 'state_progression' ? [0] : [] }))
    const firstRaw = JSON.stringify({ findings: [retained, old], semanticChecks, terminalVerdicts: [] })
    const secondWire = { findings: [retained], semanticChecks, terminalVerdicts: [], decisions: [
      { index: 0, action: 'confirm', reason: '保留真实原文对应的意见。', sourceEvidence: retained.sourceEvidence, findingIndex: 0 },
      { index: 1, action: 'retract', reason: '旧解释与实际事件不一致。', sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '正文不存在的引文' }] },
    ] }
    const secondRaw = JSON.stringify(secondWire)
    const frozen: lifecycle.LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision,
      bodies: { current: body, previous: null, terminalEvidence: terminalEvidenceContext(chapter, null, 2, undefined, undefined, 5) },
      system: 'Frozen body-only full review.', content: 'Frozen original complete manuscript.', parserVersion: 8,
      sourceScope: compilerEvidenceScope(chapter, null), reassessmentProtocol: 2, bindingHash: 'a'.repeat(64), targetType: 'chapter', targetId: chapter.id }
    const inspect = (raw: string) => inspectContinuityResponse(raw, frozen.bodies, true, 8, undefined, frozen.sourceScope)
    const first = inspect(firstRaw)
    expect(first.audit.classification).toBe('source_invalid')
    expect(inspect(secondRaw).audit.classification).toBe('source_invalid')
    const fetcher = vi.fn().mockImplementationOnce(async () => completion(firstRaw)).mockImplementationOnce(async () => completion(secondRaw))
    vi.stubGlobal('fetch', fetcher)
    const assertCurrent = async () => {}
    expect(await prisma.$transaction(tx => lifecycle.reserveLegacyContinuityAssessment(tx, ctx, frozen, assertCurrent))).toBe('new')
    const purchase = async (raw: string, action: string) => {
      await generateReviewCompletion(frozen.system, frozen.content, { modelRuntime: runtime, explicitModelSelection: true, signal: ctx.signal,
        userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, agentRunId: f.runId, action, targetType: 'chapter', targetId: chapter.id,
        beforeProviderDispatch: id => prisma.$transaction(tx => lifecycle.bindLegacyContinuityRequest(tx, ctx, frozen, id, action === 'agent3ContinuityCritic' ? 'primary' : 'reassessment', assertCurrent)).then(() => {}),
      })
      const payment = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, action } })
      await prisma.$transaction(tx => lifecycle.observeLegacyContinuityAssessment(tx, ctx, frozen,
        { content: raw, finishReason: 'stop', toolCalls: [] }, [payment.id], action === 'agent3ContinuityCritic' ? 'primary' : 'reassessment'))
      return payment
    }
    const primary = await purchase(firstRaw, 'agent3ContinuityCritic')
    expect(await prisma.$transaction(tx => lifecycle.claimLegacyContinuityReassessment(tx, ctx, frozen, first, [primary.id],
      lifecycle.continuityReassessmentRequest(frozen.system, frozen.content, first, frozen.bodies, false, 2), assertCurrent))).toBe(true)
    const second = await purchase(secondRaw, 'agent3ContinuityCriticSecondPass')
    const protectedRows = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const protectedPayments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const protectedLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const replay = () => prisma.$transaction(tx => lifecycle.readReusableLegacyContinuityAssessment(tx, { ...ctx, callId: 'resumed-call' },
      { ...frozen, content: 'Changed rendered guidance, same frozen business input.' }))
    const recovered = await replay()
    // Public normalized findings retain source/quote; raw segment addresses
    // remain in the separately preserved physical response and strict audits.
    expect(recovered).toMatchObject({ complete: true, findings: [{ ...retained, sourceEvidence: [
      { source: 'current', quote: '门先锁着' }, { source: 'current', quote: '门打开' },
    ] }], audit: { sourceProjection: {
      scope: 'unapplied_body_only_final_report', dispositionDiagnostics: [{ index: 1, code: 'retract_source_proof_invalid' }],
    } } })
    expect(recovered?.audit.rawResponse.content).toBe(JSON.stringify(secondRaw))
    expect(fetcher).toHaveBeenCalledTimes(2)
    await prisma.$transaction(tx => lifecycle.markLegacyContinuityAssessmentApplication(tx, ctx, recovered!))
    expect(await replay()).toEqual(recovered)
    await prisma.$transaction(tx => lifecycle.markLegacyContinuityAssessmentApplication(tx, ctx, recovered!))
    const applications = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview',
      metadata: { path: ['assessmentApplicationKey'], equals: lifecycle.legacyContinuityAssessmentKey(ctx, frozen) } } })
    expect(applications).toHaveLength(1)
    const application = applications[0]
    expect(application.metadata).toMatchObject({ sourceProjectionHash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    for (const scenario of ['unknown-fee', 'incomplete-response', 'bad-final-quote', 'changed-confirm', 'old-certified-application'] as const) {
      const secondFrame = protectedRows.find(row => (row.metadata as Record<string, unknown>).stage === 'reassessment'
        && (row.metadata as Record<string, unknown>).assessmentResponseKey)!
      const metadata = structuredClone(secondFrame.metadata) as Record<string, unknown>
      if (scenario === 'unknown-fee') await prisma.aiUsageLog.update({ where: { id: second.id }, data: { usageSource: 'unknown', billingStatus: 'pending_usage' } })
      if (scenario === 'incomplete-response') (metadata.response as Record<string, unknown>).transportComplete = false
      if (scenario === 'bad-final-quote' || scenario === 'changed-confirm') {
        const wire = structuredClone(secondWire)
        if (scenario === 'bad-final-quote') wire.findings[0].sourceEvidence[0].quote = '伪造当前正文引用'
        else wire.findings[0].suggestion = '改变原意见后伪称confirm'
        const raw = JSON.stringify(wire)
        ;(metadata.response as Record<string, unknown>).content = JSON.stringify(raw)
        metadata.audit = inspect(raw).audit
      }
      if (scenario === 'old-certified-application') await prisma.agentArtifact.update({ where: { id: application.id }, data: { metadata: runtimeJson({
        assessmentApplicationKey: lifecycle.legacyContinuityAssessmentKey(ctx, frozen), version: 1 }).value } })
      await prisma.agentArtifact.update({ where: { id: secondFrame.id }, data: { metadata: runtimeJson(metadata).value } })
      expect(await replay(), scenario).toBeNull()
      // Restore every synthetic mutation, including Prisma's automatic timestamp.
      await prisma.agentArtifact.update({ where: { id: secondFrame.id }, data: { metadata: secondFrame.metadata!, updatedAt: secondFrame.updatedAt } })
      await prisma.agentArtifact.update({ where: { id: application.id }, data: { metadata: application.metadata!, updatedAt: application.updatedAt } })
      await prisma.aiUsageLog.update({ where: { id: second.id }, data: { usageSource: second.usageSource, billingStatus: second.billingStatus } })
    }
    expect(await replay()).toEqual(recovered)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(protectedPayments)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(protectedLedger)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: protectedRows.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(protectedRows)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(body)
  }))
})
