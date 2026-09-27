import { describe, expect, it } from 'vitest'

import { selectAgentActivityRunActive, selectAgentGoalView } from '../../src/features/studio/agent/goal-selectors'
import type { AgentGoalSnapshot } from '../../shared/contracts/agent-goal.js'

const goal: AgentGoalSnapshot = {
  id: 'goal-1', sessionId: 'session-1', novelId: 'novel-1', objective: '完成目标', revision: 1, pendingRevision: null,
  status: 'active', phase: 'executing', stateVersion: 2, currentRunId: 'run-1', reasonCode: null,
  tokenLimit: '50000', tokensUsed: '1200', tokensReserved: '100', creditsUsedMicros: '3000', activeTimeMs: '120000', activeTimeLimitMs: '3600000',
  activeSince: '2026-09-27T00:00:00.000Z', serverTime: '2026-09-27T00:02:00.000Z', createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:02:00.000Z', finishedAt: null,
}

const select = (overrides: Partial<AgentGoalSnapshot> = {}, extra: Partial<Parameters<typeof selectAgentGoalView>[0]> = {}) => selectAgentGoalView({
  goal: { ...goal, ...overrides }, goalSessionId: 'session-1', sessionId: 'session-1', runId: 'run-1', phase: 'running', ...extra,
})

describe('selectAgentGoalView', () => {
  it('rejects a goal from another session before projecting any status', () => {
    const view = select({}, { sessionId: 'session-2' })
    expect(view.goal).toBeNull()
    expect(view.presentation).toBeNull()
    expect(view.running).toBe(false)
  })

  it('marks an owned executing run as running', () => {
    const view = select()
    expect(view.ownedRun).toBe(true)
    expect(view.running).toBe(true)
    expect(view.waiting).toBe(false)
    expect(view.canPauseOwnedRun).toBe(true)
  })

  it.each(['awaiting_input', 'awaiting_approval'] as const)('keeps %s visible without pretending it is running', (phase) => {
    const view = select({ phase })
    expect(view.waiting).toBe(true)
    expect(view.presentation?.running).toBe(false)
    expect(view.running).toBe(false)
    expect(view.canPauseOwnedRun).toBe(true)
  })

  it('does not let a late old run control a completed goal', () => {
    const view = select({ status: 'completed', phase: 'reviewing' }, { phase: 'running' })
    expect(view.terminal).toBe(true)
    expect(view.runBelongsToGoal).toBe(true)
    expect(view.running).toBe(false)
    expect(view.canPauseOwnedRun).toBe(false)
  })

  it('lets a newer ordinary run take over after a terminal goal', () => {
    const view = select({ status: 'completed', phase: 'reviewing' }, { runId: 'ordinary-run', phase: 'running' })
    expect(view.terminal).toBe(true)
    expect(view.runBelongsToGoal).toBe(false)
    expect(view.running).toBe(false)
    expect(selectAgentActivityRunActive(view, 'running')).toBe(true)
  })

  it('uses explicit server run ownership when a terminal goal has no reliable currentRunId', () => {
    const ordinary = select({ status: 'completed', phase: 'reviewing', currentRunId: null }, { runId: 'ordinary-run', phase: 'running', runGoalId: null })
    const lateGoalRun = select({ status: 'completed', phase: 'reviewing', currentRunId: null }, { runId: 'late-goal-run', phase: 'running', runGoalId: 'goal-1' })
    expect(ordinary.runBelongsToGoal).toBe(false)
    expect(lateGoalRun.runBelongsToGoal).toBe(true)
    expect(selectAgentActivityRunActive(ordinary, 'running')).toBe(true)
    expect(selectAgentActivityRunActive(lateGoalRun, 'running')).toBe(false)
  })

  it('does not treat another run as the current goal run', () => {
    const view = select({}, { runId: 'run-old' })
    expect(view.ownedRun).toBe(false)
    expect(view.running).toBe(false)
    expect(view.canPauseOwnedRun).toBe(false)
  })
})
