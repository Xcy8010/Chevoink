import { randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { advanceDurableCompletionObligations } from '../../api/lib/agent/runtime-continuation.js'
import { collectDurableDeliverables } from '../../api/lib/agent/runtime-deliverables.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { runReviewedDurableExecution } from '../../api/lib/agent/runtime-executor.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { finalizeDurableTask,pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { advanceDurableMemory } from '../../api/lib/agent/runtime-memory.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { prepareOperation } from '../../api/lib/agent/runtime-operations.js'
import { evaluateTaskPostconditions } from '../../api/lib/agent/runtime-postconditions.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { initializeExecutionState,loadExecutionState,saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { chapterCreateTool,chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterReadTool,memorySearchTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { memorySaveTool,planSaveTool } from '../../api/lib/agent/tools/write-tools.js'
import * as credits from '../../api/lib/credits.js'
import { getStructureReportObservation } from '../../api/lib/data-access.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture,novelFixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('durable explicit memory save', () => {
  it.each(['create', 'update', 'unread', 'stale', 'missing', 'rollback', 'stopped'] as const)('%s fences explicit card writes', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const title = '原角色卡'
      const seeded = scenario !== 'create' ? await storyMemory.saveStoryMemory({ userId: f.userId, novelId: f.novelId, runId: f.runId,
        sourceChapterId: null, memoryType: 'characterCard', layer: 'L1', title, content: '原角色事实', importance: 70, confidence: 1, status: 'confirmed',
        evidence: { sourceType: 'author_input', sourceId: f.runId, confidence: 1 } }) : null
      const read = !['create', 'unread'].includes(scenario)
      const tools = [memorySearchTool, memorySaveTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '更新角色事实' }, { role: 'assistant', content: null, toolCalls: [
            ...(read ? [{ id: 'memory-read', name: 'memory_search', arguments: JSON.stringify({ query: title }) }] : []),
            { id: 'memory-write', name: 'memory_save', arguments: JSON.stringify({ memoryType: 'characterCard', title, content: '新的角色事实', importance: 80, ...(seeded ? { memoryId: seeded.id } : {}) }) },
          ] }], successfulToolSignatures: [] } })
      if (read) {
        const result = await executeDurableToolStep(lease, new AbortController().signal)
        expect(result).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining(seeded!.id) } })
      }
      if (scenario === 'stale') await prisma.projectMemoryEntry.update({ where: { id: seeded!.id }, data: { content: '作者刚更新' } })
      if (scenario === 'missing') await prisma.projectMemoryEntry.delete({ where: { id: seeded!.id } })
      if (scenario === 'stopped') await pauseDurableTask(f.userId, f.runId)
      if (scenario === 'rollback') vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce(async (token, operationId, hash, work) =>
        runtimeOperations.commitOperationEffect(token, operationId, hash, async tx => { await work(tx); throw new Error('fixture memory rollback') }))
      const invoke = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'stopped' || scenario === 'rollback') await expect(invoke()).rejects.toThrow()
      else {
        const result = await invoke()
        expect(result).toMatchObject({ kind: 'tool', result: ['unread', 'stale', 'missing'].includes(scenario) ? { outcome: 'failed' } : { savedMemoryId: expect.any(String) } })
      }
      const cards = await prisma.projectMemoryEntry.findMany({ where: { novelId: f.novelId, title } })
      expect(cards).toHaveLength(scenario === 'missing' ? 0 : scenario === 'update' ? 2 : 1)
      if (scenario === 'create' || scenario === 'update') {
        expect(cards).toEqual(expect.arrayContaining([expect.objectContaining({ content: '新的角色事实', status: 'inferred', reviewStatus: 'pending' })]))
        if (scenario === 'update') expect(cards).toEqual(expect.arrayContaining([expect.objectContaining({ id: seeded!.id, content: '原角色事实' })]))
      } else if (cards.length) expect(cards[0].content).toBe(scenario === 'stale' ? '作者刚更新' : '原角色事实')
    })
  })
})

