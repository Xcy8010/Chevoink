import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { formatDurableToolObservation, runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as state from '../../api/lib/agent/runtime-state.js'
import * as requests from '../../api/lib/agent/original-request.js'
import * as scope from '../../api/lib/agent/writing-scope.js'

afterEach(() => vi.restoreAllMocks())
describe('terminal review progress in authenticated durable observations', () => {
  it.each(['new', 'repeat', 'failed', 'foreign', 'wrong-action', 'unobserved', 'child'] as const)('preserves finite report handling and ownership for %s', async scenario => {
    const spec = buildTaskSpec({ runId: 'root', novelId: 'novel', chapterId: 'chapter', prompt: '修改本章' })
    spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 5, chapterId: 'chapter' }], titleAndBodyOnly: false, repairAuthorized: true }
    const evidence = { taskId: 'root', userId: scenario === 'foreign' ? 'foreign' : 'owner', novelId: 'novel', chapterId: 'chapter', orderIndex: 5,
      contentHash: 'a'.repeat(64), phases: ['continuity', 'terminal'] }
    const rows = Array.from({ length: scenario === 'repeat' ? 3 : 1 }, (_, index) => {
      const id = `op-${index}`, action = scenario === 'wrong-action' ? 'plan_save' : 'continuity_validate'
      const input = runtimeJson({ input: { callId: `call-${index}`, normalization: { sourceRevision: index * 2 } } })
      const result = runtimeJson({ toolResult: { output: 'Complete review. Candidate still unknown.', summary: 'Complete terminal review',
        ...(scenario === 'failed' ? { outcome: 'failed' } : {}), reviewProgress: evidence } })
      const receipt = { runId: 'run', result: result.value, resultHash: result.hash }
      const observation = formatDurableToolObservation(action, 'Complete review. Candidate still unknown.', { operationId: id, resultHash: result.hash })
      return { sequence: BigInt(index + 1), eventKey: `effect:${id}`, payload: runtimeJson({ operationId: id, resultHash: result.hash }).value,
        operation: { id, action, inputSnapshot: input.value, inputHash: input.hash, effectReceipt: receipt }, observation }
    })
    const tx = { agentOperation: { findFirst: vi.fn().mockResolvedValue(null) }, agentExecutionOutbox: { findMany: vi.fn().mockResolvedValue(rows) },
      agentTaskRoot: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'root', userId: 'owner', novelId: 'novel' }) } } as unknown as RuntimeTx
    vi.spyOn(requests, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'root', spec, prompt: '修改本章', sourceRunId: 'run', parentRunId: scenario === 'child' ? 'parent' : null })
    vi.spyOn(scope, 'effectiveWritingTaskSpec').mockResolvedValue(spec)
    vi.spyOn(state, 'readExecutionFrame').mockImplementation(async (_tx, _root, revision) => {
      const row = rows[Math.floor((revision - 1) / 2)]
      return { state: revision % 2 ? { pendingOperationId: row.operation.id } : { phase: 'idle', messages: [{ role: 'tool', toolCallId: `call-${Math.floor((revision - 1) / 2)}`,
        content: scenario === 'unobserved' ? 'Different output' : row.observation }] } } as Awaited<ReturnType<typeof state.readExecutionFrame>>
    })
    const result = collectDurableToolEvidence(tx, 'root', rows.length * 2)
    if (['foreign', 'wrong-action', 'unobserved'].includes(scenario)) await expect(result).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    else {
      const inspected = await result
      expect(inspected.progressSequence).toBe(scenario === 'failed' || scenario === 'child' ? '0' : '1')
      expect(inspected.effects).toHaveLength(rows.length)
      expect(inspected.effects.map(item => item.outcome)).toEqual(rows.map(() => scenario === 'failed' ? 'failed' : 'succeeded'))
      expect(rows.every(row => JSON.stringify(row.operation.effectReceipt.result).includes('unknown'))).toBe(true)
    }
  })
})
