import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDurableToolObservation, runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readCompilerObservation } from '../../api/lib/agent/runtime-compiler-observation.js'

const mocks = vi.hoisted(() => ({ events: vi.fn(), frame: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(), readExecutionFrame: mocks.frame }))
const tx = { agentExecutionOutbox: { findMany: mocks.events } }
function saved(action = 'continuity_validate', compilerState: unknown = null, omitted = false) {
  const input = runtimeJson({ input: { callId: 'call', normalization: { sourceRevision: 0 } } })
  const result = runtimeJson({ ...(omitted ? {} : { compilerState }), toolResult: { output: 'Saved report' } })
  const operation = { id: 'operation', action, taskRootId: 'root', inputSnapshot: input.value, inputHash: input.hash,
    effectReceipt: { result: result.value, resultHash: result.hash } }
  const event = { sequence: 1n, eventKey: 'effect:operation', operation,
    payload: runtimeJson({ operationId: operation.id, resultHash: result.hash }).value }
  mocks.events.mockResolvedValue([event])
  mocks.frame.mockImplementation(async (_tx, _root, revision) => revision === 1
    ? { state: { pendingOperationId: operation.id } }
    : { state: { phase: 'idle', messages: [{ role: 'tool', toolCallId: 'call', content: formatDurableToolObservation(action, 'Saved report') }] } })
  return event
}
beforeEach(() => vi.resetAllMocks())
describe('authenticated standalone reviews do not invent compiler observations', () => {
  it.each(['continuity_validate', 'quality_analyze'])('keeps explicit null and historical omitted %s compiler identity as standalone', async action => {
    saved(action)
    expect(await readCompilerObservation(tx as never, 'root', 2)).toBeNull()
    saved(action, null, true)
    expect(await readCompilerObservation(tx as never, 'root', 2)).toBeNull()
    expect(mocks.frame).not.toHaveBeenCalled()
  })
  it.each(['input', 'result', 'event', 'payload', 'root'])('rejects corrupted %s proof before treating a report as standalone', async field => {
    const event = saved()
    if (field === 'input') event.operation.inputHash = 'f'.repeat(64)
    if (field === 'result') event.operation.effectReceipt.resultHash = 'f'.repeat(64)
    if (field === 'event') event.eventKey = 'effect:other'
    if (field === 'payload') event.payload = {}
    if (field === 'root') event.operation.taskRootId = 'other'
    await expect(readCompilerObservation(tx as never, 'root', 2)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.frame).not.toHaveBeenCalled()
  })
  it.each(['story_compiler_prepare', 'scene_task_build', 'chapter_bridge_get', 'chapter_bridge_commit'])('rejects null compiler identity for %s', async action => {
    saved(action)
    await expect(readCompilerObservation(tx as never, 'root', 2)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
  it('rejects a malformed review compiler identity while accepting the real reduced compiler observation', async () => {
    saved('continuity_validate', {})
    await expect(readCompilerObservation(tx as never, 'root', 2)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    const identity = { id: 'compilation', hash: 'a'.repeat(64) }
    saved('continuity_validate', identity)
    expect(await readCompilerObservation(tx as never, 'root', 2, identity.id)).toEqual(identity)
    expect(mocks.frame).toHaveBeenCalledTimes(2)
  })
})