describe.runIf(available)('durable domain continuation', () => {
  it.each(['own', 'old-task', 'denied', 'unknown-operation', 'stale-cursor', 'rollback', 'stagnant-resume'] as const)('%s keeps domain follow-up inside the original scope', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const tool = chapterBridgeCommitTool
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: scenario === 'denied' ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }, { role: 'assistant', content: '正文已保存' }], successfulToolSignatures: [] } })
      const other = scenario === 'old-task' ? await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', engine: 'loop', startRequest: { prompt: '授权自主创作全书，并修改已有章节。' } } }) : null
      const compilation = await prepareStoryCompilation({ ...f, runId: other?.id ?? f.runId, chapterId: f.chapterId, mode: 'balanced', intentSummary: '尚未提交章节' })
      if (other) await prisma.agentRun.update({ where: { id: other.id }, data: { status: 'failed' } })
      if (scenario === 'unknown-operation') await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: f.rootId, originRunId: f.runId,
        operationKey: 'unknown-test', kind: 'provider', action: 'fixture', inputHash: runtimeJson({}).hash, inputSnapshot: {}, status: 'unknown' } })
      if (scenario === 'rollback') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId,
        eventKey: `state:${f.rootId}:1`, type: 'fixture.conflict', payload: {} } })
      const invoke = () => advanceDurableCompletionObligations(lease, { expectedRevision: 0, expectedHash: scenario === 'stale-cursor' ? 'f'.repeat(64) : initialized.frame.snapshotHash })
      if (scenario === 'rollback' || scenario === 'stale-cursor') {
        await expect(invoke()).rejects.toThrow()
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.continuation' } })).toBe(0)
      } else if (scenario === 'old-task') expect(await invoke()).toBeNull()
      else if (scenario === 'denied' || scenario === 'unknown-operation') {
        expect(await invoke()).toMatchObject({ kind: 'reconciliation_required' })
        expect(await runReviewedDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'needs_attention', blockers: expect.any(Array) })
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
        expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(initialized.frame.snapshotHash)
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      }
      else {
        const result = await invoke()
        expect(result).toMatchObject({ kind: 'continued' })
        const event = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'execution.continuation' } })
        expect(event.payload).toMatchObject({ reason: 'domain_incomplete', reminderIndex: 1, blockers: [{ code: 'uncommitted_compilation', reference: compilation.compilation.id }] })
        const state = await loadExecutionState(f.userId, f.runId)
        expect(state.frame.state.messages.filter(item => item.role === 'user')).toHaveLength(1)
        expect(state.frame.state.turn).toBe(0)
        if (scenario === 'stagnant-resume') {
          for (let index = 2; index <= 5; index++) {
            const previous = await loadExecutionState(f.userId, lease.runId)
            const candidate = await saveExecutionState(lease, { expectedRevision: previous.frame.revision, expectedHash: previous.frame.snapshotHash,
              snapshot: { ...previous.frame.state, messages: [...previous.frame.state.messages, { role: 'assistant', content: '正文已保存' }] } })
            if (index === 3) {
              await pauseDurableTask(f.userId, lease.runId)
              const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
              const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
              lease = await claim({ userId: f.userId, runId: resumed.run.id })
            }
            expect(await advanceDurableCompletionObligations(lease, { expectedRevision: candidate.revision, expectedHash: candidate.snapshotHash }))
              .toMatchObject({ kind: index === 5 ? 'needs_attention' : 'continued' })
          }
          const events = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: f.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'asc' } })
          expect(events.map(item => (item.payload as { reminderIndex: number }).reminderIndex)).toEqual([1, 2, 3, 4])
        }
      }
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
    })
  })
})

