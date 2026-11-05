import { expect, it, vi } from 'vitest'
import { fixture, claim, reported } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { modelRouteRevision, prepareModelCursorOperation } from '../../api/lib/agent/runtime-model-cursor.js'
import { currentNativeToolViews, type NativeToolView } from '../../api/lib/agent/runtime-tool-view.js'
import { toOpenAIParameters } from '../../api/lib/agent/tool-schema.js'
import { chapterCreateTool, chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { prepareProviderAttempt, markProviderDispatched, recordProviderUsage, recordProviderResult } from '../../api/lib/agent/runtime-operations.js'
import { settleProviderOperation } from '../../api/lib/agent/runtime-settlement.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { advanceDurableContext } from '../../api/lib/agent/runtime-checkpoint-step.js'
import { AGENT_TOOL_EXECUTION_POLICY } from '../../api/lib/agent/tool-execution-guidance.js'
import { COLLABORATION_MARKER, readWritingCollaborationDigest } from '../../api/lib/agent/writing-collaboration.js'

it('recovers a paid historical combined create once, then creates a real empty identity before a separate body write', async () => {
  await fixture(async f => {
    const fetch = vi.fn(() => { throw new Error('no provider permitted in this regression') }); vi.stubGlobal('fetch', fetch)
    const lease = await claim(f), signal = new AbortController().signal
    const frozen: NativeToolView[] = [chapterCreateTool, chapterWriteTool].map(tool => ({ type: 'function', function: { name: tool.name, description: '冻结旧工具说明', parameters: toOpenAIParameters(tool.parameters) } }))
    const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://fixture.invalid', reasoningEffort: 'high' }
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) }, tools: frozen,
      toolAuthority: frozen.map(tool => ({ name: tool.function.name, permission: 'allow' as const, alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'system', content: AGENT_TOOL_EXECUTION_POLICY }, { role: 'user', content: COLLABORATION_MARKER + '这是作者原话，必须保留。' }], successfulToolSignatures: [] } })
    const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'chapter-identity-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
    const model = async (tools: NativeToolView[], name: string, args: Record<string, unknown>, callId: string) => {
      const { frame } = await loadExecutionState(f.userId, f.runId)
      const request = { endpoint: route.endpoint, body: { tools } }
      const prepared = await prepareModelCursorOperation(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, { key: `exec:${frame.state.nextOperationSequence}`, action: 'workspaceAgent', request, price })
      const attempt = await prepareProviderAttempt(lease, { operationId: prepared.operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request })
      expect(await advanceDurableContext(lease)).toBeNull()
      expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).requestSnapshot).toEqual(attempt.requestSnapshot)
      await markProviderDispatched(lease, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      await recordProviderUsage({ ...identity, revision: 1, usage: reported })
      await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: callId, name, arguments: JSON.stringify(args) }], usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } } })
      expect(await settleProviderOperation({ ...identity, lease })).toMatchObject({ status: 'settled' })
      await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
    }
    await model(frozen, 'chapter_create', { title: '历史新章', content: '已取得的旧正文，继续时不丢弃。' }, 'old-create')
    expect(await advanceDurableContext(lease)).toBeNull()
    expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { display: { kind: 'chapterDiff', after: '已取得的旧正文，继续时不丢弃。' } } })
    expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'idle' })
    expect(await prisma.chapter.count({ where: { novelId: f.novelId, title: '历史新章' } })).toBe(1)
    const views = await currentNativeToolViews(frozen, f.spec.scope)
    expect(views[0].function.parameters).not.toHaveProperty('properties.content')
    await model(views, 'chapter_create', { title: '空章身份' }, 'new-create')
    const created = await executeDurableToolStep(lease, signal)
    expect(created).toMatchObject({ kind: 'tool', result: { display: { kind: 'chapterRef', wordCount: 0 } } })
    const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: f.novelId, title: '空章身份' } })
    expect(chapter.content).toBe('')
    expect(await advanceDurableContext(lease)).not.toBeNull()
    expect(await advanceDurableContext(lease)).toBeNull()
    const digest = await prisma.$transaction(tx => readWritingCollaborationDigest(tx, { userId: f.userId, novelId: f.novelId, runId: f.runId }))
    expect(digest).toContain('空章，正文未写入')
    const state = await loadExecutionState(f.userId, f.runId)
    expect(state.frame.state.messages).toContainEqual({ role: 'user', content: COLLABORATION_MARKER + '这是作者原话，必须保留。' })
    await model(views, 'chapter_write', { chapterId: chapter.id, content: '通过真实身份另行保存的新正文。' }, 'new-write')
    expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { display: { chapterId: chapter.id, after: '通过真实身份另行保存的新正文。' } } })
    expect(await prisma.chapter.count({ where: { novelId: f.novelId, title: '空章身份' } })).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  }, undefined, '写后续章节正文')
})
