import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
const mocks = vi.hoisted(() => ({ tx: { agentExecutionOutbox: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
  agentOperation: { findMany: vi.fn(), count: vi.fn() }, coverAsset: { findMany: vi.fn() } },
  scope: vi.fn(), assertScope: vi.fn(), clarify: vi.fn(), frame: vi.fn(), state: vi.fn(), prepare: vi.fn(), reduce: vi.fn(), commit: vi.fn(), now: vi.fn(), save: vi.fn(), budget: vi.fn(),
  goal: vi.fn(), setGoalPhase: vi.fn(), recordFailure: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionFrame: mocks.frame, readExecutionStateInTransaction: mocks.state, saveExecutionStateInTransaction: mocks.save }))
vi.mock('../../api/lib/agent/runtime-budget.js', () => ({ readTaskBudgetInTransaction: mocks.budget }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(), prepareToolCursorOperation: mocks.prepare }))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ commitOperationEffectInTransaction: mocks.commit, recordToolFailure: vi.fn(), recordToolFailureInTransaction: mocks.recordFailure }))
vi.mock('../../api/lib/agent/runtime-reducer.js', async original => ({ ...await original<object>(), reduceExecutionReceipt: mocks.reduce }))
vi.mock('../../api/lib/agent/writing-scope.js', () => ({ readWritingScope: mocks.scope, assertQuestionWritingScope: mocks.assertScope }))
vi.mock('../../api/lib/agent/writing-clarification.js', () => ({ recordWritingClarification: mocks.clarify }))
vi.mock('../../api/lib/agent/goal-fence.js', () => ({ readGoalExecution: mocks.goal, assertGoalRevisionFence: vi.fn() }))
vi.mock('../../api/lib/agent/goal-runtime.js', () => ({ setGoalRunPhaseInTransaction: mocks.setGoalPhase }))
vi.mock('../../api/lib/agent/runtime-common.js', async original => ({ ...await original<object>(), databaseNow: mocks.now }))
import { executeDurableQuestion, validateHistoricalQuestionReceipt } from '../../api/lib/agent/runtime-question.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import type { ToolExecutionCursor } from '../../api/lib/agent/runtime-tool-cursor.js'
import type { AgentTool, ToolContext } from '../../api/lib/agent/tools/types.js'
import { askUserTool, formatUnansweredQuestionWrapUp } from '../../api/lib/agent/tools/interact-tools.js'

