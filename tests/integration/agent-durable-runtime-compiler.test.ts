import { randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { collectDurableCompletionEvidence } from '../../api/lib/agent/runtime-completion-evidence.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import * as runtimeReducer from '../../api/lib/agent/runtime-reducer.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { initializeExecutionState,loadExecutionState,saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { loadCurrentTodoSnapshot } from '../../api/lib/agent/session-messages.js'
import { prepareStoryCompilation,recordStoryCompilerWrite,saveSceneTasks,validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { executeDurableCompiler } from '../../api/lib/agent/tools/durable-compiler.js'
import { executeDurableRead } from '../../api/lib/agent/tools/durable-read.js'
import { executeDurableTodo } from '../../api/lib/agent/tools/durable-todo.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { sessionHistorySearchTool,sessionMessageReadTool } from '../../api/lib/agent/tools/session-history-tools.js'
import { chapterBridgeCommitTool,chapterBridgeGetTool,sceneTaskBuildTool,storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { taskContextListTool,taskContextReadTool } from '../../api/lib/agent/tools/task-context-tools.js'
import { todoWriteTool,withTodoIds } from '../../api/lib/agent/tools/todo-tools.js'
import type { AgentTool,ToolContext } from '../../api/lib/agent/tools/types.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('durable compiler dispatch', () => {
  it.each(['chain', 'resume', 'prepare-gap', 'scene-gap', 'replay', 'stale', 'foreign', 'missing', 'approval-denied', 'commit', 'commit-gap', 'commit-no-quality', 'commit-stale'] as const)('%s preserves compilation identity and atomic effects', async scenario => {
    await fixture(async f => {
      vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      let lease = await claim(f)
      const prepareArgs = { chapterId: f.chapterId, intentSummary: '先准备本章，然后构建场景并写入' }
      let foreignId: string | undefined
      if (scenario === 'foreign') {
        const otherSession = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '其他任务' } })
        const prompt = '修改第一章'
        const other = await prisma.agentRun.create({ data: { sessionId: otherSession.id, userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', engine: 'loop', startRequest: { prompt } } })
        const otherSpec = await prisma.$transaction(tx => freezeWritingScope(tx, { ...f, runId: other.id }, buildTaskSpec({ ...f, runId: other.id, prompt }), prompt))
        await prisma.agentRun.update({ where: { id: other.id }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(otherSpec))).value } })
        foreignId = (await prepareStoryCompilation({ ...f, runId: other.id, mode: 'balanced', intentSummary: '其他任务' })).compilation.id
      }
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      const sceneArgs = { ...(foreignId ? { compilationId: foreignId } : {}), tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] }
      const tools = [storyCompilerPrepareTool, sceneTaskBuildTool, chapterBridgeGetTool, chapterReadTool, chapterWriteTool, chapterBridgeCommitTool]
      const calls = [...(scenario === 'missing' ? [] : [{ id: 'prepare', name: 'story_compiler_prepare', arguments: JSON.stringify(prepareArgs) }]),
        { id: 'scene', name: 'scene_task_build', arguments: JSON.stringify(sceneArgs) },
        { id: 'bridge', name: 'chapter_bridge_get', arguments: '{}' },
        ...(scenario === 'stale' ? [{ id: 'scene-after-read', name: 'scene_task_build', arguments: JSON.stringify(sceneArgs) }] : []),
        { id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
        { id: 'write', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '他绕过锁门，在墙根发现了脚印。' }) },
        ...(scenario.startsWith('commit') ? [{ id: 'refresh', name: 'chapter_bridge_get', arguments: '{}' }, { id: 'commit', name: 'chapter_bridge_commit', arguments: '{}' }, { id: 'commit-again', name: 'chapter_bridge_commit', arguments: '{}' }] : [])]
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval-denied' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '准备本章并写入' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'approval-denied') {
        const waiting = await step()
        if (waiting.kind !== 'waiting_approval') throw new Error('Expected approval')
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'prepare', approved: false, alwaysAllow: false })
        expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(0)
        return
      }
      const injectRollback = () => {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => { await work(tx); throw new Error('fixture-compiler-rollback') }))
      }
      if (scenario === 'prepare-gap') {
        injectRollback()
        await expect(step()).rejects.toThrow('fixture-compiler-rollback')
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(0)
      }
      const prepared = await step()
      if (scenario === 'missing') {
        expect(prepared).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(await prisma.sceneTask.count({ where: { novelId: f.novelId } })).toBe(0)
        return
      }
      if (prepared.kind !== 'tool' || prepared.result.display?.kind !== 'storyCompiler') throw new Error('Expected compilation')
      const id = prepared.result.display.compilationId!
      if (scenario === 'replay') {
        const tool: AgentTool = { ...storyCompilerPrepareTool, execute: (ctx, args) => storyCompilerPrepareTool.execute(ctx, storyCompilerPrepareTool.parameters.parse(args)) }
        const ctx: ToolContext = { ...f, mode: 'build', callId: 'prepare', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {},
          durableCompiler: { lease, cursor: { expectedRevision: 0, expectedHash: initialized.frame.snapshotHash }, operationKey: 'exec:0', baseline: null } }
        expect(await executeDurableCompiler(ctx, tool, prepareArgs)).toEqual(prepared.result)
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(1)
      }
      if (scenario === 'resume') {
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'scene-resume-worker')
      }
      if (scenario === 'stale') await prisma.storyCompilation.update({ where: { id }, data: { preparedContext: { changed: true } } })
      if (scenario === 'scene-gap') {
        injectRollback()
        await expect(step()).rejects.toThrow('fixture-compiler-rollback')
        expect(await prisma.sceneTask.count({ where: { compilationId: id } })).toBe(0)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id } })).stage).toBe('prepare')
      }
      const scenes = await step()
      if (scenario === 'stale' || scenario === 'foreign') {
        expect(scenes).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(await prisma.sceneTask.count({ where: { novelId: f.novelId } })).toBe(0)
        if (scenario === 'foreign') return
        await step() // Refresh the exact original compilation, not another task.
        expect(await step()).toMatchObject({ kind: 'tool', result: { display: { kind: 'storyCompiler', compilationId: id } } })
      } else {
        expect(scenes).toMatchObject({ kind: 'tool', result: { display: { kind: 'storyCompiler', compilationId: id } } })
        expect(await step()).toMatchObject({ kind: 'tool', result: { display: { kind: 'storyCompiler', compilationId: id } } })
      }
      await step(); await step()
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id } })).stage).toBe('write')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: id } })).targetRevision).toBe(2)
      expect(await prisma.sceneTask.count({ where: { compilationId: id, status: 'writing' } })).toBe(1)
      if (scenario.startsWith('commit')) {
        await validateStoryContinuity({ ...f, compilationId: id, findings: [], expectedChapterRevision: 2, independentCheck: 'complete' })
        if (scenario !== 'commit-no-quality') await persistHumanityQualityReport({ ...f, compilationId: id, chapterRevision: 2,
          mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
        await step() // Save the validated compilation observation before COMMIT.
        if (scenario === 'commit-stale') await prisma.storyCompilation.update({ where: { id }, data: { preparedContext: { changed: true } } })
        if (scenario === 'commit-gap') {
          injectRollback()
          await expect(step()).rejects.toThrow('fixture-compiler-rollback')
          expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id } })).status).toBe('active')
          expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
        }
        const committed = await step()
        if (scenario === 'commit-stale' || scenario === 'commit-no-quality') {
          expect(committed).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
          expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id } })).status).toBe('active')
          expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
          if (scenario === 'commit-no-quality') {
            expect(committed).toMatchObject({ result: { failureCode: 'QUALITY_CHECK_REQUIRED' } })
            expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: id } })).committedAt).toBeNull()
            expect(await prisma.chapterQualityReport.count({ where: { compilationId: id } })).toBe(0)
          }
        } else {
          expect(committed).toMatchObject({ kind: 'tool', result: { summary: '提交章节桥与当前故事终态' } })
          const count = await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })
          expect(count).toBe(2)
          expect(await step()).toMatchObject({ kind: 'tool', result: { summary: '提交章节桥与当前故事终态' } })
          expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(count)
        }
      }
      const events = await publishDurableEvents(f.userId, lease.runId)
      expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'scene_task_build')).toMatchObject(scenario === 'stale' ? [{ ok: false }, { ok: true }] : [{ ok: true }])
    })
  })
})

