import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { setAdminUsersSuspended } from '../../api/lib/admin-credit-model.js'
import { getActiveRun } from '../../api/lib/agent/active-runs.js'
import { captureUserDirectives,listActiveDirectives } from '../../api/lib/agent/context-engine.js'
import { collectDurableDeliverables } from '../../api/lib/agent/runtime-deliverables.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { readObservedBaseline } from '../../api/lib/agent/runtime-observed-baseline.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { commitOperationEffect } from '../../api/lib/agent/runtime-operations.js'
import { initializeExecutionState,loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { saveReaderPromise,updateReaderPromise,upsertStoryCharter } from '../../api/lib/agent/story-compiler.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { chapterRenameTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { directiveSaveTool,directiveSupersedeTool } from '../../api/lib/agent/tools/directive-tools.js'
import { memoryEventSaveTool,memoryRelationSaveTool } from '../../api/lib/agent/tools/memory-tools.js'
import { chapterReadTool,planReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { readerPromiseSaveTool,readerPromiseUpdateTool,storyCharterGetTool,storyCharterSaveTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { planDeleteTool,planRenameTool } from '../../api/lib/agent/tools/write-tools.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('administrator credit suspension fences durable runs', () => {
  it('pauses a non-local execution and revokes its previously acquired lease', async () => {
    await fixture(async f => {
      const lease = await claim(f)
      expect(getActiveRun(f.runId)).toBeUndefined()
      expect(await setAdminUsersSuspended([f.userId], true)).toMatchObject({ users: 1, paused: true, stoppedRuns: 1 })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('paused')
      const effect = vi.fn(async () => 'must not execute')
      await expect(withRunLease(lease, effect)).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      expect(effect).not.toHaveBeenCalled()
      await setAdminUsersSuspended([f.userId], false)
      // Restoring account access is not permission to restart a stopped task.
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
    })
  })
})

describe.runIf(available)('durable chapter rename', () => {
  it.each(['deny', 'read-only', 'ask', 'replay'] as const)('rechecks current session permission before a new effect: %s', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tool = chapterRenameTool
      const args = { chapterId: f.chapterId, title: '新标题' }
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: '', parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改标题' }, { role: 'assistant', content: null, toolCalls: [{ id: 'rename', name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const { operation } = await prepareToolCursorOperation(lease, { expectedRevision: 0, expectedHash: initial.frame.snapshotHash }, {
        key: 'exec:0', action: tool.name, callId: 'rename', targetId: f.chapterId,
        operationInput: { callId: 'rename', args }, effectiveArgs: args, normalize: parsed => tool.parameters.parse(parsed),
      })
      const work = vi.fn(async (tx: Parameters<Parameters<typeof commitOperationEffect>[3]>[0]) => {
        await tx.chapter.update({ where: { id: f.chapterId }, data: { title: args.title } })
        return { title: args.title }
      })
      if (scenario === 'replay') await commitOperationEffect(lease, operation.id, operation.inputHash, work)
      await prisma.agentSession.update({ where: { id: f.sessionId }, data: scenario === 'read-only'
        ? { sandboxMode: 'read_only' } : { toolPolicy: { contentWrite: scenario === 'ask' ? 'ask' : 'deny' } } })
      if (scenario === 'replay') {
        await expect(commitOperationEffect(lease, operation.id, operation.inputHash, work)).resolves.toMatchObject({ operationId: operation.id })
        expect(work).toHaveBeenCalledOnce()
      } else {
        await expect(commitOperationEffect(lease, operation.id, operation.inputHash, work)).rejects.toMatchObject({ code: scenario === 'ask' ? 'RUNTIME_APPROVAL_REQUIRED' : 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(work).not.toHaveBeenCalled()
        expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(0)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).title).toBe('原章')
      }
    })
  })
  it.each(['rename', 'unread', 'stale', 'protected'] as const)('%s preserves the chapter body', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tools = [chapterReadTool, chapterRenameTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改章节标题' }, { role: 'assistant', content: null, toolCalls: [
            ...(scenario === 'unread' ? [] : [{ id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) }]),
            { id: 'rename', name: 'chapter_rename', arguments: JSON.stringify({ chapterId: f.chapterId, title: '新的章节标题' }) },
          ] }], successfulToolSignatures: [] } })
      if (scenario !== 'unread') await executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, title: '作者已改标题' } })
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      if (scenario === 'protected') await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow()
      else {
        const result = await executeDurableToolStep(lease, new AbortController().signal)
        expect(result).toMatchObject({ kind: 'tool', result: scenario === 'rename' ? { observedState: { kind: 'chapter', revision: before.revision + 1 } } : { outcome: 'failed' } })
      }
      const after = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(after.content).toBe(before.content)
      expect(after.title).toBe(scenario === 'rename' ? '新的章节标题' : before.title)
      expect(await prisma.memoryExtractionJob.count({ where: { novelId: f.novelId } })).toBe(0)
    })
  })
})

