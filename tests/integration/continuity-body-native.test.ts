import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { available, claim, fixture, reported } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState, loadExecutionState, readExecutionStateInTransaction } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { modelRouteRevision, prepareModelCursorOperation, validateModelCursor } from '../../api/lib/agent/runtime-model-cursor.js'
import { currentNativeToolViews, type NativeToolView } from '../../api/lib/agent/runtime-tool-view.js'
import { prepareProviderAttempt, markProviderDispatched, recordProviderUsage, recordProviderResult } from '../../api/lib/agent/runtime-operations.js'
import { settleProviderOperation, type DurableTokenPrice } from '../../api/lib/agent/runtime-settlement.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { prepareAuxiliaryModelOperation } from '../../api/lib/agent/runtime-auxiliary-model.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { chapterBridgeGetTool, continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readCompletedWritingPresentation } from '../../api/lib/agent/writing-scope.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { advanceDurableMemory } from '../../api/lib/agent/runtime-memory.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'

const broken = '他在纸上写：三十四万元的一成是三千四百元。'
const corrected = '他在纸上写：三十四万元的一成是三万四千元。'
const content = ['他把账簿放在桌上。', broken, '他划出这一行，重新核对。', '窗边响起两声轻敲。', '他合上账簿，走到门口。'].join('\n\n')
const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1', reasoningEffort: 'high' }
const price: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 11000, rateCardId: 'ordinary-native-review',
  rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }

