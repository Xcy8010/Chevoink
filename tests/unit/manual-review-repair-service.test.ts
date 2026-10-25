import { createHmac } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { manualRepairFixture } from '../support/manual-review-repair-fixture.js'
import { env } from '../../api/config/env.js'
import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import { inspectContinuityV4 } from '../../api/lib/agent/continuity-review-v4.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { legacyContinuityAssessmentKey, bindLegacyContinuityAssessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { deregisterActiveRun, getActiveRun } from '../../api/lib/agent/active-runs.js'
import { readManualReviewRepair, quoteManualReviewRepair, submitManualReviewRepair } from '../../api/lib/agent/manual-review-repair-service.js'

type Row = Record<string, unknown>
const m = vi.hoisted(() => ({ transaction: vi.fn(), runtime: vi.fn(), generate: vi.fn(), physical: vi.fn(), validate: vi.fn(), commit: vi.fn(), finish: vi.fn(),
  run: {} as Row, compilation: {} as Row, source: {} as Row, original: {} as Row, usage: [] as Row[], artifacts: [] as Row[], events: [] as Row[],
  evidence: {} as Row, oldInput: {} as LegacyAssessmentInput, response: undefined as undefined | { usageId: string; content: string; finishReason: string | null; toolCalls: unknown[] },
  invalid: false, unknown: false, cancel: false, sourceDrift: false, omitResponse: false, pause: undefined as undefined | (() => Promise<void>), tx: null as unknown as Prisma.TransactionClient,
  wire: {} as Row, oldKey: '', oldInspected: null as unknown, oldAudit: {} as Row, tail: Promise.resolve() as Promise<unknown>, actor: 'user', scopeWrong: false, pendingProvider: 0, retired: [] as string[] }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } }, prisma: { $transaction: m.transaction } }))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: m.runtime }))
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: m.generate }))
vi.mock('../../api/lib/data/novel-write-lock.js', () => ({ lockNovelActiveScope: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/manuscript-scope.js', () => ({ assertAgentManuscriptCurrent: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/cancelled-review-recovery.js', () => ({ readRetiredReviewUsageIds: vi.fn(async () => new Set(m.retired)) }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: vi.fn(async () => m.original), originalTaskRunIds: vi.fn(async () => ['run']) }))
vi.mock('../../api/lib/agent/compiler-continuity-source.js', () => ({ readCompilerContinuitySource: vi.fn(async () => m.sourceDrift ? { ...m.source, content: 'Changed source.' } : m.source) }))
vi.mock('../../api/lib/agent/terminal-evidence-context.js', async original => ({ ...await original<object>(), terminalEvidenceContext: () => structuredClone(m.evidence) }))
vi.mock('../../api/lib/agent/terminal-proposal-context.js', async original => ({ ...await original<object>(), attachTerminalProposalInput: (value: unknown) => value }))
vi.mock('../../api/lib/agent/story-compiler.js', () => ({ validateStoryContinuity: m.validate }))
vi.mock('../../api/lib/agent/tools/story-compiler-tools.js', () => ({ chapterBridgeCommitTool: { execute: m.commit } }))
vi.mock('../../api/lib/agent/loop.js', () => ({ finishManualReviewRepairWriting: m.finish }))
vi.mock('../../api/lib/agent/writing-scope.js', () => ({ readWritingScope: vi.fn(async () => ({ spec: m.original.spec, writing: { kind: 'bounded',
  targets: [{ chapterId: m.scopeWrong ? 'other-chapter' : 'chapter', orderIndex: 3 }] } })),
  readCompletedWritingDelivery: vi.fn(async () => m.compilation.status === 'completed' ? { text: 'Saved original chapter.' } : null), readRecoveredChapterDelivery: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/assessment-response-lifecycle.js', async original => {
  const actual = await original<typeof import('../../api/lib/agent/assessment-response-lifecycle.js')>()
  return { ...actual,
    readLegacyContinuityAssessment: vi.fn(async (_tx, _ctx, input: LegacyAssessmentInput) => input.parserVersion === 9
      ? { inspected: inspectContinuityV4(m.response?.content ?? '', { manifest: input.continuityManifest!, bodies: input.bodies, candidate: input.terminalCandidate!, sourceScope: input.sourceScope! }),
        billingKnown: !m.unknown, providerComplete: !!m.response, recoveryReady: !!m.response && !m.unknown, slotUsed: false, usageIds: ['new-usage'] }
      : { inspected: m.oldInspected, billingKnown: true, providerComplete: true, recoveryReady: true, slotUsed: true, usageIds: ['old-first', 'old-second'] }),
    bindLegacyContinuityRequest: vi.fn(async (_tx, _ctx, _input, _usage, _stage, assertCurrent) => { await assertCurrent(m.tx); return 'first' }),
    observeLegacyContinuityAssessment: vi.fn(async (_tx, _ctx, _input, response) => { m.response = response; return 'observation' }),
  }
})

const object = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true
    if (key === 'AND') return (value as Row[]).every(item => matches(row, item))
    if (key === 'OR') return (value as Row[]).some(item => matches(row, item))
    const filter = object(value)
    if (key === 'metadata' || key === 'payload') return (filter.path as string[]).reduce<unknown>((part, key) => object(part)[key], row[key]) === filter.equals
    if ('in' in filter) return (filter.in as unknown[]).includes(row[key])
    if ('startsWith' in filter) return typeof row[key] === 'string' && (row[key] as string).startsWith(String(filter.startsWith))
    if ('not' in filter) return row[key] !== filter.not
    if ('isNot' in filter) return row[key] == null || !matches(object(row[key]), object(filter.isNot))
    if (Object.keys(filter).length && !(value instanceof Date)) return matches(object(row[key]), filter)
    return row[key] === value
  })
}
function rows(data: () => Row[]) {
  const many = async ({ where = {}, orderBy, take }: { where?: Row; orderBy?: Row | Row[]; take?: number } = {}) => {
    let selected = data().filter(row => matches(row, where))
    if (orderBy && JSON.stringify(orderBy).includes('seq')) selected = selected.sort((a, b) => (Number(a.seq) - Number(b.seq)) * (JSON.stringify(orderBy).includes('desc') ? -1 : 1))
    if (orderBy && JSON.stringify(orderBy).includes('id')) selected = selected.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    return take ? selected.slice(0, take) : selected
  }
  return { findMany: vi.fn(many), findFirst: vi.fn(async (args?: Parameters<typeof many>[0]) => (await many(args))[0] ?? null),
    findUnique: vi.fn(async (args: Parameters<typeof many>[0]) => (await many(args))[0] ?? null), count: vi.fn(async (args?: Parameters<typeof many>[0]) => (await many(args)).length) }
}
const priorSecret = env.authSessionSecret, secret = 'synthetic-manual-repair-secret-at-least-32-characters'
async function settled() {
  let result: Awaited<ReturnType<typeof readManualReviewRepair>> | undefined
  await vi.waitFor(async () => { result = await readManualReviewRepair('user', 'run'); expect(result.status?.state).not.toBe('running') })
  return result!
}
function snapshots() { return JSON.stringify({ usage: m.usage.filter(row => String(row.id).startsWith('old')), artifacts: m.artifacts.filter(row => row.id === 'old-reservation'),
  checkpoint: object(m.run.usage).checkpoint }) }

