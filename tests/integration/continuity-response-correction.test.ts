import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as tokenPrices from '../../api/lib/billing/resolve-token-price.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterBridgeGetTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { readHistoricalStandaloneContinuityContext, standaloneContinuityBindingHash } from '../../api/lib/agent/continuity-history.js'
import { buildContinuitySnapshot, reviewContinuity, type ContinuityReport } from '../../api/lib/agent/continuity-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as correctionsModule from '../../api/lib/agent/continuity-response-correction.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { executePreparedContinuityWork } from '../../api/lib/agent/tools/durable-continuity.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'low', 'high'],
  reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const body = '门开着。门锁着。'
const finding = { signal: 'object', severity: 'error', evidence: '同一时刻门状态互斥。', suggestion: '按实际情况统一门状态。', sourceEvidence: [
  { source: 'current', segmentId: 'c0', quote: '门开着' }, { source: 'current', segmentId: 'c0', quote: '不在正文的引用' },
] }
const raw = JSON.stringify({ findings: [finding] })
const correction = JSON.stringify({ corrections: [{ index: 0, sourceEvidence: [
  { source: 'current', segmentId: 'c0', quote: '门开着' }, { source: 'current', segmentId: 'c0', quote: '门锁着' },
] }] })
type Fixture = Parameters<Parameters<typeof fixture>[0]>[0]
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

/** Immutable pre-refactor data, read by the production history readers only.
 * No retired claim/observation producer or applied marker is executed. */
async function frozenCorrection(f: Fixture, input: { chapterId: string; revision: number; targetType?: 'chapter' | 'story_compilation'; targetId?: string;
  bindingHash?: string; response?: string; finishReason?: string; unknown?: boolean; reserved?: boolean; knownZero?: boolean; observe?: boolean }) {
  const bodies = { previous: null, current: body }, interpretation = inspectContinuityResponse(raw, bodies, true, 5)
  const targetType = input.targetType ?? 'chapter', targetId = input.targetId ?? input.chapterId
  const usageData = { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: input.chapterId, targetType, targetId,
    providerType: 'text' as const, providerMode: 'custom' as const, modelName: 'original-fixture', multiplierBps: 15000, durationMs: 1,
    requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled', billingEvidence: { responseObserved: true } }
  const primary = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityCritic' } })
  const claimRow = await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId, artifactType: 'continuityReview', title: 'Frozen historical correction claim',
    metadata: runtimeJson({ version: 1, state: 'claimed', evidenceCorrectionKey: 'frozen-key', chapterId: input.chapterId, revision: input.revision,
      sourceHash: correctionsModule.continuitySourceHash(bodies), bodies, usageIds: [primary.id], original: interpretation.audit,
      interpretation: interpretation.audit, admissionId: null, callId: 'original-correction', targetType, targetId, ...(input.bindingHash ? { bindingHash: input.bindingHash } : {}) }).value } })
  const followup = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityEvidenceCorrection',
    ...(input.unknown ? { usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null } : {}),
    ...(input.reserved ? { reservedCreditMilli: 17 } : {}), ...(input.knownZero ? { requestTokens: 0, responseTokens: 0 } : {}) } })
  const content = input.response ?? correction, finishReason = input.finishReason ?? 'stop'
  const observation = input.observe === false ? null : await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId,
    artifactType: 'continuityReview', title: 'Frozen historical correction bytes', metadata: runtimeJson({ version: 1,
      correctionClaimId: claimRow.id, correctionClaimKey: 'frozen-key', contentHash: sha(content), sourceHash: correctionsModule.continuitySourceHash(bodies),
      usageIds: [followup.id], finishReason, toolCallsPresent: false, rawResponse: { version: 1, encoding: 'json-string', content: JSON.stringify(content), complete: finishReason === 'stop' } }).value } })
  return { claimRow, observation, primary, followup, bodies, interpretation }
}
async function preserve(f: Fixture) {
  const rows = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
  const fees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
  const chapters = await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })
  return async () => {
    for (const row of rows) expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(fees)
    expect(await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })).toEqual(chapters)
  }
}

