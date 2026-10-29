import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../../api/lib/agent/runtime-tool-cursor.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'

const lease = vi.hoisted(() => ({ withRunLease: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: lease.withRunLease }))

const reachedOperation = new Error('synthetic operation boundary reached')
function fixture(action: 'prepare' | 'reject' | 'reduce') {
  const snapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
    messages: [{ role: 'user', content: '合成原始请求' }], successfulToolSignatures: [] }
  const first = { revision: 0, previousHash: null, snapshot, snapshotHash: runtimeJson(snapshot).hash }
  const latestSnapshot = { ...snapshot, phase: action === 'reduce' ? 'awaiting_operation' : 'idle',
    pendingOperationId: action === 'reduce' ? 'operation' : null, nextOperationSequence: action === 'reduce' ? 1 : 0,
    messages: [...snapshot.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'call', name: 'chapter_read', arguments: '{}' }] }] }
  const latest = { ...first, revision: 1, previousHash: first.snapshotHash, snapshot: latestSnapshot, snapshotHash: runtimeJson(latestSnapshot).hash }
  const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: [{ type: 'function', function: { name: 'chapter_read', description: '', parameters: { type: 'object' } } }],
    toolAuthority: [{ name: 'chapter_read', permission: action === 'reject' ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false }],
    protectedChapterIds: [], pinnedSkillVersions: [] }
  const root = { specSnapshot: JSON.parse(JSON.stringify(buildTaskSpec({ runId: 'run', novelId: 'novel', prompt: '合成原始请求' }))), requestSnapshot: { content: '合成原始请求' }, inputHash: '' }
  root.inputHash = runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash
  const head = { revision: latest.revision, configuration, configurationHash: runtimeJson({ configuration, inputHash: root.inputHash }).hash }
  const events = [first, latest].map(frame => ({ taskRootId: 'root', type: 'execution.state.saved',
    payload: { revision: frame.revision, previousHash: frame.previousHash, snapshotHash: frame.snapshotHash } }))
  const tx = { agentExecutionState: { findUnique: vi.fn().mockResolvedValue(head) }, agentTaskRoot: { findUniqueOrThrow: vi.fn().mockResolvedValue(root) },
    agentExecutionFrame: { findFirst: vi.fn().mockResolvedValue({ revision: 1 }),
      findUnique: vi.fn(async ({ where }: { where: { taskRootId_revision: { revision: number } } }) => where.taskRootId_revision.revision === 1 ? latest : first) },
    agentExecutionOutbox: { findUnique: vi.fn(async ({ where }: { where: { eventKey: string } }) => events[Number(where.eventKey.split(':').at(-1))]) },
    agentOperation: { findFirst: vi.fn().mockRejectedValue(reachedOperation), findUnique: vi.fn().mockRejectedValue(reachedOperation) } }
  lease.withRunLease.mockImplementation(async (_token, work) => work(tx))
  return { tx: tx as unknown as RuntimeTx, queries: tx, latest, events }
}

const token = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'owner', claimId: 'claim', epoch: 1n } satisfies RunLeaseToken
const actions = {
  prepare: (cursor: { expectedRevision: number; expectedHash: string }) => prepareToolCursorOperation(token, cursor,
    { key: 'exec:0', action: 'chapter_read', callId: 'call', targetId: 'root', effectDomain: 'read',
      operationInput: { callId: 'call', args: {} }, effectiveArgs: {}, normalize: value => value }),
  reject: (cursor: { expectedRevision: number; expectedHash: string }) => rejectToolCursorCall(token, cursor, 'call'),
  reduce: (cursor: { expectedRevision: number; expectedHash: string }) => reduceExecutionReceipt(token, { ...cursor, operationId: 'operation' }),
}

beforeEach(() => { vi.clearAllMocks() })
describe('verified frame reuse within one cursor transaction', () => {
  it.for(Object.keys(actions) as Array<keyof typeof actions>)('%s keeps the caller hash check without reading the current frame twice', async action => {
    const f = fixture(action)
    await expect(actions[action]({ expectedRevision: 1, expectedHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
    expect(f.queries.agentExecutionOutbox.findUnique).toHaveBeenCalledTimes(1)
    expect(f.queries.agentExecutionFrame.findUnique.mock.calls.map(([query]) => query.where.taskRootId_revision.revision)).toEqual([1, 0])
    expect(f.queries.agentOperation.findFirst).not.toHaveBeenCalled()
    expect(f.queries.agentOperation.findUnique).not.toHaveBeenCalled()
    // With the exact same legal phase/call but correct hash, reach the real
    // operation lookup. Another invalid precondition must not mask this gate.
    await expect(actions[action]({ expectedRevision: 1, expectedHash: f.latest.snapshotHash })).rejects.toBe(reachedOperation)
    expect(action === 'reduce' ? f.queries.agentOperation.findFirst : f.queries.agentOperation.findUnique).toHaveBeenCalledOnce()
  })
  it.for(Object.keys(actions) as Array<keyof typeof actions>)('%s still verifies a historical frame event even after the head has moved', async action => {
    const f = fixture(action)
    f.events[0].payload.snapshotHash = 'b'.repeat(64)
    await expect(actions[action]({ expectedRevision: 0, expectedHash: f.latest.snapshotHash })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(f.queries.agentExecutionOutbox.findUnique).toHaveBeenCalledTimes(2)
    expect(f.queries.agentOperation.findFirst).not.toHaveBeenCalled()
  })
  it.for(Object.keys(actions) as Array<keyof typeof actions>)('%s does not reuse a current frame with a corrupt event', async action => {
    const f = fixture(action)
    f.events[1].payload.snapshotHash = 'b'.repeat(64)
    await expect(actions[action]({ expectedRevision: 1, expectedHash: f.latest.snapshotHash })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(f.queries.agentOperation.findFirst).not.toHaveBeenCalled()
  })
})