describe.runIf(available)('task-scoped author directives', () => {
  it('does not promote a temporary instruction into a permanent novel constraint', async () => {
    await fixture(async f => {
      const prompt = '本次必须在不同窗口处理。以后必须保持第三人称。'
      const capture = (taskSpec: typeof f.spec) => captureUserDirectives({ userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        chapterId: null, sourceMessageId: f.sourceMessageId, taskSpec, prompt })
      const first = await capture(f.spec)
      expect(first.find(item => item.text.includes('本次'))).toMatchObject({ scope: 'task', taskSpecId: f.spec.id })
      expect(first.find(item => item.text.includes('以后'))).toMatchObject({ scope: 'global' })
      const next = buildTaskSpec({ runId: randomUUID(), novelId: f.novelId, chapterId: null, prompt: '新的任务' })
      const applicable = await listActiveDirectives(f.userId, f.novelId, { sessionId: f.sessionId, taskSpecId: next.id })
      expect(applicable.map(item => item.text)).toEqual(['以后必须保持第三人称'])
      const second = await capture(next)
      expect(second.find(item => item.scope === 'task')?.id).not.toBe(first.find(item => item.scope === 'task')?.id)
      expect(second.find(item => item.scope === 'global')?.id).toBe(first.find(item => item.scope === 'global')?.id)
    })
  })
  it('retains global/current directives but excludes older tasks and other chapters in the same work', async () => {
    await fixture(async f => {
      const base = { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, kind: 'must' as const, sourceMessageId: f.runId }
      await prisma.userDirective.createMany({ data: [
        { ...base, scope: 'global', text: '全书长期要求' },
        { ...base, scope: 'chapter', chapterId: f.chapterId, text: '本章要求' },
        { ...base, scope: 'chapter', chapterId: randomUUID(), text: '旧第13章要求' },
        { ...base, scope: 'task', taskSpecId: f.spec.id, text: '本任务要求' },
        { ...base, scope: 'task', taskSpecId: randomUUID(), text: '旧任务多窗口要求' },
        { ...base, scope: 'task', text: '本run兼容要求' },
        { ...base, scope: 'task', sourceMessageId: randomUUID(), text: '旧run兼容要求' },
      ] })
      const scope = { sessionId: f.sessionId, chapterId: f.chapterId, runId: f.runId }
      const visible = await listActiveDirectives(f.userId, f.novelId, scope)
      expect(visible.map(item => item.text).sort()).toEqual(['全书长期要求', '本章要求', '本任务要求', '本run兼容要求'].sort())
      expect(await listActiveDirectives(f.userId, f.novelId)).toHaveLength(7)
      const nextTask = await listActiveDirectives(f.userId, f.novelId, { ...scope, runId: randomUUID(), taskSpecId: randomUUID(), chapterId: null })
      expect(nextTask.map(item => item.text)).toEqual(['全书长期要求'])
    })
  })
})