beforeEach(() => {
  vi.clearAllMocks(); env.authSessionSecret = secret
  m.tail = Promise.resolve(); m.invalid = false; m.unknown = false; m.cancel = false; m.omitResponse = false; m.sourceDrift = false; m.pause = undefined; m.response = undefined; m.actor = 'user'; m.scopeWrong = false; m.pendingProvider = 0; m.retired = []
  const f = manualRepairFixture(); m.wire = structuredClone(f.wire); m.evidence = f.context
  m.source = { content: f.frozen.bodies.previous, revision: 1, orderIndex: 2 }
  m.original = { taskId: 'task', sourceRunId: 'run', parentRunId: null, prompt: 'Review the original complete chapter.', spec: { id: 'task', intent: 'write', controlPolicy: 'until_completion' } }
  m.run = { id: 'run', userId: 'user', novelId: 'novel', sessionId: 'session', engine: 'loop', runtimeProtocolVersion: 0, taskRootId: null,
    incomingChildGrant: null, status: 'paused', manuscriptRevision: 0, modelTier: 'standard', customModelId: null, reasoningEffort: 'medium', currentTurn: 27,
    usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600, checkpoint: { version: 2, controlPolicy: 'until_completion', origin: 'unknown_legacy',
      activeExecutionMs: 1000, stagnantBatches: 4, runStartedAt: 1000, resumeCount: 3, compactionCount: 1, maxTurns: 27, tokenBudget: 500,
      writeProgress: 5, writeBaseline: 4, readProgress: 8, readBaseline: 7, progressSignatures: [], inheritedTokens: 123, inheritedTurns: 2, manualResumeCount: 0,
      reviewAttempts: Array.from({ length: 8 }, (_, i) => `paid-old-${i}`), pendingReviews: [], consumedReviewDecisionFeedback: ['a'.repeat(64)] } } }
  m.compilation = { id: 'compilation', userId: 'user', novelId: 'novel', runId: 'run', status: 'active', preparedContext: { terminalProposalReview: f.staged.state },
    chapter: { id: 'chapter', revision: 4, orderIndex: 3, content: f.content, authorId: 'user', novelId: 'novel', deletedAt: null, archivedAt: null },
    bridge: { fromChapterId: 'previous', sourceRevision: 1 }, sceneTasks: [{ ordinal: 1 }] }
  const coverage = compilerContinuityCoverage({ chapter: m.compilation.chapter as never, bridge: m.compilation.bridge, sceneTasks: m.compilation.sceneTasks as unknown[],
    source: m.source, focus: '', terminalCandidate: f.candidate }, 11)
  m.oldInput = { chapterId: 'chapter', revision: 4, bodies: f.frozen.bodies, system: 'Original frozen system', content: 'Original complete frozen context',
    terminalCandidate: f.candidate, parserVersion: 8, reassessmentProtocol: 5, sourceScope: f.frozen.sourceScope,
    bindingHash: runtimeJson(coverage).hash, targetType: 'story_compilation', targetId: 'compilation' }
  m.oldKey = legacyContinuityAssessmentKey({ runId: 'run', callId: 'original-call' }, m.oldInput)
  m.oldInspected = inspectContinuityResponse(f.originalRawResponses[0], m.oldInput.bodies, true, 8, f.candidate, f.frozen.sourceScope, { responseContract: 3 })
  m.oldAudit = bindLegacyContinuityAssessment(m.oldInspected as ReturnType<typeof inspectContinuityResponse>, { runId: 'run', callId: 'original-call' } as never, m.oldInput).audit
  m.compilation.validation = { independentCheck: 'unavailable', coverage, terminalCandidate: f.candidate, reviewFocus: '', continuityCriticResponse: m.oldAudit }
  m.artifacts = [{ id: 'old-reservation', runId: 'run', artifactType: 'continuityReview', metadata: { callId: 'original-call', continuityAssessmentRequestKey: m.oldKey, input: m.oldInput } },
    ...f.originalRawResponses.map((raw, i) => ({ id: `old-frame-${i}`, runId: 'run', artifactType: 'continuityReview', metadata: { assessmentKey: m.oldKey, stage: i === 0 ? 'first' : 'reassessment', response: { content: JSON.stringify(raw) } } }))]
  const price = { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 }
  m.usage = ['old-first', 'old-second'].map(id => ({ id, userId: 'user', novelId: 'novel', agentRunId: 'run', modelTier: 'standard', providerName: 'fixture-provider',
    modelName: 'fixture-model', multiplierBps: 12000, billingSnapshot: price, usageSource: 'reported', billingStatus: 'settled', creditChargeMilli: 123,
    chapterId: 'chapter', targetId: 'compilation', targetType: 'story_compilation', action: id === 'old-first' ? 'agent3ContinuityCritic' : 'agent3ContinuityCriticSecondPass', requestTokens: 100, responseTokens: 10, reservedCreditMilli: 0 }))
  m.events = [{ id: 'old-pause', runId: 'run', seq: 80, type: 'run.paused', payload: {} }]
  m.runtime.mockResolvedValue({ tier: 'standard', provider: 'fixture-provider', modelName: 'fixture-model', baseUrl: 'https://provider.invalid/v1', apiKey: 'never-persisted-fixture-key',
    multiplierBps: 12000, reasoningEffort: 'medium', contextWindowTokens: 250000 })
  const runRows = rows(() => [m.run]), eventRows = rows(() => m.events), usageRows = rows(() => m.usage), artifactRows = rows(() => m.artifacts)
  const tx = { agentRun: { ...runRows, update: vi.fn(async ({ data }: { data: Row }) => Object.assign(m.run, data)), updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    if (matches(m.run, where)) { Object.assign(m.run, data); return { count: 1 } }; return { count: 0 }
  }) }, agentRunEvent: { ...eventRows, create: vi.fn(async ({ data }: { data: Row }) => {
    if (m.events.some(row => row.id === data.id || row.runId === data.runId && row.seq === data.seq)) throw Error('unique event conflict')
    const row = { ...data, createdAt: new Date() }; m.events.push(row); return row
  }) }, agentArtifact: { ...artifactRows, create: vi.fn(async ({ data }: { data: Row }) => { const row = { id: `new-artifact-${m.artifacts.length}`, ...data }; m.artifacts.push(row); return row }) },
  aiUsageLog: usageRows, storyCompilation: { findMany: vi.fn(async () => [m.compilation]) }, novel: { findFirst: vi.fn(async () => ({ manuscriptRevision: 0 })) },
  agentGoalExecution: { findUnique: vi.fn(async () => null) }, agentProviderAttempt: { count: vi.fn(async () => m.pendingProvider) }, $queryRaw: vi.fn(async () => []) }
  m.tx = tx as unknown as Prisma.TransactionClient
  m.transaction.mockImplementation((work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    const result = m.tail.then(async () => {
      const before = structuredClone({ run: m.run, compilation: m.compilation, usage: m.usage, events: m.events, artifacts: m.artifacts })
      try { return await work(m.tx) } catch (error) { Object.assign(m, before); throw error }
    }); m.tail = result.catch(() => {}); return result
  })
  m.validate.mockImplementation(async (input: Row) => {
    m.compilation.validation = { ...object(m.compilation.validation), independentCheck: 'complete', continuityCriticResponse: input.continuityCriticResponse }
    return { independentCheck: 'complete', errorCount: 0, warningCount: 0 }
  })
  m.commit.mockImplementation(async () => {
    const candidate = inspectContinuityV4(m.response!.content, { manifest: (object(object(m.compilation.validation).continuityCriticResponse).continuityV4 as { frozen: Parameters<typeof inspectContinuityV4>[1] }).frozen.manifest,
      ...(object(object(m.compilation.validation).continuityCriticResponse).continuityV4 as { frozen: Parameters<typeof inspectContinuityV4>[1] }).frozen })
    if (!candidate.terminalReview?.factCoverage?.complete) return { outcome: 'failed', failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' }
    m.compilation.status = 'completed'; return { requiredResult: { targetId: 'chapter', contentHash: 'hash' } }
  })
  m.finish.mockImplementation(async (_subject, _signal, assertOwner: (tx: Prisma.TransactionClient) => Promise<void>) => {
    await m.transaction(assertOwner); m.run.status = 'completed'; return true
  })
  m.generate.mockImplementation(async (_system: string, _content: string, options: Parameters<typeof import('../../api/lib/ai-service.js').generateTextCompletion>[2]) => {
    const { record } = beginTextRequest('new-usage')
    m.usage.push({ id: 'new-usage', userId: 'user', novelId: 'novel', agentRunId: 'run', ...price, chapterId: 'chapter', targetId: 'compilation', targetType: 'story_compilation', action: 'agent3ContinuityCritic', requestTokens: null, responseTokens: null,
      usageSource: 'prepared', billingStatus: 'authorized_pending', reservedCreditMilli: 0 })
    await options.authorizedRequest!.beforeDispatch(); await options.beforeProviderDispatch!('new-usage')
    m.physical(); await m.pause?.()
    const paid = m.usage.find(row => row.id === 'new-usage')!
    Object.assign(paid, { requestTokens: m.unknown ? null : 100, responseTokens: m.unknown ? null : 10, usageSource: m.unknown ? 'unknown' : 'reported', billingStatus: m.unknown ? 'pending_usage' : 'settled' })
    if (m.cancel) { getActiveRun('run')!.controller.abort(); m.run.status = 'paused' }
    if (m.sourceDrift) m.source = { ...m.source, content: 'Changed source.' }
    if (m.omitResponse) throw Error('unknown provider outcome')
    const raw = m.invalid ? '{invalid' : JSON.stringify(m.wire)
    options.onObservedCompletion!({ usageId: 'new-usage', content: raw, finishReason: 'stop', toolCalls: [] })
    record.status = m.unknown ? 'unknown' : 'terminal'; record.billingKnown = !m.unknown
    return raw
  })
})
afterEach(async () => { await vi.waitFor(() => expect(getActiveRun('run')).toBeUndefined()); await m.tail; deregisterActiveRun('run'); env.authSessionSecret = priorSecret })

