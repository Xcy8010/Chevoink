import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { coverGoalScope, type readCoverUnit } from '../../api/lib/agent/runtime-cover-accounting.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { activationReceiptSchema } from '../../api/lib/agent/goal-activation.js'

describe('cover cost belongs to the original parent goal and authenticated child grant', () => {
  it.each(['bound', 'activation', 'foreign-parent', 'missing-grant', 'wrong-child', 'corrupt-grant', 'foreign-owner'] as const)('%s', async scenario => {
    const goal = { id: 'goal', userId: 'owner', novelId: 'novel', sessionId: 'parent-session' }
    const snapshot = { version: 1, parentRootId: 'parent-root', parentOperationId: 'original-delegation', childIndex: 0, admissionRunId: 'parent-run', admissionEpoch: '1',
      kind: 'spawned', targetSessionId: 'child-session', role: 'orchestrator', name: '封面子任务', prompt: '生成封面',
      taskSpec: JSON.parse(JSON.stringify(buildTaskSpec({ runId: 'child-run', novelId: 'novel', prompt: '生成封面' }))) as ReturnType<typeof buildTaskSpec>, configuration: {},
      price: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }, tokenCeiling: 10000, turnCeiling: 10,
      parentConfigurationHash: 'a'.repeat(64), parentFrameRevision: 0, parentFrameHash: 'b'.repeat(64) }
    const grant = { ...snapshot, admissionEpoch: 1n, snapshot, snapshotHash: scenario === 'corrupt-grant' ? 'c'.repeat(64) : runtimeJson(snapshot).hash,
      childRun: { taskRootId: scenario === 'wrong-child' ? 'foreign-child-root' : 'child-root' } }
    const activation = activationReceiptSchema.parse({ version: 1, sourceRunId: 'parent-run', activationRunId: 'parent-run', sourceRootId: scenario === 'foreign-parent' ? 'other-root' : 'parent-root', sourceMessageId: 'human',
      requestHash: 'request', startHash: 'start', specHash: 'spec', messageHash: 'message', optionsHash: 'options', authorityHash: 'authority',
      consentHash: 'consent', consentRequestId: null, callId: 'enable', toolAuthority: [], baselineBound: false })
    const db = { agentChildExecutionGrant: { findUnique: vi.fn().mockResolvedValue(scenario === 'missing-grant' ? null : grant) },
      agentTaskRoot: { findUnique: vi.fn().mockResolvedValue({ id: 'parent-root', userId: 'owner', novelId: 'novel', sessionId: 'parent-session' }) },
      agentGoalExecution: { findFirst: vi.fn().mockResolvedValue(scenario === 'bound' ? { taskRootId: 'parent-root' } : null) },
      agentGoal: { findUniqueOrThrow: vi.fn().mockResolvedValue(goal) }, agentGoalEvidence: { findUnique: vi.fn().mockResolvedValue({ receipt: activation }) } }
    const unit = { attempt: { runId: 'child-run' }, operation: { taskRootId: 'child-root', taskRoot: { userId: scenario === 'foreign-owner' ? 'another-owner' : 'owner', sessionId: 'child-session' } }, work: { novelId: 'novel' } } as NonNullable<Awaited<ReturnType<typeof readCoverUnit>>>
    const result = coverGoalScope(db as unknown as RuntimeTx, goal, unit)
    if (scenario === 'corrupt-grant') await expect(result).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    else expect(await result).toBe(scenario === 'bound' || scenario === 'activation')
  })
})