describe.runIf(available)('compiler transaction and root continuity', () => {
  it.each(['prepare-rollback', 'scenes-rollback', 'resume'] as const)('%s keeps compilation, bridge and scenes consistent', async scenario => {
    await fixture(async f => {
      const initialLease = await claim(f)
      await initializeExecutionState(initialLease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '同一个章节任务' }], successfulToolSignatures: [] } })
      const input = { userId: f.userId, novelId: f.novelId, runId: f.runId, chapterId: f.chapterId, mode: 'balanced' as const, intentSummary: '同一个章节任务' }
      const original = await prepareStoryCompilation(input)
      if (scenario === 'prepare-rollback') {
        await expect(prisma.$transaction(async tx => { await prepareStoryCompilation(input, tx); throw new Error('fixture-prepare-rollback') })).rejects.toThrow('fixture-prepare-rollback')
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(1)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: original.compilation.id } })).status).toBe('active')
        expect(await prisma.chapterBridge.count({ where: { compilation: { runId: f.runId } } })).toBe(1)
        return
      }
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      const tasks = [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low' as const, dialogue: 'medium' as const, rhetoric: 'low' as const } }]
      if (scenario === 'scenes-rollback') {
        await expect(prisma.$transaction(async tx => { await saveSceneTasks({ ...input, compilationId: original.compilation.id, tasks }, tx); throw new Error('fixture-scenes-rollback') })).rejects.toThrow('fixture-scenes-rollback')
        expect(await prisma.sceneTask.count({ where: { compilationId: original.compilation.id } })).toBe(0)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: original.compilation.id } })).stage).toBe('prepare')
        await saveSceneTasks({ ...input, compilationId: original.compilation.id, tasks })
        expect(await prisma.sceneTask.count({ where: { compilationId: original.compilation.id } })).toBe(1)
        return
      }
      await saveSceneTasks({ ...input, compilationId: original.compilation.id, tasks })
      const otherSession = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '同作品另一任务窗口' } })
      const prompt = '修改第一章'
      const other = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: otherSession.id, chapterId: f.chapterId,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', engine: 'loop', startRequest: { prompt } } })
      const otherSpec = await prisma.$transaction(tx => freezeWritingScope(tx, { ...f, runId: other.id }, buildTaskSpec({ ...f, runId: other.id, prompt }), prompt))
      await prisma.agentRun.update({ where: { id: other.id }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(otherSpec))).value } })
      const otherCompilation = await prepareStoryCompilation({ ...input, runId: other.id })
      await pauseDurableTask(f.userId, f.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
      const lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'compiler-resume-worker')
      const result = await withRunLease(lease, tx => recordStoryCompilerWrite({ ...input, runId: resumed.run.id, chapterOrderIndex: 1, chapterRevision: 1 }, tx))
      expect(result).toEqual({ compilationId: original.compilation.id, stage: 'write' })
      expect((await prisma.sceneTask.findFirstOrThrow({ where: { compilationId: original.compilation.id } })).status).toBe('writing')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: original.compilation.id } })).targetRevision).toBe(1)
      await withRunLease(lease, tx => prepareStoryCompilation({ ...input, runId: resumed.run.id }, tx))
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: original.compilation.id } })).status).toBe('abandoned')
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: otherCompilation.compilation.id } })).status).toBe('active')
    })
  })
})

