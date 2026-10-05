import { taskSpawnTool, taskWaitTool } from '../../api/lib/agent/tools/task-orchestration-tools.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { admitChildExecution } from '../../api/lib/agent/runtime-child.js'
import { commitOperationEffect } from '../../api/lib/agent/runtime-operations.js'
import { toOpenAIParameters } from '../../api/lib/agent/tool-schema.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { advanceDurableContext } from '../../api/lib/agent/runtime-checkpoint-step.js'
import { executionContextReadTool } from '../../api/lib/agent/tools/task-context-tools.js'
import { readSemanticStructureHash, observeSemanticTransition } from '../../api/lib/agent/semantic-progress.js'
import { volumeUpdateTool } from '../../api/lib/agent/tools/structure-tools.js'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease, withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { prepareOperation, prepareProviderAttempt, markProviderDispatched, recordProviderResult, recordProviderUsage } from '../../api/lib/agent/runtime-operations.js'
import { readTaskBudget, taskTurnLimit } from '../../api/lib/agent/runtime-budget.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { advanceDurableToolStagnation } from '../../api/lib/agent/runtime-continuation.js'
import { pauseDurableTask, finalizeDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { freezeWritingScope, readCompletedWritingDelivery, readSavedWritingPresentation } from '../../api/lib/agent/writing-scope.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { durableMessageId } from '../../api/lib/agent/runtime-frame-events.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
afterEach(() => vi.restoreAllMocks())
async function fixture(work: (f: {
  userId: string; novelId: string; sessionId: string; chapterId: string; runId: string; sourceMessageId: string;
  spec: ReturnType<typeof buildTaskSpec>; rootId: string;
}) => Promise<void>, tokenBudget?: number, prompt = '修改本章', freezeChapterScope = false) {
  const user = await prisma.user.create({ data: { nickname: 'until-completion-fixture', passwordHash: 'test-only-unusable' } })
  const userId = user.id
  try {
    const novel = await prisma.novel.create({ data: { authorId: userId, title: '完成条件回归', slug: randomUUID(), summary: '' } })
    // Most protocol cases deliberately admit all tools; policy narrowing has
    // separate cases below and must not rely on an implicit default approval.
    const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '测试',
      toolPolicy: { network: 'allow', contentWrite: 'allow', bulkWrite: 'allow', publish: 'allow', destructive: 'allow' } } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: userId, novelId: novel.id, volumeId: volume.id, title: '原章', content: '原文', orderIndex: 1, orderInVolume: 1, wordCount: 2 } })
    const runId = randomUUID(), sourceMessageId = randomUUID()
    let spec = buildTaskSpec({ runId, novelId: novel.id, chapterId: chapter.id, prompt })
    await prisma.agentRun.create({ data: {
      id: runId, userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, status: 'queued',
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)),
    } })
    await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    if (freezeChapterScope) {
      spec = await prisma.$transaction(tx => freezeWritingScope(tx, { userId, novelId: novel.id, runId }, spec, prompt))
      await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: JSON.parse(JSON.stringify(spec)) } })
    }
    const root = await initializeDurableTask({ userId, runId, sourceMessageId, tokenBudget })
    await work({ userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, runId, sourceMessageId, spec, rootId: root.id })
  } finally {
    // Exact fixture ownership only. New roots cascade after their original runs are removed.
    await prisma.creditRateCardEvent.deleteMany({ where: { card: { createdBy: userId } } })
    await prisma.creditRateCard.deleteMany({ where: { createdBy: userId } })
    await prisma.agentArtifact.deleteMany({ where: { run: { userId } } })
    await prisma.projectMemoryEntry.deleteMany({ where: { novel: { authorId: userId } } })
    await prisma.agentChildExecutionGrant.deleteMany({ where: { childRun: { userId } } })
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.chapter.deleteMany({ where: { authorId: userId } })
    await prisma.novel.deleteMany({ where: { authorId: userId } })
    await prisma.user.delete({ where: { id: userId } })
  }
}

const claim = (f: { userId: string; runId: string }, ownerId = 'worker-a') => acquireRunLease({ ...f, ownerId, claimId: randomUUID() })

