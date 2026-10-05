import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { env } from '../../api/config/env.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { runDurableExecution } from '../../api/lib/agent/runtime-executor.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { initializeExecutionState,loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { todoWriteTool } from '../../api/lib/agent/tools/todo-tools.js'
import * as tokenPrices from '../../api/lib/billing/resolve-token-price.js'
import * as credits from '../../api/lib/credits.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('durable worker orchestration', () => {
  it.each(['todo-finish', 'todo-noop-stall'] as const)('%s checks only the current task list without buying endless retries', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: [{ type: 'function', function: { name: 'todo_write', description: todoWriteTool.description, parameters: z.toJSONSchema(todoWriteTool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: 'todo_write', permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '完成两个步骤' }], successfulToolSignatures: [] } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'worker-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      let requests = 0
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        if (requests > 10) throw new Error('Unbounded todo loop')
        const body = JSON.parse(String(init.body))
        expect(body.messages.filter((item: { role: string }) => item.role === 'user')).toHaveLength(1)
        const toolCall = requests % 2 === 1
        if (requests === 3) expect(body.messages.at(-1).content).toContain('本任务已建立的待办仍有未完成项')
        const items = ['步骤一', '步骤二'].map(content => ({ content, status: scenario === 'todo-finish' && requests > 1 ? 'completed' : 'pending' }))
        const delta = toolCall ? { tool_calls: [{ index: 0, id: `todo-${requests}`, type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ items }) } }] } : { content: '处理结果已生成。' }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      }))
      const result = await runDurableExecution(lease, new AbortController().signal)
      expect(result.kind).toBe(scenario === 'todo-finish' ? 'completion_review' : 'needs_attention')
      expect(requests).toBe(scenario === 'todo-finish' ? 4 : 7)
      expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(0)
      const reminders = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: f.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'asc' } })
      expect(reminders).toHaveLength(scenario === 'todo-finish' ? 1 : 3)
      reminders.forEach((event, index) => expect(event.payload).toMatchObject({ reason: 'unfinished_todos', reminderIndex: index + 1, progressSequence: '0' }))
      // A completed model-maintained list is only a review candidate, not a completion receipt.
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe(scenario === 'todo-finish' ? 'active' : 'paused')
    })
  }, 30_000) // Ten real-PG model/tool transactions, like the adjacent orchestration matrix.

  it.each(['complete', 'approval', 'unknown', 'route-change', 'v1-price', 'prepare-gap', 'attempt-gap', 'checkpoint', 'checkpoint-gap', 'checkpoint-no-progress', 'checkpoint-noop',
    'continuation-promise', 'continuation-empty', 'continuation-length', 'continuation-gap', 'continuation-stagnant'] as const)('%s drives saved model/tool steps', async scenario => {
    const previousTurns = env.agentMaxTurns
    const checkpointScenario = scenario.startsWith('checkpoint')
    if (checkpointScenario) env.agentMaxTurns = 1
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    try { await fixture(async f => {
      let lease = await claim(f)
      const continues = scenario.startsWith('continuation-')
      // A prepare gap is safe to recreate; once dispatch marking itself has
      // failed, the attempt is closed as unsent and the run remains blocked
      // until an explicit reconciliation, so it cannot be treated as done.
      const completes = ['complete', 'prepare-gap', 'v1-price', 'checkpoint', 'checkpoint-gap', 'checkpoint-noop', 'checkpoint-no-progress'].includes(scenario) || continues && scenario !== 'continuation-stagnant'
      const expectedRequests = scenario === 'attempt-gap' ? 0 : continues ? scenario === 'continuation-stagnant' ? 6 : 3 : completes ? 2 : scenario === 'approval' || scenario === 'unknown' ? 1 : 0
      const writes = scenario === 'checkpoint' || scenario === 'checkpoint-gap' || scenario === 'checkpoint-noop'
      const tools = writes ? [chapterReadTool, chapterWriteTool] : [chapterReadTool]
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '检查本章' }], successfulToolSignatures: [] } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: scenario === 'route-change' ? 'https://changed.invalid/v1' : 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue(scenario === 'v1-price'
        ? { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }
        : { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'worker-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      let requests = 0
      const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        if (scenario === 'unknown') throw new Error('fixture disconnected')
        const body = JSON.parse(String(init.body))
        expect(body.messages[0].content).toBe('检查本章')
        if (requests === 2) expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: scenario === 'checkpoint-noop' ? 'noop' : writes ? 'write' : 'read' })
        if (continues && requests > 2) {
          expect(body.messages.at(-1)).toMatchObject({ role: 'system' })
          expect(body.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1)
        }
        const delta = requests === 1 ? { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) } },
          ...(writes ? [{ index: 1, id: 'write', type: 'function', function: { name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '检查点前实际写入正文' }) } }] : []),
          ...(scenario === 'checkpoint-noop' ? [{ index: 2, id: 'noop', type: 'function', function: { name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '检查点前实际写入正文' }) } }] : []),
        ] } : { content: continues && (requests === 2 || scenario === 'continuation-stagnant') ? scenario === 'continuation-empty' ? '' : '接下来读取正文。' : '检查结果已生成' }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: requests === 1 ? 'tool_calls' : scenario === 'continuation-length' && requests === 2 ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetch)
      if (scenario === 'prepare-gap') vi.spyOn(runtimeOperations, 'prepareProviderAttempt').mockRejectedValueOnce(new Error('fixture before attempt'))
      if (scenario === 'attempt-gap') vi.spyOn(runtimeOperations, 'markProviderDispatched').mockRejectedValueOnce(new Error('fixture before dispatch'))
      if (scenario === 'checkpoint-gap') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId, eventKey: `state:${f.rootId}:7`, type: 'fixture.collision', payload: {} } })
      if (scenario === 'continuation-gap') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId, eventKey: `state:${f.rootId}:7`, type: 'fixture.collision', payload: {} } })
      let run = runDurableExecution(lease, new AbortController().signal)
      if (scenario === 'continuation-gap') {
        await expect(run).rejects.toMatchObject({ code: 'P2002' })
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.continuation' } })).toBe(0)
        expect(fetch).toHaveBeenCalledTimes(2)
        await prisma.agentExecutionOutbox.delete({ where: { eventKey: `state:${f.rootId}:7` } })
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'continuation-worker')
        run = runDurableExecution(lease, new AbortController().signal)
      }
      if (scenario === 'checkpoint-gap') {
        await expect(run).rejects.toMatchObject({ code: 'P2002' })
        expect((await readTaskBudget(lease)).budget.checkpointCount).toBe(0)
        expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(0)
        await prisma.agentExecutionOutbox.delete({ where: { eventKey: `state:${f.rootId}:7` } })
        run = runDurableExecution(lease, new AbortController().signal)
      }
      if (scenario === 'prepare-gap' || scenario === 'attempt-gap') {
        await expect(run).rejects.toThrow('fixture before')
        expect(fetch).not.toHaveBeenCalled()
        const pending = await loadExecutionState(f.userId, f.runId)
        expect(pending.frame.state.phase).toBe('awaiting_operation')
        if (scenario === 'attempt-gap') {
          const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operationId: pending.frame.state.pendingOperationId! } })
          expect(attempt).toMatchObject({ status: 'cancelled', dispatchedAt: null, result: { outcome: 'cancelled', result: { dispatched: false } } })
          expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: pending.frame.state.pendingOperationId! } })).toMatchObject({ status: 'cancelled' })
        }
        await pauseDurableTask(f.userId, f.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'worker-b')
        run = runDurableExecution(lease, new AbortController().signal)
      }
      if (scenario === 'unknown') await expect(run).rejects.toThrow()
            else if (scenario === 'route-change') await expect(run).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      else if (scenario === 'attempt-gap') await expect(run).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      else expect(await run).toMatchObject({ kind: scenario === 'approval' ? 'waiting_approval' : scenario === 'continuation-stagnant' ? 'needs_attention' : 'completion_review' })
      expect(fetch).toHaveBeenCalledTimes(expectedRequests)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(scenario === 'unknown' ? 0 : expectedRequests)
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe(scenario === 'continuation-stagnant' ? 'paused' : 'active')
      if (scenario === 'approval') {
        const waiting = await runDurableExecution(lease, new AbortController().signal)
        if (waiting.kind !== 'waiting_approval') throw new Error('Expected original approval')
        expect(fetch).toHaveBeenCalledTimes(1)
        await resolveDurableApproval({ userId: f.userId, runId: lease.runId, requestId: waiting.approvalId, callId: 'read', approved: true, alwaysAllow: false })
        expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'completion_review' })
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(2)
      }
      if (completes) {
        const frame = (await loadExecutionState(f.userId, lease.runId)).frame
        expect(frame.state).toMatchObject({ turn: continues ? 3 : 2, nextOperationSequence: continues ? 4 : scenario === 'checkpoint-noop' ? 5 : writes ? 4 : 3, phase: 'idle', checkpointIndex: 0 })
        if (writes) expect((await readTaskBudget(lease)).budget.checkpointCount).toBe(0)
        if (scenario === 'checkpoint-noop') expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(0)
        const reviewed = await runDurableExecution(lease, new AbortController().signal)
        expect(reviewed).toMatchObject({ kind: 'completion_review', evidence: { snapshot: { taskRootId: f.rootId, verification: 'required', originalRequest: [{ type: 'text', text: '修改本章' }], postconditionChecks: [], obligations: { goals: f.spec.goals, expectedOutputs: f.spec.expectedOutputs } } } })
        if (reviewed.kind !== 'completion_review') throw new Error('Expected evidence review')
        expect(runtimeJson(reviewed.evidence.snapshot).hash).toBe(reviewed.evidence.snapshotHash)
        if (scenario === 'checkpoint') {
          expect(reviewed).toMatchObject({ evidence: { snapshot: { deliverables: [expect.objectContaining({ id: f.chapterId, status: 'current' })] } } })
          expect(reviewed).toMatchObject({ evidence: { snapshot: { memoryJobs: [expect.objectContaining({ chapterId: f.chapterId, verified: true })] } } })
          await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户之后改过正文' } })
          const changed = await runDurableExecution(lease, new AbortController().signal)
          expect(changed).toMatchObject({ evidence: { snapshot: { blockers: expect.arrayContaining([{ code: 'deliverable_changed', reference: f.chapterId }]) } } })
          expect(fetch).toHaveBeenCalledTimes(expectedRequests)
        }
        if (scenario === 'complete') {
          const otherRun = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', engine: 'loop', startRequest: { prompt: '授权自主创作全书，并修改已有章节。' } } })
          await prepareStoryCompilation({ ...f, runId: otherRun.id, chapterId: f.chapterId, mode: 'balanced', intentSummary: '旧任务不属于本次交付' })
          await prisma.agentRun.update({ where: { id: otherRun.id }, data: { status: 'failed' } })
          expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ evidence: { snapshot: { blockers: [], compilations: [] } } })
          const own = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '当前未提交章节' })
          expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ evidence: { snapshot: { blockers: [{ code: 'uncommitted_compilation', reference: own.compilation.id }] } } })
          const receipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId, action: 'chapter_read' } } })
          await prisma.agentEffectReceipt.update({ where: { operationId: receipt.operationId }, data: { resultHash: 'f'.repeat(64) } })
          await expect(runDurableExecution(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
          await prisma.agentEffectReceipt.update({ where: { operationId: receipt.operationId }, data: { resultHash: receipt.resultHash } })
          await prisma.agentExecutionOutbox.delete({ where: { eventKey: `effect:${receipt.operationId}` } })
          await expect(runDurableExecution(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        }
        expect(fetch).toHaveBeenCalledTimes(expectedRequests)
      }
      if (continues) expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.continuation' } })).toBe(scenario === 'continuation-stagnant' ? 4 : 1)
      if (scenario === 'continuation-stagnant') {
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).status).toBe('paused')
        expect(await prisma.agentRunLease.count({ where: { run: { taskRootId: f.rootId }, enabled: true } })).toBe(0)
        const projected = await publishDurableEvents(f.userId, lease.runId)
        expect(projected.at(-1)).toMatchObject({ type: 'run.paused', reason: 'model_stalled' })
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'stagnation-worker')
        expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'needs_attention' })
        expect(fetch).toHaveBeenCalledTimes(6)
        const secondPause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
        const third = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: secondPause.id })
        lease = await claim({ userId: f.userId, runId: third.run.id }, 'stagnation-integrity-worker')
        const lastDecision = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'desc' } })
        await prisma.agentExecutionOutbox.update({ where: { id: lastDecision.id }, data: { payload: { ...(lastDecision.payload as Prisma.JsonObject), reminderIndex: 1 } } })
        await expect(runDurableExecution(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        expect(fetch).toHaveBeenCalledTimes(6)
      }
    }) } finally { env.agentMaxTurns = previousTurns }
  }, 30_000)
})