// All provider bytes are synthetic. The operation, attempt, price, wallet,
// settlement, effect, source observation and final delivery remain real PG paths.
describe.runIf(available)('ordinary native continuity review on an existing task', () => {
  it.each(['complete-and-reenter', 'unknown-history', 'approval', 'approval-denied'] as const)('%s preserves physical receipts and current-version delivery', scenario => fixture(async f => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(true)
    const lease = await claim(f), signal = new AbortController().signal
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 5, wordCount: content.length } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: '检查并局部修复本章，然后提交。' })
    const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '核账', entryState: state, goal: '核对金额', obstacle: '笔误',
      choice: '重算', cost: '时间', turn: '合上账簿', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const historical = { checkRounds: 3, autoRepairRounds: 1, oldFailure: { classification: 'projection_invalid', parserVersion: 10, raw: '{"findings":[]}' } }
    await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: historical } })
    const tools = [chapterBridgeGetTool, continuityValidateTool, qualityAnalyzeTool, chapterBridgeCommitTool]
    const ask = scenario === 'approval' || scenario === 'approval-denied'
    const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: scenario === 'unknown-history' ? 'stable' : 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: ask && tool.name === 'continuity_validate' ? 'ask' as const : 'allow' as const, alwaysConfirm: false, dangerous: false })),
      protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
      messages: [{ role: 'user', content: '检查并修复第一章，再提交，最后简短说明。' }], successfulToolSignatures: [] } })
    const originalConfigHash = initial.head.configurationHash
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 15000, provider: 'fixture', modelName: 'fixture',
      baseUrl: route.endpoint, apiKey: 'isolated-placeholder', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native',
      thinkingEnabled: true, visionEnabled: false, contextWindowTokens: 128000 })
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue(price)
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const model = async (calls: Array<{ id: string; name: string; arguments: string }>) => {
      const current = await loadExecutionState(f.userId, f.runId), frame = current.frame
      const views: NativeToolView[] = await currentNativeToolViews(current.configuration.tools, f.spec.scope)
      const cursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, operationKey = `exec:${frame.state.nextOperationSequence}`
      await validateModelCursor(lease, cursor, { operationKey, messages: frame.state.messages, tools: views, tier: 'speed', route })
      const request = { endpoint: route.endpoint, body: { tools: views } }
      const prepared = await prepareModelCursorOperation(lease, cursor, { key: operationKey, action: 'workspaceAgent', request, price })
      const attempt = await prepareProviderAttempt(lease, { operationId: prepared.operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request })
      await markProviderDispatched(lease, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      await recordProviderUsage({ ...identity, revision: 1, usage: reported })
      await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: calls,
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } } })
      expect(await settleProviderOperation({ ...identity, lease })).toMatchObject({ status: 'settled' })
      await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
    }
    let reentered = false
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { model: string; reasoning_effort?: string; messages: Array<{ role: string; content: string }> }
      expect(request.model).toBe('fixture')
      const system = request.messages.find(message => message.role === 'system')!.content
      const text = request.messages.find(message => message.role === 'user')!.content
      let result: unknown = { findings: [] }
      if (system.includes('你是中文小说连续性编辑')) {
        const current = JSON.parse(text) as { sources: Array<{ source: string; content: string; evidence: string }> }
        const body = current.sources.find(source => source.source === 'current')!
        if (body.content.includes(broken)) {
          const rows = body.evidence.split('\n').flatMap(row => { const match = row.match(/^(q[a-f0-9]{12}) (.+)$/); return match ? [{ id: match[1], text: JSON.parse(match[2]) as string }] : [] })
          const source = rows.find(row => row.text.includes(broken))!
          expect(source).toBeDefined()
          result = { findings: [{ signal: 'object', severity: 'error', explanation: '三十四万元的一成应为三万四千元，原句算术不一致。',
            suggestion: '只纠正该处一成的金额。', evidence: [{ sourceId: source.id }] }] }
        }
        const child = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, kind: 'provider', action: 'continuity_critic' }, orderBy: { createdAt: 'desc' } })
        const frozen = child.inputSnapshot as { input: { request: Prisma.InputJsonValue; billing: DurableTokenPrice } }
        const attempts = await prisma.agentProviderAttempt.findMany({ where: { operationId: child.id }, include: { usageReceipt: true } })
        expect((await prepareAuxiliaryModelOperation(lease, { key: child.operationKey, action: child.action, step: 'continuity_critic', parentOperationId: child.parentOperationId!,
          request: frozen.input.request, price: frozen.input.billing })).id).toBe(child.id)
        expect(await prisma.agentProviderAttempt.findMany({ where: { operationId: child.id }, include: { usageReceipt: true } })).toEqual(attempts)
        reentered = true
      } else if (system.includes('只替换列出的本章原文片段')) {
        const parsed = JSON.parse(text) as { authorRequest: string; findings: Array<{ findingId: string; original: string }> }
        expect(parsed.authorRequest).toContain('修复')
        expect(parsed.findings).toHaveLength(1)
        result = { patches: [{ findingId: parsed.findings[0].findingId, replacement: parsed.findings[0].original.replace(broken, corrected) }] }
      } else if (scenario === 'complete-and-reenter' && (await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).revision === 6) {
        const source = text.split('\n').flatMap(row => { const match = row.match(/^(q[a-f0-9]{12}) (.+)$/); if (!match) return []
          try { return [{ id: match[1], text: JSON.parse(match[2]) as string }] } catch { return [] } }).find(row => row.text === '他合上账簿，走到门口。')
        expect(source, 'final quality opinion must use its actual visible source').toBeDefined()
        result = { findings: [{ signal: 'explanation_echo', severity: 'advisory', sourceId: source!.id,
          explanation: '门口动作还可压缩，但可以保留人物离开桌边的节奏。', suggestion: '考虑压缩；保留时说明当前动作的表达作用。', confidence: 0.6 }] }
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const args = { compilationId: compilation.id }, step = () => executeDurableToolStep(lease, signal)
    await model([{ id: 'read-current', name: 'chapter_bridge_get', arguments: JSON.stringify(args) },
      { id: scenario === 'unknown-history' ? 'body-review' : 'commit-current', name: scenario === 'unknown-history' ? 'continuity_validate' : 'chapter_bridge_commit', arguments: JSON.stringify(args) },
      ...(scenario === 'unknown-history' ? [{ id: 'known-body-new-call', name: 'continuity_validate', arguments: JSON.stringify(args) }] : [])])
    expect(await step()).toMatchObject({ kind: 'tool' })
    if (ask) {
      const waiting = await step()
      expect(waiting.kind).toBe('waiting_approval')
      if (waiting.kind !== 'waiting_approval') throw new Error('Missing actual commit service approval')
      const approval = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: waiting.approvalId } })
      expect(approval.payload).toMatchObject({ writingServices: { version: 1, chapterId: chapter.id } })
      expect(JSON.stringify(approval.payload)).toContain('continuity_validate')
      expect(fetcher).not.toHaveBeenCalled()
      await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'commit-current', approved: scenario !== 'approval-denied', alwaysAllow: false })
    }
    const outcome = await step()
    expect(outcome.kind).toBe('tool')
    if (scenario === 'approval-denied') {
      expect(outcome).toMatchObject({ result: { outcome: 'failed' } })
      expect(fetcher).not.toHaveBeenCalled()
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
      expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toMatchObject({ committedAt: null })
      return
    }
    if (scenario === 'unknown-history') {
      expect(outcome).toMatchObject({ result: { reviewCompleted: true } })
      const child = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_critic' }, include: { attempts: { include: { usageReceipt: true } } } })
      const receipt = child.attempts[0].usageReceipt!
      await prisma.agentProviderUsageReceipt.update({ where: { attemptId: receipt.attemptId }, data: { settlementStatus: 'pending' } })
      const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      await expect(step()).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
      expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toMatchObject({ committedAt: null })
      return
    }
    expect(outcome).toMatchObject({ result: { summary: '章节已提交' } })
    const finalQuality = await prisma.chapterQualityReport.findFirstOrThrow({ where: { userId: f.userId, chapterId: chapter.id, chapterRevision: 6 },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { findings: true } })
    const parent = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'chapter_bridge_commit' }, include: { effectReceipt: true }, orderBy: { createdAt: 'asc' } })
    const repair = await prisma.agentOperation.findFirstOrThrow({ where: { parentOperationId: parent.id, action: 'continuity_validate', kind: 'internal' }, include: { effectReceipt: true }, orderBy: { createdAt: 'asc' } })
    const memoryJobId = z.object({ memoryJobId: z.string() }).parse(repair.effectReceipt!.result).memoryJobId
    const repairJob = await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: memoryJobId } })
    expect(repairJob).toMatchObject({ novelId: f.novelId, chapterId: chapter.id, chapterRevision: 6,
      idempotencyKey: `${chapter.id}:6`, diff: { durableTaskRootId: f.rootId, durableOperationId: repair.id, after: content.replace(broken, corrected) } })
    if (scenario === 'complete-and-reenter') {
      const ready = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
      expect(ready).toMatchObject({ ready: true, decisionPending: false, revision: 6, terminalCommitted: true, retainedDecisions: [] })
      const decisions = ready!.decisionDetails!.filter(item => item.source === 'quality')
      expect(decisions).toHaveLength(1)
      expect(decisions[0]).toMatchObject({ evidence: '他合上账簿，走到门口。', severity: 'advisory', suggestion: expect.stringContaining('考虑压缩') })
      expect(finalQuality).toMatchObject({ status: 'passed', findings: [expect.objectContaining({ id: decisions[0].findingId, disposition: 'pending' })] })
      if (outcome.kind === 'tool') expect(outcome.result.output).toContain('当前仍有 1 条报告意见，其中 0 条已明确保留')
      const committedParent = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'chapter_bridge_commit' }, include: { effectReceipt: true } })
      expect(committedParent).toMatchObject({ status: 'succeeded', effectReceipt: { result: { toolResult: { summary: '章节已提交' } } } })
      const memoryStep = await advanceDurableMemory(lease)
      expect(memoryStep).toMatchObject({ kind: 'memory', result: { jobId: memoryJobId } })
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: memoryStep!.operationId } })).toMatchObject({
        taskRootId: f.rootId, parentOperationId: repair.id, action: 'memory_extract',
        inputSnapshot: { input: { sourceOperationId: repair.id, sourceResultHash: repair.effectReceipt!.resultHash,
          jobId: memoryJobId, chapterId: chapter.id, chapterRevision: 6 } } })
      expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: memoryJobId } })).status).toBe('completed')
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).not.toHaveProperty('retainedReviewDecision')
    }
    const saved = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })
    expect(saved).toMatchObject({ revision: 6, content: content.replace(broken, corrected) })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))).toMatchObject({ ready: true, decisionPending: false, terminalCommitted: true, revision: 6 })
    expect(await prisma.$transaction(tx => readCompletedWritingPresentation(tx, f))).not.toBeNull()
    const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    expect(committed).toMatchObject({ status: 'completed', validation: historical, bridge: { committedAt: expect.any(Date), targetRevision: 6 } })
    expect(repair.effectReceipt?.result).toHaveProperty('progress.kind', 'content_revision')
    const evidence = await withRunLease(lease, async tx => collectDurableToolEvidence(tx, f.rootId, (await readExecutionStateInTransaction(tx, f.rootId)).frame.revision))
    expect(evidence.effects.some(effect => effect.operationId === repair.id)).toBe(true)
    const jobs = await prisma.memoryExtractionJob.findMany({ where: { novelId: f.novelId, chapterId: chapter.id, chapterRevision: 6,
      diff: { path: ['durableOperationId'], equals: repair.id } } })
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(memoryJobId)
    expect(jobs[0].diff).toMatchObject({ durableTaskRootId: f.rootId, durableOperationId: repair.id })
    const attempts = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(attempts.every(attempt => attempt.usageReceipt?.settlementStatus === 'settled')).toBe(true)
    expect(ledger).toHaveLength(attempts.length)
    const count = fetcher.mock.calls.length
    await model([...(scenario === 'complete-and-reenter' ? [{ id: 'read-final-advice', name: 'chapter_bridge_get', arguments: JSON.stringify(args) }] : []), { id: 'reread-current', name: 'continuity_validate', arguments: JSON.stringify(args) }, { id: 'same-commit', name: 'chapter_bridge_commit', arguments: JSON.stringify(args) }])
    if (scenario === 'complete-and-reenter') {
      const visible = await step()
      expect(visible.kind).toBe('tool')
      if (visible.kind === 'tool') {
        const finding = finalQuality.findings[0]
        expect(visible.result.output).toContain(finding.id)
        expect(visible.result.output).toContain(finding.evidenceExcerpt)
        expect(visible.result.output).toContain(finding.suggestion)
      }
      expect(fetcher).toHaveBeenCalledTimes(count)
    }
    if (ask) {
      const waiting = await step()
      expect(waiting.kind).toBe('waiting_approval')
      if (waiting.kind !== 'waiting_approval') throw new Error('Missing approval for the new standalone review call')
      const approval = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: waiting.approvalId } })
      expect(approval.payload).toMatchObject({ toolName: 'continuity_validate', callId: 'reread-current', args })
      expect(fetcher).toHaveBeenCalledTimes(count)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(saved)
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })).toEqual(committed)
      await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'reread-current', approved: true, alwaysAllow: false })
    }
    expect(await step()).toMatchObject({ result: { reviewCompleted: true, output: expect.stringContaining('复用已保存报告') } })
    expect(await step()).toMatchObject({ result: { summary: '章节已提交' } })
    expect(fetcher).toHaveBeenCalledTimes(count)
    const refreshed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const originalValidation = committed.validation as Prisma.JsonObject, refreshedValidation = refreshed.validation as Prisma.JsonObject
    expect(refreshedValidation.checkedAt).toEqual(expect.any(String))
    expect(Date.parse(String(refreshedValidation.checkedAt))).toBeGreaterThanOrEqual(Date.parse(String(originalValidation.checkedAt)))
    expect(refreshed.updatedAt.getTime()).toBeGreaterThanOrEqual(committed.updatedAt.getTime())
    // A new read can refresh only report-check timestamps; delivery, bridge, findings and historical fields stay exact.
    expect({ ...refreshed, updatedAt: committed.updatedAt, validation: { ...refreshedValidation, checkedAt: originalValidation.checkedAt } }).toEqual(committed)
    const refreshedAttempts = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })
    const refreshedLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(refreshedAttempts).toHaveLength(attempts.length + 1) // Only the recorded main assistant request is new.
    expect(refreshedLedger).toHaveLength(ledger.length + 1)
    expect(refreshedAttempts.filter(row => attempts.some(original => original.id === row.id))).toEqual(attempts)
    expect(refreshedLedger.filter(row => ledger.some(original => original.id === row.id))).toEqual(ledger)
    expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: parent.id }, include: { effectReceipt: true } })).toEqual(parent)
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: finalQuality.id }, include: { findings: true } })).toEqual(finalQuality)
    expect((await loadExecutionState(f.userId, f.runId)).head.configurationHash).toBe(originalConfigHash)
    expect(reentered).toBe(true)
  }, undefined, '检查并修复第一章，再提交，最后简短说明。', { freezeWriting: true, reviewProtocol: 1, continuityReportProtocol: 5 }), 45000)
})
