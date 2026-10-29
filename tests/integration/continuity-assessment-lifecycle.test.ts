import { readQualityReviewAdmission } from '../../api/lib/agent/quality-review-admission.js'
import { describe, expect, it, vi } from 'vitest'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { tokenPriceSchema } from '../../api/lib/billing/token-price.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import type { ContinuityReport } from '../../api/lib/agent/continuity-review.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readLegacyContinuityAssessment, legacyContinuityAssessmentKey, legacyAssessmentInputSchema, continuityReassessmentRequest, applyContinuityReassessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { inspectAuthenticatedContinuityAssessment, assertLegacyContinuityInspection } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import type { ToolContext, ToolResult } from '../../api/lib/agent/tools/types.js'
import { fixture } from '../support/agent-durable-runtime-fixture.js'

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0]
const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1',
  apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 }
const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'continuity-lifecycle-fixture',
  rates: { inputNano: 100000, cacheNano: 25000, outputNano: 1000000 } }
const body = '门先锁着。随后门打开，人物走进门。', state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
const completion = (content: string, finishReason = 'stop') => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }],
  usage: { prompt_tokens: 12, completion_tokens: 8 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const rateLimited = (usage?: object) => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'RPM exceeded' },
  ...(usage === undefined ? {} : { usage }) }), { status: 429 })
function interceptRetryWait(controller: AbortController, onWait: () => Promise<void> = async () => {}) {
  const realTimeout = globalThis.setTimeout, waits: number[] = [], errors: unknown[] = []
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 60_000) return realTimeout(callback, ms, ...args)
    waits.push(ms); return realTimeout(() => { void onWait().then(() => callback(...args)).catch(error => { errors.push(error); controller.abort(error) }) }, 0)
  }) as typeof setTimeout)
  return { waits, errors }
}
async function setup(f: Fixture, controller = new AbortController()) {
  await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running',
    startRequest: runtimeJson(withHumanAdmission({ prompt: '修改本章', sessionId: f.sessionId, novelId: f.novelId, mode: 'build' })).value } })
  const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, revision: 4, wordCount: body.length } })
  const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: '核对实际正文' })
  await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '过门', entryState: state, goal: '进门', obstacle: '门锁',
    choice: '等待', cost: '时间', turn: '门开', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
  const window = credits.getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
  vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue(price)
  const ctx: ToolContext = { ...f, callId: 'current-check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', sandboxMode: 'read_only',
    modelRuntime: runtime, signal: controller.signal, emit: () => {} }
  return { ctx, chapter, compilation, controller, args: { compilationId: compilation.id } }
}
const paid = (f: Fixture) => prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { createdAt: 'asc' } })
async function stored(compilationId: string) {
  return ((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation as { continuityReport?: ContinuityReport } | null)?.continuityReport
}
function idFromRequest(init: RequestInit) {
  const request = JSON.parse(String(init.body)), payload = JSON.parse(request.messages[1].content)
  const current = payload.sources.find((source: { source: string }) => source.source === 'current')
  return /^q[a-f0-9]{12}/m.exec(current.evidence)![0]
}
const opinion = (sourceId: string) => ({ signal: 'object', severity: 'error', explanation: '这条门状态意见需要核对事件先后。',
  suggestion: '保留先锁门后开门的实际顺序。', evidence: [{ sourceId }] })
const result = (ctx: ToolContext, args: { compilationId?: string; chapterId?: string; focus?: string }): Promise<ToolResult> =>
  continuityValidateTool.execute(ctx, args).catch(error => ({ outcome: 'failed', failureCode: error.code ?? error.name, output: error.message, summary: '检查未完成' }))

/** Synthetic historical body-only pair, using the omitted parser field layout
 * present in HEAD. This is fixture data, not a copied persisted production row.
 * The omitted field selects the original parser6 interpretation, not parser7. */
function historicalBodyOnlyPair(chapter: { id: string; revision: number }, owner: { runId: string; callId: string }) {
  const bodies = { current: body, previous: null }
  const input: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies, system: 'Original frozen reviewer',
    content: body, reassessmentProtocol: 2, targetType: 'chapter', targetId: chapter.id }
  const firstRaw = JSON.stringify({ findings: [{ signal: 'object', severity: 'error', evidence: '原意见含无效引用', suggestion: '核对门状态',
    sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '不存在的正文' }] }] })
  const first = inspectContinuityResponse(firstRaw, bodies, true, 6)
  const secondRaw = JSON.stringify({ decisions: [{ index: 0, action: 'retract', reason: '实际先锁门后开门，原判断混淆时序。',
    sourceEvidence: [{ source: 'current', segmentId: 'c0' }] }], findings: [] })
  return { bodies, input, firstRaw, secondRaw, first, key: legacyContinuityAssessmentKey(owner, input) }
}