describe.runIf(available)('story memory graph transaction boundary', () => {
  it.each(['event', 'relation', 'unread-source', 'revision-without-source'] as const)('%s uses a durable receipt without duplicate graph writes', async scenario => {
    await fixture(async f => {
      const lease = await claim(f), tool = scenario === 'relation' ? memoryRelationSaveTool : memoryEventSaveTool
      const args = scenario === 'relation' ? { fromName: '甲', toName: '乙', relationType: '同袍', confidence: 0.8 }
        : { title: '夜巡', description: '发现火光', confidence: 0.8,
          ...(scenario === 'unread-source' ? { sourceChapterId: f.chapterId } : scenario === 'revision-without-source' ? { revision: 1 } : {}) }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '保存本次确认的事件与关系' }, { role: 'assistant', content: null,
            toolCalls: [{ id: 'save-memory-graph', name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const failed = scenario === 'unread-source' || scenario === 'revision-without-source'
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: failed ? { outcome: 'failed' } : { savedMemoryId: expect.any(String) } })
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'idle' })
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(failed ? 0 : 1)
      expect(await prisma.storyEvent.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.storyEntity.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(1)
      if (!failed) {
        const memory = await prisma.projectMemoryEntry.findFirstOrThrow({ where: { novelId: f.novelId } })
        expect(memory.reviewStatus).toBe('pending')
        await storyMemory.resolveMemoryReview(f.userId, memory.id, true)
        expect(await prisma.storyEvent.count({ where: { novelId: f.novelId, status: 'confirmed' } })).toBe(scenario === 'event' ? 1 : 0)
        expect(await prisma.storyEntity.count({ where: { novelId: f.novelId } })).toBe(scenario === 'relation' ? 2 : 0)
        expect(await prisma.entityRelation.count({ where: { sourceId: memory.id } })).toBe(scenario === 'relation' ? 1 : 0)
        await expect(storyMemory.resolveMemoryReview(f.userId, memory.id, true)).rejects.toMatchObject({ code: 'MEMORY_REVIEW_STALE' })
        // Editing prose must not leave previously projected structured facts active.
        const edited = await storyMemory.updateStoryMemoryEntry(f.userId, memory.id, { content: '作者修改了原事实', expectedVersion: 2 })
        expect(await prisma.storyEvent.count({ where: { novelId: f.novelId, status: 'confirmed' } })).toBe(0)
        expect(await prisma.entityRelation.count({ where: { sourceId: memory.id } })).toBe(0)
        await storyMemory.deleteStoryMemoryEntry(f.userId, memory.id, edited.version)
        expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ status: 'invalid' })
      }
    })
  })

  it.each(['event', 'relation'] as const)('%s rolls back graph and memory together', async kind => {
    await fixture(async f => {
      const invoke = (tx?: Prisma.TransactionClient) => kind === 'event'
        ? storyMemory.saveStoryEvent({ userId: f.userId, novelId: f.novelId, sourceId: f.runId, title: '夜巡', description: '发现异常火光', participants: [], causes: [], effects: [], confidence: 0.8 }, tx)
        : storyMemory.saveEntityRelation({ userId: f.userId, novelId: f.novelId, sourceId: f.runId, fromName: '陈砚', toName: '赵得胜', relationType: '同袍', confidence: 0.8 }, tx)
      await expect(prisma.$transaction(async tx => {
        await invoke(tx)
        throw new Error('fixture graph rollback')
      })).rejects.toThrow('fixture graph rollback')
      expect(await prisma.storyEvent.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.storyEntity.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      const saved = await invoke()
      expect(await prisma.projectMemoryEntry.findUnique({ where: { id: saved.savedMemoryId } })).toMatchObject({ novelId: f.novelId })
    })
  })
})

