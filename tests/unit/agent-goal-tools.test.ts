import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ execution: vi.fn(), fence: vi.fn(), inspect: vi.fn(), snapshot: vi.fn(),
  goal: vi.fn(), run: vi.fn() }))
vi.mock('../../api/lib/agent/goal-fence.js', () => ({ readGoalExecution: mocks.execution, assertGoalFence: mocks.fence }))
vi.mock('../../api/lib/agent/goal-evidence.js', () => ({ inspectGoalEvidence: mocks.inspect }))
vi.mock('../../api/lib/agent/goal-store.js', () => ({ goalSnapshot: mocks.snapshot, changeGoal: vi.fn(), closeGoalActivity: vi.fn() }))
import { goalReadTool, goalReportTool } from '../../api/lib/agent/tools/goal-tools.js'

const context = { userId: 'owner', runId: 'child-run', sessionId: 'child-session', novelId: 'novel',
  transaction: { agentGoal: { findFirst: mocks.goal }, agentRun: { findFirst: mocks.run } } } as unknown as ToolContext

beforeEach(() => {
  vi.resetAllMocks()
  mocks.execution.mockResolvedValue({ goalId: 'goal', sessionId: 'parent-session', novelId: 'novel' })
  mocks.run.mockResolvedValue({ id: 'child-run' })
  mocks.goal.mockResolvedValue({ id: 'goal', currentRunId: 'parent-run' })
  mocks.snapshot.mockResolvedValue({ id: 'goal', objective: '作者目标' })
  mocks.inspect.mockResolvedValue({ objective: '作者目标', facts: {}, blockers: [], requirements: {} })
})

describe('delegated goal tools authority', () => {
  it('allows an owned delegated run to read the parent goal', async () => {
    expect((await goalReadTool.execute(context, {})).output).toContain('作者目标')
    expect(mocks.run).toHaveBeenCalledWith({ where: { id: 'child-run', userId: 'owner', novelId: 'novel', sessionId: 'child-session' }, select: { id: true } })
    expect(mocks.goal).toHaveBeenCalledWith({ where: { id: 'goal', userId: 'owner', novelId: 'novel', sessionId: 'parent-session' } })
  })
  it('rejects a forged delegated session even when a valid run binding exists', async () => {
    mocks.run.mockResolvedValue(null)
    expect(await goalReadTool.execute(context, {})).toMatchObject({ outcome: 'failed', failureCode: 'GOAL_SCOPE_MISMATCH' })
    expect(mocks.goal).not.toHaveBeenCalled()
    expect(mocks.inspect).not.toHaveBeenCalled()
  })
  it('does not let a delegated run complete or change the parent goal', async () => {
    expect(await goalReportTool.execute(context, { status: 'completed' })).toMatchObject({ outcome: 'failed', failureCode: 'GOAL_EXECUTION_FENCED' })
    expect(mocks.fence).not.toHaveBeenCalled()
    expect(mocks.inspect).not.toHaveBeenCalled()
  })
})