it('serializes the synthetic historical body-only layout with omitted parser identity and exact parser6 raw replay', () => {
  const owner = { runId: 'synthetic-original-run', callId: 'synthetic-original-call' }
  const pair = historicalBodyOnlyPair({ id: 'synthetic-original-chapter', revision: 4 }, owner)
  expect(pair.input).not.toHaveProperty('parserVersion')
  expect(pair.input).not.toHaveProperty('sourceScope')
  expect(pair.first.audit.parserVersion).toBe(6)
  const before = runtimeJson({ input: pair.input, raw: [pair.firstRaw, pair.secondRaw], audit: pair.first.audit }).hash
  const persisted = JSON.parse(JSON.stringify(pair.input)) as LegacyAssessmentInput
  expect(legacyAssessmentInputSchema.parse(persisted)).toEqual(pair.input)
  expect(legacyContinuityAssessmentKey(owner, persisted)).toBe(pair.key)
  expect(inspectAuthenticatedContinuityAssessment(pair.firstRaw, persisted, true)).toEqual(pair.first)
  const replay = applyContinuityReassessment(pair.first, pair.secondRaw, pair.bodies, 2)
  assertLegacyContinuityInspection(replay)
  expect(replay.complete).toBe(true)
  expect(replay.audit.parserVersion).toBe(6)
  expect(JSON.parse(replay.audit.rawResponse.content)).toBe(JSON.stringify({ findings: [] }))
  expect(replay.audit).toMatchObject({ reassessment: { original: pair.first.audit, rawResponse: { content: JSON.stringify(pair.secondRaw) } } })
  // An explicit parser6 with no sourceScope was never a serializable old key.
  // Keep that impossible shape outside the accepted historical input schema.
  expect(legacyAssessmentInputSchema.safeParse({ ...persisted, parserVersion: 6 }).success).toBe(false)
  expect(before).toBe(runtimeJson({ input: pair.input, raw: [pair.firstRaw, pair.secondRaw], audit: pair.first.audit }).hash)
})

