import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ execution: vi.fn(), fence: vi.fn(), inspect: vi.fn(), snapshot: vi.fn(),
  goal: vi.fn(), run: vi.fn(), savedProgress: vi.fn() }))
vi.mock('../../api/lib/agent/goal-fence.js', () => ({ readGoalExecution: mocks.execution, assertGoalFence: mocks.fence }))
vi.mock('../../api/lib/agent/goal-evidence.js', () => ({ inspectGoalEvidence: mocks.inspect }))
vi.mock('../../api/lib/agent/goal-saved-progress.js', () => ({ readGoalSavedProgress: mocks.savedProgress }))
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
  mocks.savedProgress.mockResolvedValue({ completionCredit: false, entries: [], truncated: false })
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
  it('exposes prior saved objects separately from current revision facts without granting completion credit', async () => {
    const savedProgress = { completionCredit: false, entries: [{ kind: 'chapter', id: 'saved-chapter', sourceRevision: 1, verification: 'current', requiresRevalidation: true }], truncated: false }
    mocks.savedProgress.mockResolvedValue(savedProgress)
    mocks.inspect.mockResolvedValue({ objective: '新版目标', facts: { chapters: [] }, blockers: [{ code: 'CHAPTER_REQUIRED', id: 'goal' }], requirements: {}, hasDeliverable: false, progressHash: 'current-revision' })
    const output = JSON.parse((await goalReadTool.execute(context, {})).output!)
    expect(output.savedProgress).toEqual(savedProgress)
    expect(output.facts).toEqual({ chapters: [] })
    expect(output.hasDeliverable).toBe(false)
    expect(output.progressHash).toBe('current-revision')
    expect(mocks.savedProgress).toHaveBeenCalledWith(context.transaction, { id: 'goal', currentRunId: 'parent-run' })
    mocks.savedProgress.mockClear()
    mocks.goal.mockResolvedValue({ id: 'goal', currentRunId: 'child-run' })
    expect(await goalReportTool.execute(context, { status: 'completed' })).toMatchObject({ outcome: 'failed', failureCode: 'GOAL_EVIDENCE_INCOMPLETE' })
    expect(mocks.savedProgress).not.toHaveBeenCalled()
  })
})