describe('manual repair consent, durable sender and local apply recovery', () => {
  it('reads eligibility and quotes without provider, admission, wallet or body mutations', async () => {
    const before = snapshots(), preview = await readManualReviewRepair('user', 'run'), quote = await quoteManualReviewRepair('user', 'run')
    expect(preview.eligible).toBe(true); expect(quote.maxProviderDispatches).toBe(1); expect(quote.model.modelName).toBe('fixture-model')
    expect(quote.maximumCreditMilli).toBeGreaterThan(0); expect(snapshots()).toBe(before); expect(m.events).toHaveLength(1)
    expect(m.generate).not.toHaveBeenCalled(); expect(quote.quoteToken).not.toContain('fixture-key')
  })
  it('dispatches exactly once for concurrent duplicate intent, preserves all original claims, fees and consumed decision, then commits normally', async () => {
    const before = snapshots(), quote = await quoteManualReviewRepair('user', 'run'), intent = { intent: 'repair_failed_review_once' as const, quoteToken: quote.quoteToken }
    await Promise.all([submitManualReviewRepair('user', 'run', intent), submitManualReviewRepair('user', 'run', intent)])
    expect((await settled()).status).toMatchObject({ state: 'complete', terminalCommitted: true, eventStartSeq: 80 })
    expect(m.physical).toHaveBeenCalledOnce(); expect(m.generate).toHaveBeenCalledOnce(); expect(m.commit).toHaveBeenCalledOnce(); expect(m.finish).toHaveBeenCalledOnce()
    expect(snapshots()).toBe(before); expect(m.run.usage).toMatchObject({ promptTokens: 600, completionTokens: 110, totalTokens: 710 })
    await submitManualReviewRepair('user', 'run', intent); expect(m.physical).toHaveBeenCalledOnce()
  })
  it.each(['invalid', 'cancel', 'unknown', 'omitResponse'] as const)('preserves %s evidence and consumes at most one physical request without a format repair', async kind => {
    m[kind] = true
    const before = snapshots(), quote = await quoteManualReviewRepair('user', 'run'), input = { intent: 'repair_failed_review_once' as const, quoteToken: quote.quoteToken }
    await submitManualReviewRepair('user', 'run', input)
    const result = await settled(); expect(result.status?.state).not.toBe('complete')
    if (kind !== 'cancel') expect(result.status?.canResume).not.toBe(true)
    expect(m.physical).toHaveBeenCalledOnce(); expect(m.commit).not.toHaveBeenCalled(); expect(snapshots()).toBe(before)
    const afterStopped = JSON.stringify({ run: m.run, compilation: m.compilation, events: m.events })
    await submitManualReviewRepair('user', 'run', input); expect(m.physical).toHaveBeenCalledOnce()
    expect(JSON.stringify({ run: m.run, compilation: m.compilation, events: m.events })).toBe(afterStopped)
    if (kind !== 'unknown') expect(m.run.usage).toMatchObject({ promptTokens: 600, completionTokens: 110, totalTokens: 710 })
  })
  it('keeps coverage UNKNOWN and old emotion pending, without claiming a chapter commit', async () => {
    m.wire.terminalDispositions = (m.wire.terminalDispositions as Row[]).map(row => ({ obligationIndex: row.obligationIndex, outcome: 'unknown', reason: 'No independently established mapping.', sourceEvidence: [] }))
    const quote = await quoteManualReviewRepair('user', 'run')
    await submitManualReviewRepair('user', 'run', { intent: 'repair_failed_review_once', quoteToken: quote.quoteToken })
    expect((await settled()).status).toMatchObject({ state: 'incomplete', terminalCommitted: false })
    expect((await readManualReviewRepair('user', 'run')).status?.canResume).not.toBe(true)
    expect(object(m.compilation.validation).independentCheck).toBe('complete')
    expect(object(object(m.compilation.validation).continuityCriticResponse).parserVersion).toBe(9)
    expect(object(m.compilation.preparedContext).terminalProposalReview).toBeDefined()
    expect(m.physical).toHaveBeenCalledOnce(); expect(m.finish).not.toHaveBeenCalled()
  })
  it.each(['pending-review', 'provider-unknown', 'review-fee-unknown', 'foreign-target'] as const)('blocks %s before a new authorization or provider', async kind => {
    if (kind === 'pending-review') object(object(m.run.usage).checkpoint).pendingReviews = [{ compilationId: 'compilation', chapterId: 'chapter', revision: 4, toolName: 'quality_analyze', callId: 'pending' }]
    if (kind === 'provider-unknown') m.pendingProvider = 1
    if (kind === 'review-fee-unknown') Object.assign(m.usage[0], { usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null })
    if (kind === 'foreign-target') m.scopeWrong = true
    expect((await readManualReviewRepair('user', 'run')).eligible).toBe(false)
    await expect(quoteManualReviewRepair('user', 'run')).rejects.toMatchObject({ code: 'MANUAL_REVIEW_REPAIR_REFUSED' })
    expect(m.physical).not.toHaveBeenCalled(); expect(m.events).toHaveLength(1)
  })
  it('preserves an already authenticated historical retirement as unknown without granting a resend of that old request', async () => {
    m.usage.push({ ...m.usage[0], id: 'retired-old-usage', usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null })
    m.retired = ['retired-old-usage']
    const before = structuredClone(m.usage)
    expect((await readManualReviewRepair('user', 'run')).eligible).toBe(true)
    expect(m.usage).toEqual(before); expect(m.generate).not.toHaveBeenCalled()
  })
  it('reconciles an authenticated known raw after a crash before report application, with a fresh readonly recovery token and zero further providers', async () => {
    m.validate.mockRejectedValueOnce(Error('simulated crash before atomic apply'))
    const before = snapshots(), quote = await quoteManualReviewRepair('user', 'run')
    await submitManualReviewRepair('user', 'run', { intent: 'repair_failed_review_once', quoteToken: quote.quoteToken })
    expect((await settled()).status?.canResume).toBe(true)
    const recovery = await quoteManualReviewRepair('user', 'run')
    expect(recovery).toMatchObject({ operationId: quote.operationId, recoveryOnly: true, maximumCreditMilli: 0, maxProviderDispatches: 0 })
    await submitManualReviewRepair('user', 'run', { intent: 'repair_failed_review_once', quoteToken: recovery.quoteToken })
    expect((await settled()).status).toMatchObject({ state: 'complete', terminalCommitted: true })
    expect(m.physical).toHaveBeenCalledOnce(); expect(snapshots()).toBe(before)
    expect(m.run.usage).toMatchObject({ promptTokens: 600, completionTokens: 110, totalTokens: 710 })
    expect(m.events.filter(row => row.type === 'review.manual_repair.usage_accounted')).toHaveLength(1)
  })
  it('records immutable per-owner recovery outcomes when two local apply attempts fail before a later attempt succeeds', async () => {
    m.validate.mockRejectedValueOnce(Error('crash before report')).mockRejectedValueOnce(Error('first local apply interrupted'))
    const quote = await quoteManualReviewRepair('user', 'run'), input = { intent: 'repair_failed_review_once' as const, quoteToken: quote.quoteToken }
    await submitManualReviewRepair('user', 'run', input); expect((await settled()).status?.canResume).toBe(true)
    const firstRecovery = await quoteManualReviewRepair('user', 'run')
    await submitManualReviewRepair('user', 'run', { ...input, quoteToken: firstRecovery.quoteToken }); expect((await settled()).status?.canResume).toBe(true)
    const secondRecovery = await quoteManualReviewRepair('user', 'run')
    await submitManualReviewRepair('user', 'run', { ...input, quoteToken: secondRecovery.quoteToken }); expect((await settled()).status?.state).toBe('complete')
    expect(m.physical).toHaveBeenCalledOnce()
    const outcomes = m.events.filter(row => String(row.type).startsWith('review.manual_repair.finished_'))
    expect(outcomes).toHaveLength(3); expect(new Set(outcomes.map(row => row.id)).size).toBe(3)
    expect(m.events.filter(row => row.type === 'review.manual_repair.usage_accounted')).toHaveLength(1)
  })
  it('requires a fresh purpose-bound zero-provider action after cancellation; a late paid-intent replay remains read-only', async () => {
    m.cancel = true
    const quote = await quoteManualReviewRepair('user', 'run'), paidIntent = { intent: 'repair_failed_review_once' as const, quoteToken: quote.quoteToken }
    await submitManualReviewRepair('user', 'run', paidIntent); expect((await settled()).status?.canResume).toBe(true)
    const before = JSON.stringify({ run: m.run, compilation: m.compilation, events: m.events })
    await submitManualReviewRepair('user', 'run', paidIntent)
    expect(JSON.stringify({ run: m.run, compilation: m.compilation, events: m.events })).toBe(before)
    expect(m.commit).not.toHaveBeenCalled()
    const recovery = await quoteManualReviewRepair('user', 'run')
    expect(JSON.parse(Buffer.from(recovery.quoteToken.split('.')[0], 'base64url').toString('utf8')).mode).toBe('apply_known_result')
    await submitManualReviewRepair('user', 'run', { ...paidIntent, quoteToken: recovery.quoteToken })
    expect((await settled()).status?.state).toBe('complete'); expect(m.physical).toHaveBeenCalledOnce()
  })
  it.each(['expired', 'control-changed'] as const)('rejects a %s local recovery token without another sender or write owner', async kind => {
    m.validate.mockRejectedValueOnce(Error('interrupted apply'))
    const quote = await quoteManualReviewRepair('user', 'run')
    await submitManualReviewRepair('user', 'run', { intent: 'repair_failed_review_once', quoteToken: quote.quoteToken }); await settled()
    const recovery = await quoteManualReviewRepair('user', 'run')
    let token = recovery.quoteToken
    if (kind === 'expired') {
      const value = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Row; value.expiresAt = Date.now() - 1
      const encoded = Buffer.from(JSON.stringify(value)).toString('base64url'); token = `${encoded}.${createHmac('sha256', secret).update(`manual-review-repair-once-v1.${encoded}`).digest('hex')}`
    } else m.events.push({ id: 'later-author-stop', runId: 'run', seq: Number(m.events.at(-1)!.seq) + 1, type: 'run.paused', payload: { reason: 'user_stop' } })
    const before = JSON.stringify({ run: m.run, compilation: m.compilation, events: m.events })
    await expect(submitManualReviewRepair('user', 'run', { intent: 'repair_failed_review_once', quoteToken: token })).rejects.toMatchObject({ code: 'MANUAL_REVIEW_REPAIR_REFUSED' })
    expect(JSON.stringify({ run: m.run, compilation: m.compilation, events: m.events })).toBe(before)
    expect(m.physical).toHaveBeenCalledOnce()
  })
  it('reads actual completed delivery after a crash before the ancillary operation outcome without resending', async () => {
    const quote = await quoteManualReviewRepair('user', 'run')
    await submitManualReviewRepair('user', 'run', { intent: 'repair_failed_review_once', quoteToken: quote.quoteToken })
    expect((await settled()).status?.state).toBe('complete')
    m.events = m.events.filter(row => !String(row.type).startsWith('review.manual_repair.finished_'))
    expect((await readManualReviewRepair('user', 'run')).status).toMatchObject({ state: 'complete', terminalCommitted: true })
    expect(m.physical).toHaveBeenCalledOnce()
  })
  it('runs the persisted owner fence inside the final terminal callback and rejects a late old owner before any completion write', async () => {
    m.finish.mockImplementationOnce(async (_subject, _signal, assertOwner: (tx: Prisma.TransactionClient) => Promise<void>) => {
      const owner = m.events.findLast(row => row.type === 'review.manual_repair.owner')!
      m.events.push({ ...owner, id: 'new-owner', seq: Number(owner.seq) + 100 })
      await m.transaction(assertOwner)
      m.run.status = 'completed'
      return true
    })
    const quote = await quoteManualReviewRepair('user', 'run')
    await submitManualReviewRepair('user', 'run', { intent: 'repair_failed_review_once', quoteToken: quote.quoteToken })
    await settled()
    expect(m.run.status).not.toBe('completed'); expect(m.physical).toHaveBeenCalledOnce()
    expect(m.events.filter(row => String(row.type).startsWith('review.manual_repair.finished_'))).toHaveLength(0)
  })
  it.each(['intent', 'forged', 'expired', 'actor', 'price', 'model', 'body'] as const)('refuses %s drift without paid dispatch', async kind => {
    const quote = await quoteManualReviewRepair('user', 'run')
    let token = quote.quoteToken
    if (kind === 'forged') token = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    if (kind === 'expired') {
      const value = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Row; value.expiresAt = Date.now() - 1
      const encoded = Buffer.from(JSON.stringify(value)).toString('base64url'); token = `${encoded}.${createHmac('sha256', secret).update(`manual-review-repair-once-v1.${encoded}`).digest('hex')}`
    }
    if (kind === 'price') object(m.usage[0].billingSnapshot).multiplierBps = 9999
    if (kind === 'model') m.runtime.mockResolvedValue({ ...(await m.runtime()), modelName: 'other-model' })
    if (kind === 'body') object(m.compilation.chapter).content = 'Changed body.'
    await expect(submitManualReviewRepair(kind === 'actor' ? 'other-user' : 'user', 'run', { intent: kind === 'intent' ? 'continue' as never : 'repair_failed_review_once', quoteToken: token })).rejects.toBeDefined()
    expect(m.physical).not.toHaveBeenCalled(); expect(m.events).toHaveLength(1)
  })
})
