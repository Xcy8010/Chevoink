import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
const mocks = vi.hoisted(() => ({ tx: { agentExecutionOutbox: { findUnique: vi.fn(), count: vi.fn() }, agentOperation: { findMany: vi.fn() } },
  scope: vi.fn(), assertScope: vi.fn(), clarify: vi.fn(), frame: vi.fn(), state: vi.fn(), prepare: vi.fn(), reduce: vi.fn(), commit: vi.fn(), now: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionFrame: mocks.frame, readExecutionStateInTransaction: mocks.state }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(), prepareToolCursorOperation: mocks.prepare }))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ commitOperationEffectInTransaction: mocks.commit, recordToolFailure: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-reducer.js', () => ({ reduceExecutionReceipt: mocks.reduce }))
vi.mock('../../api/lib/agent/writing-scope.js', () => ({ readWritingScope: mocks.scope, assertQuestionWritingScope: mocks.assertScope }))
vi.mock('../../api/lib/agent/writing-clarification.js', () => ({ recordWritingClarification: mocks.clarify }))
vi.mock('../../api/lib/agent/runtime-common.js', async original => ({ ...await original<object>(), databaseNow: mocks.now }))
import { executeDurableQuestion, readDurableAuthorInputBoundary } from '../../api/lib/agent/runtime-question.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import type { ToolExecutionCursor } from '../../api/lib/agent/runtime-tool-cursor.js'
import type { AgentTool, ToolContext } from '../../api/lib/agent/tools/types.js'

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
  mocks.reduce.mockResolvedValue({ revision: 2, snapshotHash: 'reduced', state: { phase: 'idle' } })
  mocks.now.mockResolvedValue(new Date('2026-11-04T00:00:00.000Z'))
  mocks.tx.agentExecutionOutbox.count.mockResolvedValue(0)
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
    expect(await executeDurableQuestion(lease, cursor, ctx, tool, args)).toMatchObject({ kind: 'needs_attention', authorInputRequired: true,
      frame: { revision: 2, snapshotHash: 'reduced' } })
    expect((await mocks.commit.mock.results[0].value).result).toMatchObject({ toolResult: {
      failureCode: 'AUTHOR_INPUT_REQUIRED', display: { answer: answer!.payload.answer, scopeResolution: 'needs_input' } } })
  })
  it('does not mark an ordinary creative preference as manuscript authority', async () => {
    frozenScope('bounded')
    const result = await executeDurableQuestion(lease, cursor, ctx, tool, args)
    expect(result.kind).toBe('tool')
    if (result.kind !== 'tool') throw Error('fixture expected an answered question')
    expect(result.result.display).not.toHaveProperty('scopeResolution')
    expect(result.result.failureCode).toBeUndefined()
  })
  it('keeps an unanswered required scope unresolved without recording an author grant', async () => {
    answer = null
    mocks.now.mockResolvedValue(new Date('2031-01-01T00:00:00.000Z'))
    expect(await executeDurableQuestion(lease, cursor, ctx, tool, args)).toMatchObject({ kind: 'needs_attention', authorInputRequired: true,
      frame: { revision: 2, snapshotHash: 'reduced' } })
    expect(mocks.clarify).not.toHaveBeenCalled()
  })
  it.each([true, false])('recovers only the verified current required-scope effect, required=%s', async required => {
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
    expect(await readDurableAuthorInputBoundary(lease)).toEqual(required ? { kind: 'needs_attention', frame, authorInputRequired: true,
      reason: expect.any(String) } : null)
    if (required) {
      mocks.tx.agentOperation.findMany.mockResolvedValue([{ id: 'operation', inputSnapshot: input.value, inputHash: 'corrupt',
        effectReceipt: { result: result.value, resultHash: result.hash } }])
      await expect(readDurableAuthorInputBoundary(lease)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
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
    expect(await readDurableAuthorInputBoundary(lease)).toEqual(required ? expect.objectContaining({ kind: 'needs_attention', authorInputRequired: true }) : null)
    if (required) {
      mocks.frame.mockResolvedValue({ snapshotHash: 'wrong-source' })
      await expect(readDurableAuthorInputBoundary(lease)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    }
  })
  it('does not turn an already consumed failed/imported ask into a missing-success receipt error', async () => {
    mocks.state.mockResolvedValue({ frame: { state: { phase: 'idle', messages: [
      { role: 'assistant', toolCalls: [{ id: ctx.callId, name: 'ask_user', arguments: JSON.stringify(args) }] },
      { role: 'tool', toolCallId: ctx.callId, content: 'scope/schema rejected' },
    ] } } })
    mocks.tx.agentOperation.findMany.mockResolvedValue([])
    expect(await readDurableAuthorInputBoundary(lease)).toBeNull()
  })
  it('rejects an answer linked to a different question before any clarification effect', async () => {
    answer!.payload.requestHash = 'wrong-question'
    await expect(executeDurableQuestion(lease, cursor, ctx, tool, args)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.clarify).not.toHaveBeenCalled()
  })
})