describe.runIf(available)('传统任务待办快照', () => {
  it('较新副本覆盖旧消息，续跑继承但新任务不串用，作者结束保持取消语义', async () => {
    await fixture(async f => {
      const original = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      const createLegacy = (id: string, taskSpec: typeof f.spec, offset: number) => prisma.agentRun.create({ data: {
        id, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, engine: 'loop', runtimeProtocolVersion: 0,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'completed',
        taskSpec, createdAt: new Date(original.createdAt.getTime() + offset),
      } })
      const firstId = randomUUID()
      const spec = buildTaskSpec({ runId: firstId, novelId: f.novelId, chapterId: f.chapterId, prompt: '检查本章并报告' })
      await createLegacy(firstId, spec, 100)
      const pending = withTodoIds([{ content: '检查正文', status: 'in_progress' }, { content: '保存报告', status: 'pending' }])
      const done = pending.map(item => ({ ...item, status: 'completed' as const }))
      await prisma.agentMessage.create({ data: { sessionId: f.sessionId, runId: firstId, role: 'assistant', createdAt: new Date(100),
        parts: runtimeJson([{ type: 'tool-call', toolName: 'todo_write', status: 'success', display: { kind: 'todoList', items: pending } }]).value } })
      await prisma.agentArtifact.create({ data: { runId: firstId, artifactType: 'chapterPlan', title: '待办', content: JSON.stringify(done), metadata: { todoList: true }, updatedAt: new Date(200) } })
      expect(await loadCurrentTodoSnapshot(f.userId, f.sessionId)).toEqual({ runId: firstId, taskId: spec.id, items: done })
      const continuationId = randomUUID()
      await createLegacy(continuationId, spec, 200)
      expect(await loadCurrentTodoSnapshot(f.userId, f.sessionId)).toEqual({ runId: continuationId, taskId: spec.id, items: done })
      const freshId = randomUUID()
      const fresh = buildTaskSpec({ runId: freshId, novelId: f.novelId, chapterId: f.chapterId, prompt: '询问其他问题' })
      await createLegacy(freshId, fresh, 300)
      expect(await loadCurrentTodoSnapshot(f.userId, f.sessionId)).toEqual({ runId: freshId, taskId: fresh.id, items: [] })
      const cancelled = pending.map(item => ({ ...item, status: 'cancelled' as const, reason: '作者结束' }))
      await prisma.agentRun.update({ where: { id: freshId }, data: { usage: { authorEnded: { fulfilled: false, todoItems: cancelled } } } })
      expect((await loadCurrentTodoSnapshot(f.userId, f.sessionId))?.items).toEqual(cancelled)
      expect(await loadCurrentTodoSnapshot('another-user', f.sessionId)).toBeNull()
    })
  })
})

