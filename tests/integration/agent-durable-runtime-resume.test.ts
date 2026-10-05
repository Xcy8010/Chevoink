import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { deregisterActiveRun,getActiveRun,registerActiveRun } from '../../api/lib/agent/active-runs.js'
import { continueLoopRun,deleteAgentSessionData } from '../../api/lib/agent/run-service.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import * as runtimeExecutor from '../../api/lib/agent/runtime-executor.js'
import { attachRunToDurableTask,initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { revokeRunLease,withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { commitOperationEffect,markProviderDispatched,prepareOperation,prepareProviderAttempt,recordProviderResult } from '../../api/lib/agent/runtime-operations.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { initializeExecutionState,loadExecutionState,saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as credits from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('explicit durable resume admission', () => {
  it('checks session ownership before cancellation and revokes an owned task before deletion', async () => {
    await fixture(async f => {
      const lease = await claim(f)
      const controller = new AbortController()
      registerActiveRun(f.runId, { userId: f.userId, sessionId: f.sessionId, controller })
      try {
        await expect(deleteAgentSessionData('another-user', f.sessionId)).rejects.toMatchObject({ status: 403, code: 'AGENT_SESSION_FORBIDDEN' })
        expect(controller.signal.aborted).toBe(false)
        await withRunLease(lease, async () => {})
        await expect(deleteAgentSessionData(f.userId, f.sessionId)).resolves.toMatchObject({ deleted: true })
        expect(controller.signal.aborted).toBe(true)
        expect(await prisma.agentSession.findUnique({ where: { id: f.sessionId } })).toBeNull()
        await expect(withRunLease(lease, async () => {})).rejects.toThrow()
      } finally { deregisterActiveRun(f.runId) }
    })
  })

  it('dispatches the saved root from the continue API and replays a lost response without another executor', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const original = await initializeExecutionState(token, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
      await pauseDurableTask(f.userId, f.runId)
      const creditGate = vi.spyOn(credits, 'assertCreditAccess').mockRejectedValue(new Error('fixture exhausted balance'))
      let release!: () => void
      const wait = new Promise<void>(resolve => { release = resolve })
      const execute = vi.spyOn(runtimeExecutor, 'runReviewedDurableExecution').mockImplementation(async lease => {
        expect(lease.taskRootId).toBe(f.rootId)
        expect((await loadExecutionState(f.userId, lease.runId)).frame).toEqual(original.frame)
        await wait
        return { kind: 'needs_attention', reason: 'fixture exit', frame: original.frame }
      })
      let resumedId: string | undefined
      try {
        const first = await continueLoopRun(f.userId, f.runId)
        resumedId = first.runId
        expect(first.runId).not.toBe(f.runId)
        expect(getActiveRun(first.runId)).toBeDefined()
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
        const replay = await continueLoopRun(f.userId, f.runId)
        expect(replay.runId).toBe(first.runId)
        expect(execute).toHaveBeenCalledOnce()
        expect(creditGate).not.toHaveBeenCalled()
        expect(await prisma.agentRun.count({ where: { taskRootId: f.rootId } })).toBe(2)
        expect(await prisma.agentMessage.count({ where: { runId: first.runId, role: 'user' } })).toBe(0)
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      } finally {
        release()
        if (resumedId) await vi.waitFor(() => expect(getActiveRun(resumedId!)).toBeUndefined(), { timeout: 5000 })
      }
    })
  }, 30_000)

  it('serializes two paused roots against the same account concurrency limit', async () => {
    await fixture(async f => {
      const previousLimit = env.agentUserMaxConcurrent
      try {
        env.agentUserMaxConcurrent = 1
        const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '第二个任务根' } })
        const runId = randomUUID(), sourceMessageId = randomUUID()
        const spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: f.chapterId, prompt: '只检查本章' })
        await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: session.id, chapterId: f.chapterId,
          mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)) } })
        await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: '只检查本章' }] } })
        await initializeDurableTask({ userId: f.userId, runId, sourceMessageId })
        const requests: Array<{ userId: string; runId: string; pauseEventId: string }> = []
        for (const target of [f.runId, runId]) {
          const token = await claim({ userId: f.userId, runId: target })
          await initializeExecutionState(token, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
            model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
          snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
            messages: [{ role: 'user', content: target === f.runId ? '修改本章' : '只检查本章' }], successfulToolSignatures: [] } })
          await pauseDurableTask(f.userId, target)
          const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: target, type: 'run.paused' } })
          requests.push({ userId: f.userId, runId: target, pauseEventId: pause.id })
        }
        const results = await Promise.allSettled(requests.map(request => resumeDurableTask(request)))
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find(result => result.status === 'rejected')
        expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ code: 'RUN_LIMIT' })
        expect(await prisma.agentRun.count({ where: { userId: f.userId, status: 'queued' } })).toBe(1)
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRoot: { userId: f.userId }, type: 'run.resume.queued' } })).toBe(1)
      } finally { env.agentUserMaxConcurrent = previousLimit }
    })
  }, 30_000)

  it.each(['replay', 'restop', 'stale', 'scope', 'missing-state', 'corrupt-state', 'incomplete-fence', 'limit', 'corrupt-resume', 'pending'] as const)('%s', async scenario => {
    await fixture(async f => {
      const token = await claim(f)
      const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }
      const snapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] }
      let original = scenario === 'missing-state' ? null : await initializeExecutionState(token, { configuration, snapshot })
      if (scenario === 'pending' && original) {
        const operation = await prepareOperation(token, { key: 'exec:0', kind: 'provider', action: 'chat', input: {} })
        await saveExecutionState(token, { expectedRevision: 0, expectedHash: original.frame.snapshotHash,
          snapshot: { ...snapshot, phase: 'awaiting_operation', pendingOperationId: operation.id, turn: 1, nextOperationSequence: 1 } })
        const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
        await markProviderDispatched(token, attempt.id)
        original = await loadExecutionState(f.userId, f.runId)
      }
      const originalBudget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
      const originalRoot = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
      const startRequest = { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, mode: 'build', prompt: '修改本章',
        selection: { text: '原选区', start: 0, end: 3 }, pinnedSkillIds: ['original-skill'], qualityMode: 'premium' }
      await prisma.agentRun.update({ where: { id: f.runId }, data: { startRequest } })
      await pauseDurableTask(f.userId, f.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
      const request = { userId: f.userId, runId: f.runId, pauseEventId: pause.id }
      const previousLimit = env.agentUserMaxConcurrent
      if (scenario === 'replay') {
        await prisma.agentMessage.create({ data: { id: randomUUID(), runId: f.runId, sessionId: f.sessionId, role: 'assistant',
          parts: [{ type: 'tool-call', callId: 'interrupted-history', toolName: 'chapter_read', title: '读取章节', args: {}, status: 'running' }] } })
        const { listLoopSessionMessages } = await import('../../api/lib/agent/session-messages.js')
        const stopped = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 20 })
        expect(stopped).toMatchObject({ activeRunId: null, resumeRunId: f.runId })
        expect(stopped.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ callId: 'interrupted-history', status: 'failed', summary: '已停止' }))
      }
      try {
        if (scenario === 'stale' || scenario === 'limit') {
          const sessionId = scenario === 'limit' ? (await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '并发任务' } })).id : f.sessionId
          await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued' } })
          if (scenario === 'limit') env.agentUserMaxConcurrent = 1
        }
        if (scenario === 'corrupt-state') await prisma.agentExecutionState.update({ where: { taskRootId: f.rootId }, data: { configurationHash: 'b'.repeat(64) } })
        if (scenario === 'incomplete-fence') await prisma.agentRunLease.update({ where: { runId: f.runId }, data: { enabled: true } })
        const errors: Record<string, string> = { stale: 'STALE_RESUME_TARGET', scope: 'RUNTIME_SCOPE_MISMATCH', 'missing-state': 'RUNTIME_STATE_REQUIRED',
          'corrupt-state': 'RUNTIME_RECEIPT_INVALID', 'incomplete-fence': 'RUNTIME_STATE_CONFLICT', limit: 'RUN_LIMIT' }
        if (errors[scenario]) {
          await expect(resumeDurableTask(scenario === 'scope' ? { ...request, userId: 'other-user' } : request)).rejects.toMatchObject({ code: errors[scenario] })
          expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('paused')
          expect(await prisma.agentRun.count({ where: { taskRootId: f.rootId } })).toBe(1)
          return
        }
        const [a, b] = await Promise.all([resumeDurableTask(request), resumeDurableTask(request)])
        expect(a.run.id).toBe(b.run.id)
        expect(a.replay === b.replay).toBe(false)
        expect(a.run.id).not.toBe(f.runId)
        expect(a.run.status).toBe('queued')
        if (scenario === 'replay') {
          const { listLoopSessionMessages } = await import('../../api/lib/agent/session-messages.js')
          const waiting = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 1 })
          expect(waiting).toMatchObject({ activeRunId: a.run.id, resumeRunId: null })
          expect(waiting.messages.some(message => message.id === f.sourceMessageId)).toBe(true)
          const { deleteLoopSessionMessage, rollbackLoopSessionFromMessage } = await import('../../api/lib/agent/session-messages.js')
          await expect(deleteLoopSessionMessage(f.userId, f.sessionId, f.sourceMessageId)).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
          await expect(rollbackLoopSessionFromMessage(f.userId, f.sessionId, f.sourceMessageId)).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
          expect(waiting.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ callId: 'interrupted-history', status: 'running' }))
        }
        expect(a.run.startRequest).toEqual(startRequest)
        expect(await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: a.run.id } })).toMatchObject({ enabled: true, ownerId: null, expiresAt: null })
        expect(await prisma.agentRun.count({ where: { taskRootId: f.rootId } })).toBe(2)
        expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(originalBudget)
        const restored = await loadExecutionState(f.userId, a.run.id)
        expect(restored.frame).toEqual(original!.frame)
        expect(restored.originalRequest).toEqual(original!.originalRequest)
        expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).createdAt).toEqual(originalRoot.createdAt)
        await expect(withRunLease(token, async () => 'stale write')).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
        const resumed = await claim({ userId: f.userId, runId: a.run.id }, 'explicitly-resumed')
        if (scenario === 'pending') expect((await readTaskBudget(resumed)).unresolvedAttempts).toBe(1n)
        if (scenario === 'corrupt-resume') {
          const event = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `resume:${pause.id}` } })
          await prisma.agentExecutionOutbox.update({ where: { id: event.id }, data: { payload: { ...(event.payload as Record<string, Prisma.InputJsonValue>), snapshotHash: 'f'.repeat(64) } } })
          await expect(resumeDurableTask(request)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        } else if (scenario === 'restop') {
          await pauseDurableTask(f.userId, a.run.id)
          await expect(resumeDurableTask(request)).rejects.toMatchObject({ code: 'STALE_RESUME_TARGET' })
          const secondPause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
          const next = await resumeDurableTask({ userId: f.userId, runId: a.run.id, pauseEventId: secondPause.id })
          expect(next.run.id).not.toBe(a.run.id)
          expect((await loadExecutionState(f.userId, next.run.id)).frame.snapshotHash).toBe(original!.frame.snapshotHash)
        } else expect((await resumeDurableTask(request)).run.id).toBe(a.run.id)
      } finally { env.agentUserMaxConcurrent = previousLimit }
    })
  }, 30_000)
})