const oldPolicy = (version: 1 | 2) => ({ version, initialTokens: 500, tokenCeiling: 500, budgetSlice: 1000,
  maxCheckpoints: 0, maxCompactions: 0, wallClockMs: 1, longWallClockMs: 1,
  ...(version === 2 ? { initialTurns: 1, turnSlice: 1 } : {}) })

describe.runIf(available)('real durable default execution control', () => {
  it('short rewrite ordinary completion replaces final/history chat text with a bound saved confirmation and preserves the immutable candidate', async () => {
    await fixture(async f => {
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      const prompt = '以后不要重复正文，只保存章节。'
      const correction = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'completed', engine: 'loop', createdAt: new Date(run.createdAt.getTime() - 1000),
        startRequest: withHumanAdmission({ novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId, mode: 'build', prompt }) } })
      await prisma.agentMessage.create({ data: { runId: correction.id, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
      const content = '沈桐看见旧罗盘的价值，心头一热，决定抓住这个只有自己知道的机会。他尚未询问价格。'
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: '第一章 旧罗盘', content, revision: { increment: 1 }, wordCount: content.length } })
      await prisma.storyCompilation.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId, chapterId: f.chapterId, targetOrderIndex: 1,
        mode: 'balanced', status: 'completed', stage: 'commit', sourcePromptHash: runtimeJson({ prompt: '重写第一章，突出捡漏爽文。' }).hash,
        preparedContext: { terminalContentHash: runtimeJson({ content }).hash }, completedAt: new Date(),
        bridge: { create: { userId: f.userId, novelId: f.novelId, targetOrderIndex: 1, toChapterId: f.chapterId, targetRevision: chapter.revision, committedAt: new Date(),
          knowledgeState: [], bodyState: [], objectState: [], relationshipState: [], emotionAftermath: [], recentOpenings: [], recentEndings: [], openLoops: [] } } } })
      const lease = await claim(f)
      const candidate = `${chapter.title}\n\n${content}`
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0,
        checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '重写第一章，突出捡漏爽文。' }, { role: 'assistant', content: candidate }], successfulToolSignatures: [] } })
      const candidateMessageId = durableMessageId(f.rootId, 0)
      await prisma.agentMessage.create({ data: { id: candidateMessageId, runId: f.runId, sessionId: f.sessionId,
        role: 'assistant', parts: [{ type: 'text', text: candidate }] } })
      expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId: f.userId, novelId: f.novelId, runId: f.runId }))).toBeNull()
      expect(await prisma.$transaction(tx => readSavedWritingPresentation(tx, { userId: f.userId, novelId: f.novelId, runId: f.runId }))).toMatchObject({ text: '已保存《第一章 旧罗盘》。' })
      const before = await loadExecutionState(f.userId, f.runId)
      const originalRoot = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId }, select: { requestSnapshot: true, specSnapshot: true, inputHash: true } })
      expect(await finalizeDurableTask(lease, { expectedRevision: before.frame.revision, expectedHash: before.frame.snapshotHash })).toMatchObject({ kind: 'completed' })
      const after = await loadExecutionState(f.userId, f.runId)
      expect(after.frame.state.messages).toEqual(before.frame.state.messages)
      expect(after.frame.state.messages.at(-1)?.content).toBe(candidate)
      expect(await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId }, select: { requestSnapshot: true, specSnapshot: true, inputHash: true } })).toEqual(originalRoot)
      await publishDurableEvents(f.userId, f.runId)
      const message = await prisma.agentMessage.findUniqueOrThrow({ where: { id: candidateMessageId } })
      expect(message.parts).toEqual([{ type: 'text', text: '已保存《第一章 旧罗盘》。' }])
      const finished = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId, type: 'run.finished' } })
      expect(finished.payload).toMatchObject({ outputSummary: '已保存《第一章 旧罗盘》。' })
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(content)
    }, undefined, '重写第一章，突出捡漏爽文。', true)
  })
  it.each([1, 2, 3] as const)('version %s preserves raw policy/usage and dispatches beyond old token/time limits', async version => {
    await fixture(async f => {
      if (version !== 3) {
        const policy = runtimeJson(oldPolicy(version))
        await prisma.agentTaskBudget.update({ where: { taskRootId: f.rootId }, data: { policy: policy.value, policyHash: policy.hash, tokenLimit: 500 } })
      }
      await prisma.agentTaskRoot.update({ where: { id: f.rootId }, data: { createdAt: new Date(0) } })
      const token = await claim(f)
      const raw = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
      const op = await prepareOperation(token, { key: 'first', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: { body: { max_tokens: 100 } } })
      expect((await markProviderDispatched(token, attempt.id)).dispatchGranted).toBe(true)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      await recordProviderUsage({ ...identity, revision: 1, usage: { source: 'reported', promptTokens: 10000000, completionTokens: 123, cacheHitTokens: null, cacheMissTokens: null } })
      await recordProviderResult({ ...identity, outcome: 'succeeded', result: { text: '真实已保存结果' } })
      const state = await readTaskBudget(token)
      expect(state.usedTokens).toBe(10000123n)
      expect(state.control.limits).toEqual({ tokens: null, turns: null, activeTimeMs: null })
      expect(state.control.origin).toBe(version === 3 ? 'system_default' : 'unknown_legacy')
      expect(taskTurnLimit(state.policy, 0)).toBeNull()
      const next = await prepareOperation(token, { key: 'second', kind: 'provider', action: 'chat', input: {} })
      const nextAttempt = await prepareProviderAttempt(token, { operationId: next.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: { body: { max_tokens: 100 } } })
      expect((await markProviderDispatched(token, nextAttempt.id)).dispatchGranted).toBe(true)
      expect((await markProviderDispatched(token, nextAttempt.id)).dispatchGranted).toBe(false)
      const after = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
      expect(after.policy).toEqual(raw.policy)
      expect(after.policyHash).toBe(raw.policyHash)
      expect(after.tokenLimit).toBe(raw.tokenLimit)
      expect(await prisma.agentProviderUsageReceipt.count({ where: { attempt: { operation: { taskRootId: f.rootId } } } })).toBe(1)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    }, 999999)
  })

  it.each(['unknown', 'corrupt', 'cancelled'] as const)('%s still prevents dispatch without resetting evidence', async reason => {
    await fixture(async f => {
      const token = await claim(f)
      const op = await prepareOperation(token, { key: 'first', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      if (reason !== 'cancelled') {
        await markProviderDispatched(token, attempt.id)
        if (reason === 'corrupt') {
          await recordProviderUsage({ userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash, revision: 1,
            usage: { source: 'reported', promptTokens: 1000, completionTokens: 0, cacheHitTokens: null, cacheMissTokens: null } })
          await recordProviderResult({ userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash, outcome: 'succeeded', result: {} })
          await prisma.agentProviderUsageReceipt.update({ where: { attemptId: attempt.id }, data: { promptTokens: 0 } })
        }
      }
      const next = await prepareOperation(token, { key: 'second', kind: 'provider', action: 'chat', input: {} })
      const second = await prepareProviderAttempt(token, { operationId: next.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      if (reason === 'cancelled') await pauseDurableTask(f.userId, f.runId)
      await expect(markProviderDispatched(token, second.id)).rejects.toMatchObject({ code: reason === 'unknown' ? 'RUNTIME_RECONCILIATION_REQUIRED'
        : reason === 'corrupt' ? 'RUNTIME_RECEIPT_INVALID' : 'RUNTIME_NOT_ACTIVE' })
      expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: second.id } })).dispatchedAt).toBeNull()
    })
  })

  it('checks every fully observed batch and parks repeated same-state reads with durable replay proof', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const tool = chapterReadTool
      await initializeExecutionState(token, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
      let firstProgress = ''
      for (let index = 0; index < 5; index++) {
        const { frame } = await loadExecutionState(f.userId, f.runId)
        await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: null,
            toolCalls: [{ id: `read-${index}`, name: tool.name, arguments: JSON.stringify({ chapterId: f.chapterId }) }] }] } })
        await executeDurableToolStep(token, new AbortController().signal)
        const current = await loadExecutionState(f.userId, f.runId)
        const evidence = await withRunLease(token, tx => collectDurableToolEvidence(tx, f.rootId, current.frame.revision))
        if (index === 0) firstProgress = evidence.progressSequence
        expect(evidence.progressSequence).toBe(firstProgress)
        const decision = await advanceDurableToolStagnation(token)
        expect(decision?.kind ?? null).toBe(index === 4 ? 'needs_attention' : null)
        expect(await advanceDurableToolStagnation(token)).toEqual(decision)
      }
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.stagnation' } })).toBe(5)
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
      const last = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'execution.stagnation' }, orderBy: { sequence: 'desc' } })
      await prisma.agentExecutionOutbox.update({ where: { id: last.id }, data: { payload: runtimeJson({ ...(last.payload as object), stagnantBatches: 0 }).value } })
      await expect(advanceDurableToolStagnation(token)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      await prisma.agentExecutionOutbox.update({ where: { id: last.id }, data: { payload: last.payload! } })
      // A fresh lease/restart cannot consume the same completed batch again.
      await pauseDurableTask(f.userId, f.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
      const restarted = await acquireRunLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'restart-worker', claimId: randomUUID() })
      expect((await advanceDurableToolStagnation(restarted))?.kind).toBe('needs_attention')
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.stagnation' } })).toBe(5)
    })
  }, 15000)
})