describe.runIf(available)('durable task todos', () => {
  it.each(['build', 'plan', 'review', 'late', 'empty', 'single', 'replay', 'corrupt', 'rollback', 'isolation', 'resume', 'cancelled', 'pending-snapshot'] as const)('%s keeps task progress in confirmed receipts', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const mode = scenario === 'plan' || scenario === 'review' ? scenario : 'build'
      const initial = withTodoIds([{ content: '步骤一', status: 'in_progress' }, { content: '步骤二', status: 'pending' }])
      // Creation has no server-issued IDs yet; subsequent calls use the receipt IDs.
      const creation = initial.map(({ content, status }) => ({ content, status }))
      const args = { items: scenario === 'late' ? creation.map(item => ({ ...item, status: 'completed' })) : scenario === 'empty' ? [] : scenario === 'single' ? creation.slice(0, 1) : creation }
      const ignored = ['late', 'empty', 'single'].includes(scenario)
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode, agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: 'todo_write', description: todoWriteTool.description, parameters: z.toJSONSchema(todoWriteTool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: 'todo_write', permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [f.chapterId], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '分两步处理本章' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'todo-first', name: 'todo_write', arguments: JSON.stringify(args) },
            { id: 'todo-next', name: 'todo_write', arguments: JSON.stringify({ items: scenario === 'cancelled' ? initial.map(item => ({ ...item, status: 'cancelled', reason: '重复清单，剩余项不再执行' })) : [{ ...initial[0], status: 'completed' }] }) },
          ] }], successfulToolSignatures: [] } })
      let otherArtifact: { id: string; content: string } | undefined
      if (scenario === 'isolation') {
        const runId = randomUUID(), sourceMessageId = randomUUID()
        const spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: f.chapterId, prompt: '另一个任务' })
        await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)) } })
        await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: '另一个任务' }] } })
        await initializeDurableTask({ userId: f.userId, runId, sourceMessageId })
        otherArtifact = await prisma.agentArtifact.create({ data: { runId, artifactType: 'chapterPlan', title: '旧清单', content: JSON.stringify([{ content: '旧任务已完成', status: 'completed' }]), metadata: { todoList: true } } })
      }
      if (scenario === 'rollback') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => { await work(tx); throw new Error('fixture-effect-rollback') }))
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('fixture-effect-rollback')
        expect(await prisma.agentArtifact.count({ where: { runId: f.runId } })).toBe(0)
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      }
      const first = await executeDurableToolStep(lease, new AbortController().signal)
      expect(first.kind).toBe('tool')
      const artifact = await prisma.agentArtifact.findFirst({ where: { runId: f.runId } })
      expect(Boolean(artifact)).toBe(!ignored)
      if (ignored) {
        if (first.kind === 'tool') expect(first.result.outcome === 'failed').toBe(scenario !== 'empty')
        expect((await loadCurrentTodoSnapshot(f.userId, f.sessionId))?.items).toEqual([])
        return
      }
      expect(JSON.parse(artifact!.content)).toEqual(initial)
      if (scenario === 'replay') {
        const ctx: ToolContext = { ...f, mode, callId: 'todo-first', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {},
          durableTask: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: initialized.frame.snapshotHash } } }
        expect(await executeDurableTodo(ctx, args)).toEqual(first.kind === 'tool' ? first.result : undefined)
        expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: artifact!.id } })).updatedAt).toEqual(artifact!.updatedAt)
      }
      if (scenario === 'corrupt') {
        const receipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } } })
        await prisma.agentEffectReceipt.update({ where: { operationId: receipt.operationId }, data: { resultHash: '0'.repeat(64) } })
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        return
      }
      // A stale/corrupt display copy must not become the authoritative prior list.
      await prisma.agentArtifact.update({ where: { id: artifact!.id }, data: { content: 'stale UI copy' } })
      expect((await loadCurrentTodoSnapshot(f.userId, f.sessionId))?.items).toEqual(scenario === 'isolation' ? [] : initial)
      if (scenario === 'pending-snapshot') {
        const reduce = vi.spyOn(runtimeReducer, 'reduceExecutionReceipt').mockRejectedValueOnce(new Error('fixture-before-reduce'))
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('fixture-before-reduce')
        expect((await loadCurrentTodoSnapshot(f.userId, f.sessionId))?.items).toEqual(initial)
        reduce.mockRestore()
      }
      if (scenario === 'resume') {
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'todo-resume-worker')
      }
      await executeDurableToolStep(lease, new AbortController().signal)
      const expected = scenario === 'cancelled'
        ? initial.map(item => ({ ...item, status: 'cancelled', reason: '重复清单，剩余项不再执行' }))
        : [{ ...initial[0], status: 'completed' }, initial[1]]
      expect(JSON.parse((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: artifact!.id } })).content)).toEqual(expected)
      if (scenario !== 'isolation') expect(await loadCurrentTodoSnapshot(f.userId, f.sessionId)).toEqual({ runId: lease.runId, taskId: f.rootId, items: expected })
      if (scenario === 'cancelled') {
        const own = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '正文终态仍未提交' })
        const frame = (await loadExecutionState(f.userId, lease.runId)).frame
        const saved = await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: '已取消剩余清单。' }] } })
        const evidence = await collectDurableCompletionEvidence(lease, { expectedRevision: saved.revision, expectedHash: saved.snapshotHash })
        expect(evidence.snapshot).toMatchObject({ todos: expected, blockers: [{ code: 'uncommitted_compilation', reference: own.compilation.id }] })
        expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('active')
      }
      if (otherArtifact) expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: otherArtifact.id } })).content).toBe(otherArtifact.content)
      const receipts = await prisma.agentEffectReceipt.findMany({ where: { operation: { taskRootId: f.rootId } } })
      for (const receipt of receipts) expect(receipt.result).not.toHaveProperty('progress')
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId } })).toBe(1)
      if (scenario === 'build') {
        const events = await publishDurableEvents(f.userId, lease.runId)
        expect(events.filter(event => event.type === 'tool.call')).toHaveLength(2)
        const finished = events.filter(event => event.type === 'tool.result')
        expect(finished).toHaveLength(2)
        expect(finished.at(-1)).toMatchObject({ ok: true, display: { kind: 'todoList', items: expected } })
      }
    })
  })
})

