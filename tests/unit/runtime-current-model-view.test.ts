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
  it.each(['implicit', 'current', 'constraint', 'description', 'required', 'strict-true', 'explicit-false-removed', 'explicit-true-removed', 'order'] as const)('checks the complete idle %s candidate without mutating cursor, frames or configuration', async scenario => {
    const implicit = structuredClone(mocks.projected)
    const projected = implicit.map(definition => ({ ...definition, function: { ...definition.function, strict: false } }))
    const explicit = { type: 'function' as const, function: { name: 'private', description: 'custom', strict: scenario === 'explicit-true-removed', parameters: { type: 'object' } } }
    const frozen = [...implicit, explicit]
    const expected = [...projected, explicit]
    const originalProjected = mocks.projected
    mocks.projected = expected
    const configuration = mocks.current.configuration as { tools: unknown }
    configuration.tools = frozen
    const supplied = structuredClone(scenario === 'current' ? expected : frozen)
    if (scenario === 'constraint') supplied[0].function.parameters = { type: 'object', properties: { content: { type: 'string', minLength: 999 } } }
    if (scenario === 'description') supplied[0].function.description += ' changed'
    if (scenario === 'required') supplied[0].function.parameters.required = ['content']
    if (scenario === 'strict-true') Object.assign(supplied[0].function, { strict: true })
    if (scenario === 'explicit-false-removed' || scenario === 'explicit-true-removed') Reflect.deleteProperty(supplied[1].function, 'strict')
    if (scenario === 'order') supplied.reverse()
    const before = runtimeJson(JSON.parse(JSON.stringify(mocks.current))).hash, cursorBefore = structuredClone(cursor)
    try {
      const result = validateModelCursor(token, cursor, { ...input(), tools: supplied })
      if (scenario === 'implicit' || scenario === 'current') await expect(result).resolves.toEqual(mocks.frame)
      else await expect(result).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      expect(runtimeJson(JSON.parse(JSON.stringify(mocks.current))).hash).toBe(before)
      expect(cursor).toEqual(cursorBefore)
    } finally { mocks.projected = originalProjected }
  })
  it.each(['idle', 'prepared'] as const)('keeps the complete request identity while synchronizing an existing plan: %s', async phase => {
    const todo = { type: 'function', function: { name: 'todo_write', description: 'sync original ids', parameters: { type: 'object' } } }
    const full = [...mocks.projected, todo]
    const originalProjected = mocks.projected
    mocks.projected = full
    ;(mocks.current.configuration as { tools: unknown }).tools = full
    const snapshot = { kind: 'provider', action: 'workspaceAgent', parentOperationId: null, input: { request: { body: { tools: full } } } }
    mocks.operation.inputSnapshot = snapshot; mocks.operation.inputHash = runtimeJson(snapshot).hash
    if (phase === 'prepared') mocks.current.frame = { revision: 1, state: { phase: 'awaiting_operation', pendingOperationId: 'op', messages } }
    const before = runtimeJson(mocks.operation).hash
    try {
      await expect(validateModelCursor(token, cursor, { ...input(), tools: full })).resolves.toEqual(mocks.frame)
      await expect(validateModelCursor(token, cursor, { ...input(), tools: [todo] })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      expect(runtimeJson(mocks.operation).hash).toBe(before)
    } finally { mocks.projected = originalProjected }
  })
  it('does not add the implicit compatibility candidate to an already prepared explicit-false request', async () => {
    const preparedTools = mocks.projected.map(definition => ({ ...definition, function: { ...definition.function, strict: false } }))
    const snapshot = { kind: 'provider', action: 'workspaceAgent', parentOperationId: null, input: { request: { body: { tools: preparedTools } } } }
    mocks.operation.inputSnapshot = snapshot; mocks.operation.inputHash = runtimeJson(snapshot).hash
    mocks.current.frame = { revision: 1, state: { phase: 'awaiting_operation', pendingOperationId: 'op', messages } }
    const before = runtimeJson(mocks.operation).hash
    await expect(validateModelCursor(token, cursor, { ...input(), tools: preparedTools })).resolves.toEqual(mocks.frame)
    await expect(validateModelCursor(token, cursor, input())).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(runtimeJson(mocks.operation).hash).toBe(before)
  })
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