describe.runIf(available)('persisted semantic progress, separate from revision admission', () => {
  it('actual healthy child grant waits preserve stagnation count and frame proof without dispatching a provider', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const tools = [taskSpawnTool, taskWaitTool, chapterReadTool]
      const args = { tasks: [{ title: '独立审阅', brief: '只读审阅原任务的既有作品设定并交付完整报告，保持全部正文不变。' }], mode: 'review', inherit: 'brief' }
      const initial = await initializeExecutionState(token, { configuration: { version: 1, mode: 'review', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: toOpenAIParameters(tool.parameters) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow' as const, alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '只读审阅本章' }, { role: 'assistant', content: null, toolCalls: [{ id: 'spawn', name: 'task_spawn', arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const prepare = async (frame: typeof initial.frame, action: string, callId: string, input: Record<string, unknown>, tool: typeof taskSpawnTool | typeof taskWaitTool) =>
        prepareToolCursorOperation(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, { key: `exec:${frame.state.nextOperationSequence}`, action, callId,
          targetId: f.rootId, effectDomain: 'read', effectiveArgs: input, operationInput: { callId, args: input }, normalize: raw => tool.parameters.parse(raw) })
      const spawned = await prepare(initial.frame, 'task_spawn', 'spawn', args, taskSpawnTool)
      const grant = await admitChildExecution(token, { parentOperationId: spawned.operation.id, childIndex: 0, kind: 'spawned', role: 'orchestrator', name: args.tasks[0].title,
        prompt: args.tasks[0].brief, spec: { ...f.spec, id: randomUUID() }, configuration: initial.configuration,
        price: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 0 }, tokenCeiling: 500, turnCeiling: 1, roleTools: ['chapter_read'],
        messages: [{ role: 'user', content: args.tasks[0].brief }] })
      await commitOperationEffect(token, spawned.operation.id, spawned.operation.inputHash, async () => ({ toolResult: { output: '已登记原任务的只读子任务', summary: '子任务已登记' } }))
      await reduceExecutionReceipt(token, { expectedRevision: spawned.pending.revision, expectedHash: spawned.pending.snapshotHash, operationId: spawned.operation.id })
      const child = await prisma.agentRun.findUniqueOrThrow({ where: { id: grant.childRunId } })
      for (let index = 0; index < 6; index++) {
        const { frame } = await loadExecutionState(f.userId, f.runId)
        const input = { sessionIds: [child.sessionId], mode: 'all', timeoutSeconds: 10 }
        const source = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: `wait-${index}`, name: 'task_wait', arguments: JSON.stringify(input) }] }] } })
        const wait = await prepare(source, 'task_wait', `wait-${index}`, input, taskWaitTool)
        // DB-only native observation of the real admitted queued child. Never
        // start its provider merely to test the parent's waiting fence.
        const stored = await prisma.agentRun.findUniqueOrThrow({ where: { id: child.id } })
        expect(stored.status).toBe('queued')
        await commitOperationEffect(token, wait.operation.id, wait.operation.inputHash, async () => ({ toolResult: { output: `子任务 ${stored.sessionId} 仍在执行`, summary: '仍在执行' } }))
        await reduceExecutionReceipt(token, { expectedRevision: wait.pending.revision, expectedHash: wait.pending.snapshotHash, operationId: wait.operation.id })
        expect(await advanceDurableToolStagnation(token)).toBeNull()
        expect(await advanceDurableToolStagnation(token)).toBeNull()
        const decision = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'execution.stagnation' }, orderBy: { sequence: 'desc' } })
        expect(decision.payload).toMatchObject({ stagnantBatches: 0, healthyChildWaiting: true })
        const state = await loadExecutionState(f.userId, f.runId)
        expect(state.frame.state.stagnation).toMatchObject({ payloadHash: runtimeJson(decision.payload).hash })
      }
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: { in: [f.rootId, child.taskRootId!] } } } })).toBe(0)
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.stagnation' } })).toBe(6)
    }, undefined, '只读审阅本章')
  }, 30000)

  it('actual structural noop/revision-only changes do not buy progress, but real title/body and cycles are identified', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const volume = await prisma.volume.findFirstOrThrow({ where: { novelId: f.novelId } })
      const seen = new Set<string>()
      const ctx = { ...f, callId: 'structure', mode: 'build' as const, creativeFreedom: 'balanced' as const, qualityMode: 'premium' as const,
        emit: () => {}, signal: new AbortController().signal, toolAuthority: new Map([['volume_update', { permission: 'allow' as const, alwaysConfirm: false, dangerous: false }]]) }
      const hash = await withRunLease(token, tx => readSemanticStructureHash(tx, f.novelId))
      await prisma.volume.update({ where: { id: volume.id }, data: { revision: { increment: 1 } } })
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
      expect(await withRunLease(token, tx => readSemanticStructureHash(tx, f.novelId))).toBe(hash)
      const noop = await volumeUpdateTool.execute(ctx, { volumeId: volume.id, title: volume.title })
      expect(noop.semanticTransition).toMatchObject({ beforeHash: hash, afterHash: hash })
      const moved = await volumeUpdateTool.execute(ctx, { volumeId: volume.id, title: '实际新卷名' })
      const change = moved.semanticTransition!
      expect(observeSemanticTransition(seen, f.novelId, change.beforeHash, change.afterHash)).toBe(true)
      const restored = await volumeUpdateTool.execute(ctx, { volumeId: volume.id, title: volume.title })
      expect(observeSemanticTransition(seen, f.novelId, restored.semanticTransition!.beforeHash, restored.semanticTransition!.afterHash)).toBe(false)
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '真实正文小修', revision: { increment: 1 } } })
      expect(await withRunLease(token, tx => readSemanticStructureHash(tx, f.novelId))).not.toBe(hash)
    }, undefined, '授权自主创作全书，并修改已有章节及卷章结构。')
  })

  it('chapter revision-only re-read does not refresh the observed progress sequence', async () => {
    await fixture(async f => {
      const token = await claim(f), tool = chapterReadTool
      await initializeExecutionState(token, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
      const read = async (index: number) => {
        const { frame } = await loadExecutionState(f.userId, f.runId)
        await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: null,
            toolCalls: [{ id: `r-${index}`, name: tool.name, arguments: JSON.stringify({ chapterId: f.chapterId }) }] }] } })
        await executeDurableToolStep(token, new AbortController().signal)
        const current = await loadExecutionState(f.userId, f.runId)
        return withRunLease(token, tx => collectDurableToolEvidence(tx, f.rootId, current.frame.revision))
      }
      const first = await read(1)
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
      expect((await read(2)).progressSequence).toBe(first.progressSequence)
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '真实新正文', revision: { increment: 1 } } })
      expect((await read(3)).progressSequence).not.toBe(first.progressSequence)
    })
  })
})

