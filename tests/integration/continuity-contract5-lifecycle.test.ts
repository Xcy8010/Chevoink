import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { handleToolCall } from '../../api/lib/agent/loop.js'
import { freezeWritingScope, bindWritingChapter, readCompletedWritingPresentation } from '../../api/lib/agent/writing-scope.js'
import { withHumanAdmission, readHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { readQualityReviewAdmission } from '../../api/lib/agent/quality-review-admission.js'
import { RunEventBus, loadPersistedEvents } from '../../api/lib/agent/events.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import type { ContinuityReport } from '../../api/lib/agent/continuity-review.js'

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0]
const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 15000, provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
  reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 }
const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'contract5-fixture',
  rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
const completion = (content: string) => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 8 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const owner = (f: Fixture, seq: number) => async (tx: Prisma.TransactionClient) => {
  const run = await tx.agentRun.findFirst({ where: { id: f.runId, userId: f.userId, novelId: f.novelId, status: 'running' } })
  const latest = await tx.agentRunEvent.findFirst({ where: { runId: f.runId, type: 'run.started' }, orderBy: { seq: 'desc' } })
  if (!run || latest?.seq !== seq) throw new DataAccessError(409, 'RUNTIME_OWNER_CHANGED', '原执行已停止或归属变化。')
}
async function setup(f: Fixture, prompt: string, content: string, revision = 4) {
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', taskRootId: null, runtimeProtocolVersion: 0,
    startRequest: runtimeJson(withHumanAdmission({ prompt, sessionId: f.sessionId, novelId: f.novelId, mode: 'build' })).value } })
  await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.started', payload: {} } })
  const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision, wordCount: content.length } })
  const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: prompt })
  await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Record', entryState: state, goal: 'Record', obstacle: 'Delay',
    choice: 'Record', cost: 'Time', turn: 'Recorded', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
  vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue(price)
  vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
  const window = credits.getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
  const controller = new AbortController()
  const ctx: ToolContext = { ...f, callId: 'current-review', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
    modelRuntime: runtime, signal: controller.signal, emit: () => {}, assertCurrentExecution: owner(f, 1) }
  return { chapter, compilation, ctx, controller }
}
function sources(init: RequestInit) {
  const request = JSON.parse(String(init.body)), content = JSON.parse(request.messages[1].content)
  const current = content.sources.find((source: { source: string }) => source.source === 'current')
  const id = /^q[a-f0-9]{12}/m.exec(current.evidence)?.[0]
  if (!id) throw Error('Synthetic provider must select a source actually shown in this request')
  return { request, current, id }
}
async function report(compilationId: string) {
  return (await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation as { continuityReport: ContinuityReport }
}
async function quality(f: Fixture, compilationId: string, revision: number) {
  await persistHumanityQualityReport({ ...f, compilationId, chapterId: f.chapterId, chapterRevision: revision, mode: 'balanced',
    criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
}

describe.runIf(available)('ordinary continuity reports preserve frozen contract5 history and real billing', () => {
  it('preserves a failed known body pair through eight real edits, current-version recheck and one actual commit', () => fixture(async f => {
    const prompt = '写第一章', content = Array.from({ length: 8 }, (_, i) => 'Entry ' + i + ' remains pending.').join(' ')
    const old = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await prisma.$transaction(async tx => {
      await tx.chapter.delete({ where: { id: old.id } })
      f.spec = await freezeWritingScope(tx, f, f.spec, prompt)
      expect(f.spec.scope.writing).toMatchObject({ kind: 'bounded', targets: [{ chapterId: null, orderIndex: 1 }] })
      await tx.agentRun.update({ where: { id: f.runId }, data: { taskSpec: runtimeJson(f.spec).value, chapterId: null } })
      await tx.chapter.create({ data: { id: old.id, authorId: f.userId, novelId: f.novelId, volumeId: old.volumeId, title: old.title,
        orderIndex: 1, orderInVolume: 1, content, wordCount: content.length, revision: 3 } })
      await bindWritingChapter(tx, f, 1, old.id)
      await tx.agentRun.update({ where: { id: f.runId }, data: { chapterId: old.id } })
    })
    const s = await setup(f, prompt, content, 3), args = { compilationId: s.compilation.id }
    const admitted = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(readHumanAdmission(admitted.startRequest)).toMatchObject({ request: { prompt, sessionId: f.sessionId, novelId: f.novelId, mode: 'build' } })
    expect(await prisma.$transaction(tx => readQualityReviewAdmission(tx, admitted))).toMatchObject({ id: 'author-message:' + f.sourceMessageId })
    let sends = 0
    const network = vi.fn(async (_url: unknown, init: RequestInit) => {
      sends++
      if (sends === 1) {
        const { request } = sources(init)
        expect(request.messages[0].content).toContain('sourceId')
        return completion(JSON.stringify({ findings: [{ signal: 'object', severity: 'error', explanation: 'The records need inspection.',
          suggestion: 'Check the pending records.', evidence: [{ sourceId: 'q000000000000' }] }] }))
      }
      return completion(sends === 2 ? '{"corrections":[]}' : '{"findings":[]}')
    }); vi.stubGlobal('fetch', network)
    const bus = new RunEventBus(f.runId, 1)
    try {
      expect(await handleToolCall({ id: 'failed-body', name: 'continuity_validate', arguments: JSON.stringify(args) },
        [continuityValidateTool], { ...s.ctx, callId: 'failed-body' }, bus, 'failed-body-message', f.runId, undefined, () => bus.persist()))
        .toMatchObject({ failureCode: 'CONTINUITY_REPORT_INCOMPLETE', part: { status: 'failed' } })
    } finally { await bus.close() }
    expect((await loadPersistedEvents(f.runId, 1)).filter(event => event.type === 'tool.result'))
      .toMatchObject([{ toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_REPORT_INCOMPLETE' }])
    const failed = (await report(s.compilation.id)).continuityReport
    expect(failed).toMatchObject({ complete: false, billingKnown: true, unlocatedIndexes: [0] })
    expect(failed.rawResponses).toHaveLength(2); expect(failed.opinions).toHaveLength(1)
    const oldFees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const oldLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const oldArtifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    expect(oldFees).toHaveLength(2); expect(oldLedger).toHaveLength(2)
    const patches = Array.from({ length: 8 }, (_, i) => ({ oldText: 'Entry ' + i + ' remains pending.', newText: 'Entry ' + i + ' remains recorded.' }))
    expect(await chapterEditRangeTool.execute({ ...s.ctx, callId: 'eight-real-edits' }, { chapterId: old.id, patches })).not.toMatchObject({ outcome: 'failed' })
    const revised = await prisma.chapter.findUniqueOrThrow({ where: { id: old.id } })
    expect(revised).toMatchObject({ revision: 4, content: patches.map(patch => patch.newText).join(' ') })
    expect(await continuityValidateTool.execute({ ...s.ctx, callId: 'current-version-check' }, args)).toMatchObject({ reviewCompleted: true })
    expect(await continuityValidateTool.execute({ ...s.ctx, callId: 'same-current-cache' }, args)).toMatchObject({ reviewCompleted: true })
    await quality(f, s.compilation.id, 4)
    expect(await chapterBridgeCommitTool.execute({ ...s.ctx, callId: 'one-real-commit' }, args)).not.toMatchObject({ outcome: 'failed' })
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).toMatchObject({ targetRevision: 4, committedAt: expect.any(Date) })
    expect(await prisma.$transaction(tx => readCompletedWritingPresentation(tx, f))).not.toBeNull()
    expect(network).toHaveBeenCalledTimes(3)
    expect(await prisma.aiUsageLog.findMany({ where: { id: { in: oldFees.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(oldFees)
    expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: oldLedger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(oldLedger)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: oldArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(oldArtifacts)
    expect((await prisma.agentArtifact.findMany({ where: { runId: f.runId } })).some(row =>
      !!(row.metadata as Record<string, unknown>).continuityPhaseClaim)).toBe(false)
  }, undefined, '写第一章', { continuityEvidenceProtocol: 1, continuityReportProtocol: 5, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)

  it.each(['complete', 'normalized-cross-chunk', 'preserved-canonical', 'typed-sparse-repair', 'repaired-background', 'single-background',
    'recovered-failed-background', 'unknown', 'applied-typed-error', 'merged-revision', 'spent-revision', 'cancel-known-raw', 'wrong-owner',
    'body-only-first-terminal', 'body-only-unknown', 'body-only-old-local-refusal', 'body-only-with-obligation'] as const)(
    '%s preserves author scope, sources and the original V2 price through the current report path', scenario => fixture(async f => {
      const prompt = '修改第一章，只输出标题和正文', auto = scenario === 'merged-revision' || scenario === 'spent-revision'
      const broken = 'The packet is sealed.\n\nThe packet is open.', fixed = 'The packet is sealed.\n\nThe guard keeps the packet sealed.'
      const content = auto || scenario === 'applied-typed-error' ? broken : scenario === 'normalized-cross-chunk'
        ? 'x'.repeat(290) + 'The sealed packet remains with the guard.' : 'The sealed packet remains with the guard.'
      const s = await setup(f, prompt, content), args = { compilationId: s.compilation.id }
      if (!auto) s.ctx.sandboxMode = 'read_only'
      let previous: Awaited<ReturnType<typeof prisma.chapter.create>> | undefined
      if (['preserved-canonical', 'repaired-background', 'single-background', 'recovered-failed-background', 'body-only-with-obligation'].includes(scenario))
        previous = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: s.chapter.volumeId,
          orderIndex: 0, orderInVolume: 0, title: 'Synthetic predecessor', revision: 2, content: 'The guard remembers an unresolved earlier address.' } })
      const history = { parserVersion: 10, responseContract: 5, classification: 'projection_invalid', rawResponse: { content: JSON.stringify('{"findings":[]}') },
        checkRounds: 3, autoRepairRounds: 1, newDraftRevision: { checkedRevision: 3, afterHash: 'a'.repeat(64) }, uncertainty: ['An unresolved earlier address.'] }
      const old = await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId, artifactType: 'continuityReview', title: 'Immutable original report', metadata: runtimeJson(history).value } })
      await prisma.storyCompilation.update({ where: { id: s.compilation.id }, data: { validation: { checkRounds: 3, autoRepairRounds: 1, oldFailure: history } } })
      if (scenario === 'body-only-old-local-refusal') await prisma.agentRunEvent.createMany({ data: [
        { runId: f.runId, seq: 2, type: 'tool.call', payload: { callId: 'old-local', toolName: 'continuity_validate', args } },
        { runId: f.runId, seq: 3, type: 'tool.result', payload: { callId: 'old-local', toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' } },
      ] })
      const requests: Array<Record<string, unknown>> = []
      const network = vi.fn(async (_url: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body)); requests.push(request)
        const system = request.messages[0].content as string
        if (scenario === 'cancel-known-raw') s.controller.abort()
        if (scenario === 'wrong-owner') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', payload: {} } })
        if (system.includes('"patches"') || system.includes('findingId')) return completion(JSON.stringify({ patches: [{ findingId: '0',
          replacement: 'The guard keeps the packet sealed.' }], retainedFindings: [] }))
        if (system.startsWith('只为原意见')) {
          const payload = JSON.parse(request.messages[1].content), catalog = payload.sources.find((row: { chapterId: string }) => row.chapterId === s.chapter.id).evidence
          const id = /^q[a-f0-9]{12}/m.exec(catalog)![0]
          return completion(JSON.stringify({ corrections: [{ index: 0, evidence: [{ sourceId: id }] }] }))
        }
        const source = sources(init)
        if (auto) source.id = source.current.evidence.split('\n').find((line: string) => line.includes('The packet is open.'))?.match(/^q[a-f0-9]{12}/)?.[0] ?? source.id
        const issue = auto && source.current.content.includes('The packet is open.') || scenario === 'applied-typed-error'
          || ['typed-sparse-repair', 'recovered-failed-background'].includes(scenario)
        const opinion = { signal: 'object', severity: 'error', explanation: 'The saved packet states require a concrete decision.',
          suggestion: 'Keep the packet sealed in the saved scene.', evidence: [{ sourceId: ['typed-sparse-repair', 'recovered-failed-background'].includes(scenario) ? 'q000000000000' : source.id }] }
        if (scenario === 'repaired-background' && requests.length === 1) return completion('{broken')
        return completion(JSON.stringify({ findings: issue ? [opinion] : [] }))
      }); vi.stubGlobal('fetch', network)
      if (scenario === 'cancel-known-raw' || scenario === 'wrong-owner') {
        await expect(continuityValidateTool.execute(s.ctx, args)).rejects.toBeDefined()
        const artifact = await prisma.agentArtifact.findFirstOrThrow({ where: { runId: f.runId, artifactType: 'continuityReview',
          metadata: { path: ['continuityReport', 'chapterId'], equals: s.chapter.id } } })
        expect((artifact.metadata as { continuityReport: ContinuityReport }).continuityReport.rawResponses).toHaveLength(1)
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: s.chapter.id } })).toEqual(s.chapter)
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).committedAt).toBeNull()
      } else {
        const checked = await continuityValidateTool.execute(s.ctx, args)
        expect(checked).not.toMatchObject({ outcome: 'failed' })
        if (auto) {
          expect(await prisma.chapter.findUniqueOrThrow({ where: { id: s.chapter.id } })).toMatchObject({ revision: 5, content: fixed })
          expect(checked.reviewCompleted).toBe(false)
          expect(await continuityValidateTool.execute({ ...s.ctx, callId: 'final-current-check', sandboxMode: 'read_only' }, args)).toMatchObject({ reviewCompleted: true })
        } else expect(checked.reviewCompleted).toBe(true)
        const current = await prisma.chapter.findUniqueOrThrow({ where: { id: s.chapter.id } }), saved = (await report(s.compilation.id)).continuityReport
        expect(saved).toMatchObject({ revision: current.revision, complete: true, billingKnown: true })
        if (previous) expect(saved.sourceVersions).toEqual(expect.arrayContaining([{ chapterId: previous.id, revision: 2,
          contentHash: expect.any(String) }]))
        const before = requests.length
        if (scenario === 'unknown' || scenario === 'body-only-unknown') {
          const fee = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId } })
          await prisma.aiUsageLog.update({ where: { id: fee.id }, data: { billingStatus: 'pending_settlement' } })
          const fees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
          await expect(continuityValidateTool.execute({ ...s.ctx, callId: 'unknown-no-redispatch' }, args)).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
          expect(requests).toHaveLength(before)
          expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(fees)
          expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).committedAt).toBeNull()
          return
        }
        expect(await continuityValidateTool.execute({ ...s.ctx, callId: 'cached-current' }, args)).toMatchObject({ reviewCompleted: true })
        expect(requests).toHaveLength(before)
        await quality(f, s.compilation.id, current.revision)
        const commit = await chapterBridgeCommitTool.execute({ ...s.ctx, callId: 'commit-current', sandboxMode: undefined }, args)
        if (saved.findings.length) {
          expect(commit).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_ERRORS_REMAIN' })
          expect(commit.output).toContain(saved.id)
          expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: s.compilation.id } })).committedAt).toBeNull()
        } else {
          expect(commit).not.toMatchObject({ outcome: 'failed' })
          expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, s.compilation.id))).toMatchObject({ terminalCommitted: true })
          const complete = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: s.compilation.id } })
          expect(complete.preparedContext).not.toHaveProperty('terminalFactProofs')
        }
        expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old)
      }
      const fees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })
      expect(fees).toHaveLength(requests.length)
      expect(fees.every(row => row.billingStatus === 'settled' && row.usageSource === 'reported' && row.reservedCreditMilli === 0)).toBe(true)
      expect(fees[0]).toMatchObject({ multiplierBps: 15000, billingSnapshot: price })
      expect(requests.every(request => request.model === 'fixture')).toBe(true)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(requests.length)
      if (!auto) expect(await prisma.chapter.findUniqueOrThrow({ where: { id: s.chapter.id } })).toEqual(s.chapter)
    }, undefined, '修改第一章，只输出标题和正文', { freezeWriting: true, continuityEvidenceProtocol: 1, continuityReportProtocol: 5,
      terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
