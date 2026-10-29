import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

type Phase = 'registration' | 'dispatch' | 'application'
const phases: Phase[] = ['registration', 'dispatch', 'application']
const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', multiplierBps: 10000, reasoningEffort: 'high',
  reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'transaction-budget-fixture',
  rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
const chargeMilli = priceTokenEvidence(price, 12, 8, null)
const content = 'The guard waits at the closed door. The door opens, and the guard enters.'
const raw = JSON.stringify({ findings: [] })
const cases = [{ kind: 'slow' as const, phase: null }, ...phases.flatMap(phase =>
  (['changed-source', 'cancelled'] as const).map(kind => ({ kind, phase })))]

describe.runIf(available)('full continuity source authentication uses the operation transaction budget', () => {
  it.each(cases)('$kind at $phase preserves source guards and unique provider settlement', ({ kind, phase: affected }) => fixture(async f => {
    const controller = new AbortController()
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running', startRequest: { prompt: '修改本章' } } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 4, wordCount: content.length, orderIndex: 2, orderInVolume: 2 } })
    const previous = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId,
      title: 'Synthetic previous chapter', orderIndex: 1, orderInVolume: 1, revision: 1, content: 'The guard waits outside the closed door.' } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Synthetic complete source authentication.' })
    const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Enter', entryState: state, goal: 'Pass the door', obstacle: 'Closed door',
      choice: 'Wait', cost: 'Time', turn: 'Door opens', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 1000000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue(price)
    const ctx: ToolContext = { ...f, chapterId: chapter.id, callId: 'source-budget', modelRuntime: runtime, signal: controller.signal,
      mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {} }
    const provider = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } })))
    vi.stubGlobal('fetch', provider)
    const observed = new Map<Phase, number>()
    let fences = 0
    ctx.assertCurrentExecution = async db => {
      // Registration and dispatch fence on the root client. Only the actual
      // report-binding transaction is the application boundary; additional
      // pre-dispatch source checks must not be mistaken for a transaction.
      const phase: Phase = db !== prisma ? 'application' : fences++ === 0 ? 'registration' : 'dispatch'
      if (observed.has(phase)) return
      observed.set(phase, 0)
      const started = performance.now()
      // The real report-binding transaction retains the existing 20s operation
      // budget. Model/network work remains outside this transaction.
      if (phase === 'application') {
        expect(db).not.toBe(prisma)
        if (kind === 'slow') await db.$queryRaw`SELECT 1 AS complete FROM pg_sleep(5.1)`
      }
      if (phase === affected && kind === 'changed-source') await prisma.chapter.update({ where: { id: previous.id },
        data: { content: previous.content + ' A new source event occurs.', revision: { increment: 1 } } })
      if (phase === affected && kind === 'cancelled') controller.abort(new DOMException('Synthetic cancellation', 'AbortError'))
      observed.set(phase, performance.now() - started)
    }
    if (kind === 'slow') {
      expect(await continuityValidateTool.execute(ctx, { compilationId: compilation.id })).toMatchObject({ reviewCompleted: true })
      expect([...observed.keys()]).toEqual(phases)
      expect(observed.get('application')).toBeGreaterThan(5000)
    } else {
      const result = continuityValidateTool.execute(ctx, { compilationId: compilation.id })
      if (kind === 'changed-source') await expect(result).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
      else await expect(result).rejects.toThrow()
      expect(observed.has(affected!)).toBe(true)
    }
    const expectedRequests = kind === 'slow' || affected === 'application' ? 1 : 0
    expect(provider).toHaveBeenCalledTimes(expectedRequests)
    const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(payments.reduce((sum, row) => sum + row.creditChargeMilli, 0)).toBe(expectedRequests * chargeMilli)
    expect(ledger.reduce((sum, row) => sum - row.deltaMilli, 0)).toBe(expectedRequests * chargeMilli)
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    if (kind === 'slow') {
      expect(saved.validation).toMatchObject({ independentCheck: 'complete', checkedRevision: chapter.revision,
        continuityReport: { complete: true, rawResponses: [raw] } })
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({ billingSnapshot: price, usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, creditChargeMilli: chargeMilli })
      expect(ledger).toHaveLength(1)
      expect(ledger[0]).toMatchObject({ idempotencyKey: 'usage:' + payments[0].id, deltaMilli: -chargeMilli })
      const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
      expect(artifacts.filter(row => row.artifactType === 'continuityReview')).toHaveLength(1)
      expect(await continuityValidateTool.execute({ ...ctx, callId: 'same-source-repeat' }, { compilationId: compilation.id })).toMatchObject({ reviewCompleted: true })
      expect(provider).toHaveBeenCalledOnce()
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(payments)
      expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
      expect(await prisma.agentArtifact.findMany({ where: { id: { in: artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(artifacts)
    } else {
      expect(saved.validation).not.toMatchObject({ independentCheck: 'complete' })
      if (expectedRequests) {
        expect(payments).toHaveLength(1)
        expect(ledger).toHaveLength(1)
        const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId } })
        expect(artifacts.some(row => JSON.stringify(row.metadata).includes(JSON.stringify(raw)))).toBe(true)
      }
    }
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ content, revision: chapter.revision })
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toMatchObject({ committedAt: null })
  }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 60000)
})
