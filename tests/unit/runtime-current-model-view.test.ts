import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { validateModelCursor, modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'

const mocks = vi.hoisted(() => ({ current: {} as Record<string, unknown>, frame: {} as Record<string, unknown>, operation: {} as Record<string, unknown>, dispatches: 0,
  frozen: [{ type: 'function', function: { name: 'chapter_write', description: 'old', parameters: { type: 'object', required: ['writing'] } } }],
  projected: [{ type: 'function', function: { name: 'chapter_write', description: 'current', parameters: { type: 'object', properties: { content: { type: 'string' } } } } }] }))
vi.mock('../../api/lib/agent/runtime-tool-view.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/runtime-tool-view.js')>(), currentNativeToolViews: vi.fn(async () => mocks.projected) }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionStateInTransaction: vi.fn(async () => mocks.current), readExecutionFrame: vi.fn(async () => mocks.frame) }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: vi.fn(async (_token, work) => work({ agentOperation: { findUniqueOrThrow: async () => mocks.operation }, agentProviderAttempt: { count: async () => mocks.dispatches } })) }))
const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://fixture.invalid/v1', reasoningEffort: 'high' }
const token = { taskRootId: 'root', runId: 'run', userId: 'user' } as RunLeaseToken
const messages = [{ role: 'user', content: '原请求' }]
const cursor = { expectedRevision: 0, expectedHash: 'a'.repeat(64) }
const input = () => ({ operationKey: 'exec:0', messages, tools: mocks.projected, tier: 'speed', route })
beforeEach(() => {
  mocks.dispatches = 0
  mocks.frame = { revision: 0, snapshotHash: cursor.expectedHash, state: { phase: 'idle', messages, nextOperationSequence: 0, pendingOperationId: null } }
  mocks.current = { frame: mocks.frame, originalSpec: buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt: '修改当前章节' }), configuration: {
    tools: mocks.frozen, model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', reasoningEffort: 'high', routeRevision: modelRouteRevision(route) } } }
  const snapshot = { kind: 'provider', action: 'workspaceAgent', parentOperationId: null, input: { request: { body: { tools: mocks.frozen } } } }
  mocks.operation = { id: 'op', taskRootId: 'root', kind: 'provider', status: 'prepared', operationKey: 'exec:0', inputSnapshot: snapshot, inputHash: runtimeJson(snapshot).hash }
})
describe('current model request tools and exact prepared-request recovery', () => {
  it('sends only the exact current presentation while leaving the frozen configuration unchanged', async () => {
    const hash = runtimeJson(JSON.parse(JSON.stringify(mocks.current))).hash
    await expect(validateModelCursor(token, cursor, input())).resolves.toEqual(mocks.frame)
    expect(runtimeJson(JSON.parse(JSON.stringify(mocks.current))).hash).toBe(hash)
    await expect(validateModelCursor(token, cursor, { ...input(), tools: mocks.frozen })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
  })
  it('preserves an actually prepared undispatched original request instead of replacing its tools', async () => {
    mocks.current.frame = { revision: 1, state: { phase: 'awaiting_operation', pendingOperationId: 'op', messages } }
    await expect(validateModelCursor(token, cursor, { ...input(), tools: mocks.frozen })).resolves.toEqual(mocks.frame)
    await expect(validateModelCursor(token, cursor, input())).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(mocks.operation.status).toBe('prepared')
  })
  it.each(['dispatched', 'unknown', 'wrong-root', 'input-tampered', 'other-source'] as const)('rejects prepared recovery with %s and retains its original request identity', async scenario => {
    mocks.current.frame = { revision: scenario === 'other-source' ? 3 : 1, state: { phase: 'awaiting_operation', pendingOperationId: 'op', messages } }
    if (scenario === 'dispatched') mocks.dispatches = 1
    if (scenario === 'unknown') mocks.operation.status = 'unknown'
    if (scenario === 'wrong-root') mocks.operation.taskRootId = 'other'
    if (scenario === 'input-tampered') mocks.operation.inputHash = '0'.repeat(64)
    const saved = runtimeJson(mocks.operation).hash
    await expect(validateModelCursor(token, cursor, { ...input(), tools: mocks.frozen })).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(runtimeJson(mocks.operation).hash).toBe(saved)
  })
})
