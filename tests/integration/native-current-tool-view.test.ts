import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fixture, claim, reported } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { modelRouteRevision, prepareModelCursorOperation, validateModelCursor } from '../../api/lib/agent/runtime-model-cursor.js'
import { currentNativeToolViews, type NativeToolView } from '../../api/lib/agent/runtime-tool-view.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { prepareProviderAttempt, markProviderDispatched, recordProviderUsage, recordProviderResult } from '../../api/lib/agent/runtime-operations.js'
import { settleProviderOperation } from '../../api/lib/agent/runtime-settlement.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { coordinatedWriterParameters } from '../../api/lib/agent/coordinated-writing-input.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'

// Requires the same explicitly isolated PostgreSQL fixture as the native gates.
// No live provider or availability skip is introduced by this regression.
describe('native current parameters after a historical coordination call', () => {
  it.each(['allow', 'ask'] as const)('%s reaches an ordinary CAS on the same task without changing the old configuration or receipts', async permission => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await fixture(async f => {
      const lease = await claim(f), signal = new AbortController().signal
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, dailyUsedMilli: 0, bonusBalanceMilli: 0, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1', reasoningEffort: 'high' }
      const frozen: NativeToolView[] = [chapterReadTool, chapterWriteTool].map(tool => ({ type: 'function', function: { name: tool.name,
        description: tool.name === 'chapter_write' ? '旧协调写入必须填写writing.actualOutcomes七张表' : tool.description,
        parameters: z.toJSONSchema(coordinatedWriterParameters(tool, f.spec.scope), { io: 'input' }) } }))
      const writerDefinition = frozen.find(tool => tool.function.name === 'chapter_write')!
      writerDefinition.function.parameters = { ...writerDefinition.function.parameters,
        properties: { ...(writerDefinition.function.parameters.properties as object), reviewer: { type: 'string', enum: ['author'] } },
        required: [...(writerDefinition.function.parameters.required as string[] ?? []), 'reviewer'] }
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: frozen, toolAuthority: [{ name: 'chapter_read', permission: 'allow', alwaysConfirm: false, dangerous: false }, { name: 'chapter_write', permission, alwaysConfirm: false, dangerous: false }],
        protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
      const oldConfig = runtimeJson(initial.configuration).hash
      const oldConfigHash = initial.head.configurationHash
      const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'current-view-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
      const model = async (tools: NativeToolView[], calls: Array<{ id: string; name: string; arguments: string }>, historical = false) => {
        const state = await loadExecutionState(f.userId, f.runId), frame = state.frame, cursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }
        const operationKey = `exec:${frame.state.nextOperationSequence}`
        if (!historical) await validateModelCursor(lease, cursor, { operationKey, messages: frame.state.messages, tools, tier: 'speed', route })
        const request = { endpoint: route.endpoint, body: { tools } }
        const prepared = await prepareModelCursorOperation(lease, cursor, { key: operationKey, action: 'workspaceAgent', request, price })
        const attempt = await prepareProviderAttempt(lease, { operationId: prepared.operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request })
        await markProviderDispatched(lease, attempt.id)
        const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
        await recordProviderUsage({ ...identity, revision: 1, usage: reported })
        await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: calls,
          usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } } })
        expect(await settleProviderOperation({ ...identity, lease })).toMatchObject({ status: 'settled' })
        await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
        return { operation: prepared.operation, attempt }
      }
      const original = await model(frozen, [{ id: 'old-manifest', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '旧调用不能执行', writing: { draftComplete: false } }) }], true)
      expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed', summary: '旧协调参数未执行' } })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
      const oldLedger = await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId: f.userId, kind: 'usage' } })
      const oldObservation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'chapter_write' }, include: { effectReceipt: true } })
      expect(oldObservation.effectReceipt?.result).toMatchObject({ outcome: 'failed', effectApplied: false, code: 'TOOL_CONTRACT_RETIRED' })
      const before = await loadExecutionState(f.userId, f.runId), views = await currentNativeToolViews(before.configuration.tools, f.spec.scope)
      expect(views.find(tool => tool.function.name === 'chapter_write')?.function.parameters).not.toHaveProperty('properties.writing')
      expect(views.find(tool => tool.function.name === 'chapter_write')?.function.description).not.toContain('actualOutcomes')
      await model(views, [{ id: 'current-read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
        { id: 'invalid-custom', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '错误附加约束不得写入', reviewer: 'other' }) },
        { id: 'current-write', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '当前参数实际保存的正文', reviewer: 'author' }) }])
      expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { observedState: { kind: 'chapter' } } })
      expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed', summary: '参数校验失败' } })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
      if (permission === 'ask') {
        const waiting = await executeDurableToolStep(lease, signal)
        expect(waiting.kind).toBe('waiting_approval')
        if (waiting.kind !== 'waiting_approval') throw new Error('Missing original ask approval')
        const request = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: waiting.approvalId } })
        expect(request.payload).not.toHaveProperty('writingServices')
        expect(request.payload).toMatchObject({ rawArguments: JSON.stringify({ chapterId: f.chapterId, content: '当前参数实际保存的正文', reviewer: 'author' }) })
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'current-write', approved: true, alwaysAllow: false })
      }
      const written = await executeDurableToolStep(lease, signal)
      expect(written).toMatchObject({ kind: 'tool' })
      if (written.kind === 'tool') expect(written.result.outcome).not.toBe('failed')
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(chapter).toMatchObject({ content: '当前参数实际保存的正文', revision: 2 })
      const final = await loadExecutionState(f.userId, f.runId)
      expect(runtimeJson(final.configuration).hash).toBe(oldConfig)
      expect(final.head.configurationHash).toBe(oldConfigHash)
      expect(final.configuration.tools).toEqual(frozen)
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: original.operation.id } })).toMatchObject({ inputHash: original.operation.inputHash, inputSnapshot: original.operation.inputSnapshot })
      expect(await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: original.attempt.id } })).toMatchObject({ requestHash: original.attempt.requestHash, requestSnapshot: original.attempt.requestSnapshot })
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: oldObservation.id }, include: { effectReceipt: true } })).toEqual(oldObservation)
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(2)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(2)
      expect(await prisma.creditLedgerEntry.findUniqueOrThrow({ where: { id: oldLedger.id } })).toEqual(oldLedger)
      const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId, kind: 'usage' } })
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(-ledger.reduce((total, row) => total + row.deltaMilli, 0))
      expect(fetch).not.toHaveBeenCalled()
    }, undefined, '修改本章', { freezeWriting: true, writingCoordinationProtocol: 1 })
  })
})