const lease = { userId: 'author', runId: 'run', taskRootId: 'original-root', ownerId: 'worker', claimId: 'claim', epoch: 1n } as RunLeaseToken
const ctx: ToolContext = { userId: lease.userId, novelId: 'novel', sessionId: 'session', runId: lease.runId,
  chapterId: null, callId: 'original-call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
const args = { question: '保存在哪一章？', options: [{ label: '第一章' }, { label: '先讨论' }] }
const tool: AgentTool = { name: 'ask_user', title: '提问', description: 'fixture', readOnly: true,
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, parameters: z.object({ question: z.string(), options: z.array(z.object({ label: z.string() })) }),
  execute: async () => ({ output: 'unused' }) }
const cursor = { expectedRevision: 0, expectedHash: 'snapshot' } as ToolExecutionCursor
const request = { id: 'original-question', taskRootId: lease.taskRootId, runId: lease.runId, operationId: 'operation', type: 'question.requested',
  payload: { version: 1, operationId: 'operation', callId: ctx.callId, ...args, expiresAt: '2030-01-01T00:00:00.000Z' } }
let answer: { taskRootId: string; operationId: string; type: string; payload: Record<string, unknown> } | null
function frozenScope(kind: 'bounded' | 'needs_input') {
  const spec = buildTaskSpec({ runId: lease.runId, novelId: ctx.novelId, prompt: '请写一段短场景' })
  spec.scope.writing = { version: 1, kind, titleAndBodyOnly: false, repairAuthorized: false,
    targets: kind === 'bounded' ? [{ chapterId: 'chapter', orderIndex: 1 }] : [] }
  mocks.scope.mockResolvedValue({ spec, writing: spec.scope.writing })
}
beforeEach(() => {
  vi.clearAllMocks()
  frozenScope('needs_input')
  mocks.frame.mockResolvedValue({ state: { nextOperationSequence: 0 } })
  mocks.prepare.mockResolvedValue({ operation: { id: 'operation', inputHash: 'input' }, pending: { revision: 1, snapshotHash: 'pending' } })
  mocks.clarify.mockResolvedValue(null)
  mocks.goal.mockResolvedValue(undefined)
  mocks.reduce.mockResolvedValue({ revision: 2, snapshotHash: 'reduced', state: { phase: 'idle' } })
  mocks.now.mockResolvedValue(new Date('2026-11-04T00:00:00.000Z'))
  mocks.tx.agentExecutionOutbox.count.mockResolvedValue(0)
  mocks.tx.agentExecutionOutbox.findFirst.mockResolvedValue(null)
  mocks.tx.agentOperation.count.mockResolvedValue(0)
  mocks.budget.mockResolvedValue({ unresolvedAttempts: 0n })
  mocks.commit.mockImplementation(async (_tx, _lease, _id, _hash, effect: () => unknown) => ({ result: await effect() }))
  answer = { taskRootId: lease.taskRootId, operationId: 'operation', type: 'question.answered', payload: {
    requestId: request.id, requestHash: runtimeJson(request.payload).hash, answer: '第一章：启程（约4000字）', userId: lease.userId,
  } }
  mocks.tx.agentExecutionOutbox.findUnique.mockImplementation(async ({ where }: { where: { eventKey: string } }) =>
    where.eventKey.startsWith('question-answer:') ? answer : request)
})

describe('durable question semantic scope receipts', () => {
  it('labels scope accepted only when the original call records a real clarification transition', async () => {
    mocks.clarify.mockResolvedValue({ targetId: 'writing-scope:original-root', beforeHash: 'old', afterHash: 'new' })
    const result = await executeDurableQuestion(lease, cursor, ctx, tool, args)
    expect(result).toMatchObject({ kind: 'tool', result: { display: { kind: 'question', scopeResolution: 'accepted' },
      semanticTransition: { targetId: 'writing-scope:original-root' } } })
    expect(mocks.clarify).toHaveBeenCalledWith(mocks.tx, ctx, expect.objectContaining({ callId: ctx.callId, requestId: request.id, source: 'durable_question' }))
    expect(mocks.reduce).toHaveBeenCalledOnce()
  })
  it('distinguishes a received but unaccepted answer from a confirmed writing target', async () => {
    expect(await executeDurableQuestion(lease, cursor, ctx, tool, args)).toMatchObject({ kind: 'tool', result: { display: { kind: 'question' } } })
    expect((await mocks.commit.mock.results[0].value).result).toMatchObject({ toolResult: {
      display: { answer: answer!.payload.answer } } })
  })
  it('does not mark an ordinary creative preference as manuscript authority', async () => {
    frozenScope('bounded')
    const result = await executeDurableQuestion(lease, cursor, ctx, tool, args)
    expect(result.kind).toBe('tool')
    if (result.kind !== 'tool') throw Error('fixture expected an answered question')
    expect(result.result.display).not.toHaveProperty('scopeResolution')
    expect(result.result.failureCode).toBeUndefined()
  })
  it.each(['owned', 'unavailable'] as const)('admits image-bearing durable questions only against scoped assets: %s', async scenario => {
    const cover = { label: '第一张', detail: '蓝色调', coverAssetId: 'cover-id' }
    const question = { question: '用哪张封面？', options: [cover, { label: '暂不应用' }] }
    const batch = { ...args, questions: [args, question] }
    const response = { ...answer!, payload: { requestId: request.id, userId: lease.userId, answers: ['第一章', '第一张（蓝色调）'] } }
    let saved: typeof request | undefined
    mocks.tx.agentExecutionOutbox.findUnique.mockImplementation(async ({ where }) => where.eventKey.startsWith('question-answer:')
      ? saved && { ...response, payload: { ...response.payload, requestHash: runtimeJson(saved.payload).hash } } : saved)
    mocks.tx.agentExecutionOutbox.create.mockImplementation(async ({ data }) => saved = { ...data, id: request.id })
    mocks.tx.coverAsset.findMany.mockResolvedValue(scenario === 'owned' ? [{ id: 'cover-id' }] : [])
    mocks.recordFailure.mockImplementation(async (_tx, _lease, { code, summary, output }) => ({ result: { code,
      outcome: 'failed', effectApplied: false, toolResult: { summary, output } } }))
    const compatible = { ...ctx, writingScope: { novelId: ctx.novelId, agentQuestionProtocol: 1 as const } }
    const result = await executeDurableQuestion(lease, cursor, compatible, askUserTool, batch)
    expect(mocks.tx.coverAsset.findMany).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: ['cover-id'] }, ownerUserId: ctx.userId, novelId: ctx.novelId }, select: { id: true } })
    if (scenario === 'unavailable') {
      expect(result).toMatchObject({ kind: 'tool', result: { failureCode: 'QUESTION_COVER_UNAVAILABLE', outcome: 'failed' } })
      expect(mocks.tx.agentExecutionOutbox.create).not.toHaveBeenCalled()
      expect(mocks.clarify).not.toHaveBeenCalled()
      return
    }
    expect(saved?.payload).toMatchObject(batch)
    expect(result).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining('作者选择的封面候选 coverAssetId：cover-id'),
      display: { ...batch, answer: '第一章', answers: response.payload.answers } } })
  })
  it('rejects a fresh batch for an unmarked client before publishing a pending question', async () => {
    mocks.tx.agentExecutionOutbox.findUnique.mockResolvedValue(null)
    mocks.recordFailure.mockImplementation(async (_tx, _lease, { code, summary, output }) => ({ result: {
      code, outcome: 'failed', effectApplied: false, toolResult: { summary, output },
    } }))
    const result = await executeDurableQuestion(lease, cursor, ctx, askUserTool, { questions: [args] })
    expect(result).toMatchObject({ kind: 'tool', result: { failureCode: 'TOOL_SCHEMA_INVALID', outcome: 'failed' } })
    expect(mocks.tx.agentExecutionOutbox.create).not.toHaveBeenCalled()
  })
  it.each(['answer', 'cancel', 'partial'] as const)('consumes a batch only with a full saved answer or explicit cancellation: %s', async scenario => {
    const questions = [args, { question: '采用哪个视角？', options: [{ label: '第三人称' }, { label: '第一人称' }] }]
    const batch = { ...request, payload: { ...request.payload, questions } }
    const answers = ['第一章', '第三人称']
    const goal = { goalId: 'goal', runId: lease.runId }
    mocks.goal.mockResolvedValue(goal)
    answer!.payload = { requestId: request.id, requestHash: runtimeJson(batch.payload).hash, userId: lease.userId,
      ...(scenario === 'cancel' ? { cancelled: true } : { answers: scenario === 'partial' ? answers.slice(0, 1) : answers }) }
    if (scenario === 'cancel') answer!.type = 'question.cancelled'
    mocks.tx.agentExecutionOutbox.findUnique.mockImplementation(async ({ where }) => where.eventKey.startsWith('question-answer:') ? answer : batch)
    const run = () => executeDurableQuestion(lease, cursor, ctx, askUserTool, { questions })
    if (scenario === 'partial') {
      await expect(run()).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(mocks.commit).not.toHaveBeenCalled()
      expect(mocks.clarify).not.toHaveBeenCalled()
      expect(mocks.setGoalPhase).not.toHaveBeenCalled()
      return
    }
    if (scenario === 'cancel') {
      expect(await run()).toMatchObject({ kind: 'tool', result: { output: '已取消提问，已保存的内容会保留。你希望接下来怎么处理？', questionCancelled: true, questionCancellationVersion: 2,
        display: { kind: 'question', questions, cancelled: true, unanswered: true } } })
      expect(mocks.clarify).not.toHaveBeenCalled()
      expect(mocks.setGoalPhase).toHaveBeenCalledExactlyOnceWith(mocks.tx, goal, 'awaiting_input', 'GOAL_QUESTION_CANCELLED')
    } else {
      expect(await run()).toMatchObject({ kind: 'tool', result: { output: '1. 保存在哪一章？\n作者的回答：第一章\n\n2. 采用哪个视角？\n作者的回答：第三人称',
        display: { kind: 'question', questions, answer: '第一章', answers } } })
      expect(mocks.clarify).toHaveBeenCalledExactlyOnceWith(mocks.tx, ctx, expect.objectContaining({ ...args, answer: '第一章' }))
      expect(mocks.setGoalPhase).not.toHaveBeenCalled()
    }
  })
  it('uses only the displayed order of image options for a cover follow-up and exposes no asset IDs', () => {
    const options = [{ label: '暂不应用' }, { label: '山景', coverAssetId: 'asset-z' }, { label: '海景', coverAssetId: 'asset-a' }]
    expect(formatUnansweredQuestionWrapUp({ options })).toBe('已取消提问，未根据这次提问应用封面。你可以回复「第一张」（山景）、「第二张」（海景），或说「你帮我选一张」。')
    expect(formatUnansweredQuestionWrapUp({ options: options.slice(0, 2) })).not.toContain('第二张')
  })
  it('keeps an unanswered required scope unresolved without recording an author grant', async () => {
    answer = null
    mocks.now.mockResolvedValue(new Date('2031-01-01T00:00:00.000Z'))
    expect(await executeDurableQuestion(lease, cursor, ctx, tool, args)).toMatchObject({ kind: 'tool', result: { questionTimedOut: true, display: { unanswered: true } } })
    expect(mocks.clarify).not.toHaveBeenCalled()
  })
  it.each(['automatic', 'unknown', 'explicit'] as const)('supersedes an ended timeout only for a fenced author resume with settled effects: %s', async scenario => {
    const frame = { revision: 2, snapshotHash: 'saved-timeout', state: { phase: 'idle', messages: [
      { role: 'assistant', content: '提问已超时，本轮已结束。', localCompletion: { kind: 'question_timeout', operationId: 'operation' } },
    ] } }
    mocks.state.mockResolvedValue({ frame })
    if (scenario !== 'automatic') mocks.tx.agentExecutionOutbox.findFirst.mockResolvedValue({ eventKey: 'resume:pause',
      payload: { revision: frame.revision, snapshotHash: frame.snapshotHash, runId: lease.runId, pauseEventId: 'pause' } })
    if (scenario === 'unknown') mocks.budget.mockResolvedValue({ unresolvedAttempts: 1n })
    if (scenario !== 'explicit') {
      expect(await validateHistoricalQuestionReceipt(lease)).toEqual(frame)
      expect(mocks.save).not.toHaveBeenCalled()
      return
    }
    expect(await validateHistoricalQuestionReceipt(lease)).toBeNull()
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(mocks.tx, lease, expect.objectContaining({
      expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
      snapshot: expect.objectContaining({ messages: [...frame.state.messages,
        expect.objectContaining({ role: 'system', content: expect.stringContaining('作者已主动继续原任务') })] }),
    }))
  })
  it.each([true, false])('validates old required-scope receipts without pausing again, required=%s', async required => {
    const input = runtimeJson({ input: { callId: ctx.callId, args } })
    const result = runtimeJson({ toolResult: { output: 'reply', ...(required ? { failureCode: 'AUTHOR_INPUT_REQUIRED' } : {}) } })
    const frame = { revision: 2, snapshotHash: 'frame', state: { phase: 'idle', messages: [
      { role: 'assistant', content: null, toolCalls: [{ id: ctx.callId, name: 'ask_user', arguments: JSON.stringify(args) }] },
      { role: 'tool', toolCallId: ctx.callId, content: 'reply' },
    ] } }
    mocks.state.mockResolvedValue({ frame })
    mocks.tx.agentOperation.findMany.mockResolvedValue([{ id: 'operation', inputSnapshot: input.value, inputHash: input.hash,
      effectReceipt: { result: result.value, resultHash: result.hash } }])
    mocks.tx.agentExecutionOutbox.findUnique.mockResolvedValue({ taskRootId: lease.taskRootId, operationId: 'operation', type: 'effect.committed',
      payload: { operationId: 'operation', resultHash: result.hash } })
    expect(await validateHistoricalQuestionReceipt(lease)).toBeNull()
    if (required) {
      mocks.tx.agentOperation.findMany.mockResolvedValue([{ id: 'operation', inputSnapshot: input.value, inputHash: 'corrupt',
        effectReceipt: { result: result.value, resultHash: result.hash } }])
      await expect(validateHistoricalQuestionReceipt(lease)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    }
  })
  it.each([true, false])('uses saved normalization for wrapped string options without reinterpreting history, required=%s', async required => {
    const rawArguments = '```json\n' + JSON.stringify({ input: { question: ` ${args.question} `, options: ['第一章', '先讨论'] } }) + '\n```'
    const input = runtimeJson({ input: { callId: ctx.callId, args, normalization: { version: 1, rawArguments,
      normalizedArgsHash: runtimeJson(args).hash, sourceRevision: 0, sourceSnapshotHash: 'a'.repeat(64) } } })
    const result = runtimeJson({ toolResult: { output: 'reply', ...(required ? { failureCode: 'AUTHOR_INPUT_REQUIRED' } : {}) } })
    mocks.state.mockResolvedValue({ frame: { revision: 2, snapshotHash: 'frame', state: { phase: 'idle', messages: [
      { role: 'assistant', content: null, toolCalls: [{ id: ctx.callId, name: 'ask_user', arguments: rawArguments }] },
      { role: 'tool', toolCallId: ctx.callId, content: 'reply' },
    ] } } })
    mocks.frame.mockResolvedValue({ snapshotHash: 'a'.repeat(64) })
    mocks.tx.agentOperation.findMany.mockResolvedValue([{ id: 'operation', inputSnapshot: input.value, inputHash: input.hash,
      effectReceipt: { result: result.value, resultHash: result.hash } }])
    mocks.tx.agentExecutionOutbox.findUnique.mockResolvedValue({ taskRootId: lease.taskRootId, operationId: 'operation', type: 'effect.committed',
      payload: { operationId: 'operation', resultHash: result.hash } })
    expect(await validateHistoricalQuestionReceipt(lease)).toBeNull()
    if (required) {
      mocks.frame.mockResolvedValue({ snapshotHash: 'wrong-source' })
      await expect(validateHistoricalQuestionReceipt(lease)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    }
  })
  it('does not turn an already consumed failed/imported ask into a missing-success receipt error', async () => {
    mocks.state.mockResolvedValue({ frame: { state: { phase: 'idle', messages: [
      { role: 'assistant', toolCalls: [{ id: ctx.callId, name: 'ask_user', arguments: JSON.stringify(args) }] },
      { role: 'tool', toolCallId: ctx.callId, content: 'scope/schema rejected' },
    ] } } })
    mocks.tx.agentOperation.findMany.mockResolvedValue([])
    expect(await validateHistoricalQuestionReceipt(lease)).toBeNull()
  })
  it('rejects an answer linked to a different question before any clarification effect', async () => {
    answer!.payload.requestHash = 'wrong-question'
    await expect(executeDurableQuestion(lease, cursor, ctx, tool, args)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.clarify).not.toHaveBeenCalled()
  })
})
