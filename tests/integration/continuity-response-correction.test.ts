import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as tokenPrices from '../../api/lib/billing/resolve-token-price.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import * as storyCompiler from '../../api/lib/agent/story-compiler.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterBridgeGetTool, continuityValidateTool, buildStandaloneContinuityContext, standaloneContinuityBindingHash } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { claimLegacyContinuityCorrection, recordLegacyContinuityCorrectionObservation } from '../../api/lib/agent/continuity-response-correction.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { readContinuedContinuityEvidence } from '../../api/lib/agent/continued-continuity-evidence.js'
import { readContinuedContinuityRecovery } from '../../api/lib/agent/legacy-continuity-recovery.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as review from '../../api/lib/agent/review-completion.js'
import * as correctionsModule from '../../api/lib/agent/continuity-response-correction.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
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
const reassessment = JSON.stringify({ decisions: [{ index: 0, action: 'confirm', reason: '核对两处实际原文后确认原判断并纠正定位。',
  sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '门开着' }, { source: 'current', segmentId: 'c0', quote: '门锁着' }], findingIndex: 0 }],
  findings: [{ ...finding, sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '门开着' }, { source: 'current', segmentId: 'c0', quote: '门锁着' }] }] })

describe.runIf(available)('continuity evidence correction actual PostgreSQL effects', () => {
  it.each(['legacy', 'durable'] as const)('%s applies the same exact report policy through actual tools', path => fixture(async f => {
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
      let sends = 0
      const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        sends++
        const request = JSON.parse(String(init.body))
        expect(request.model).toBe('fixture')
        if (sends === 2) {
          const diagnostic = await prisma.agentArtifact.findFirst({ where: { runId: f.runId, artifactType: 'continuityReview',
            metadata: { path: ['original', 'contentHash'], equals: inspectContinuityResponse(raw, { previous: null, current: body }, true, 5).audit.contentHash } } })
          expect(diagnostic).not.toBeNull()
          expect(request.messages[0].content).toContain('为每个原 index')
        }
        const content = sends === 1 ? raw : reassessment
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      vi.stubGlobal('fetch', fetch)
      if (path === 'legacy') {
        const ctx: ToolContext = { ...f, callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime,
          signal: new AbortController().signal, emit: () => {} }
        const result = await continuityValidateTool.execute(ctx, { compilationId: compilation.id })
        expect(result.outcome).not.toBe('failed')
        expect((await continuityValidateTool.execute(ctx, { compilationId: compilation.id })).outcome).not.toBe('failed')
      } else {
        const lease = await claim(f)
        const tools = [chapterBridgeGetTool, continuityValidateTool]
        await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
          model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
          tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
          toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
          snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
            messages: [{ role: 'user', content: '复查章节' }, { role: 'assistant', content: null, toolCalls: ['bridge', 'check', 'cached'].map(id => ({ id,
              name: id === 'bridge' ? 'chapter_bridge_get' : 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id }) })) }], successfulToolSignatures: [] } })
        for (let index = 0; index < 3; index++) await executeDurableToolStep(lease, new AbortController().signal)
      }
      expect(sends).toBe(2)
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      expect(saved.validation).toMatchObject({ independentCheck: 'complete', findings: [{ signal: finding.signal, severity: finding.severity,
        evidence: finding.evidence, suggestion: finding.suggestion, sourceEvidence: [{ source: 'current', quote: '门开着' }, { source: 'current', quote: '门锁着' }] }],
        continuityCriticResponse: { parserVersion: 6, reassessment: { original: { candidateFindings: [finding] } } } })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(body)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))

  it.each(['reported', 'unknown', 'reserved'] as const)('%s billing gates an immutable claim and duplicate/restart cannot claim again', scenario => fixture(async f => {
    try {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, targetType: 'chapter', targetId: f.chapterId,
        providerType: 'text', providerMode: 'custom', modelName: 'fixture', action: 'agent3ContinuityCritic', durationMs: 1,
        requestTokens: 12, responseTokens: 8, usageSource: scenario === 'unknown' ? 'unknown' : 'reported', billingStatus: 'settled',
        reservedCreditMilli: scenario === 'reserved' ? 1 : 0 } })
      const ctx: ToolContext = { ...f, callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
      const input = { chapterId: f.chapterId, revision: 1, bodies: { previous: null, current: body }, original: inspectContinuityResponse(raw, { previous: null, current: body }, true, 5),
        usageIds: [usage.id], targetType: 'chapter' as const, targetId: f.chapterId, assertCurrent: async () => {} }
      const claims = await Promise.all([0, 1].map(() => prisma.$transaction(tx => claimLegacyContinuityCorrection(tx, ctx, input))))
      expect(claims.filter(Boolean)).toHaveLength(scenario === 'reported' ? 1 : 0)
      expect(await prisma.$transaction(tx => claimLegacyContinuityCorrection(tx, ctx, input))).toBe(false)
      const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId } })
      expect(artifacts).toHaveLength(scenario === 'reported' ? 1 : 0)
      if (scenario === 'reported') expect(artifacts[0].metadata).toMatchObject({ state: 'claimed', original: { candidateFindings: [finding] } })
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))

  it.each(['known', 'known-zero', 'invalid-continue', 'unknown-fresh', 'truncated-continue', 'valid-unapplied', 'valid-unapplied-binding', 'unknown', 'raw-tampered', 'source-changed', 'no-author'] as const)('saved %s response needs exact original paid proof and author continuation', scenario => fixture(async f => {
    try {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running', startRequest: { prompt: '修改本章' } } })
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length, revision: 7 } })
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '核对本章' })
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '开门', entryState: state, goal: '通过', obstacle: '门锁',
        choice: '等待', cost: '时间', turn: '等候', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const current = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
      const coverage = compilerContinuityCoverage({ chapter, bridge: current.bridge, sceneTasks: current.sceneTasks, source: null })
      const start = new Date(Date.now() - 15000), at = (offset: number) => new Date(start.getTime() + offset)
      const event = (seq: number, type: string, payload: object, offset: number) => prisma.agentRunEvent.create({ data: { runId: f.runId, seq, type,
        payload: runtimeJson(payload).value, createdAt: at(offset) } })
      await event(1, 'tool.call', { toolName: 'continuity_validate', callId: 'original', args: { compilationId: compilation.id } }, 0)
      await event(2, 'tool.result', { toolName: 'continuity_validate', callId: 'original', ok: false, failureCode: 'CONTINUITY_REPORT_INCOMPLETE' }, 1000)
      const paused = await event(3, 'run.paused', {}, 1100)
      if (scenario !== 'no-author') await event(4, 'run.started', { authorContinue: { eventId: paused.id, afterSeq: 3 } }, 1200)
      await event(5, 'tool.call', { toolName: 'continuity_validate', callId: 'current', args: { compilationId: compilation.id } }, 1300)
      const audit = inspectContinuityResponse(raw, { previous: null, current: body }, true, 4).audit
      const validation = { independentCheck: 'unavailable', checkedRevision: 7, checkedChapterId: chapter.id, checkedContent: body, checkedAt: at(900).toISOString(),
        coverage, reviewFocus: '', checkRounds: 3, autoRepairRounds: 0, errorCount: 0, warningCount: 0, findings: [],
        continuityCriticResponse: { ...audit, ...(scenario === 'raw-tampered' ? { contentHash: 'a'.repeat(64) } : {}) } }
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson(validation).value } })
      const originalAuditJSON = JSON.stringify((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation &&
        ((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation as Record<string, unknown>).continuityCriticResponse)
      await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, targetType: 'story_compilation', targetId: compilation.id,
        providerType: 'text', providerMode: 'custom', modelName: 'fixture', action: 'agent3ContinuityCritic', durationMs: 1, createdAt: at(500),
        requestTokens: 12, responseTokens: scenario === 'known-zero' ? 0 : 8, usageSource: scenario === 'unknown' ? 'unknown' : 'reported', billingStatus: 'settled', billingEvidence: { responseObserved: true } } })
      if (scenario === 'source-changed') await prisma.chapter.update({ where: { id: chapter.id }, data: { content: '改变后的正文' } })
      const ctx: ToolContext = { ...f, callId: 'current', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime,
        signal: new AbortController().signal, emit: () => {} }
      const proof = await prisma.$transaction(tx => readContinuedContinuityEvidence(tx, ctx, { compilationId: compilation.id }))
      if (['unknown', 'raw-tampered', 'source-changed', 'no-author'].includes(scenario)) { expect(proof).toBeNull(); return }
      expect(proof?.inspected).toMatchObject({ structured: true, complete: false, candidateFindings: [finding] })
      const originalReview = review.generateReviewCompletion
      const firstCritic = vi.spyOn(review, 'generateReviewCompletion').mockImplementation(originalReview)
      const window = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      let sends = 0
      const fetch = vi.fn(async () => {
        sends++
        const content = ['invalid-continue', 'unknown-fresh', 'truncated-continue', 'valid-unapplied-binding'].includes(scenario)
          ? sends === 1 ? ['invalid-continue', 'unknown-fresh'].includes(scenario) ? '{"corrections":[]}' : scenario === 'truncated-continue' ? '{"corrections":[' : correction
            : scenario === 'unknown-fresh' ? 'broken first assessment' : '{"findings":[]}' : correction
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: scenario === 'truncated-continue' && sends === 1 ? 'length' : 'stop' }],
          ...(scenario === 'unknown-fresh' && sends === 2 ? {} : { usage: { prompt_tokens: 12, completion_tokens: 8 } }) })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      vi.stubGlobal('fetch', fetch)
      if (scenario.startsWith('valid-unapplied')) {
        // The observation transaction has committed before report application.
        // Fail this separate transaction, preserving the independently received bytes.
        vi.spyOn(storyCompiler, 'validateStoryContinuity').mockRejectedValueOnce(new Error('simulated application guard after immutable observation'))
      }
      if (scenario === 'truncated-continue') await expect(continuityValidateTool.execute(ctx, { compilationId: compilation.id })).rejects.toMatchObject({ code: 'AI_PROVIDER_OUTPUT_LIMIT' })
      else if (scenario.startsWith('valid-unapplied')) await expect(continuityValidateTool.execute(ctx, { compilationId: compilation.id })).rejects.toThrow('simulated application guard')
      else {
        const initialResult = await continuityValidateTool.execute(ctx, { compilationId: compilation.id })
        expect(initialResult.outcome === 'failed').toBe(['invalid-continue', 'unknown-fresh'].includes(scenario))
      }
      expect(firstCritic).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(1)
      if (scenario === 'truncated-continue') {
        const observation = await prisma.agentArtifact.findFirstOrThrow({ where: { runId: f.runId, artifactType: 'continuityReview',
          metadata: { path: ['finishReason'], equals: 'length' } } })
        expect(observation.metadata).toMatchObject({ finishReason: 'length', assessmentComplete: false,
          rawResponse: { encoding: 'json-string', content: JSON.stringify('{"corrections":['), complete: false } })
        const observedUsageIds = (observation.metadata as { usageIds: string[] }).usageIds
        expect(observedUsageIds).toHaveLength(1)
        expect(await prisma.aiUsageLog.findMany({ where: { id: { in: observedUsageIds } } })).toMatchObject([
          { action: 'agent3ContinuityEvidenceCorrection', usageSource: 'reported', requestTokens: 12, responseTokens: 8,
            billingStatus: 'settled', reservedCreditMilli: 0, billingEvidence: { responseObserved: true } },
        ])
      }
      if (scenario.startsWith('valid-unapplied')) expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'continuityReview',
        metadata: { path: ['rawResponse', 'content'], equals: JSON.stringify(correction) } } })).toBe(1)
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      expect(saved.validation).toMatchObject({ independentCheck: ['known', 'known-zero'].includes(scenario) ? 'complete' : 'unavailable', checkRounds: 3, autoRepairRounds: 0,
        checkedAt: validation.checkedAt, continuityCriticResponse: audit })
      if (['known', 'known-zero', 'invalid-continue'].includes(scenario)) expect(saved.validation).toMatchObject({
        continuityEvidenceRecovery: { originalParserVersion: 4, audit: { parserVersion: 5, candidateFindings: [finding] } } })
      expect(JSON.stringify((saved.validation as Record<string, unknown>).continuityCriticResponse)).toBe(originalAuditJSON)
      if (scenario === 'valid-unapplied') {
        expect((await continuityValidateTool.execute(ctx, { compilationId: compilation.id })).outcome).not.toBe('failed')
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(firstCritic).not.toHaveBeenCalled()
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).toMatchObject({ independentCheck: 'complete', checkRounds: 3,
          continuityCriticResponse: audit, continuityEvidenceRecovery: { offline: true, originalParserVersion: 4 } })
      }
      if (['invalid-continue', 'unknown-fresh', 'truncated-continue', 'valid-unapplied-binding'].includes(scenario)) {
        if (scenario === 'valid-unapplied-binding') await prisma.sceneTask.update({ where: { id: current.sceneTasks[0].id }, data: { goal: '改变后的目标' } })
        expect((await continuityValidateTool.execute(ctx, { compilationId: compilation.id })).outcome).toBe('failed')
        expect(fetch).toHaveBeenCalledTimes(1)
        const nextAt = Date.now() + 1000
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 6, type: 'tool.result', createdAt: new Date(nextAt),
          payload: { toolName: 'continuity_validate', callId: 'current', ok: false, failureCode: scenario === 'truncated-continue' ? 'AI_PROVIDER_OUTPUT_LIMIT'
            : scenario === 'valid-unapplied-binding' ? 'CONTINUITY_REPORT_SAVE_FAILED' : 'CONTINUITY_EVIDENCE_UNLOCATED' } } })
        const nextPause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 7, type: 'run.paused', createdAt: new Date(nextAt + 1), payload: {} } })
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 8, type: 'run.started', createdAt: new Date(nextAt + 2),
          payload: { authorContinue: { eventId: nextPause.id, afterSeq: 7 } } } })
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 9, type: 'tool.call', createdAt: new Date(nextAt + 3),
          payload: { toolName: 'continuity_validate', callId: 'fresh', args: { compilationId: compilation.id } } } })
        const freshCtx = { ...ctx, callId: 'fresh' }
        expect(await prisma.$transaction(tx => readContinuedContinuityRecovery(tx, freshCtx, { callId: 'fresh', compilationId: compilation.id, chapterId: chapter.id }))).toHaveLength(1)
        const freshResult = await continuityValidateTool.execute(freshCtx, { compilationId: compilation.id }).catch(() => ({ outcome: 'failed' }))
        expect(freshResult.outcome === 'failed').toBe(scenario === 'unknown-fresh')
        expect(firstCritic).toHaveBeenCalledTimes(1)
        expect(fetch).toHaveBeenCalledTimes(2)
        expect((await continuityValidateTool.execute(freshCtx, { compilationId: compilation.id })).outcome === 'failed').toBe(scenario === 'unknown-fresh')
        expect(fetch).toHaveBeenCalledTimes(2)
        if (scenario === 'unknown-fresh') {
          const stop = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 10, type: 'run.paused', createdAt: new Date(nextAt + 4), payload: {} } })
          await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 11, type: 'run.started', createdAt: new Date(nextAt + 5), payload: { authorContinue: { eventId: stop.id, afterSeq: 10 } } } })
          expect((await continuityValidateTool.execute({ ...freshCtx, callId: 'later' }, { compilationId: compilation.id })).outcome).toBe('failed')
          expect(fetch).toHaveBeenCalledTimes(2)
          expect(await prisma.agentArtifact.findFirst({ where: { runId: f.runId, artifactType: 'continuityReview', metadata: { path: ['dispatchState'], equals: 'finished' } } })).not.toBeNull()
        }
      }
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(body)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))

  it('standalone offline reuse freezes focus and a newer assessment prevents old response revival', async () => fixture(async f => {
    try {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length } })
      const ctx: ToolContext = { ...f, callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
      const context = await buildStandaloneContinuityContext(ctx, f.chapterId)
      const bodies = { previous: context.precedingBodies, current: body }
      const original = inspectContinuityResponse(raw, bodies, true, 5)
      const usageData = { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, targetType: 'chapter', targetId: f.chapterId,
        providerType: 'text', providerMode: 'custom', modelName: 'fixture', durationMs: 1, requestTokens: 12, responseTokens: 8,
        usageSource: 'reported', billingStatus: 'settled', billingEvidence: { responseObserved: true } }
      const critic = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityCritic' } })
      expect(await prisma.$transaction(tx => claimLegacyContinuityCorrection(tx, ctx, { chapterId: f.chapterId, revision: context.chapter.revision, bodies, original,
        usageIds: [critic.id], targetType: 'chapter', targetId: f.chapterId, assertCurrent: async () => {}, bindingHash: standaloneContinuityBindingHash(context.contextHash, 'A') }))).toBe(true)
      const followup = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityEvidenceCorrection' } })
      await prisma.$transaction(tx => recordLegacyContinuityCorrectionObservation(tx, ctx, { original, bodies, content: correction, finishReason: 'stop', toolCallsPresent: false, usageIds: [followup.id] }))
      const fetch = vi.fn().mockRejectedValue(new Error('No provider dispatch permitted'))
      vi.stubGlobal('fetch', fetch)
      expect((await continuityValidateTool.execute(ctx, { chapterId: f.chapterId, focus: 'B' })).outcome).toBe('failed')
      expect((await continuityValidateTool.execute(ctx, { chapterId: f.chapterId, focus: 'A' })).outcome).not.toBe('failed')
      expect(fetch).not.toHaveBeenCalled()
      const bindingHash = standaloneContinuityBindingHash(context.contextHash, 'A')
      await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'new assessment', content: 'fixture',
        metadata: { continuityAssessmentAdmissionId: 'later-fixture-admission', callId: 'newer', chapterId: f.chapterId, revision: context.chapter.revision,
          sourceHash: correctionsModule.continuitySourceHash(bodies), bindingHash } } })
      expect(await prisma.$transaction(tx => correctionsModule.readReusableLegacyContinuityCorrection(tx, ctx, { chapterId: f.chapterId, revision: context.chapter.revision, bodies, bindingHash }))).toBeNull()
      const newer = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityCritic', usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null } })
      await prisma.$transaction(tx => correctionsModule.recordLegacyContinuityAssessmentObservation(tx, { ...ctx, callId: 'newer' }, { admissionId: 'later-fixture-admission', usageIds: [newer.id] }))
      expect((await prisma.$transaction(tx => correctionsModule.readLegacyContinuityCorrectionGate(tx, ctx, { chapterId: f.chapterId, revision: context.chapter.revision, bodies }))).blocked).toBe(true)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))

  it.each(['direct', 'offline-correction'] as const)('a known fresh standalone %s assessment commits its original reservation before the next revision', scenario => fixture(async f => {
    try {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length } })
      const ctx: ToolContext = { ...f, callId: 'old', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime,
        signal: new AbortController().signal, emit: () => {} }
      const context = await buildStandaloneContinuityContext(ctx, f.chapterId), bodies = { previous: context.precedingBodies, current: body }
      const original = inspectContinuityResponse(raw, bodies, true, 5)
      const usageData = { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, targetType: 'chapter', targetId: f.chapterId,
        providerType: 'text', providerMode: 'custom', modelName: 'fixture', durationMs: 1, requestTokens: 12, responseTokens: 8,
        usageSource: 'reported', billingStatus: 'settled', billingEvidence: { responseObserved: true } }
      const critic = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityCritic' } })
      expect(await prisma.$transaction(tx => claimLegacyContinuityCorrection(tx, ctx, { chapterId: f.chapterId, revision: chapter.revision, bodies, original,
        usageIds: [critic.id], targetType: 'chapter', targetId: f.chapterId, assertCurrent: async () => {}, bindingHash: standaloneContinuityBindingHash(context.contextHash) }))).toBe(true)
      const correctionUsage = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityEvidenceCorrection' } })
      await prisma.$transaction(tx => recordLegacyContinuityCorrectionObservation(tx, ctx, { original, bodies, content: '{"corrections":[]}', finishReason: 'stop', toolCallsPresent: false, usageIds: [correctionUsage.id] }))
      const at = Date.now() + 1000
      const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.paused', createdAt: new Date(at), payload: {} } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'run.started', createdAt: new Date(at + 1),
        payload: { authorContinue: { eventId: pause.id, afterSeq: 1 } } } })
      const window = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      let sends = 0
      const fetch = vi.fn(async () => {
        sends++
        const content = scenario === 'offline-correction' ? sends === 1 ? raw : sends === 2 ? reassessment : '{"findings":[]}' : '{"findings":[]}'
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      vi.stubGlobal('fetch', fetch)
      const fresh = { ...ctx, callId: 'fresh' }
      if (scenario === 'offline-correction') {
        vi.spyOn(correctionsModule, 'markLegacyContinuityCorrectionApplied').mockRejectedValueOnce(new Error('application transaction failed after paid correction'))
        await expect(continuityValidateTool.execute(fresh, { chapterId: f.chapterId })).rejects.toThrow('application transaction failed')
        expect(fetch).toHaveBeenCalledTimes(2)
        expect((await continuityValidateTool.execute({ ...fresh, callId: 'offline-apply' }, { chapterId: f.chapterId })).outcome).not.toBe('failed')
        expect(fetch).toHaveBeenCalledTimes(2)
      } else {
        expect((await continuityValidateTool.execute(fresh, { chapterId: f.chapterId })).outcome).not.toBe('failed')
        expect(fetch).toHaveBeenCalledTimes(1)
      }
      const applied = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' } })
      expect(applied.some(item => typeof (item.metadata as Record<string, unknown> | null)?.assessmentAppliedReservationId === 'string')).toBe(true)
      if (scenario === 'offline-correction') expect(applied.some(item => typeof (item.metadata as Record<string, unknown> | null)?.assessmentApplicationKey === 'string')).toBe(true)
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者的新正文，门已经打开。', revision: { increment: 1 } } })
      // This is an external edit, with no original review-cycle CAS receipt.
      // Applying the old report does not grant another independent whole check.
      await expect(continuityValidateTool.execute({ ...fresh, callId: 'next-revision' }, { chapterId: f.chapterId }))
        .rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
      await continuityValidateTool.execute({ ...fresh, callId: 'same-revision' }, { chapterId: f.chapterId }).catch(() => {})
      expect(fetch).toHaveBeenCalledTimes(scenario === 'offline-correction' ? 2 : 1)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))

  it.each(['aborted', 'body-changed', 'save-failed', 'usage-unknown'] as const)('independent %s correction observation survives application guards', scenario => fixture(async f => {
    try {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      const usageData = { userId: f.userId, novelId: f.novelId, targetType: 'chapter', targetId: f.chapterId, providerType: 'text',
        providerMode: 'custom', modelName: 'fixture', durationMs: 1, requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled',
        billingEvidence: { responseObserved: true } }
      const critic = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityCritic' } })
      const ctx: ToolContext = { ...f, callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
        signal: new AbortController().signal, emit: () => {} }
      const original = inspectContinuityResponse(raw, { previous: null, current: body }, true, 5)
      expect(await prisma.$transaction(tx => claimLegacyContinuityCorrection(tx, ctx, { chapterId: f.chapterId, revision: 1, bodies: { previous: null, current: body }, original,
        usageIds: [critic.id], targetType: 'chapter', targetId: f.chapterId, assertCurrent: async () => {} }))).toBe(true)
      const followup = await prisma.aiUsageLog.create({ data: { ...usageData, action: 'agent3ContinuityEvidenceCorrection',
        ...(scenario === 'usage-unknown' ? { usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null } : {}) } })
      const usageBefore = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      if (scenario === 'body-changed') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者的新正文', revision: { increment: 1 } } })
      const controller = new AbortController()
      if (scenario === 'aborted') controller.abort()
      const observation = await prisma.$transaction(tx => recordLegacyContinuityCorrectionObservation(tx, { ...ctx, signal: controller.signal }, {
        original, bodies: { previous: null, current: body }, content: correction, finishReason: 'stop', toolCallsPresent: false, usageIds: [followup.id] }))
      if (scenario === 'save-failed') await expect(prisma.$transaction(async () => { throw new Error('Application save failed') })).rejects.toThrow('Application save failed')
      expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: observation } })).metadata).toMatchObject({ correctionClaimId: expect.any(String),
        usageIds: [followup.id], rawResponse: { encoding: 'json-string', content: JSON.stringify(correction), complete: true } })
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(usageBefore)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))
})
