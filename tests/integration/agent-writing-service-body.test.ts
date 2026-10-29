import { describe, expect, it, vi } from 'vitest'
import { available, claim, fixture, reported } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState, loadExecutionState, readExecutionStateInTransaction } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { modelRouteRevision, prepareModelCursorOperation, validateModelCursor } from '../../api/lib/agent/runtime-model-cursor.js'
import { currentNativeToolViews } from '../../api/lib/agent/runtime-tool-view.js'
import { toOpenAIToolPresentation } from '../../api/lib/agent/tool-schema.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import { settleProviderOperation, type DurableTokenPrice } from '../../api/lib/agent/runtime-settlement.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { collectDurableMemoryWork } from '../../api/lib/agent/runtime-memory.js'
import { processMemoryExtractionJob } from '../../api/lib/agent/story-memory.js'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { storyCompilerPrepareTool, sceneTaskBuildTool, continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1', reasoningEffort: 'high' }
const price: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
  rateCardId: 'ordinary-writer-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }

describe.runIf(available)('ordinary writer actual PG body and original task cursor', () => {
  it.each(['draft', 'shell-draft', 'shell-approve', 'shell-deny', 'shell-approved-resume', 'rollback-body', 'stale-body', 'narrowed-policy', 'resume-after-body', 'complete-chain', 'complete-reduce-recovery'] as const)('%s preserves the real body transaction and task identity', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
      const fullChain = scenario === 'complete-chain' || scenario === 'complete-reduce-recovery'
      const resumedBody = scenario === 'resume-after-body' || scenario === 'shell-approved-resume'
      const serviceAsk = ['shell-approve', 'shell-deny', 'shell-approved-resume'].includes(scenario)
      const originalFlag = featureFlags.isAgent2FeatureEnabled
      vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation((key, userId) => key === 'memory2' || originalFlag(key, userId))
      const args = { chapterId: f.chapterId, content: '他看过记录，留下缺项，等待另一人复核。' }
      const tools = [chapterReadTool, chapterWriteTool, storyCompilerPrepareTool, sceneTaskBuildTool, continuityValidateTool, qualityAnalyzeTool, chapterBridgeCommitTool]
      const authority = tools.map(tool => ({ name: tool.name, permission: serviceAsk && tool.name === 'chapter_write' ? 'ask' as const : 'allow' as const,
        alwaysConfirm: false, dangerous: false }))
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, ...toOpenAIToolPresentation(tool, f.spec.scope) } })),
        toolAuthority: authority, protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
        phase: 'idle', pendingOperationId: null, successfulToolSignatures: [], messages: [{ role: 'user', content: '完整重写当前章节' }] } })
      const configurationHash = initial.head.configurationHash
      const window = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: price.multiplierBps, provider: 'fixture', modelName: 'fixture',
        baseUrl: route.endpoint, apiKey: 'isolated-fixture-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
        reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue(price)
      const model = async (calls: Array<{ id: string; name: string; arguments: string }>) => {
        const state = await loadExecutionState(f.userId, lease.runId), frame = state.frame
        const views = await currentNativeToolViews(state.configuration.tools, f.spec.scope)
        const cursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, key = `exec:${frame.state.nextOperationSequence}`
        await validateModelCursor(lease, cursor, { operationKey: key, messages: frame.state.messages, tools: views, tier: 'speed', route })
        const request = { endpoint: route.endpoint, body: { tools: views } }
        const prepared = await prepareModelCursorOperation(lease, cursor, { key, action: 'workspaceAgent', request, price })
        const attempt = await operations.prepareProviderAttempt(lease, { operationId: prepared.operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request })
        await operations.markProviderDispatched(lease, attempt.id)
        const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
        await operations.recordProviderUsage({ ...identity, revision: 1, usage: reported })
        await operations.recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: calls,
          usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } } })
        expect(await settleProviderOperation({ ...identity, lease })).toMatchObject({ status: 'settled' })
        await reducer.reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
      }
      const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        expect(body.messages.map((item: { role: string }) => item.role)).toEqual(['system', 'user'])
        expect(body.tools).toBeUndefined(); expect(body.reasoning_effort).toBe('none')
        expect(credits.getModelTierRuntime).toHaveBeenCalledWith('speed', f.userId, null, 'high')
        expect(body.messages[1].content).toContain(args.content)
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      vi.stubGlobal('fetch', fetcher)
      await model([{ id: 'prepare', name: 'story_compiler_prepare', arguments: JSON.stringify({ chapterId: f.chapterId, intentSummary: '核查记录' }) },
        { id: 'scenes', name: 'scene_task_build', arguments: JSON.stringify({ tasks: [{ purpose: '当班检查', entryState: {}, goal: '核查记录', obstacle: '记录不全',
          choice: '留下缺项', cost: '核查延后', turn: '请人复核', exitState: {}, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] }) },
        { id: 'read-body', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
        { id: 'real-writer', name: 'chapter_write', arguments: JSON.stringify(args) }])
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      for (let index = 0; index < 3; index++) expect(await step()).toMatchObject({ kind: 'tool' })
      const before = await loadExecutionState(f.userId, lease.runId)
      const compilationBefore = await prisma.storyCompilation.findFirstOrThrow({ where: { userId: f.userId, chapterId: f.chapterId }, include: { sceneTasks: true, bridge: true } })
      const originalAttempts = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })
      const originalLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      const direct: ToolContext = { ...f, runId: lease.runId, callId: 'real-writer', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
        protectedChapterIds: new Set(), toolAuthority: new Map(authority.map(grant => [grant.name, grant])), signal: new AbortController().signal, emit: () => {},
        durableContent: { lease, operationKey: `exec:${before.frame.state.nextOperationSequence}`, chapterId: f.chapterId, expectedRevision: 1,
          cursor: { expectedRevision: before.frame.revision, expectedHash: before.frame.snapshotHash } } }
      const execute = async () => {
        if (scenario === 'draft') return chapterWriteTool.execute(direct, args)
        const current = await step()
        if (current.kind !== 'tool') throw Error(`Expected body tool, received ${current.kind}`)
        return current.result
      }
      if (serviceAsk) {
        const waiting = await step()
        if (waiting.kind !== 'waiting_approval') throw Error('Expected explicit current writer approval')
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 1, content: '原文' })
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'chapter_write' } } })).toBe(0)
        const approval = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: waiting.approvalId } })
        expect(approval.payload).toMatchObject({ toolName: 'chapter_write', args })
        expect(approval.payload).not.toHaveProperty('writingServices')
        await resolveDurableApproval({ userId: f.userId, runId: lease.runId, requestId: waiting.approvalId, callId: 'real-writer', approved: scenario !== 'shell-deny', alwaysAllow: false })
        if (scenario === 'shell-deny') {
          expect(await execute()).toMatchObject({ outcome: 'failed' })
          expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 1, content: '原文' })
          expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationBefore.id }, include: { sceneTasks: true, bridge: true } })).toEqual(compilationBefore)
          expect(await prisma.memoryExtractionJob.count({ where: { chapterId: f.chapterId } })).toBe(0)
          expect(fetcher).not.toHaveBeenCalled()
          return
        }
      }
      if (scenario === 'rollback-body') {
        const original = operations.commitOperationEffect
        vi.spyOn(operations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => {
          await work(tx); throw Error('interrupted before body transaction committed')
        }))
        await expect(execute()).rejects.toThrow('interrupted before body transaction committed')
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 1, content: '原文' })
        expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationBefore.id }, include: { sceneTasks: true, bridge: true } })).toEqual(compilationBefore)
        expect(await prisma.memoryExtractionJob.count({ where: { chapterId: f.chapterId } })).toBe(0)
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'chapter_write' } } })).toBe(0)
      }
      if (scenario === 'stale-body') {
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者新文', revision: { increment: 1 } } })
        expect(await execute()).toMatchObject({ outcome: 'failed', failureCode: 'CHAPTER_REVISION_CONFLICT' })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '作者新文', revision: 2 })
        expect(fetcher).not.toHaveBeenCalled(); return
      }
      if (scenario === 'narrowed-policy') {
        await prisma.agentSession.update({ where: { id: f.sessionId }, data: { toolPolicy: { contentWrite: 'deny' } } })
        await expect(execute()).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 1, content: '原文' })
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'chapter_write' } } })).toBe(0)
        expect(fetcher).not.toHaveBeenCalled(); return
      }
      if (resumedBody) {
        const reduction = vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after committed body'))
        await expect(execute()).rejects.toThrow('interrupted after committed body')
        reduction.mockRestore()
        const parent = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'chapter_write' }, include: { effectReceipt: true } })
        expect(parent).toMatchObject({ status: 'succeeded', effectReceipt: { result: { toolResult: { display: { chapterId: f.chapterId, revision: 2 } } } } })
        expect((await loadExecutionState(f.userId, lease.runId)).frame.state).toMatchObject({ phase: 'awaiting_operation', pendingOperationId: parent.id })
        const job = await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { idempotencyKey: `${f.chapterId}:2` } })
        expect(job.diff).toMatchObject({ durableTaskRootId: f.rootId, durableOperationId: parent.id })
        await processMemoryExtractionJob(job.id)
        expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'pending', attempts: 0 })
        const originalReceipt = parent.effectReceipt
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'ordinary-writer-resume')
        expect(await step()).toMatchObject({ kind: 'recovered' })
        expect(await prisma.agentEffectReceipt.findUniqueOrThrow({ where: { operationId: parent.id } })).toEqual(originalReceipt)
      } else expect(await execute()).toMatchObject({ display: { kind: 'chapterDiff', chapterId: f.chapterId, after: args.content, revision: 2 } })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: args.content, revision: 2 })
      expect(await prisma.storyCompilation.count({ where: { userId: f.userId } })).toBe(1)
      expect(await prisma.sceneTask.count({ where: { userId: f.userId } })).toBe(1)
      const body = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, kind: 'tool', action: 'chapter_write' }, include: { effectReceipt: true } })
      expect(body.inputSnapshot).not.toHaveProperty('input.writingManifest')
      expect(body.effectReceipt?.result).toHaveProperty('progress.kind', 'content_revision')
      expect(await prisma.agentProviderAttempt.findMany({ where: { id: { in: originalAttempts.map(row => row.id) } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })).toEqual(originalAttempts)
      expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(originalLedger)
      if (fullChain) {
        await model([{ id: 'commit-current', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId: compilationBefore.id }) }])
        if (scenario === 'complete-chain') {
          const usage = originalAttempts[0].usageReceipt!
          await prisma.agentProviderUsageReceipt.update({ where: { attemptId: usage.attemptId }, data: { settlementStatus: 'pending' } })
          const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
          await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
          expect(fetcher).not.toHaveBeenCalled()
          expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
          expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilationBefore.id } })).toMatchObject({ committedAt: null })
          await prisma.agentProviderUsageReceipt.update({ where: { attemptId: usage.attemptId }, data: { settlementStatus: usage.settlementStatus } })
        }
        if (scenario === 'complete-reduce-recovery') {
          const reduction = vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after actual chapter commit'))
          await expect(step()).rejects.toThrow('interrupted after actual chapter commit')
          reduction.mockRestore()
          expect(await step()).toMatchObject({ kind: 'recovered' })
        } else expect(await step()).toMatchObject({ kind: 'tool', result: { summary: '章节已提交' } })
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationBefore.id } })).toMatchObject({ status: 'completed', stage: 'commit',
          validation: { independentCheck: 'complete', checkedRevision: 2, continuityReport: { complete: true, revision: 2 } } })
        expect(await prisma.chapterQualityReport.findFirstOrThrow({ where: { userId: f.userId, chapterId: f.chapterId } })).toMatchObject({ chapterRevision: 2 })
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'chapter_bridge_commit', status: 'succeeded' } })).toBe(1)
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(4)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(4)
        const attempts = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true } })
        expect(attempts.every(row => row.usageReceipt?.settlementStatus === 'settled')).toBe(true)
      } else expect(fetcher).not.toHaveBeenCalled()
      const state = await loadExecutionState(f.userId, lease.runId)
      expect(state.frame.state).toMatchObject({ phase: 'idle', pendingOperationId: null })
      expect(state.frame.state.messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual([
        'prepare', 'scenes', 'read-body', 'real-writer', ...(fullChain ? ['commit-current'] : [])])
      expect(state.head.configurationHash).toBe(configurationHash)
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, kind: 'tool', action: 'chapter_write' } })).toBe(1)
      expect(await prisma.memoryExtractionJob.count({ where: { chapterId: f.chapterId, chapterRevision: 2 } })).toBe(1)
      const effects = await withRunLease(lease, async tx => collectDurableToolEvidence(tx, f.rootId, (await readExecutionStateInTransaction(tx, f.rootId)).frame.revision))
      const parentEvent = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `effect:${body.id}` } })
      expect(BigInt(effects.progressSequence)).toBeGreaterThanOrEqual(parentEvent.sequence)
      expect(effects.effects.find(effect => effect.operationId === body.id)).toMatchObject({ outcome: 'succeeded' })
      const memory = await withRunLease(lease, tx => collectDurableMemoryWork(tx, { id: f.rootId, novelId: f.novelId }, effects.effects))
      expect(memory).toHaveLength(1); expect(memory[0].source.operationId).toBe(body.id)
    }, undefined, '完整重写当前章节', { freezeWriting: true, writingCoordinationProtocol: 1 })
  })
})
