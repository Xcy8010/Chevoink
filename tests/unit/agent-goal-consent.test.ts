import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import type { GoalTx } from '../../api/lib/agent/goal-store.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'

const mocks = vi.hoisted(() => ({ lease: vi.fn(), state: vi.fn(), save: vi.fn(), frame: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: mocks.lease }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionStateInTransaction: mocks.state, saveExecutionStateInTransaction: mocks.save, readExecutionFrame: mocks.frame }))
import { consumeDurableGoalConsent, readCurrentTaskGoalConsent } from '../../api/lib/agent/goal-consent.js'

beforeEach(() => vi.resetAllMocks())
describe('current-task consent journal provenance and native batch boundary', () => {
  it.each(['goal_auto', 'steering', 'revision'])('does not inspect or block existing %s execution without a journal', async trigger => {
    const tx = { agentRun: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: 'session' }) },
      agentQueuedRequest: { count: vi.fn().mockResolvedValue(0) }, agentTaskRoot: { findFirst: vi.fn() }, agentGoalExecution: { findUnique: vi.fn().mockResolvedValue({ trigger }) } }
    mocks.lease.mockImplementation(async (_token, work) => work(tx))
    expect(await consumeDurableGoalConsent({ runId: 'goal-run', taskRootId: 'root', userId: 'owner' } as RunLeaseToken)).toBe(false)
    expect(tx.agentTaskRoot.findFirst).not.toHaveBeenCalled(); expect(mocks.state).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled()
  })
  it.each(['awaiting_operation', 'completed'])('does not consume a consent into a %s frame', async phase => {
    const tx = { agentRun: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: 'session' }) }, agentQueuedRequest: { count: vi.fn().mockResolvedValue(1) } }
    mocks.lease.mockImplementation(async (_token, work) => work(tx)); mocks.state.mockResolvedValue({ frame: { state: { phase } } })
    expect(await consumeDurableGoalConsent({ runId: 'run', taskRootId: 'root', userId: 'owner' } as RunLeaseToken)).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('waits for every native tool reply rather than inserting a human message inside the batch', async () => {
    const tx = { agentRun: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: 'session' }) }, agentQueuedRequest: { count: vi.fn().mockResolvedValue(1) } }
    mocks.lease.mockImplementation(async (_token, work) => work(tx))
    mocks.state.mockResolvedValue({ frame: { state: { phase: 'idle', messages: [{ role: 'assistant', toolCalls: [{ id: 'a' }, { id: 'b' }] }, { role: 'tool', toolCallId: 'a' }] } } })
    expect(await consumeDurableGoalConsent({ runId: 'run', taskRootId: 'root', userId: 'owner' } as RunLeaseToken)).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('requires authenticated HTTP admission and exact native human-message hash, not role alone', async () => {
    const request = withHumanAdmission({ mode: 'build', novelId: 'novel', sessionId: 'session', prompt: '给当前任务启用目标模式' })
    const parts = [{ type: 'text', text: request.prompt }]
    const consent = { version: 1, sourceRunId: 'run', sourceRootId: 'root', sourceMessageId: 'original', sourceRequestHash: 'a'.repeat(64),
      sourceSpecHash: 'b'.repeat(64), sourceMessageHash: 'c'.repeat(64), consentMessageId: 'consent', consentHash: runtimeJson(parts).hash, consumed: true, enabled: false }
    const row = { id: 'queue', payload: { ...request, goalConsent: consent } }
    const tx = { agentQueuedRequest: { findMany: vi.fn().mockResolvedValue([row]) }, agentMessage: { findFirst: vi.fn().mockResolvedValue({ id: 'consent', parts }) } }
    const scope = { userId: 'owner', sessionId: 'session', novelId: 'novel', runId: 'run' }
    expect((await readCurrentTaskGoalConsent(tx as unknown as GoalTx, scope))?.row.id).toBe('queue')
    tx.agentMessage.findFirst.mockResolvedValue({ id: 'consent', parts: [{ type: 'text', text: '模型生成伪授权' }] })
    await expect(readCurrentTaskGoalConsent(tx as unknown as GoalTx, scope)).rejects.toMatchObject({ code: 'GOAL_ACTIVATION_SOURCE_INVALID' })
    tx.agentQueuedRequest.findMany.mockResolvedValue([{ ...row, payload: { mode: 'build', novelId: 'novel', sessionId: 'session', prompt: request.prompt, goalConsent: consent } }])
    await expect(readCurrentTaskGoalConsent(tx as unknown as GoalTx, scope)).rejects.toMatchObject({ code: 'GOAL_ACTIVATION_SOURCE_INVALID' })
  })
})