describe.runIf(available)('actual saved-frame consumers beyond historical default allowances', () => {
  it('one v2 task continues real chapter progress beyond its frozen one-turn policy without changing raw policy or prior frames', async () => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      const policy = runtimeJson(oldPolicy(2))
      await prisma.agentTaskBudget.update({ where: { taskRootId: f.rootId }, data: { policy: policy.value, policyHash: policy.hash, tokenLimit: 500 } })
      const token = await acquireRunLease({ ...f, ownerId: 'progress-worker', claimId: randomUUID(), ttlMs: 120000 })
      const tools = [chapterReadTool, chapterWriteTool]
      const initial = await initializeExecutionState(token, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
      for (let index = 0; index < 52; index++) {
        const { frame } = await loadExecutionState(f.userId, f.runId)
        const op = await prepareOperation(token, { key: `exec:${frame.state.nextOperationSequence}`, kind: 'provider', action: 'chat', input: {} })
        const pending = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, phase: 'awaiting_operation', pendingOperationId: op.id, turn: frame.state.turn + 1, nextOperationSequence: frame.state.nextOperationSequence + 1 } })
        const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: { body: { max_tokens: 100 } } })
        expect((await markProviderDispatched(token, attempt.id)).dispatchGranted).toBe(true)
        const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
        await recordProviderUsage({ ...identity, revision: 1, usage: { source: 'reported', promptTokens: 100000, completionTokens: 100, cacheHitTokens: null, cacheMissTokens: null } })
        await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '', reasoning: '', usage: { promptTokens: 100000, completionTokens: 100, totalTokens: 100100, promptCacheHitTokens: null, promptCacheMissTokens: null },
          finishReason: 'tool_calls', toolCalls: [{ id: `read-${index}`, name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
            { id: `write-${index}`, name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: `真实正文推进第${index}次` }) }] } })
        await reduceExecutionReceipt(token, { expectedRevision: pending.revision, expectedHash: pending.snapshotHash, operationId: op.id })
        await executeDurableToolStep(token, new AbortController().signal)
        await executeDurableToolStep(token, new AbortController().signal)
        expect(await advanceDurableToolStagnation(token)).toBeNull()
      }
      const current = await loadExecutionState(f.userId, f.runId)
      expect(current.frame.state.turn).toBe(52)
      expect(current.frame.state.checkpointIndex).toBe(0)
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('真实正文推进第51次')
      const stored = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
      expect(stored.policy).toEqual(policy.value); expect(stored.policyHash).toBe(policy.hash)
      expect(stored).toMatchObject({ tokenLimit: 500, checkpointCount: 0, compactionCount: 0 })
      expect((await readTaskBudget(token)).usedTokens).toBe(5205200n)
      expect((await prisma.agentExecutionFrame.findUniqueOrThrow({ where: { taskRootId_revision: { taskRootId: f.rootId, revision: 0 } } })).snapshotHash).toBe(initial.frame.snapshotHash)
    })
  }, 120000)

  it('context pressure can archive beyond old six-compaction quota while preserving original request/raw frame and policy', async () => {
    await fixture(async f => {
      const policy = runtimeJson(oldPolicy(2))
      await prisma.agentTaskBudget.update({ where: { taskRootId: f.rootId }, data: { policy: policy.value, policyHash: policy.hash, tokenLimit: 500 } })
      const token = await claim(f), tool = executionContextReadTool
      const initial = await initializeExecutionState(token, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
      for (let round = 0; round < 8; round++) {
        const { frame } = await loadExecutionState(f.userId, f.runId)
        const messages = [...frame.state.messages]
        for (let index = 0; index < 4; index++) messages.push({ role: 'assistant', content: null,
          toolCalls: [{ id: `archived-${round}-${index}`, name: 'chapter_read', arguments: '{}' }] },
          { role: 'tool', toolCallId: `archived-${round}-${index}`, content: `已保存观察${round}-${index}：` + '正文证据'.repeat(2000) })
        await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...frame.state, messages } })
        const archived = await advanceDurableContext(token, 5000)
        expect(archived).not.toBeNull()
        expect(archived?.state.messages[0]).toEqual(initial.frame.state.messages[0])
      }
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.context.archived' } })).toBe(8)
      expect((await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).policyHash).toBe(policy.hash)
      expect((await readTaskBudget(token)).budget.compactionCount).toBe(0)
      expect((await prisma.agentExecutionFrame.findUniqueOrThrow({ where: { taskRootId_revision: { taskRootId: f.rootId, revision: 0 } } })).snapshot).toEqual(initial.frame.snapshot)
    })
  }, 30000)
})