describe.runIf(available)('durable history observations', () => {
  it.each(['session_history_search', 'session_message_read', 'task_context_list', 'task_context_read', 'missing-message', 'missing-task'] as const)('%s freezes historical observations without importing authority', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const action = scenario === 'missing-message' ? 'session_message_read' : scenario === 'missing-task' ? 'task_context_read' : scenario
      const checked = <T,>(tool: AgentTool<T>): AgentTool => ({ ...tool, execute: (ctx, args) => tool.execute(ctx, tool.parameters.parse(args)) })
      const tool = [checked(sessionHistorySearchTool), checked(sessionMessageReadTool), checked(taskContextListTool), checked(taskContextReadTool)].find(item => item.name === action)!
      const raw = action === 'session_history_search' ? { mode: 'first_user_prompt' } : action === 'session_message_read' ? { messageId: scenario === 'missing-message' ? 'missing' : f.sourceMessageId }
        : action === 'task_context_read' ? { sessionId: scenario === 'missing-task' ? 'missing' : f.sessionId } : {}
      const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(value) as Record<string, unknown>).filter(([, item]) => item !== undefined))
      const args = normalize(raw)
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'review', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: action, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: action, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '查阅历史记录，仅作为参考' }, { role: 'assistant', content: null, toolCalls: [{ id: 'history', name: action, arguments: JSON.stringify(raw) }] }], successfulToolSignatures: [] } })
      const result = await executeDurableToolStep(lease, new AbortController().signal)
      if (result.kind !== 'tool') throw new Error('Expected persisted history result')
      expect(result.result.outcome === 'failed').toBe(scenario.startsWith('missing'))
      await prisma.agentMessage.update({ where: { id: f.sourceMessageId }, data: { parts: [{ type: 'text', text: '改变了的历史消息' }] } })
      await prisma.agentSession.update({ where: { id: f.sessionId }, data: { title: '改变了的任务标题' } })
      const ctx: ToolContext = { ...f, callId: 'history', mode: 'review', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {},
        toolAuthority: new Map([[action, { permission: 'allow', alwaysConfirm: false, dangerous: false }]]),
        durableRead: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: initialized.frame.snapshotHash } } }
      const replay = await executeDurableRead(ctx, action, args, normalize, async () => { throw new Error('Replay must not read changed history') })
      expect(replay).toEqual(result.result)
      expect((await loadExecutionState(f.userId, f.runId)).configuration).toEqual(initialized.configuration)
    })
  })
})