describe.runIf(available)('continuity evidence correction actual PostgreSQL effects', () => {
  it.each(['legacy', 'durable', 'native-work7'] as const)('%s applies the same exact report policy through actual tools', path => fixture(async f => {
    try {
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length } })
      if (path === 'legacy') await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '核对本章' })
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '开门', entryState: state, goal: '通过', obstacle: '门锁',
        choice: '等待', cost: '时间', turn: '等候', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const window = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      let sends = 0, currentSourceId = ''
      const opinion = { signal: 'object', severity: 'error', explanation: finding.evidence, suggestion: finding.suggestion, evidence: [{ sourceId: 'q000000000000' }] }
      const currentRaw = JSON.stringify({ findings: [opinion] })
      const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        sends++
        const request = JSON.parse(String(init.body))
        expect(request.model).toBe('fixture')
        if (sends === 1) {
          const payload = JSON.parse(request.messages[1].content)
          currentSourceId = /^q[a-f0-9]{12}/m.exec(payload.sources.find((source: { source: string }) => source.source === 'current').evidence)![0]
        } else {
          expect(request.messages[0].content).toContain('真实sourceId')
          expect(request.messages[1].content).toContain(currentSourceId)
          const diagnostic = await prisma.agentArtifact.findFirst({ where: { runId: f.runId, artifactType: 'continuityReview',
            metadata: { path: ['continuityReport', 'rawResponses'], array_contains: [currentRaw] } } })
          expect(diagnostic).not.toBeNull()
        }
        const content = sends === 1 ? currentRaw : JSON.stringify({ corrections: [{ index: 0, evidence: [{ sourceId: currentSourceId }] }] })
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      vi.stubGlobal('fetch', fetch)
      if (path === 'legacy') {
        const ctx: ToolContext = { ...f, callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime, sandboxMode: 'read_only',
          signal: new AbortController().signal, emit: () => {} }
        const result = await continuityValidateTool.execute(ctx, { compilationId: compilation.id })
        expect(result.outcome).not.toBe('failed')
        expect((await continuityValidateTool.execute(ctx, { compilationId: compilation.id })).outcome).not.toBe('failed')
      } else {
        const lease = await claim(f)
        const historical = path === 'native-work7' ? await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId,
          artifactType: 'continuityReview', title: 'Frozen work7 source', metadata: runtimeJson({ kind: 'check', version: 7, rawResponse: raw }).value } }) : null
        const tools = [chapterBridgeGetTool, continuityValidateTool]
        await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'stable', qualityMode: 'balanced',
          model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
          tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
          toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
          snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
            messages: [{ role: 'user', content: '复查章节' }, { role: 'assistant', content: null, toolCalls: ['bridge', 'check', 'cached'].map(id => ({ id,
              name: id === 'bridge' ? 'chapter_bridge_get' : 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id }) })) }], successfulToolSignatures: [] } })
        for (let index = 0; index < 3; index++) await executeDurableToolStep(lease, new AbortController().signal)
        if (path === 'native-work7') {
          const original = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_validate',
            inputSnapshot: { path: ['input', 'callId'], equals: 'check' } }, include: { children: { include: { attempts: { include: { usageReceipt: true } } } } } })
          expect(original.inputSnapshot).toMatchObject({ input: { work: { kind: 'continuityReview', route: { model: 'fixture' }, price: { version: 'credits-v2-itemized' } } } })
          expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: historical!.id } })).toEqual(historical)
          expect(original.children.map(child => child.action).sort()).toEqual(['continuity_critic', 'continuity_evidence_correction'])
          for (const child of original.children) {
            expect(child.operationKey).toBe(`aux:${original.id}:${child.action}`)
            expect(child.attempts).toHaveLength(1)
            expect(child.attempts[0]).toMatchObject({ attemptKey: '1', status: 'succeeded', usageReceipt: { source: 'reported', settlementStatus: 'settled' } })
          }
          const frozen = structuredClone(original)
          await executePreparedContinuityWork({ ...f, callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
            signal: new AbortController().signal, emit: () => {} }, lease, original.id)
          expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: original.id },
            include: { children: { include: { attempts: { include: { usageReceipt: true } } } } } })).toEqual(frozen)
          expect(fetch).toHaveBeenCalledTimes(2)
        }
      }
      expect(sends).toBe(2)
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      const report = (saved.validation as { continuityReport: ContinuityReport }).continuityReport
      expect(report).toMatchObject({ complete: true, billingKnown: true, rawResponses: [currentRaw,
        JSON.stringify({ corrections: [{ index: 0, evidence: [{ sourceId: currentSourceId }] }] })],
      findings: [{ signal: finding.signal, severity: finding.severity, explanation: finding.evidence,
        suggestion: `${finding.evidence}\n${finding.suggestion}`, references: [{ sourceId: expect.any(String), quote: '门开着。', source: 'current' }] }] })
      expect(report.opinions).toEqual([{ ...opinion, evidence: [{ sourceId: currentSourceId }] }])
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(body)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))

  it.each(['reported', 'unknown', 'reserved'] as const)('%s billing authenticates only existing correction bytes without another claim', scenario => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body } })
    const h = await frozenCorrection(f, { chapterId: chapter.id, revision: chapter.revision, unknown: scenario === 'unknown', reserved: scenario === 'reserved' })
    const unchanged = await preserve(f), network = vi.fn(() => { throw Error('History cannot send') }); vi.stubGlobal('fetch', network)
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      const read = await correctionsModule.readHistoricalContinuityCorrectionBilling(prisma, f, h.claimRow, [f.runId])
      expect(read).toEqual(scenario === 'reported' ? { usageIds: [h.followup.id] } : null)
    }
    expect(correctionsModule).not.toHaveProperty('claimLegacyContinuityCorrection')
    expect(network).not.toHaveBeenCalled(); await unchanged()
  }))

  it.each(['known', 'known-zero', 'invalid-continue', 'unknown-fresh', 'truncated-continue', 'valid-unapplied', 'valid-unapplied-binding', 'unknown', 'raw-tampered', 'source-changed', 'no-author'] as const)(
    'saved %s preserves old evidence without minting or applying a paid phase', scenario => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, revision: 7 } })
    const ctx = { ...f, callId: 'current', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      signal: new AbortController().signal, emit: () => {} } as ToolContext
    const h = await frozenCorrection(f, { chapterId: chapter.id, revision: chapter.revision, bindingHash: 'original-binding',
      unknown: scenario === 'unknown' || scenario === 'unknown-fresh', knownZero: scenario === 'known-zero',
      response: scenario === 'invalid-continue' || scenario === 'known' || scenario === 'known-zero' ? '{"corrections":[]}'
        : scenario === 'truncated-continue' ? '{"corrections":[' : correction,
      finishReason: scenario === 'truncated-continue' ? 'length' : 'stop' })
    if (scenario === 'raw-tampered') await prisma.agentArtifact.update({ where: { id: h.observation!.id },
      data: { metadata: runtimeJson({ ...(h.observation!.metadata as object), contentHash: '0'.repeat(64) }).value } })
    if (scenario === 'source-changed') await prisma.chapter.update({ where: { id: chapter.id }, data: { content: '作者改变后的正文' } })
    if (scenario !== 'no-author') {
      const stop = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.paused', payload: {} } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'run.started', payload: { authorContinue: { eventId: stop.id, afterSeq: 1 } } } })
    }
    const unchanged = await preserve(f), network = vi.fn(() => { throw Error('Continue cannot send') }); vi.stubGlobal('fetch', network)
    const saved = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })
    const args = { chapterId: chapter.id, revision: chapter.revision, bodies: { previous: null, current: saved.content },
      bindingHash: scenario === 'valid-unapplied-binding' ? 'changed-binding' : 'original-binding' }
    const read = await correctionsModule.readReusableLegacyContinuityCorrection(prisma, ctx, args)
    const valid = scenario === 'valid-unapplied' || scenario === 'no-author'
    expect(read?.inspected.complete ?? false).toBe(valid)
    if (valid) expect(read).toMatchObject({ observationId: h.observation!.id, usageIds: [h.followup.id], inspected: { candidateFindings: [
      { signal: finding.signal, severity: finding.severity, evidence: finding.evidence, suggestion: finding.suggestion } ] } })
    const billing = await correctionsModule.readHistoricalContinuityCorrectionBilling(prisma, f, h.claimRow, [f.runId])
    expect(billing !== null).toBe(!['unknown', 'unknown-fresh', 'raw-tampered'].includes(scenario))
    expect(correctionsModule).not.toHaveProperty('markLegacyContinuityCorrectionApplied')
    expect(network).not.toHaveBeenCalled(); await unchanged()
  }))

  it('standalone history freezes focus and a newer assessment prevents revival without rewriting old bytes', async () => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body } })
    const ctx = { ...f, callId: 'read-history', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} } as ToolContext
    const context = await readHistoricalStandaloneContinuityContext(ctx, chapter.id), bindingHash = standaloneContinuityBindingHash(context.contextHash, 'A')
    await frozenCorrection(f, { chapterId: chapter.id, revision: chapter.revision, bindingHash })
    const args = { chapterId: chapter.id, revision: chapter.revision, bodies: { previous: null, current: body }, bindingHash }
    expect(await correctionsModule.readReusableLegacyContinuityCorrection(prisma, ctx,
      { ...args, bindingHash: standaloneContinuityBindingHash(context.contextHash, 'B') })).toBeNull()
    expect((await correctionsModule.readReusableLegacyContinuityCorrection(prisma, ctx, args))?.inspected.complete).toBe(true)
    await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId, artifactType: 'continuityReview', title: 'Later immutable assessment', metadata: {
      continuityAssessmentAdmissionId: 'later-admission', chapterId: chapter.id, revision: chapter.revision,
      sourceHash: correctionsModule.continuitySourceHash(args.bodies), bindingHash } } })
    const unchanged = await preserve(f)
    expect(await correctionsModule.readReusableLegacyContinuityCorrection(prisma, ctx, args)).toBeNull(); await unchanged()
  }))

  it.each(['direct', 'offline-correction'] as const)('standalone %s remains history while the ordinary runner owns the new report', scenario => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body } })
    const h = await frozenCorrection(f, { chapterId: chapter.id, revision: chapter.revision, bindingHash: 'old',
      response: scenario === 'direct' ? '{"corrections":[]}' : correction })
    const unchanged = await preserve(f), ctx = { ...f, callId: 'ordinary-check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      signal: new AbortController().signal, emit: () => {} } as ToolContext
    expect((await correctionsModule.readReusableLegacyContinuityCorrection(prisma, ctx,
      { chapterId: chapter.id, revision: chapter.revision, bodies: h.bodies, bindingHash: 'old' }))?.inspected.complete ?? false).toBe(scenario === 'offline-correction')
    const snapshot = await buildContinuitySnapshot(ctx, { chapterId: chapter.id }), dispatch = vi.fn(async () => ({ content: '{"findings":[]}', usageIds: [], billingKnown: true }))
    expect(await reviewContinuity(ctx, { chapterId: chapter.id }, { snapshot, dispatch, allowRepair: false })).toMatchObject({ reviewCompleted: true })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(await reviewContinuity(ctx, { chapterId: chapter.id }, { snapshot, dispatch, allowRepair: false })).toMatchObject({ reviewCompleted: true })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(correctionsModule).not.toHaveProperty('markLegacyContinuityCorrectionApplied'); await unchanged()
    await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: { increment: 1 }, content: '作者保存的新正文' } })
    expect(await correctionsModule.readReusableLegacyContinuityCorrection(prisma, ctx,
      { chapterId: chapter.id, revision: chapter.revision + 1, bodies: { previous: null, current: '作者保存的新正文' }, bindingHash: 'new' })).toBeNull()
  }))

  it.each(['aborted', 'body-changed', 'save-failed', 'usage-unknown'] as const)('independent %s correction bytes survive without application or redispatch', scenario => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body } })
    const h = await frozenCorrection(f, { chapterId: chapter.id, revision: chapter.revision, bindingHash: 'old', unknown: scenario === 'usage-unknown' })
    const controller = new AbortController()
    if (scenario === 'aborted') controller.abort()
    if (scenario === 'body-changed') await prisma.chapter.update({ where: { id: chapter.id }, data: { content: '作者的新正文', revision: { increment: 1 } } })
    if (scenario === 'save-failed') await expect(prisma.$transaction(async () => { throw Error('Application save failed') })).rejects.toThrow('Application save failed')
    const unchanged = await preserve(f), read = await correctionsModule.readHistoricalContinuityCorrectionBilling(prisma, f, h.claimRow, [f.runId])
    expect(read).toEqual(scenario === 'usage-unknown' ? null : { usageIds: [h.followup.id] })
    expect(h.observation!.metadata).toMatchObject({ rawResponse: { content: JSON.stringify(correction), complete: true }, usageIds: [h.followup.id] })
    expect(correctionsModule).not.toHaveProperty('recordLegacyContinuityCorrectionObservation'); await unchanged()
  }))
})
