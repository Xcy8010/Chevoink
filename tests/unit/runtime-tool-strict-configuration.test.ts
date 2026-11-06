import { expect, it, vi } from 'vitest'
import { readExecutionStateInTransaction } from '../../api/lib/agent/runtime-state.js'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'

function fixture(strict: unknown) {
  const configuration = { version: 1, mode: 'build', agentType: 'writer', creativeFreedom: 'balanced', qualityMode: 'balanced',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: [{ type: 'function', function: { name: 'synthetic_create', description: 'fixture',
      ...(strict !== undefined ? { strict } : {}), parameters: { type: 'object', properties: { optional: { type: 'string' } } } } }],
    toolAuthority: [{ name: 'synthetic_create', permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: ['protected'], pinnedSkillVersions: [] }
  const root = { specSnapshot: { scope: 'synthetic' }, requestSnapshot: { prompt: 'synthetic' }, inputHash: '' }
  root.inputHash = runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash
  const head = { configuration, configurationHash: runtimeJson({ configuration, inputHash: root.inputHash }).hash, revision: 0 }
  const snapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
    messages: [{ role: 'user', content: 'synthetic' }], successfulToolSignatures: [] }
  const frame = { revision: 0, snapshot, snapshotHash: runtimeJson(snapshot).hash, previousHash: null as string | null }
  const event = { taskRootId: 'root', type: 'execution.state.saved',
    payload: { revision: 0, snapshotHash: frame.snapshotHash, previousHash: frame.previousHash } }
  const tx = { agentExecutionState: { findUnique: vi.fn<() => Promise<typeof head | null>>(async () => head) }, agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => root) },
    agentExecutionFrame: { findFirst: vi.fn<() => Promise<typeof frame | null>>(async () => frame), findUnique: vi.fn<() => Promise<typeof frame | null>>(async () => frame) },
    agentExecutionOutbox: { findUnique: vi.fn<() => Promise<typeof event | null>>(async () => event) } }
  return { tx: tx as unknown as RuntimeTx, queries: tx, head, frame, event }
}

it.each([undefined, false, true])('reads persisted strict=%s without defaulting or changing the original configuration identity', async strict => {
  const f = fixture(strict), before = structuredClone(f.head)
  const current = await readExecutionStateInTransaction(f.tx, 'root')
  expect(current.configuration.tools[0].function).toEqual(f.head.configuration.tools[0].function)
  expect(f.head).toEqual(before)
  expect(current.configuration.protectedChapterIds).toEqual(['protected'])
})

it('rejects an invalid strict value and an unauthenticated strict change', async () => {
  await expect(readExecutionStateInTransaction(fixture('false').tx, 'root')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  const f = fixture(false)
  f.head.configuration.tools[0].function.strict = true
  await expect(readExecutionStateInTransaction(f.tx, 'root')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
})

it.each(['head-missing', 'latest-missing', 'head-revision', 'snapshot', 'snapshot-invalid',
  'event-missing', 'event-root', 'event-type', 'event-payload', 'initial-chain', 'previous-missing', 'previous-hash'] as const)(
  'rejects %s while reusing the latest row and retaining its live receipt checks', async fault => {
    const f = fixture(false)
    if (fault === 'head-missing') f.queries.agentExecutionState.findUnique.mockResolvedValueOnce(null)
    if (fault === 'latest-missing') f.queries.agentExecutionFrame.findFirst.mockResolvedValueOnce(null)
    if (fault === 'head-revision') f.head.revision = 1
    if (fault === 'snapshot') f.frame.snapshot.messages[0].content = 'changed without a matching hash'
    if (fault === 'snapshot-invalid') f.frame.snapshot.messages = []
    if (fault === 'event-missing') f.queries.agentExecutionOutbox.findUnique.mockResolvedValueOnce(null)
    if (fault === 'event-root') f.event.taskRootId = 'another-root'
    if (fault === 'event-type') f.event.type = 'another.event'
    if (fault === 'event-payload') f.event.payload.snapshotHash = 'b'.repeat(64)
    if (fault === 'initial-chain') f.event.payload.previousHash = f.frame.previousHash = 'b'.repeat(64)
    if (fault === 'previous-missing' || fault === 'previous-hash') {
      f.event.payload.revision = f.frame.revision = f.head.revision = 1
      f.event.payload.previousHash = f.frame.previousHash = 'b'.repeat(64)
      f.queries.agentExecutionFrame.findUnique.mockResolvedValueOnce(fault === 'previous-missing'
        ? null : { ...f.frame, snapshotHash: 'c'.repeat(64) })
    }
    await expect(readExecutionStateInTransaction(f.tx, 'root')).rejects.toMatchObject({ code: fault === 'head-missing'
      ? 'RUNTIME_STATE_REQUIRED' : fault === 'snapshot-invalid' ? 'RUNTIME_STATE_INVALID' : 'RUNTIME_RECEIPT_INVALID' })
  })
