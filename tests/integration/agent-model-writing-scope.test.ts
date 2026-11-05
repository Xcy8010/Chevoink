import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { collectDurableCompletionEvidence } from '../../api/lib/agent/runtime-completion-evidence.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { taskScopeBindTool } from '../../api/lib/agent/tools/task-scope-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { storyCompilerPrepareTool, sceneTaskBuildTool, chapterBridgeGetTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'

describe.runIf(available)('main Agent scope through the durable saved cursor', () => {
  it('rejects a cancelled owner before the model binding can be committed', () => fixture(async f => {
    const lease = await claim(f)
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [{ type: 'function', function: { name: taskScopeBindTool.name, description: taskScopeBindTool.description, parameters: z.toJSONSchema(taskScopeBindTool.parameters, { io: 'input' }) } }],
      toolAuthority: [{ name: taskScopeBindTool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'assistant', content: null, toolCalls: [{ id: 'late-binding', name: taskScopeBindTool.name,
          arguments: JSON.stringify({ intent: 'revise', targets: [{ chapterId: f.chapterId }] }) }] }], successfulToolSignatures: [] } })
    await pauseDurableTask(f.userId, f.runId)
    await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toBeDefined()
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId, metadata: { path: ['agentWritingScopeBinding'], equals: true } } })).toBe(0)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
  }, undefined, '把对白处理自然并保存。', { agentWritingProtocol: 1 }))
  it('recovers confirmed binding errors, reuses the binding and edits only the locked current chapter', () => fixture(async f => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const fetch = vi.fn(() => { throw Error('No paid provider in scope regression') }); vi.stubGlobal('fetch', fetch)
    const other = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId,
      volumeId: (await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).volumeId,
      title: '另章', content: '另一章保持不变。', orderIndex: 2, orderInVolume: 2 } })
    const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
    const lease = await claim(f), tools = [taskScopeBindTool, chapterReadTool, storyCompilerPrepareTool, sceneTaskBuildTool, chapterEditRangeTool, chapterBridgeGetTool, chapterBridgeCommitTool]
    const binding = { intent: 'revise', targets: [{ chapterId: f.chapterId }], requiredChecks: [] }
    const calls = [
      { id: 'unbound-prepare', name: storyCompilerPrepareTool.name, arguments: JSON.stringify({ chapterId: f.chapterId, intentSummary: '模型可根据工具反馈先确定正文任务' }) },
      { id: 'invalid-target', name: taskScopeBindTool.name, arguments: JSON.stringify({ ...binding, targets: [{ chapterId: randomUUID() }] }) },
      { id: 'bind', name: taskScopeBindTool.name, arguments: JSON.stringify(binding) },
      { id: 'bind-again', name: taskScopeBindTool.name, arguments: JSON.stringify(binding) },
      { id: 'read', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: f.chapterId }) },
      { id: 'prepare', name: storyCompilerPrepareTool.name, arguments: JSON.stringify({ chapterId: f.chapterId, intentSummary: '按原作者请求准备当前章节' }) },
      { id: 'scenes', name: sceneTaskBuildTool.name, arguments: JSON.stringify({ tasks: [{ purpose: '合成对白', goal: '询问', obstacle: '犹豫', choice: '说清楚', cost: '坦白', turn: '说出请求' }] }) },
      { id: 'edit', name: chapterEditRangeTool.name, arguments: JSON.stringify({ chapterId: f.chapterId, oldText: '原文', newText: '自然的对白' }) },
      { id: 'read-other', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: other.id }) },
      { id: 'edit-other', name: chapterEditRangeTool.name, arguments: JSON.stringify({ chapterId: other.id, oldText: '保持不变', newText: '不该修改' }) },
    ]
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '这一页对白像播报，调自然一点并落到稿子里。' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
    const signal = new AbortController().signal
    for (const call of calls) {
      const step = await executeDurableToolStep(lease, signal)
      expect(step.kind).toBe('tool')
      if (step.kind !== 'tool') throw Error('Expected tool receipt')
      expect(step.result.outcome === 'failed', call.id).toBe(['unbound-prepare', 'invalid-target', 'edit-other'].includes(call.id))
    }
    expect(await executeDurableToolStep(lease, signal)).toEqual({ kind: 'idle' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '自然的对白', revision: 2 })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: other.id } })).toEqual(other)
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId, metadata: { path: ['agentWritingScopeBinding'], equals: true } } })).toBe(1)
    const effective = await prisma.$transaction(tx => readWritingScope(tx, f))
    expect(effective.writing).toMatchObject({ kind: 'bounded', targets: [{ chapterId: f.chapterId }] })
    const after = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
    expect(after.inputHash).toBe(root.inputHash)
    expect(after.specSnapshot).toEqual(root.specSnapshot)
    expect(after.requestSnapshot).toEqual(root.requestSnapshot)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(budget)
    const current = await loadExecutionState(f.userId, f.runId)
    const candidate = await saveExecutionState(lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'assistant', content: '已完成' }] } })
    const evidence = await collectDurableCompletionEvidence(lease, { expectedRevision: candidate.revision, expectedHash: candidate.snapshotHash })
    expect(evidence.snapshot).toMatchObject({ blockers: expect.arrayContaining([{ code: 'writing_delivery_missing', reference: f.rootId }]) })
    await saveExecutionState(lease, { expectedRevision: candidate.revision, expectedHash: candidate.snapshotHash,
      snapshot: { ...candidate.state, messages: [...candidate.state.messages, { role: 'assistant', content: null, toolCalls: [
        { id: 'bridge', name: chapterBridgeGetTool.name, arguments: '{}' },
        { id: 'commit', name: chapterBridgeCommitTool.name, arguments: JSON.stringify({ chapterSummary: '已保存自然对白' }) },
      ] }] } })
    expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool' })
    expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { summary: '章节已提交' } })
    const committed = await loadExecutionState(f.userId, f.runId)
    const final = await saveExecutionState(lease, { expectedRevision: committed.frame.revision, expectedHash: committed.frame.snapshotHash,
      snapshot: { ...committed.frame.state, messages: [...committed.frame.state.messages, { role: 'assistant', content: '已修改并保存当前章节。' }] } })
    const complete = await collectDurableCompletionEvidence(lease, { expectedRevision: final.revision, expectedHash: final.snapshotHash })
    expect(complete.snapshot).toMatchObject({ blockers: [] })
    expect(runtimeJson(root.specSnapshot).hash).toBe(runtimeJson(after.specSnapshot).hash)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  }, undefined, '这一页对白像播报，调自然一点并落到稿子里。', { agentWritingProtocol: 1, reviewProtocol: 1 }))
})
