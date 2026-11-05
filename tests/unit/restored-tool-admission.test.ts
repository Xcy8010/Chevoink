import { beforeEach, expect, it, vi } from 'vitest'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const mocks = vi.hoisted(() => ({ current: {} as Record<string, unknown>, effective: {} as Record<string, unknown>,
  views: [] as unknown[], prepare: vi.fn(), root: {} as Record<string, unknown> }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: async (_token: unknown, work: (tx: unknown) => unknown) =>
  work({ agentTaskRoot: { findUniqueOrThrow: async () => mocks.root } }) }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionStateInTransaction: async () => mocks.current }))
vi.mock('../../api/lib/agent/native-tool-policy.js', () => ({ readEffectiveNativeTooling: async () => mocks.effective, readNativeToolAdmission: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-tool-view.js', async original => ({ ...await original<object>(), verifiedAssistantToolViews: async () => mocks.views }))
vi.mock('../../api/lib/agent/runtime-operations.js', async original => ({ ...await original<object>(), prepareOperationInTransaction: mocks.prepare }))
vi.mock('../../api/lib/agent/tools/registry.js', () => ({ getToolByName: () => undefined }))

const reached = Error('prepared actual admission')
beforeEach(() => { vi.clearAllMocks(); mocks.prepare.mockRejectedValue(reached) })

it.each(['grant', 'definition', 'both'] as const)('records actual restored tooling when the frozen %s is absent', async missing => {
  const definition = { type: 'function' as const, function: { name: 'chapter_read', description: 'Read owned source', parameters: { type: 'object' } } }
  const grant = { name: definition.function.name, permission: 'allow' as const, dangerous: false, alwaysConfirm: false }
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', prompt: '读取当前章节。' })
  const configuration = { mode: 'build', protectedChapterIds: [], tools: missing === 'grant' ? [definition] : [],
    toolAuthority: missing === 'definition' ? [grant] : [] }
  const snapshot = runtimeJson(configuration)
  mocks.root = { specSnapshot: JSON.parse(JSON.stringify(spec)) }
  mocks.current = { configuration, originalSpec: mocks.root.specSnapshot, frame: { revision: 4, snapshotHash: 'a'.repeat(64), state: {
    phase: 'idle', nextOperationSequence: 2, messages: [{ role: 'assistant', content: null,
      toolCalls: [{ id: 'call', name: definition.function.name, arguments: '{}' }] }] } } }
  mocks.effective = { ...configuration, tools: [definition], toolAuthority: [grant] }
  mocks.views = [definition]
  const token = { userId: 'author', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
  await expect(prepareToolCursorOperation(token, { expectedRevision: 4, expectedHash: 'a'.repeat(64) }, {
    key: 'exec:2', action: definition.function.name, callId: 'call', targetId: token.taskRootId, effectDomain: 'read',
    effectiveArgs: {}, operationInput: { callId: 'call', args: {} }, normalize: value => value,
  })).rejects.toBe(reached)
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(expect.anything(), token, expect.objectContaining({
    input: expect.objectContaining({ toolAdmission: { version: 1, definition, grant } }),
  }))
  expect(runtimeJson(configuration)).toEqual(snapshot)
})
