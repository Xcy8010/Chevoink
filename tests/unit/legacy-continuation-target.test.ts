import type { AgentRun, Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readLegacyContinuationTarget, readLegacyContinuationResolution } from '../../api/lib/agent/legacy-continuation-target.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
vi.mock('../../api/lib/agent/tools/registry.js', () => ({ getAgentToolManifest: () => [
  { name: 'quality_analyze', readOnly: true }, { name: 'chapter_read', readOnly: true },
  { name: 'chapter_write', readOnly: false }, { name: 'ask_user', readOnly: true },
] }))

function fixture() {
  const spec = buildTaskSpec({ runId: 'original', novelId: 'novel', chapterId: 'chapter', prompt: '修订第一章', authorWritingProtocol: 2 })
  const continuation = buildTaskSpec({ runId: 'wrapper', novelId: 'novel', chapterId: 'chapter', prompt: '继续', authorWritingProtocol: 2 })
  const common = { userId: 'owner', novelId: 'novel', sessionId: 'session', taskRootId: null, runtimeProtocolVersion: 0,
    manuscriptRevision: 0, engine: 'loop', status: 'paused', chapterId: 'chapter' }
  const source = { ...common, id: 'original', startRequest: { prompt: '修订第一章' }, taskSpec: spec,
    currentTurn: 18, usage: { totalTokens: 50000, checkpoint: { pendingReviews: [{ chapterId: 'chapter', callId: 'old-check', revision: 6 }] } } } as unknown as AgentRun
  const wrapper = { ...common, id: 'wrapper', startRequest: { prompt: '继续' }, taskSpec: continuation,
    currentTurn: 1, usage: { totalTokens: 1200, checkpoint: { pendingReviews: [{ chapterId: 'chapter', toolName: 'quality_analyze', callId: 'later-check', revision: 6 }] } } } as unknown as AgentRun
  const runs = [wrapper, source]
  const parts: unknown[] = [{ type: 'tool-call', toolName: 'quality_analyze', status: 'failed', reviewOutcome: 'provider_unresolved' }]
  const at = new Date()
  const events: unknown[] = [
    { id: 'call-event', runId: 'wrapper', seq: 1, createdAt: at, type: 'tool.call', payload: { callId: 'later-check', toolName: 'quality_analyze', args: { chapterId: 'chapter' } } },
    { id: 'result-event', runId: 'wrapper', seq: 2, createdAt: at, type: 'tool.result', payload: { callId: 'later-check', toolName: 'quality_analyze', ok: false, failureCode: 'AI_PROVIDER_TIMEOUT' } },
    { id: 'terminal-event', runId: 'wrapper', seq: 3, createdAt: at, type: 'run.paused', payload: {} },
  ]
  const db = { agentRun: { findFirst: vi.fn(async () => runs[0]), findMany: vi.fn(async () => runs) },
    agentMessage: { findFirst: vi.fn(async () => ({ parts: [{ type: 'text', text: '继续' }] })), findMany: vi.fn(async () => [{ parts }]) },
    agentRunEvent: { findMany: vi.fn(async () => events) }, agentGoalExecution: { count: vi.fn(async () => 0) },
    agentOperation: { count: vi.fn(async () => 0) }, agentProviderAttempt: { count: vi.fn(async () => 0) },
    aiUsageLog: { findMany: vi.fn(async () => [{ id: 'unknown-usage', agentRunId: 'wrapper', userId: 'owner', novelId: 'novel',
      reservedCreditMilli: 0, billingStatus: 'settled', usageSource: 'unknown', durationMs: 0, createdAt: at }]),
      update: vi.fn(() => { throw Error('billing must remain untouched') }) } }
  return { source, wrapper, runs, parts, events, db, read: (run = wrapper) => readLegacyContinuationTarget(db as unknown as Prisma.TransactionClient, run) }
}
beforeEach(() => vi.clearAllMocks())
describe('legacy plain Continue recovers the actual task without merging contracts', () => {
  it('resolves both old and later Continue entrances to the same original run, preserving progress and unknown usage', async () => {
    const f = fixture(), before = JSON.stringify([f.source, f.wrapper])
    expect(await f.read()).toBe(f.source)
    expect(await f.read(f.source)).toBe(f.source)
    expect(JSON.stringify([f.source, f.wrapper])).toBe(before)
    expect(f.source.currentTurn).toBe(18)
    expect(await readLegacyContinuationResolution(f.db as unknown as Prisma.TransactionClient, f.wrapper)).toMatchObject({
      source: { id: 'original' }, retirements: [{ wrapperRunId: 'wrapper', terminalEventId: 'terminal-event',
        calls: [{ callId: 'later-check', resultEventId: 'result-event' }], usageIds: ['unknown-usage'], usageOutcome: 'preserved' }],
    })
    expect(f.db.aiUsageLog.update).not.toHaveBeenCalled()
  })
  it.each(['new-task', 'active-wrapper', 'ended', 'other-chapter', 'epoch', 'write-call', 'write-snapshot', 'goal', 'unknown-operation', 'input-mismatch',
    'active-attempt', 'missing-terminal', 'missing-result', 'reserved-usage'])(
    'does not join unrelated, changed or effectful work: %s', async kind => {
      const f = fixture()
      if (kind === 'new-task') f.wrapper.startRequest = { prompt: '写第二章' }
      if (kind === 'active-wrapper') f.wrapper.status = 'running'
      if (kind === 'ended') f.source.usage = { authorEnded: { fulfilled: false } }
      if (kind === 'other-chapter') f.wrapper.chapterId = 'different'
      if (kind === 'epoch') f.wrapper.manuscriptRevision = 1
      if (kind === 'write-call') f.events.push({ type: 'tool.call', runId: 'wrapper', seq: 4, payload: { toolName: 'chapter_write' } })
      if (kind === 'write-snapshot') f.parts.push({ type: 'tool-call', toolName: 'quality_analyze', snapshot: { field: 'content' } })
      if (kind === 'goal') f.db.agentGoalExecution.count.mockResolvedValue(1)
      if (kind === 'unknown-operation') f.db.agentOperation.count.mockResolvedValue(1)
      if (kind === 'input-mismatch') f.db.agentMessage.findFirst.mockResolvedValue({ parts: [{ type: 'text', text: '其它要求' }] })
      if (kind === 'active-attempt') f.db.agentProviderAttempt.count.mockResolvedValue(1)
      if (kind === 'missing-terminal') f.events.pop()
      if (kind === 'missing-result') f.events.splice(1, 1)
      if (kind === 'reserved-usage') f.db.aiUsageLog.findMany.mockResolvedValue([{ ...(await f.db.aiUsageLog.findMany())[0], reservedCreditMilli: 1 }])
      expect(await f.read(f.source)).toBeNull()
      expect(f.db.aiUsageLog.update).not.toHaveBeenCalled()
    })
  it('keeps a genuinely new current task as itself', async () => {
    const f = fixture(); f.runs.splice(0, 1)
    expect(await f.read(f.source)).toBe(f.source)
  })
})
