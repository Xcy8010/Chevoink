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
  const frame = { revision: 0, snapshot, snapshotHash: runtimeJson(snapshot).hash, previousHash: null }
  const tx = { agentExecutionState: { findUnique: vi.fn(async () => head) }, agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => root) },
    agentExecutionFrame: { findFirst: vi.fn(async () => ({ revision: 0 })), findUnique: vi.fn(async () => frame) },
    agentExecutionOutbox: { findUnique: vi.fn(async () => ({ taskRootId: 'root', type: 'execution.state.saved',
      payload: { revision: 0, snapshotHash: frame.snapshotHash, previousHash: null } })) } }
  return { tx: tx as unknown as RuntimeTx, head }
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