describe.runIf(available)('durable completion without an extra model call', () => {
  it.each(['complete', 'stopped', 'stale-cursor', 'changed-body', 'pending', 'rollback', 'empty', 'promise'] as const)(
    '%s keeps existing checks and commits the terminal receipt atomically', async scenario => {
      await fixture(async f => {
        const lease = await claim(f)
        const candidate = scenario === 'empty' ? '' : scenario === 'promise' ? '现在读取章节。' : '你好'
        const initialized = await initializeExecutionState(lease, {
          configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
            model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
            tools: [], toolAuthority: [], protectedChapterIds: [f.chapterId], pinnedSkillVersions: [] },
          snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
            messages: [{ role: 'user', content: '不要修改已有章节，回答你好' }, { role: 'assistant', content: candidate }], successfulToolSignatures: [] },
        })
        const cursor = { expectedRevision: initialized.frame.revision, expectedHash: initialized.frame.snapshotHash }
        const fetch = vi.fn(async () => { throw new Error('completion must not make a paid request') })
        vi.stubGlobal('fetch', fetch)
        const route = vi.spyOn(credits, 'getModelTierRuntime')
        if (scenario === 'stopped') await pauseDurableTask(f.userId, f.runId)
        if (scenario === 'changed-body') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者已修改正文' } })
        if (scenario === 'stale-cursor') await saveExecutionState(lease, { ...cursor,
          snapshot: { ...initialized.frame.state, messages: [...initialized.frame.state.messages, { role: 'assistant', content: '新的答复' }] } })
        if (scenario === 'pending') await prepareOperation(lease, { key: 'still-pending', kind: 'internal', action: 'fixture_pending', input: {} })
        if (scenario === 'rollback') {
          const commit = runtimeOperations.commitOperationEffectInTransaction
          vi.spyOn(runtimeOperations, 'commitOperationEffectInTransaction').mockImplementationOnce(async (...args) => {
            await commit(...args)
            throw new Error('fixture terminal transaction rollback')
          })
        }
        if (scenario === 'complete') {
          expect(await runReviewedDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'completed' })
          expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('completed')
          expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('completed')
          expect(await prisma.agentRunLease.count({ where: { runId: f.runId, enabled: true } })).toBe(0)
          const events = await publishDurableEvents(f.userId, f.runId)
          expect(events.find(event => event.type === 'run.finished')).toMatchObject({
            status: 'succeeded', outputSummary: '你好', usage: { totalTokens: 0 },
          })
          expect((await publishDurableEvents(f.userId, f.runId)).filter(event => event.type === 'run.finished')).toHaveLength(0)
          await expect(finalizeDurableTask(lease, cursor)).rejects.toThrow()
          expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.completion.decided' } })).toBe(1)
        } else {
          await expect(finalizeDurableTask(lease, cursor)).rejects.toThrow()
          expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe(scenario === 'stopped' ? 'paused' : 'active')
          expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.completion.decided' } })).toBe(0)
          expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'completion_finalize' } } })).toBe(0)
          if (scenario === 'rollback') {
            expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'completion_finalize' } })).toBe(0)
            expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(cursor.expectedRevision)
          }
        }
        expect(fetch).not.toHaveBeenCalled()
        expect(route).not.toHaveBeenCalled()
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      }, undefined, '不要修改已有章节，回答你好')
    })
})

