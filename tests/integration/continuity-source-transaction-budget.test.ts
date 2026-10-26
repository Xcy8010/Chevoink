import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import * as assessments from '../../api/lib/agent/assessment-response-lifecycle.js'
import * as sources from '../../api/lib/agent/compiler-continuity-source.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

type Phase = 'reservation' | 'dispatch' | 'application'
const phases: Phase[] = ['reservation', 'dispatch', 'application']
const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', multiplierBps: 10000, reasoningEffort: 'high',
  reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'transaction-budget-fixture',
  rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
const chargeMilli = priceTokenEvidence(price, 12, 8, null)
const content = 'The guard waits at the closed door. The door opens, and the guard enters.'
const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind,
  result: 'clear', reason: 'transaction-budget-whole-body: the guard enters after the door opens.', findingIndexes: [] })),
  terminalVerdicts: [], terminalProofVerdicts: [], terminalDispositions: [] })
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
    let activePhase: Phase | null = null
    const reserve = assessments.reserveLegacyContinuityAssessment
    vi.spyOn(assessments, 'reserveLegacyContinuityAssessment').mockImplementation(async (...args) => {
      activePhase = 'reservation'
      try { return await reserve(...args) } finally { activePhase = null }
    })
    const bind = assessments.bindLegacyContinuityRequest
    vi.spyOn(assessments, 'bindLegacyContinuityRequest').mockImplementation(async (...args) => {
      activePhase = 'dispatch'
      try { return await bind(...args) } finally { activePhase = null }
    })
    const readSource = sources.readCompilerContinuitySource
    const observed = new Map<Phase, number>()
    vi.spyOn(sources, 'readCompilerContinuitySource').mockImplementation(async (...args) => {
      const phase = args[0] === prisma ? null : activePhase ?? (provider.mock.calls.length ? 'application' : null)
      if (!phase || observed.has(phase)) return readSource(...args)
      expect(args[4]).toBe(11)
      observed.set(phase, 0)
      const started = performance.now()
      // The actual PostgreSQL timer remains real. This read-only query exceeds
      // Prisma's default 5 seconds before the unmodified full source reader.
      if (kind === 'slow') await args[0].$queryRaw`SELECT 1 AS complete FROM pg_sleep(5.1)`
      if (phase === affected && kind === 'changed-source') await prisma.chapter.update({ where: { id: previous.id },
        data: { content: previous.content + ' A new source event occurs.', revision: { increment: 1 } } })
      if (phase === affected && kind === 'cancelled') controller.abort(new DOMException('Synthetic cancellation', 'AbortError'))
      const result = await readSource(...args)
      observed.set(phase, performance.now() - started)
      return result
    })
    if (kind === 'slow') {
      expect(await continuityValidateTool.execute(ctx, { compilationId: compilation.id })).toMatchObject({ reviewCompleted: true })
      expect([...observed.keys()]).toEqual(phases)
      for (const elapsed of observed.values()) expect(elapsed).toBeGreaterThan(5000)
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
        continuityCriticResponse: { rawResponse: { content: JSON.stringify(raw), complete: true } } })
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({ billingSnapshot: price, usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, creditChargeMilli: chargeMilli })
      expect(ledger).toHaveLength(1)
      expect(ledger[0]).toMatchObject({ idempotencyKey: 'usage:' + payments[0].id, deltaMilli: -chargeMilli })
      const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
      expect(artifacts.filter(row => Object.hasOwn(row.metadata as object, 'continuityAssessmentRequestKey'))).toHaveLength(1)
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
        expect(artifacts.some(row => JSON.stringify(row.metadata).includes('transaction-budget-whole-body'))).toBe(true)
      }
    }
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ content, revision: chapter.revision })
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toMatchObject({ committedAt: null })
  }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 60000)
})