describe.runIf(available)('reader promise transaction boundary', () => {
  it.each(['save', 'update', 'stale', 'unread', 'rollback'] as const)('%s uses the observed charter and promise bundle', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const input = { title: '揭示内鬼', promise: '公布证据链', payoffHorizon: '本卷末', priority: 50 }
      const promise = scenario === 'save' ? null : await saveReaderPromise(f.userId, f.novelId, input)
      const tool = promise ? readerPromiseUpdateTool : readerPromiseSaveTool
      const args = promise ? { promiseId: promise.id, status: 'deferred' } : input
      const tools = [storyCharterGetTool, tool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'plan', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: z.toJSONSchema(item.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(item => ({ name: item.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '整理承诺' }, { role: 'assistant', content: null, toolCalls: [
            ...(scenario === 'unread' ? [] : [{ id: 'read', name: storyCharterGetTool.name, arguments: '{}' }]),
            { id: 'write', name: tool.name, arguments: JSON.stringify(args) },
          ] }], successfulToolSignatures: [] } })
      const invoke = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario !== 'unread') await invoke()
      if (scenario === 'stale') await prisma.readerPromise.update({ where: { id: promise!.id }, data: { promise: '作者刚修改的承诺' } })
      if (scenario === 'rollback') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => {
          await work(tx); throw new Error('fixture promise effect rollback')
        }))
        await expect(invoke()).rejects.toThrow('fixture promise effect rollback')
        expect((await prisma.readerPromise.findUniqueOrThrow({ where: { id: promise!.id } })).status).toBe('open')
      }
      expect(await invoke()).toMatchObject({ kind: 'tool', result: ['stale', 'unread'].includes(scenario) ? { outcome: 'failed' } : { observedState: { kind: 'charter' } } })
      expect(await invoke()).toMatchObject({ kind: 'idle' })
      const records = await prisma.readerPromise.findMany({ where: { novelId: f.novelId } })
      expect(records).toHaveLength(1)
      expect(records[0].status).toBe(['update', 'rollback'].includes(scenario) ? 'deferred' : 'open')
      if (scenario === 'stale') expect(records[0].promise).toBe('作者刚修改的承诺')
    })
  })

  it('rolls back with its caller and rejects payoff without a saved chapter', async () => {
    await fixture(async f => {
      const input = { title: '揭示内鬼', promise: '公布证据链', payoffHorizon: '本卷末', priority: 50 }
      await expect(prisma.$transaction(async tx => {
        await saveReaderPromise(f.userId, f.novelId, input, tx)
        throw new Error('fixture promise rollback')
      })).rejects.toThrow('fixture promise rollback')
      expect(await prisma.readerPromise.count({ where: { novelId: f.novelId } })).toBe(0)
      const promise = await saveReaderPromise(f.userId, f.novelId, input)
      const update = { userId: f.userId, novelId: f.novelId, promiseId: promise.id, status: 'paid' as const }
      await expect(updateReaderPromise({ ...update, paidAtChapter: 999 })).rejects.toMatchObject({ code: 'PAYOFF_CHAPTER_REQUIRED' })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const paid = await updateReaderPromise({ ...update, paidAtChapter: chapter.orderIndex })
      expect(await updateReaderPromise({ ...update, paidAtChapter: chapter.orderIndex })).toEqual(paid)
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '' } })
      await expect(updateReaderPromise({ ...update, paidAtChapter: chapter.orderIndex })).rejects.toMatchObject({ code: 'PAYOFF_CHAPTER_REQUIRED' })
    })
  })
})