describe.runIf(available)('fenced derivative memory', () => {
  it.each(['complete', 'concurrent', 'rollback', 'stopped-resume', 'stale', 'body-tamper', 'job-tamper', 'owner-tamper', 'missing-job', 'missing-event', 'processing', 'legacy-worker', 'legacy-completed', 'unowned-job'] as const)('%s binds memory writes and receipt to the original effect', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const tools = [chapterReadTool, chapterWriteTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
            { id: 'write', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '已保存的正文' }) },
          ] }], successfulToolSignatures: [] } })
      await executeDurableToolStep(lease, new AbortController().signal)
      await executeDurableToolStep(lease, new AbortController().signal)
      const job = await prisma.memoryExtractionJob.findFirstOrThrow({ where: { novelId: f.novelId } })
      expect(job.status).toBe('pending')
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, content: '更新的正文' } })
      if (scenario === 'body-tamper') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '同版本正文已变' } })
      if (scenario === 'job-tamper') await prisma.memoryExtractionJob.update({ where: { id: job.id }, data: { diff: { after: '不是原始来源' } } })
      if (scenario === 'owner-tamper') await prisma.memoryExtractionJob.update({ where: { id: job.id }, data: { diff: { ...(job.diff as object), durableTaskRootId: 'wrong-root' } } })
      if (scenario === 'missing-job') await prisma.memoryExtractionJob.delete({ where: { id: job.id } })
      if (scenario === 'processing') await prisma.memoryExtractionJob.update({ where: { id: job.id }, data: { status: 'processing' } })
      if (scenario === 'legacy-completed') await prisma.memoryExtractionJob.update({ where: { id: job.id }, data: { status: 'completed' } })
      if (scenario === 'unowned-job') await prisma.$transaction(tx => storyMemory.enqueueChapterMemoryExtraction({ novelId: f.novelId, chapterId: f.chapterId, chapterRevision: 99, before: '', after: '不属于本任务的排队工作' }, tx))
      if (scenario === 'legacy-worker') {
        await storyMemory.processMemoryExtractionJob(job.id)
        expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('pending')
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      }
      if (['body-tamper', 'job-tamper', 'owner-tamper', 'missing-job', 'processing'].includes(scenario)) {
        await expect(advanceDurableMemory(lease)).rejects.toMatchObject({ code: scenario === 'body-tamper' ? 'MEMORY_JOB_SOURCE_MISMATCH' : scenario === 'processing' ? 'RUNTIME_RECONCILIATION_REQUIRED' : 'RUNTIME_RECEIPT_INVALID' })
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'memory_extract' } })).toBe(0)
        return
      }
      if (scenario === 'rollback') {
        const original = storyMemory.applyMemoryExtractionJob
        const mock = vi.spyOn(storyMemory, 'applyMemoryExtractionJob').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('fixture memory transaction rollback') })
        await expect(advanceDurableMemory(lease)).rejects.toThrow('fixture memory transaction rollback')
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
        expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('pending')
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'memory_extract' } })).toBe(0)
        mock.mockRestore()
      }
      if (scenario === 'stopped-resume') {
        await pauseDurableTask(f.userId, f.runId)
        await expect(advanceDurableMemory(lease)).rejects.toThrow()
        expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('pending')
        const event = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: event.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'memory-resumed')
      }
      const results = scenario === 'concurrent' ? await Promise.all([advanceDurableMemory(lease), advanceDurableMemory(lease)]) : [await advanceDurableMemory(lease)]
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(results.find(Boolean)?.result).toMatchObject({ jobId: job.id, status: scenario === 'stale' ? 'stale' : 'applied' })
      const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'memory_extract' } })
      expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('completed')
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(scenario === 'stale' ? 0 : 2)
      if (scenario === 'missing-event') {
        await prisma.agentExecutionOutbox.delete({ where: { eventKey: `effect:${operation.id}` } })
        await expect(advanceDurableMemory(lease)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      } else expect(await advanceDurableMemory(lease)).toBeNull()
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'memory_extract' } })).toBe(1)
      if (scenario === 'unowned-job') expect(await prisma.memoryExtractionJob.count({ where: { novelId: f.novelId, status: 'pending' } })).toBe(1)
    })
  })
})