describe.runIf(available)('receipt context reduction', () => {
  it.each(['replay', 'unknown', 'corrupt', 'missing-event', 'wrong-cursor', 'tool', 'new-run', 'wrong-call', 'wrong-args', 'incomplete'] as const)('%s', async scenario => {
    await fixture(async f => {
      let token = await claim(f)
      const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }
      const snapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] }
      let frame = (await initializeExecutionState(token, { configuration, snapshot })).frame
      const op = await prepareOperation(token, { key: 'exec:0', kind: 'provider', action: 'chat', input: {} })
      frame = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
        snapshot: { ...frame.state, phase: 'awaiting_operation', pendingOperationId: op.id, turn: 1, nextOperationSequence: 1 } })
      const cursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, operationId: op.id }
      const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const args = { chapterId: f.chapterId, content: '新正文' }
      const toolCase = ['tool', 'new-run', 'wrong-call', 'wrong-args', 'incomplete'].includes(scenario)
      const result = { content: '现在写入', reasoning: '已核对原任务', finishReason: toolCase ? 'tool_calls' : 'stop',
        toolCalls: toolCase ? [{ id: 'call-1', name: 'chapter_write', arguments: JSON.stringify(args), ...(scenario === 'incomplete' ? { incomplete: true } : {}) }] : [],
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: 0, promptCacheMissTokens: 10 } }
      await recordProviderResult({ userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash,
        outcome: scenario === 'unknown' ? 'unknown' : 'succeeded', result })
      if (scenario === 'corrupt') await prisma.agentProviderAttempt.update({ where: { id: attempt.id }, data: { result: { content: '篡改' } } })
      if (scenario === 'missing-event') await prisma.agentExecutionOutbox.deleteMany({ where: { operationId: op.id, type: 'provider.result.recorded' } })
      if (['unknown', 'corrupt', 'missing-event', 'wrong-cursor'].includes(scenario)) {
        await expect(reduceExecutionReceipt(token, scenario === 'wrong-cursor' ? { ...cursor, operationId: randomUUID() } : cursor)).rejects.toMatchObject({ code:
          scenario === 'unknown' ? 'RUNTIME_RECONCILIATION_REQUIRED' : scenario === 'wrong-cursor' ? 'RUNTIME_STATE_CONFLICT' : 'RUNTIME_RECEIPT_INVALID' })
        expect((await loadExecutionState(f.userId, f.runId)).head.revision).toBe(1)
        return
      }
      const [a, b] = await Promise.all([reduceExecutionReceipt(token, cursor), reduceExecutionReceipt(token, cursor)])
      expect(a.snapshotHash).toBe(b.snapshotHash)
      expect(a.state.messages).toHaveLength(2)
      expect(a.state.messages[0]).toEqual(snapshot.messages[0])
      expect(a.state.messages[1]).toMatchObject({ role: 'assistant', content: result.content, reasoning: result.reasoning })
      expect(a.state.phase).toBe('idle') // stop is not task-completion proof
      if (!toolCase) return
      const write = await prepareOperation(token, { key: 'exec:1', kind: 'tool', action: 'chapter_write', input: {
        callId: scenario === 'wrong-call' ? 'old-call' : 'call-1', novelId: f.novelId, chapterId: f.chapterId, expectedRevision: 1,
        args: scenario === 'wrong-args' ? { ...args, content: '不同正文' } : args } })
      frame = await saveExecutionState(token, { expectedRevision: a.revision, expectedHash: a.snapshotHash,
        snapshot: { ...a.state, phase: 'awaiting_operation', pendingOperationId: write.id, nextOperationSequence: 2 } })
      let output = '正文已落库'
      if (scenario === 'tool' || scenario === 'new-run') {
        vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
        const ctx: ToolContext = { ...f, callId: 'call-1', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal,
          toolAuthority: new Map([['chapter_write', { permission: 'allow', alwaysConfirm: false, dangerous: false }]]), protectedChapterIds: new Set(),
          durableContent: { lease: token, operationKey: 'exec:1', chapterId: f.chapterId, expectedRevision: 1 } }
        output = (await chapterWriteTool.execute(ctx, args)).output
      } else await commitOperationEffect(token, write.id, write.inputHash, async () => ({ toolResult: { output } }))
      if (scenario === 'new-run') {
        const resumedRun = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
          status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: JSON.parse(JSON.stringify(f.spec)) } })
        await attachRunToDurableTask({ userId: f.userId, runId: resumedRun.id, taskRootId: f.rootId })
        await revokeRunLease(f.userId, f.runId)
        token = await claim({ userId: f.userId, runId: resumedRun.id }, 'resumed-owner')
      }
      const toolCursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, operationId: write.id }
      if (scenario !== 'tool' && scenario !== 'new-run') {
        await expect(reduceExecutionReceipt(token, toolCursor)).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
        expect((await loadExecutionState(f.userId, f.runId)).head.revision).toBe(3)
        return
      }
      const reduced = await reduceExecutionReceipt(token, toolCursor)
      expect(reduced.state.messages).toHaveLength(3)
      expect(reduced.state.messages[2]).toEqual({ role: 'tool', toolCallId: 'call-1', content: `<tool_output tool="chapter_write">\n${output}\n</tool_output>` })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision).toBe(2)
      expect((await reduceExecutionReceipt(token, toolCursor)).snapshotHash).toBe(reduced.snapshotHash)
      expect((await reduceExecutionReceipt(token, cursor)).revision).toBe(2)
      expect((await loadExecutionState(f.userId, f.runId)).head.revision).toBe(4)
      expect(await prisma.agentProviderAttempt.count({ where: { operationId: op.id } })).toBe(1)
    })
  }, 30_000) // Multiple real PG transactions, including cross-run recovery and CAS retries.
})

