import { expect, it, vi } from 'vitest'
import type { AgentExecutionOutbox } from '@prisma/client'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { persistProjectedMessages, projectExecutionFrame } from '../../api/lib/agent/runtime-frame-events.js'

vi.mock('../../api/lib/agent/runtime-state.js', () => ({
  readExecutionFrame: vi.fn(async (_tx: unknown, _root: string, revision: number) => ({ revision, snapshotHash: 'current-frame',
    state: revision === 1 ? { phase: 'awaiting_operation', pendingOperationId: 'operation', messages: [] }
      : { phase: 'idle', turn: 1, messages: [{ role: 'tool', toolCallId: 'call', content: 'Original report data.' }] } })),
  readExecutionStateInTransaction: vi.fn(async () => ({})),
}))
vi.mock('../../api/lib/agent/runtime-review-deferral.js', () => ({ projectReviewWriteDeferral: vi.fn(async () => null) }))

it.each(['continuity_validate', 'chapter_bridge_commit', 'quality_analyze'] as const)(
  '%s projects execution results without turning report data into a third tool status', async action => {
    for (const failed of [false, true]) {
      const result = { toolResult: { summary: 'Report opinions remain data.', reviewOutcome: 'decision_required',
        ...(failed ? { outcome: 'failed', failureCode: 'EXACT_COMMIT_NOT_APPLIED' } : {}) } }
      const receipt = { result, resultHash: runtimeJson(result).hash, createdAt: new Date(10) }
      const originalReceipt = structuredClone(receipt)
      const message = vi.fn(async (input: { create: { parts: Array<Record<string, unknown>> } }) => input)
      const tx = { agentOperation: { findFirst: vi.fn(async () => ({ action, status: failed ? 'failed' : 'succeeded',
        createdAt: new Date(0), effectReceipt: receipt })) }, agentEffectReceipt: { findUniqueOrThrow: vi.fn(async () => receipt) },
      agentMessage: { findUnique: vi.fn(async () => null), upsert: message } } as unknown as RuntimeTx
      const source: AgentExecutionOutbox = { id: 'source', taskRootId: 'root', runId: 'run', operationId: null, sequence: 1n,
        type: 'execution.state.saved', eventKey: 'state:root:2', payload: { revision: 2, snapshotHash: 'current-frame', previousHash: null },
        createdAt: new Date(10), publishedAt: null }
      const events = await projectExecutionFrame(tx, source)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'tool.result', toolName: action, ok: !failed })
      if (action === 'quality_analyze') expect(events[0]).toHaveProperty('reviewOutcome', 'decision_required')
      else expect(events[0]).not.toHaveProperty('reviewOutcome')
      await persistProjectedMessages(tx, source, 'session', events)
      const parts = message.mock.calls[0][0].create.parts
      expect(parts).toMatchObject([{ type: 'tool-call', toolName: action, status: failed ? 'failed' : 'success' }])
      if (action === 'quality_analyze') expect(parts[0]).toHaveProperty('reviewOutcome', 'decision_required')
      else expect(parts[0]).not.toHaveProperty('reviewOutcome')
      expect(receipt).toEqual(originalReceipt)
      expect(runtimeJson(receipt.result).hash).toBe(originalReceipt.resultHash)
    }
  },
)