describe.runIf(available)('durable deliverable facts', () => {
  it.each(['chapter', 'changed', 'title-changed', 'deleted', 'revision-only', 'no-op', 'second-write', 'read-only', 'plan', 'plan-changed', 'plan-deleted', 'empty-create', 'create-write-retry'] as const)('%s checks latest authored output against actual scoped storage', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await novelFixture(async f => {
      const lease = await claim(f)
      const tools = [chapterReadTool, chapterWriteTool, chapterCreateTool, planSaveTool]
      const calls: { id: string; name: string; arguments: string }[] = []
      const add = (name: string, args: object) => calls.push({ id: `call-${calls.length}`, name, arguments: JSON.stringify(args) })
      if (scenario.startsWith('plan')) add('plan_save', { title: '交付计划', content: '计划正文' })
      else if (scenario === 'empty-create') add('chapter_create', { title: '新空章' })
      else if (scenario === 'create-write-retry') {
        add('chapter_create', { title: '新章', content: '新正文' })
      } else {
        add('chapter_read', { chapterId: f.chapterId })
        if (scenario !== 'read-only') add('chapter_write', { chapterId: f.chapterId, content: scenario === 'no-op' ? '原文' : '交付正文' })
        if (scenario === 'second-write') add('chapter_write', { chapterId: f.chapterId, content: '最后交付正文' })
      }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '交付正文和计划' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      for (const _ of calls) await executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'create-write-retry') {
        const originalCreate = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId, action: 'chapter_create' } } })
        const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: f.novelId, title: '新章' } })
        const frame = (await loadExecutionState(f.userId, f.runId)).frame
        await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: null, toolCalls: [
            { id: 'later-write', name: 'chapter_write', arguments: JSON.stringify({ chapterId: chapter.id, content: '实际最终正文' }) },
            { id: 'retry-create', name: 'chapter_create', arguments: JSON.stringify({ title: '新章', content: '新正文' }) },
          ] }] } })
        await executeDurableToolStep(lease, new AbortController().signal)
        const finalWrite = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'chapter_write' } })
        await executeDurableToolStep(lease, new AbortController().signal)
        const retry = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId, action: 'chapter_create' } }, orderBy: { createdAt: 'desc' } })
        const writtenChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })
        expect(retry.result).toMatchObject({ toolResult: { chapterCreateReuse: { version: 1, userId: f.userId, novelId: f.novelId,
          chapterId: chapter.id, revision: writtenChapter.revision }, display: { kind: 'chapterRef', chapterId: chapter.id } } })
        expect(retry.result).not.toHaveProperty('progress')
        expect(await prisma.agentEffectReceipt.findUniqueOrThrow({ where: { operationId: originalCreate.operationId } })).toEqual(originalCreate)
        const frameAfterRetry = (await loadExecutionState(f.userId, f.runId)).frame
        const latest = await withRunLease(lease, async tx => {
          const evidence = await collectDurableToolEvidence(tx, f.rootId, frameAfterRetry.revision)
          return collectDurableDeliverables(tx, { id: f.rootId, userId: f.userId, novelId: f.novelId }, evidence.effects)
        })
        expect(latest).toEqual([expect.objectContaining({ sourceOperationId: finalWrite.id,
          expectedHash: runtimeJson({ title: chapter.title, content: '实际最终正文' }).hash, characters: '实际最终正文'.length })])
      }
      if (scenario === 'changed') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '外部改动' } })
      if (scenario === 'title-changed') await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: '外部改名' } })
      if (scenario === 'deleted') await prisma.chapter.delete({ where: { id: f.chapterId } })
      if (scenario === 'revision-only') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
      if (scenario === 'plan-changed') await prisma.agentArtifact.updateMany({ where: { runId: f.runId, artifactType: 'chapterPlan' }, data: { content: '外部计划' } })
      if (scenario === 'plan-deleted') await prisma.agentArtifact.deleteMany({ where: { runId: f.runId, artifactType: 'chapterPlan' } })
      const frame = (await loadExecutionState(f.userId, f.runId)).frame
      const result = await withRunLease(lease, async tx => {
        const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
        const evidence = await collectDurableToolEvidence(tx, root.id, frame.revision)
        return collectDurableDeliverables(tx, root, evidence.effects)
      })
      expect(result).toHaveLength(scenario === 'read-only' ? 0 : 1)
      if (scenario === 'read-only') return
      expect(result[0].status).toBe(['changed', 'title-changed', 'plan-changed'].includes(scenario) ? 'changed' : ['deleted', 'plan-deleted'].includes(scenario) ? 'missing' : 'current')
      if (scenario === 'empty-create') expect(result[0].characters).toBe(0)
      if (scenario === 'second-write') expect(result[0].characters).toBe('最后交付正文'.length)
      if (scenario === 'create-write-retry') expect(result[0].characters).toBe('实际最终正文'.length)
      if (scenario === 'revision-only') expect(result[0].currentRevision).not.toBe(result[0].expectedRevision)
      expect(storyMemory.processMemoryExtractionJob).not.toHaveBeenCalled()
      if (scenario === 'chapter') expect(await prisma.memoryExtractionJob.count({ where: { novelId: f.novelId, status: 'pending' } })).toBe(1)
    })
  })

  it.each(['', '合成历史正文'])('fresh bounded creation reuse of %j never invents authored delivery or derivative memory work', async content => {
    await fixture(async f => {
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, wordCount: content.length } })
      const prompt = '写第一章', runId = randomUUID(), sourceMessageId = randomUUID()
      let spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: f.chapterId, prompt })
      await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId,
        status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', startRequest: { prompt }, taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
      await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
      spec = await prisma.$transaction(tx => freezeWritingScope(tx, { userId: f.userId, novelId: f.novelId, runId }, spec, prompt))
      await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
      const root = await initializeDurableTask({ userId: f.userId, runId, sourceMessageId })
      const lease = await claim({ userId: f.userId, runId })
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: chapterCreateTool.name, description: chapterCreateTool.description, parameters: z.toJSONSchema(chapterCreateTool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: chapterCreateTool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: null, toolCalls: [
            { id: 'historical-reuse', name: chapterCreateTool.name, arguments: JSON.stringify({ title: '不应改名', content: '不应覆盖', position: 1 }) },
          ] }], successfulToolSignatures: [] } })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const novel = await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: {
        chapterCreateReuse: { version: 1, userId: f.userId, novelId: f.novelId, chapterId: chapter.id, revision: chapter.revision }, display: { kind: 'chapterRef' },
      } })
      const frame = (await loadExecutionState(f.userId, runId)).frame
      await withRunLease(lease, async tx => {
        const evidence = await collectDurableToolEvidence(tx, root.id, frame.revision)
        expect(evidence.progressSequence).toBe('0')
        expect(await collectDurableDeliverables(tx, root, evidence.effects)).toEqual([])
      })
      const receipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: root.id, action: chapterCreateTool.name } } })
      expect(receipt.result).not.toHaveProperty('progress')
      expect(receipt.result).toMatchObject({ memoryJobId: null })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
      expect(await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })).toEqual(novel)
      const unchangedRoot = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: root.id } })
      expect(unchangedRoot.inputHash).toBe(root.inputHash)
      expect(unchangedRoot.specSnapshot).toEqual(root.specSnapshot)
      expect(await prisma.memoryExtractionJob.count({ where: { novelId: f.novelId } })).toBe(0)
    })
  })
})

