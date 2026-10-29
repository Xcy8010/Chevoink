import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { advanceDurableToolStagnation } from '../../api/lib/agent/runtime-continuation.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import type { executionSnapshotSchema } from '../../api/lib/agent/runtime-state.js'

type Snapshot = z.infer<typeof executionSnapshotSchema>
type Frame = { revision: number; snapshotHash: string; previousHash: string | null; state: Snapshot }
type Event = { taskRootId: string; eventKey: string; type: string; payload: Record<string, unknown> }
const mocks = vi.hoisted(() => ({ frames: new Map<number, Frame>(), current: 0, events: [] as Event[], progress: '0',
  denied: null as Error | null, budget: vi.fn(), children: [] as unknown[] }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withManuscriptRunLease: vi.fn(async (_token, work) => work({
  agentExecutionOutbox: { findFirst: async () => mocks.events.at(-1) ?? null, create: async ({ data }: { data: Event }) => { mocks.events.push(data); return data } },
  agentChildExecutionGrant: { findMany: async () => mocks.children },
})) }))
vi.mock('../../api/lib/agent/runtime-budget.js', () => ({ assertProviderBudget: mocks.budget }))
vi.mock('../../api/lib/agent/runtime-evidence.js', () => ({ collectDurableToolEvidence: vi.fn(async () => ({ progressSequence: mocks.progress })) }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({
  readExecutionStateInTransaction: vi.fn(async () => ({ frame: mocks.frames.get(mocks.current) })),
  readExecutionFrame: vi.fn(async (_tx, _root, revision: number) => mocks.frames.get(revision)),
  saveExecutionStateInTransaction: vi.fn(async (_tx, _token, input: { expectedRevision: number; expectedHash: string; snapshot: Snapshot }) => {
    const frame = mocks.frames.get(mocks.current)!
    if (frame.revision !== input.expectedRevision || frame.snapshotHash !== input.expectedHash) throw Error('fixture CAS rejected')
    return append(input.snapshot)
  }),
}))
function append(state: Snapshot) {
  const previous = mocks.frames.get(mocks.current)
  const revision = previous ? mocks.current + 1 : 0
  const frame = { revision, snapshotHash: runtimeJson(state).hash, previousHash: previous?.snapshotHash ?? null, state: structuredClone(state) }
  mocks.frames.set(revision, frame); mocks.current = revision
  return frame
}
function observedBatch(index: number) {
  const previous = mocks.frames.get(mocks.current)?.state
  return append({ version: 1, turn: index, nextOperationSequence: index, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
    successfulToolSignatures: [], ...(previous?.stagnation ? { stagnation: previous.stagnation } : {}), messages: [{ role: 'user', content: '完成当前任务' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'call' + index, name: 'chapter_read', arguments: '{"chapterId":"chapter"}' }] },
      { role: 'tool', toolCallId: 'call' + index, content: '同一保存正文，当前完整报告仍待处置。' }] })
}
const lease = { userId: 'user', runId: 'run', taskRootId: 'root' } as RunLeaseToken
beforeEach(() => {
  mocks.frames.clear(); mocks.events = []; mocks.current = 0; mocks.progress = '0'; mocks.children = []; mocks.denied = null
  mocks.budget.mockReset(); mocks.budget.mockImplementation(async () => { if (mocks.denied) throw mocks.denied })
})
describe('native repeated observations preserve progress truth without a task-stop count', () => {
  it('records ten actual unchanged batches and replays each once without attention or counter reset', async () => {
    for (let index = 1; index <= 10; index++) {
      const source = observedBatch(index), original = runtimeJson(source).hash
      await expect(advanceDurableToolStagnation(lease)).resolves.toBeNull()
      expect(mocks.events.at(-1)?.payload).toMatchObject({ sourceRevision: source.revision, progressSequence: '0', stagnantBatches: index })
      expect(runtimeJson(mocks.frames.get(source.revision)).hash).toBe(original)
      await expect(advanceDurableToolStagnation(lease)).resolves.toBeNull()
      expect(mocks.events).toHaveLength(index)
    }
    expect(mocks.frames.get(mocks.current)?.state.stagnation?.payloadHash).toBe(runtimeJson(mocks.events.at(-1)!.payload).hash)
  })
  it('records actual new progress after historical stagnation without changing old event evidence', async () => {
    observedBatch(1); await advanceDurableToolStagnation(lease)
    const original = runtimeJson(mocks.events[0]).hash
    observedBatch(2); mocks.progress = '12'
    await expect(advanceDurableToolStagnation(lease)).resolves.toBeNull()
    expect(mocks.events.at(-1)?.payload).toMatchObject({ progressSequence: '12', stagnantBatches: 0 })
    expect(runtimeJson(mocks.events[0]).hash).toBe(original)
  })
  it('rejects tampered historical counter evidence before recording any new observation', async () => {
    observedBatch(1); await advanceDurableToolStagnation(lease)
    mocks.events[0].payload.stagnantBatches = 0
    await expect(advanceDurableToolStagnation(lease)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.events).toHaveLength(1)
  })
  it.each(['RUNTIME_BUDGET_EXCEEDED', 'RUNTIME_RECONCILIATION_REQUIRED'])('preserves actual %s admission before new audit work', async code => {
    observedBatch(1); mocks.denied = new DataAccessError(409, code, 'original budget or unknown result')
    await expect(advanceDurableToolStagnation(lease)).rejects.toMatchObject({ code })
    expect(mocks.events).toEqual([])
    expect(mocks.frames.size).toBe(1)
  })
})