describe.runIf(available)('saved task directive identity', () => {
  it.each(['save', 'rollback', 'denied', 'replace', 'cancel', 'old-scope', 'replace-rollback'] as const)('%s commits the directive and receipt together', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const replacing = ['replace', 'cancel', 'old-scope', 'replace-rollback'].includes(scenario)
      const tool = replacing ? directiveSupersedeTool : directiveSaveTool
      const originalDirective = replacing ? await prisma.userDirective.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        taskSpecId: scenario === 'old-scope' ? randomUUID() : f.rootId, sourceMessageId: f.runId, scope: 'task', kind: 'must', text: '旧约束' } }) : null
      const args = originalDirective ? { directiveId: originalDirective.id, ...(scenario === 'cancel' ? {} : { replacementText: '新约束' }) }
        : { text: '本次只处理第19章', kind: 'must', scope: 'task' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'plan', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: scenario === 'denied' ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '本次只处理第19章' }, { role: 'assistant', content: null, toolCalls: [{ id: 'save-directive', name: tool.name,
            arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const original = runtimeOperations.commitOperationEffect
      if (scenario === 'rollback' || scenario === 'replace-rollback') vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce(async (token, operationId, hash, work) => original(token, operationId, hash, async tx => {
        await work(tx)
        throw new Error('fixture directive rollback')
      }))
      const invoke = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'rollback' || scenario === 'replace-rollback') {
        await expect(invoke()).rejects.toThrow('fixture directive rollback')
        expect(await prisma.userDirective.count({ where: { userId: f.userId } })).toBe(originalDirective ? 1 : 0)
        if (originalDirective) expect((await prisma.userDirective.findUniqueOrThrow({ where: { id: originalDirective.id } })).status).toBe('active')
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      }
      expect(await invoke()).toMatchObject({ kind: 'tool', result: scenario === 'denied' || scenario === 'old-scope' ? { outcome: 'failed' }
        : { summary: replacing ? scenario === 'cancel' ? '取消旧指令' : '替代旧指令' : '保存must指令' } })
      expect(await invoke()).toMatchObject({ kind: 'idle' })
      expect(await prisma.userDirective.count({ where: { userId: f.userId, taskSpecId: f.rootId } })).toBe(scenario === 'denied' || scenario === 'old-scope' ? 0 : replacing && scenario !== 'cancel' ? 2 : 1)
      if (originalDirective) expect((await prisma.userDirective.findUniqueOrThrow({ where: { id: originalDirective.id } })).status)
        .toBe(scenario === 'old-scope' ? 'active' : scenario === 'cancel' ? 'cancelled' : 'superseded')
      expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(1)
    })
  })

  it('keeps an explicit task directive across run replacement but not a later task', async () => {
    await fixture(async f => {
      const ctx: ToolContext = { ...f, callId: 'save-directive', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
        signal: new AbortController().signal, emit: () => {} }
      const first = await directiveSaveTool.execute(ctx, { text: '本次只处理第19章', kind: 'must', scope: 'task' })
      expect(await directiveSaveTool.execute(ctx, { text: '本次只处理第19章', kind: 'must', scope: 'task' })).toEqual(first)
      const saved = await prisma.userDirective.findFirstOrThrow({ where: { userId: f.userId, sourceMessageId: f.runId } })
      expect(saved.taskSpecId).toBe(f.rootId)
      const resumed = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'queued', taskRootId: f.rootId, runtimeProtocolVersion: 1 } })
      expect(await directiveSaveTool.execute({ ...ctx, runId: resumed.id }, { text: '本次只处理第19章', kind: 'must', scope: 'task' })).toEqual(first)
      expect((await listActiveDirectives(f.userId, f.novelId, { sessionId: f.sessionId, runId: resumed.id })).map(item => item.id)).toContain(saved.id)
      expect(await listActiveDirectives(f.userId, f.novelId, { sessionId: f.sessionId, taskSpecId: randomUUID() })).toEqual([])
      expect(await directiveSaveTool.execute({ ...ctx, chapterId: null }, { text: '章节约束', kind: 'must', scope: 'chapter' })).toMatchObject({ outcome: 'failed' })
      expect(await prisma.userDirective.count({ where: { userId: f.userId } })).toBe(1)
    })
  })
})

describe.runIf(available)('durable plan metadata', () => {
  it.each(['plan_rename', 'plan_delete'] as const)('%s commits with a verified baseline and preserves stored content', async action => {
    await fixture(async f => {
      const plan = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '原计划', content: '计划正文不得丢失', metadata: { savedAsPlan: true } } })
      const lease = await claim(f), tools = [planReadTool, planRenameTool, planDeleteTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'plan', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '调整这份计划' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'read-plan', name: 'plan_read', arguments: JSON.stringify({ planId: plan.id }) },
            { id: 'change-plan', name: action, arguments: JSON.stringify({ planId: plan.id, ...(action === 'plan_rename' ? { title: '新的计划' } : {}) }) },
          ] }], successfulToolSignatures: [] } })
      await executeDurableToolStep(lease, new AbortController().signal)
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { observedState: { kind: 'plan', id: plan.id } } })
      const saved = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: plan.id } })
      expect(saved.content).toBe(plan.content)
      expect(saved.title).toBe(action === 'plan_rename' ? '新的计划' : plan.title)
      expect(saved.metadata).toMatchObject({ savedAsPlan: action !== 'plan_delete' })
      const state = await loadExecutionState(f.userId, f.runId)
      const deliverables = await withRunLease(lease, async tx => {
        const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
        return collectDurableDeliverables(tx, root, (await collectDurableToolEvidence(tx, root.id, state.frame.revision)).effects)
      })
      expect(deliverables).toEqual([expect.objectContaining({ kind: 'plan', id: plan.id, status: action === 'plan_delete' ? 'removed' : 'current' })])
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'idle' })
      expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: plan.id } })).updatedAt).toEqual(saved.updatedAt)
    })
  })
})