describe.runIf(available)('durable domain postconditions', () => {
  it.each(['unchanged', 'changed', 'revision-only', 'deleted', 'missing-baseline', 'corrupt-baseline', 'resume', 'new-chapter'] as const)('%s checks original body facts without re-baselining', async scenario => {
    await fixture(async f => {
      const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
      expect(root.specSnapshot).toMatchObject({ postconditions: expect.arrayContaining([expect.objectContaining({ code: 'EARLIER_CONTENT_UNCHANGED' })]) })
      const event = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `baseline:${root.id}` } })
      if (scenario === 'changed' || scenario === 'resume') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '已被改动' } })
      if (scenario === 'revision-only') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
      if (scenario === 'deleted') await prisma.chapter.delete({ where: { id: f.chapterId } })
      if (scenario === 'missing-baseline') await prisma.agentExecutionOutbox.delete({ where: { id: event.id } })
      if (scenario === 'corrupt-baseline') await prisma.agentExecutionOutbox.update({ where: { id: event.id }, data: { payload: { ...(event.payload as object), snapshotHash: 'broken' } } })
      if (scenario === 'resume') {
        await initializeDurableTask(f)
        expect((await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: event.id } })).payload).toEqual(event.payload)
      }
      if (scenario === 'new-chapter') {
        const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: '新增', content: '新增正文', orderIndex: 2, orderInVolume: 2 } })
      }
      const check = prisma.$transaction(tx => evaluateTaskPostconditions(tx, root))
      if (scenario === 'corrupt-baseline') { await expect(check).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' }); return }
      const result = (await check).find(item => item.code === 'EARLIER_CONTENT_UNCHANGED')
      expect(result?.status).toBe(scenario === 'missing-baseline' ? 'unverified' : ['changed', 'deleted', 'resume'].includes(scenario) ? 'failed' : 'passed')
    }, undefined, '不要修改已有章节，继续写新章')
  })
  it.each(['order', 'chapter-title', 'volume-title', 'foreign-volume'] as const)('%s rechecks current structure rather than trusting an earlier successful observation', async scenario => {
    await fixture(async f => {
      const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
      expect(await prisma.$transaction(tx => evaluateTaskPostconditions(tx, root))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STRUCTURE_VALIDATED', status: 'passed' })]))
      const before = await getStructureReportObservation(f.userId, f.novelId)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      if (scenario === 'order') await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 9 } })
      if (scenario === 'chapter-title') await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: ' ' } })
      if (scenario === 'volume-title') await prisma.volume.update({ where: { id: chapter.volumeId }, data: { title: ' ' } })
      if (scenario === 'foreign-volume') {
        const other = await prisma.novel.create({ data: { authorId: f.userId, title: '另一本', slug: randomUUID(), summary: '' } })
        const volume = await prisma.volume.create({ data: { novelId: other.id, title: '其他卷', orderIndex: 1 } })
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { volumeId: volume.id } })
      }
      const results = await prisma.$transaction(tx => evaluateTaskPostconditions(tx, root))
      expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STRUCTURE_VALIDATED', status: 'failed' })]))
      expect((await getStructureReportObservation(f.userId, f.novelId)).stateHash).not.toBe(before.stateHash)
    }, undefined, '调整章节顺序')
  })
})