/** Fixed synthetic pre-refactor rows; no retired producer or paid phase runs. */
async function history(f: Fixture, chapter: { id: string; revision: number }, compilationId: string) {
  const old: ToolContext = { userId: f.userId, novelId: f.novelId, runId: f.runId, sessionId: f.sessionId, chapterId: chapter.id,
    callId: 'original-history', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
  const { bodies, input, firstRaw, secondRaw, first, key } = historicalBodyOnlyPair(chapter, old)
  const fees: Array<Awaited<ReturnType<typeof prisma.aiUsageLog.create>>> = [], ledger = []
  for (const action of ['agent3ContinuityCritic', 'agent3ContinuityCriticSecondPass']) {
    const fee = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
      targetType: input.targetType, targetId: input.targetId, providerType: 'text', providerMode: 'custom', providerName: 'fixture', modelTier: 'speed', modelName: 'fixture',
      action, requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled', creditChargeMilli: 23, reservedCreditMilli: 0, durationMs: 0 } })
    fees.push(fee)
    ledger.push(await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: fee.id,
      idempotencyKey: 'original-history:' + fee.id, deltaMilli: -23, dailyDeltaMilli: -23, modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8 } }))
  }
  await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyUsedMilli: 46 } })
  const values = [{ version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: chapter.id, input, callId: old.callId, compilationId },
    { version: 1, fullReassessmentKey: key, input, callId: old.callId, original: first.audit,
      request: continuityReassessmentRequest(input.system, input.content, first, bodies, false, 2) },
    ...['first', 'reassessment'].flatMap((stage, index) => [
      { version: 1, assessmentRequestOwnerKey: key, stage, callId: old.callId, usageIds: [fees[index].id] },
      { version: 1, assessmentKey: key, assessmentResponseKey: runtimeJson({ key, stage }).hash, input, stage, callId: old.callId, usageIds: [fees[index].id],
        response: { content: JSON.stringify(index ? secondRaw : firstRaw), transportComplete: true, finishReason: 'stop', toolCalls: [] } },
    ])]
  const artifacts = []
  for (const value of values) artifacts.push(await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId, artifactType: 'continuityReview',
    title: 'Original immutable response', metadata: runtimeJson(value).value } }))
  return { old, input, firstRaw, secondRaw, first, fees, ledger, artifacts }
}
async function unchanged(f: Fixture, h: Awaited<ReturnType<typeof history>>) {
  expect(await prisma.aiUsageLog.findMany({ where: { id: { in: h.fees.map(row => row.id) } }, orderBy: { id: 'asc' } }))
    .toEqual([...h.fees].sort((a, b) => a.id.localeCompare(b.id)))
  expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: h.ledger.map(row => row.id) } }, orderBy: { id: 'asc' } }))
    .toEqual([...h.ledger].sort((a, b) => a.id.localeCompare(b.id)))
  expect(await prisma.agentArtifact.findMany({ where: { id: { in: h.artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } }))
    .toEqual([...h.artifacts].sort((a, b) => a.id.localeCompare(b.id)))
}
describe('legacy historical reports and ordinary current review lifecycle in PostgreSQL', () => {
  it('replays a frozen settled pair after JSONB persistence without rewriting its old report or buying a request', () => fixture(async f => {
    const s = await setup(f), h = await history(f, s.chapter, s.compilation.id), network = vi.fn(); vi.stubGlobal('fetch', network)
    const first = await readLegacyContinuityAssessment(prisma, h.old, h.input)
    expect(first).toMatchObject({ billingKnown: true, providerComplete: true, slotUsed: true, inspected: { complete: true, findings: [] } })
    expect(await readLegacyContinuityAssessment(prisma, h.old, h.input)).toEqual(first)
    await unchanged(f, h); expect(network).not.toHaveBeenCalled()
  }))
  it('keeps a closed old failure frozen while ordinary same-body review can produce a current report', () => fixture(async f => {
    const s = await setup(f), h = await history(f, s.chapter, s.compilation.id)
    const network = vi.fn(async () => completion('{"findings":[]}')); vi.stubGlobal('fetch', network)
    expect(await result(s.ctx, s.args)).toMatchObject({ reviewCompleted: true })
    expect(await result({ ...s.ctx, callId: 'Continue' }, s.args)).toMatchObject({ reviewCompleted: true })
    expect(network).toHaveBeenCalledOnce(); await unchanged(f, h)
  }))
  it.each(['fresh4', 'frozen3'] as const)('preserves %s history and commits the saved current report without another check', variant => fixture(async f => {
    const s = await setup(f), h = await history(f, s.chapter, s.compilation.id)
    await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId, artifactType: 'continuityReview', title: variant, metadata: { responseContract: variant, raw: h.firstRaw } } })
    const network = vi.fn(async () => completion('{"findings":[]}')); vi.stubGlobal('fetch', network)
    expect(await result(s.ctx, s.args)).toMatchObject({ reviewCompleted: true })
    await persistHumanityQualityReport({ ...f, ...s.args, chapterId: s.chapter.id, chapterRevision: 4, mode: 'balanced',
      criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    expect(await chapterBridgeCommitTool.execute({ ...s.ctx, sandboxMode: undefined }, s.args)).not.toMatchObject({ outcome: 'failed' })
    expect(network).toHaveBeenCalledOnce(); await unchanged(f, h)
  }))
  it.each(['unknown-second', 'missing-second-frame', 'wrong-contract-marker'] as const)('does not reinterpret or resend unresolved %s history', scenario => fixture(async f => {
    const s = await setup(f), h = await history(f, s.chapter, s.compilation.id)
    if (scenario === 'unknown-second') await prisma.aiUsageLog.update({ where: { id: h.fees[1].id }, data: { usageSource: 'unknown', billingStatus: 'pending_usage' } })
    if (scenario === 'missing-second-frame') await prisma.agentArtifact.delete({ where: { id: h.artifacts.at(-1)!.id } })
    if (scenario === 'wrong-contract-marker') await prisma.agentArtifact.update({ where: { id: h.artifacts[0].id },
      data: { metadata: runtimeJson({ ...(h.artifacts[0].metadata as object), input: { ...h.input, reassessmentProtocol: 7 } }).value } })
    const fees = await paid(f), network = vi.fn(); vi.stubGlobal('fetch', network)
    expect(await result(s.ctx, s.args)).toMatchObject({ outcome: 'failed', failureCode: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(network).not.toHaveBeenCalled(); expect(await paid(f)).toEqual(fees)
  }))
  it.each(['known-new-body', 'known-new-body-no-candidate', 'known-new-candidate', 'delayed-call-persistence', 'no-author-admission', 'unknown-first', 'unknown-second', 'incomplete-second', 'focus-only', 'revision-only'] as const)(
    '%s uses current scope and closed physical receipts without an old revision allowance', scenario => fixture(async f => {
      const s = await setup(f), h = await history(f, s.chapter, s.compilation.id)
      if (scenario === 'unknown-first' || scenario === 'unknown-second') await prisma.aiUsageLog.update({ where: { id: h.fees[scenario === 'unknown-first' ? 0 : 1].id }, data: { usageSource: 'unknown', billingStatus: 'pending_usage' } })
      if (scenario === 'incomplete-second') await prisma.agentArtifact.update({ where: { id: h.artifacts.at(-1)!.id }, data: { metadata: runtimeJson({
        ...(h.artifacts.at(-1)!.metadata as object), response: { content: JSON.stringify('{"decisions":['), transportComplete: false, finishReason: 'length', toolCalls: [] } }).value } })
      if (scenario.startsWith('known-new-body')) expect(await chapterEditRangeTool.execute({ ...s.ctx, sandboxMode: undefined },
        { chapterId: f.chapterId, oldText: '人物走进门', newText: '人物平静地走进门' })).not.toMatchObject({ outcome: 'failed' })
      if (scenario === 'revision-only') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
      if (scenario === 'no-author-admission') {
        await prisma.agentMessage.delete({ where: { id: f.sourceMessageId } })
        const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        const network = vi.fn(() => { throw Error('Historical admission inspection cannot dispatch') }); vi.stubGlobal('fetch', network)
        expect(await prisma.$transaction(tx => readQualityReviewAdmission(tx, run))).toBeNull()
        await unchanged(f, h); expect(network).not.toHaveBeenCalled()
        return
      }
      const network = vi.fn(async () => completion('{"findings":[]}')); vi.stubGlobal('fetch', network)
      const checked = await result(s.ctx, { ...s.args, ...(scenario === 'focus-only' ? { focus: '只核事件时序' } : {}) })
      const blocked = scenario.startsWith('unknown-')
      expect(checked).toMatchObject(blocked ? { outcome: 'failed' } : { reviewCompleted: true })
      expect(network).toHaveBeenCalledTimes(blocked ? 0 : 1)
      if (scenario !== 'incomplete-second' && !scenario.startsWith('unknown-')) await unchanged(f, h)
    }))
  it('does not dispatch a concurrent current request while its original physical request is still in flight', () => fixture(async f => {
    const s = await setup(f); let entered = () => {}, release = () => {}
    const waiting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const network = vi.fn(async () => { entered(); await held; return completion('{"findings":[]}') }); vi.stubGlobal('fetch', network)
    const first = result(s.ctx, s.args)
    try {
      await waiting
      expect(await result({ ...s.ctx, callId: 'concurrent' }, s.args)).toMatchObject({ outcome: 'failed', failureCode: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
      expect(network).toHaveBeenCalledOnce()
    } finally { release() }
    expect(await first).toMatchObject({ reviewCompleted: true }); expect(network).toHaveBeenCalledOnce()
  }))
  it.each(['settled-with-continue', 'unknown-same-admission'] as const)('keeps original %s rows and fees without turning Continue into another grant', scenario => fixture(async f => {
    const s = await setup(f), h = await history(f, s.chapter, s.compilation.id)
    if (scenario === 'unknown-same-admission') await prisma.aiUsageLog.update({ where: { id: h.fees[1].id }, data: { usageSource: 'unknown', billingStatus: 'pending_usage' } })
    const fees = await paid(f), network = vi.fn(async () => completion('{"findings":[]}')); vi.stubGlobal('fetch', network)
    const checked = await result({ ...s.ctx, callId: 'Continue' }, s.args)
    expect(checked).toMatchObject(scenario === 'settled-with-continue' ? { reviewCompleted: true } : { outcome: 'failed', failureCode: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(network).toHaveBeenCalledTimes(scenario === 'settled-with-continue' ? 1 : 0)
    for (const row of fees) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row)
  }))
  it('preserves unknown second-pass usage after a known-zero primary rejection and does not retire it on Continue', () => fixture(async f => {
    const s = await setup(f), h = await history(f, s.chapter, s.compilation.id)
    const rejection = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
      targetType: 'chapter', targetId: f.chapterId, providerType: 'text', providerMode: 'custom', modelName: 'fixture', modelTier: 'speed',
      action: 'agent3ContinuityCritic', requestTokens: null, responseTokens: null, durationMs: 0,
      usageSource: 'prepared', billingStatus: 'provider_rejected', creditChargeMilli: 0, reservedCreditMilli: 0 } })
    await prisma.aiUsageLog.update({ where: { id: h.fees[1].id }, data: { usageSource: 'unknown', billingStatus: 'pending_usage' } })
    const fees = await paid(f), network = vi.fn(); vi.stubGlobal('fetch', network)
    for (const callId of ['Continue', 'restart']) expect(await result({ ...s.ctx, callId }, s.args)).toMatchObject({ outcome: 'failed' })
    expect(network).not.toHaveBeenCalled(); expect(await paid(f)).toEqual(fees)
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: rejection.id } })).toEqual(rejection)
  }))
  it.each(['first-absent', 'first-zero', 'second-absent', 'second-zero', 'both', 'first-then-source-invalid', 'first-then-output-limit'] as const)(
    '%s retains actual HTTP attempts, prices and settled receipts while reusing the final report', scenario => fixture(async f => {
      const s = await setup(f), timers = interceptRetryWait(s.controller)
      const correction = ['second-absent', 'second-zero', 'both', 'first-then-source-invalid'].includes(scenario)
      const rejectsFirst = !['second-absent', 'second-zero'].includes(scenario), rejectsSecond = ['second-absent', 'second-zero', 'both'].includes(scenario)
      const queue = [ ...(rejectsFirst ? [rateLimited(scenario === 'first-zero' ? { prompt_tokens: 0, completion_tokens: 0 } : undefined)] : []),
        completion(JSON.stringify({ findings: correction ? [opinion('q000000000000')] : [] }), scenario === 'first-then-output-limit' ? 'length' : 'stop'),
        ...(rejectsSecond ? [rateLimited(scenario === 'second-zero' ? { prompt_tokens: 0, completion_tokens: 0 } : undefined)] : []) ]
      const network = vi.fn(async (_url: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body))
        expect(request.model).toBe(runtime.modelName)
        expect(request.reasoning_effort).toBe(request.messages[0].content.startsWith('只为原意见') ? runtime.reasoningEffort : 'none')
        if (queue.length) return queue.shift()!
        return completion(correction ? JSON.stringify({ corrections: [{ index: 0, evidence: [{ sourceId: idFromRequest(init) }] }] }) : '{"findings":[]}')
      }); vi.stubGlobal('fetch', network)
      const expected = Number(rejectsFirst) + 1 + Number(rejectsSecond) + Number(correction || scenario === 'first-then-output-limit')
      expect(await result(s.ctx, s.args)).toMatchObject({ reviewCompleted: true, reviewOutcome: correction ? 'decision_required' : 'complete' })
      expect(network).toHaveBeenCalledTimes(expected); expect(timers.waits).toHaveLength(Number(rejectsFirst) + Number(rejectsSecond)); expect(timers.errors).toEqual([])
      const fees = await paid(f); expect(fees).toHaveLength(expected)
      for (const fee of fees) {
        expect(fee.modelName).toBe(runtime.modelName); expect(fee.multiplierBps).toBe(runtime.multiplierBps); expect(fee.reservedCreditMilli).toBe(0)
        if (fee.billingStatus === 'provider_rejected') expect(fee).toMatchObject({ requestTokens: null, responseTokens: null, creditChargeMilli: 0 })
        else {
          expect(fee.billingStatus).toBe('settled')
          expect(fee.creditChargeMilli).toBe(priceTokenEvidence(tokenPriceSchema.parse(fee.billingSnapshot), fee.requestTokens!, fee.responseTokens!, fee.promptCacheHitTokens))
        }
      }
      const report = await stored(s.compilation.id); expect(report).toMatchObject({ complete: true, billingKnown: true })
      expect(report!.usageIds.sort()).toEqual(fees.map(row => row.id).sort())
      expect(await result({ ...s.ctx, callId: 'cached' }, s.args)).toMatchObject({ reviewCompleted: true })
      expect(network).toHaveBeenCalledTimes(expected); for (const fee of fees) expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: fee.id } })).toEqual(fee)
    }))
  it.each(['empty-usage', 'partial-usage', 'transport-unknown', 'pending-settlement', 'cancel-during-wait', 'stale-during-wait',
    'second-empty-usage', 'second-partial-usage', 'second-transport-unknown', 'second-pending-settlement', 'second-cancel-during-wait', 'second-stale-during-wait'] as const)(
    '%s preserves unresolved billing and never issues another unknown request', scenario => fixture(async f => {
      const s = await setup(f), second = scenario.startsWith('second-'), failure = scenario.replace(/^second-/, '')
      const timers = interceptRetryWait(s.controller, async () => {
        if (failure === 'cancel-during-wait') s.controller.abort()
        if (failure === 'stale-during-wait') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body + '作者更新。', revision: { increment: 1 } } })
      })
      if (failure === 'pending-settlement') {
        const consume = credits.consumeTokenCredits
        vi.spyOn(credits, 'consumeTokenCredits').mockImplementation(async args => {
          const fee = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: args.usageLogId } })
          if (fee.action === (second ? 'agent3ContinuityEvidenceCorrection' : 'agent3ContinuityCritic')) throw Error('Synthetic pending settlement')
          return consume(args)
        })
      }
      let sends = 0
      const network = vi.fn(async () => {
        if (second && ++sends === 1) return completion(JSON.stringify({ findings: [opinion('q000000000000')] }))
        if (failure === 'transport-unknown') throw new TypeError('fetch failed after dispatch')
        return rateLimited(failure === 'empty-usage' ? {} : failure === 'partial-usage' ? { prompt_tokens: 12 }
          : failure === 'pending-settlement' ? { prompt_tokens: 0, completion_tokens: 0 } : undefined)
      }); vi.stubGlobal('fetch', network)
      expect(await result(s.ctx, s.args)).toMatchObject({ outcome: 'failed' })
      expect(network).toHaveBeenCalledTimes(second ? 2 : 1); expect(timers.errors).toEqual([])
      const fees = await paid(f), guarded = failure.endsWith('during-wait')
      expect(fees).toHaveLength(Number(second) + (failure === 'stale-during-wait' ? 2 : 1))
      if (!guarded) {
        expect(fees.at(-1)!.billingStatus).toBe(failure === 'pending-settlement' ? 'pending_settlement' : 'pending_usage')
        const before = await paid(f)
        expect(await result({ ...s.ctx, callId: 'Continue' }, s.args)).toMatchObject({ outcome: 'failed' })
        expect(await paid(f)).toEqual(before); expect(network).toHaveBeenCalledTimes(second ? 2 : 1)
      } else expect(fees.every(row => row.billingStatus === 'settled' || ['not_dispatched', 'provider_rejected'].includes(row.billingStatus))).toBe(true)
      expect((await stored(s.compilation.id))?.complete).not.toBe(true)
    }))
})
describe('current continuity response parsing and application in PostgreSQL', () => {
  it('keeps an invalid known follow-up and every original opinion instead of certifying an empty report', () => fixture(async f => {
    const s = await setup(f), first = JSON.stringify({ findings: [opinion('q000000000000')] }), second = '{"corrections":[]}'
    const network = vi.fn(async () => completion(network.mock.calls.length === 1 ? first : second)); vi.stubGlobal('fetch', network)
    expect(await result(s.ctx, { chapterId: f.chapterId })).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE' })
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' } })
    const report = (artifacts[0].metadata as { continuityReport: ContinuityReport }).continuityReport
    expect(report).toMatchObject({ complete: false, billingKnown: true, opinions: [opinion('q000000000000')], rawResponses: [first, second], unlocatedIndexes: [0] })
    expect(await paid(f)).toHaveLength(2); expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(body)
  }))
  it.each(['syntax', 'fields', 'judgment', 'pair', 'failed-second', 'unknown-first', 'unknown-second', 'cancelled-second', 'stale-second',
    'abort-after-claim', 'stale-after-claim', 'abort-first-reserved', 'credit-first-reserved', 'abort-first-bound', 'abort-second-bound', 'stale-second-bound', 'credit-second-reserved'] as const)(
    '%s preserves real paid results and applies only under the current owner and body', scenario => fixture(async f => {
      const s = await setup(f), second = !['unknown-first', 'abort-first-reserved', 'credit-first-reserved', 'abort-first-bound'].includes(scenario)
      const first = ['syntax', 'fields'].includes(scenario) ? scenario === 'syntax' ? '{broken' : '{"findings":"wrong"}' : JSON.stringify({ findings: [opinion('q000000000000')] })
      const guardFirst = ['abort-first-reserved', 'credit-first-reserved', 'abort-first-bound'].includes(scenario)
      const guardSecond = ['abort-after-claim', 'stale-after-claim', 'abort-second-bound', 'stale-second-bound', 'credit-second-reserved'].includes(scenario)
      s.ctx.assertCurrentExecution = async tx => {
        const fees = await tx.aiUsageLog.findMany({ where: { userId: f.userId } })
        const prepared = fees.find(row => ['prepared', 'authorized_pending'].includes(row.billingStatus))
        if (prepared && (guardFirst || guardSecond && fees.length > 1)) {
          if (scenario.startsWith('stale')) await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body + '作者更新。', revision: { increment: 1 } } })
          else if (scenario.startsWith('credit')) throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '合成钱包不足')
          else s.controller.abort()
        }
        if (fees.length >= 2 && fees.every(row => row.billingStatus === 'settled')) {
          if (scenario === 'cancelled-second') s.controller.abort()
          if (scenario === 'stale-second') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body + '作者更新。', revision: { increment: 1 } } })
        }
      }
      let sends = 0
      const raw: string[] = []
      const network = vi.fn(async (_url: unknown, init: RequestInit) => {
        sends++
        if (scenario === 'unknown-first' || scenario === 'unknown-second' && sends === 2) throw TypeError('fetch failed after dispatch')
        const answer = sends === 1 ? first : ['syntax', 'fields'].includes(scenario) ? '{"findings":[]}'
          : scenario === 'failed-second' ? '{"corrections":[]}' : JSON.stringify({ corrections: [{ index: 0, evidence: [{ sourceId: idFromRequest(init) }] }] })
        raw.push(answer); return completion(answer)
      }); vi.stubGlobal('fetch', network)
      const checked = await result(s.ctx, s.args), good = ['syntax', 'fields', 'judgment', 'pair'].includes(scenario)
      expect(checked).toMatchObject(good ? { reviewCompleted: true } : { outcome: 'failed' })
      expect(network).toHaveBeenCalledTimes(guardFirst ? 0 : guardSecond || !second ? 1 : 2)
      const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' } })
      const saved = (artifacts[0].metadata as { continuityReport: ContinuityReport }).continuityReport
      expect(saved.rawResponses).toEqual(raw); expect(saved.complete).toBe(good)
      if (!['syntax', 'fields'].includes(scenario) && raw.length) expect(saved.opinions).toHaveLength(1)
      if (scenario.startsWith('unknown-')) {
        const fees = await paid(f), before = network.mock.calls.length
        expect(await result({ ...s.ctx, callId: 'unknown-replay' }, s.args)).toMatchObject({ outcome: 'failed' })
        expect(network).toHaveBeenCalledTimes(before); expect(await paid(f)).toEqual(fees)
      }
    }))
  it('retains the exact complete historical second response without repurchasing or rewriting it', () => fixture(async f => {
    const s = await setup(f), h = await history(f, s.chapter, s.compilation.id), network = vi.fn(); vi.stubGlobal('fetch', network)
    expect(await readLegacyContinuityAssessment(prisma, h.old, h.input)).toMatchObject({ inspected: { complete: true } })
    await unchanged(f, h); expect(network).not.toHaveBeenCalled()
  }))
  it('preserves an unsupported retract as failed audit data and retains the original opinion', () => fixture(async f => {
    const s = await setup(f), h = await history(f, s.chapter, s.compilation.id)
    const response = { content: JSON.stringify('{"decisions":[{"index":0,"action":"retract","reason":"无证据","sourceEvidence":[{"source":"current","segmentId":"c0","quote":"杜撰"}]}],"findings":[]}'),
      transportComplete: true, finishReason: 'stop', toolCalls: [] }
    await prisma.agentArtifact.update({ where: { id: h.artifacts.at(-1)!.id }, data: { metadata: runtimeJson({ ...(h.artifacts.at(-1)!.metadata as object), response }).value } })
    const frozen = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const read = await readLegacyContinuityAssessment(prisma, h.old, h.input)
    expect(read.inspected.complete).toBe(false); expect(read.inspected.audit.rawResponse.content).toBe(JSON.stringify(h.firstRaw))
    expect(read.inspected.candidateFindings).toHaveLength(1)
    expect(await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })).toEqual(frozen)
    expect(await paid(f)).toHaveLength(2)
  }))
})