describe.runIf(available)('durable charter save', () => {
  it.each(['create', 'plan', 'stale', 'unread', 'rollback', 'same-content'] as const)('%s preserves observed charter and commits once', async scenario => {
    await fixture(async f => {
      const args = storyCharterSaveTool.parameters.parse({ oneLinePromise: '寻找失落证据', targetAudience: '悬疑读者', protagonistDesire: '寻找真相',
        protagonistFear: '失去亲人', protagonistMisbelief: '证据不会骗人', protagonistNonNegotiable: '不伤害无辜者',
        conflictEngine: '证据互相矛盾', relationshipEngine: '互不信任的同伴', emotionalBaseline: '克制', emotionalRange: '从怀疑到信任' })
      const lease = await claim(f), tools = [storyCharterGetTool, storyCharterSaveTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: scenario === 'plan' ? 'plan' : 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '建立创作宪章' }, { role: 'assistant', content: null, toolCalls: [
            ...(scenario === 'unread' ? [] : [{ id: 'read', name: 'story_charter_get', arguments: '{}' }]),
            { id: 'save', name: 'story_charter_save', arguments: JSON.stringify(args) },
            ...(scenario === 'same-content' ? [{ id: 'save-again', name: 'story_charter_save', arguments: JSON.stringify(args) }] : []),
          ] }], successfulToolSignatures: [] } })
      if (scenario !== 'unread') await executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'stale') await upsertStoryCharter(f.userId, f.novelId, { ...args, oneLinePromise: '作者刚刚修改的承诺' })
      if (scenario === 'rollback') {
        const original = storyCharterSaveTool.execute
        vi.spyOn(storyCharterSaveTool, 'execute').mockImplementationOnce(async (ctx, input) => {
          await original(ctx, input)
          throw new Error('fixture after charter write')
        })
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('fixture after charter write')
        expect(await prisma.storyCharter.count({ where: { novelId: f.novelId } })).toBe(0)
      }
      const result = await executeDurableToolStep(lease, new AbortController().signal)
      expect(result).toMatchObject({ kind: 'tool', result: ['stale', 'unread'].includes(scenario)
        ? { outcome: 'failed' } : { observedState: { kind: 'charter', id: f.novelId } } })
      const saved = await prisma.storyCharter.findUnique({ where: { novelId: f.novelId } })
      if (scenario === 'unread') expect(saved).toBeNull()
      else {
        expect(saved?.oneLinePromise).toBe(scenario === 'stale' ? '作者刚刚修改的承诺' : args.oneLinePromise)
        expect(saved?.revision).toBe(1)
      }
      if (!['stale', 'unread'].includes(scenario)) {
        const state = await loadExecutionState(f.userId, f.runId)
        expect(await withRunLease(lease, tx => readObservedBaseline(tx, f.rootId, state.frame.revision, { kind: 'charter', id: f.novelId })))
          .toMatchObject({ kind: 'charter', id: f.novelId })
      }
      if (scenario === 'same-content') {
        expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool' })
        const repeated = await prisma.storyCharter.findUniqueOrThrow({ where: { novelId: f.novelId } })
        expect(repeated.revision).toBe(saved!.revision)
        expect(repeated.updatedAt).toEqual(saved!.updatedAt)
      }
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'idle' })
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'story_charter_save' } })).toBe(scenario === 'same-content' ? 2 : 1)
    })
  })
})


