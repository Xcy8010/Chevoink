import { beforeEach, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import { readExecutionFrame, saveExecutionStateInTransaction } from '../../api/lib/agent/runtime-state.js'
import { deferReviewWriteInTransaction, deferWritingTodoProposalInTransaction, projectReviewWriteDeferral } from '../../api/lib/agent/runtime-review-deferral.js'
import { isCompletedWritingRepeatProposal } from '../../api/lib/agent/runtime-writing-todo.js'

vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionFrame: vi.fn(), saveExecutionStateInTransaction: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

it.each(['chapter_read', 'quality_report_get', 'chapter_bridge_get', 'execution_context_read', 'web_search', 'web_read', 'todo_write', 'ask_user'])(
  'keeps %s available while reconciling the original plan', action => expect(isCompletedWritingRepeatProposal(action)).toBe(false))

it.each(['chapter_write', 'chapter_append', 'chapter_edit_range', 'story_compiler_prepare', 'scene_task_build', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit'])(
  'recognizes repeated %s delivery work', action => expect(isCompletedWritingRepeatProposal(action)).toBe(true))

it.each(['chapter_write', 'quality_analyze', 'chapter_bridge_commit'] as const)('preserves the %s call identity and observes only not_dispatched before the next todo call', async action => {
  const call = { id: 'repeat', name: action, arguments: '{"chapterId":"chapter"}' }
  const snapshot = { phase: 'idle', pendingOperationId: null, nextOperationSequence: 7, turn: 3, messages: [{ role: 'assistant', content: null, toolCalls: [call,
    { id: 'todo', name: 'todo_write', arguments: '{"items":[]}' }] }] }
  const previous = { revision: 12, snapshotHash: runtimeJson(snapshot).hash, state: snapshot } as unknown as Awaited<ReturnType<typeof readExecutionFrame>>
  const before = structuredClone(previous)
  let next: Awaited<ReturnType<typeof readExecutionFrame>> | undefined
  vi.mocked(saveExecutionStateInTransaction).mockImplementation(async (_tx, _lease, input) => {
    next = { revision: 13, snapshotHash: runtimeJson(input.snapshot).hash, state: input.snapshot } as Awaited<ReturnType<typeof readExecutionFrame>>
    return next
  })
  let witness: unknown
  const tx = { agentExecutionOutbox: { create: vi.fn(async ({ data }: { data: unknown }) => { witness = data; return data }), findUnique: vi.fn(async () => witness) } } as unknown as RuntimeTx
  const lease = { taskRootId: 'root', runId: 'run' } as RunLeaseToken
  const defer = action === 'chapter_write' ? deferReviewWriteInTransaction : deferWritingTodoProposalInTransaction
  await defer(tx, lease, previous, call, 'Synchronize the existing todo id using current saved facts.')
  expect(previous).toEqual(before)
  expect(next?.state.nextOperationSequence).toBe(7)
  expect(next?.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: call.id })
  expect(witness).toMatchObject({ type: action === 'chapter_write' ? 'review.proposal.deferred' : 'writing.todo_proposal.deferred',
    payload: { version: action === 'chapter_write' ? 1 : 2, callId: call.id, toolName: action, argumentsHash: runtimeJson(call.arguments).hash } })
  expect(await projectReviewWriteDeferral(tx, 'root', previous, next!, 'message')).toEqual([
    { type: 'tool.deferred', messageId: 'message', callId: call.id, toolName: action, reason: 'Synchronize the existing todo id using current saved facts.', execution: 'not_dispatched' },
  ])
  const changed = structuredClone(previous)
  changed.state.messages[0].toolCalls![0].arguments = '{"chapterId":"other"}'
  await expect(projectReviewWriteDeferral(tx, 'root', changed, next!, 'message')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  await expect(deferWritingTodoProposalInTransaction(tx, lease, { ...previous, state: { ...previous.state, phase: 'awaiting_operation', pendingOperationId: 'existing' } }, call, 'sync'))
    .rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
  expect(saveExecutionStateInTransaction).toHaveBeenCalledOnce()
})
