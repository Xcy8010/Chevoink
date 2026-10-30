import { beforeEach, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import { prepareTodoUpdate } from '../../api/lib/agent/tools/todo-tools.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'

const mocks = vi.hoisted(() => ({ state: vi.fn(), lease: vi.fn(), save: vi.fn(), todos: vi.fn(), delivery: vi.fn(), nativeAdmission: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(),
  readExecutionStateInTransaction: mocks.state, saveExecutionStateInTransaction: mocks.save,
}))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(), withRunLease: mocks.lease }))
vi.mock('../../api/lib/agent/goal-fence.js', async original => ({ ...await original<object>(), readGoalExecution: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/tools/durable-todo.js', async original => ({ ...await original<object>(), readDurableTodoItems: mocks.todos }))
vi.mock('../../api/lib/agent/writing-scope.js', async original => ({ ...await original<object>(), readCompletedWritingDelivery: mocks.delivery }))
vi.mock('../../api/lib/agent/runtime-tool-view.js', async original => ({ ...await original<object>(), needsNativeToolProjection: mocks.nativeAdmission }))

beforeEach(() => vi.clearAllMocks())

it.each([
  ['completed', 'quality_analyze', true], ['completed', 'chapter_write', true],
  ['pending', 'quality_analyze', true], ['completed', 'chapter_read', false],
  ['empty', 'quality_analyze', false], ['stale', 'quality_analyze', false],
] as const)('%s original todo snapshot handles the later %s proposal without losing current delivery checks', async (plan, action, deferred) => {
  // Exercise the real todo state machine: no invented id or first completed item.
  const baseline = prepareTodoUpdate([], [{ content: 'Write the authorized chapter', status: 'in_progress' }, { content: 'Check and commit it', status: 'pending' }])
  expect(baseline.error).toBeUndefined()
  const completed = prepareTodoUpdate(baseline.items, baseline.items.map(item => ({ ...item, status: 'completed' })))
  expect(completed.error).toBeUndefined()
  mocks.todos.mockResolvedValue(plan === 'empty' ? [] : plan === 'pending' ? baseline.items : completed.items)
  mocks.delivery.mockResolvedValue(plan === 'stale' ? null : { chapters: [{ id: 'chapter', revision: 2 }] })
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt: '修改本章，只输出标题和正文。' })
  const call = { id: 'after-sync', name: action, arguments: '{"chapterId":"chapter"}' }
  const snapshot = { version: 1, phase: 'idle', pendingOperationId: null, nextOperationSequence: 7, turn: 2,
    messages: [{ role: 'assistant', content: null, toolCalls: [{ id: 'sync', name: 'todo_write', arguments: JSON.stringify({ items: completed.items }) }, call] },
      { role: 'tool', toolCallId: 'sync', content: 'Actual existing todo ids are now completed.' }] }
  const frame = { revision: 12, snapshotHash: runtimeJson(snapshot).hash, state: snapshot }
  mocks.state.mockResolvedValue({ frame, configuration: { tools: [{ type: 'function', function: { name: action } }],
    toolAuthority: [{ name: action, permission: 'allow' }] } })
  const outbox = { create: vi.fn(async () => ({})) }
  const tx = { agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => ({ id: 'root', novelId: 'novel', specSnapshot: spec })) }, agentExecutionOutbox: outbox }
  mocks.lease.mockImplementation(async (_token, work) => work(tx))
  mocks.save.mockImplementation(async (_tx, _token, input) => ({ revision: 13, snapshotHash: runtimeJson(input.snapshot).hash, state: input.snapshot }))
  const adapterAdmission = new Error('Normal native tool admission reached')
  mocks.nativeAdmission.mockRejectedValue(adapterAdmission)
  const lease = { userId: 'user', taskRootId: 'root', runId: 'run' } as RunLeaseToken
  if (deferred) {
    const result = await executeDurableToolStep(lease, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'context', frame: { state: { nextOperationSequence: 7,
      messages: [...snapshot.messages, { role: 'tool', toolCallId: call.id, content: expect.stringContaining('not dispatched') }] } } })
    expect(mocks.nativeAdmission).not.toHaveBeenCalled()
    expect(outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'writing.todo_proposal.deferred', payload: expect.objectContaining({ callId: call.id, toolName: action }) }) }))
  } else {
    await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toBe(adapterAdmission)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(outbox.create).not.toHaveBeenCalled()
  }
  expect(frame.state).toEqual(snapshot)
})
