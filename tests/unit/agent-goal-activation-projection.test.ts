// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { selectAgentActivityRunActive, selectAgentGoalView, selectAgentPanelPhase } from '../../src/features/studio/agent/goal-selectors'
import type { AgentGoalSnapshot } from '../../shared/contracts/agent-goal.js'

const snapshot: AgentGoalSnapshot = { id: 'goal', sessionId: 'session', novelId: 'novel', objective: '写下一章', revision: 1,
  pendingRevision: null, status: 'active', phase: 'reconciling', stateVersion: 1, currentRunId: 'run', reasonCode: 'GOAL_ACTIVATION_PENDING',
  tokenLimit: '1000', tokensUsed: '0', tokensReserved: '0', creditsUsedMicros: '0', activeTimeMs: '0', activeTimeLimitMs: '1000',
  activeSince: null, serverTime: '2026-10-03T00:00:00Z', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', finishedAt: null }
beforeEach(() => useAgentStore.setState({ runId: 'run', runGoalId: null, activeSessionId: 'session', loadedSessionId: 'session',
  phase: 'running', lastSeq: 0, goal: null, goalSessionId: null, goalEventSequence: 0 }))
it('discovers a server-created pending goal without claiming execution binding or stopping ordinary activity', () => {
  useAgentStore.getState().applyEvent({ type: 'goal.snapshot', runId: 'run', seq: 1, ts: snapshot.serverTime, snapshot })
  const state = useAgentStore.getState()
  expect(state.goal).toEqual(snapshot)
  expect(state.runGoalId).toBeNull()
  const view = selectAgentGoalView({ goal: state.goal, goalSessionId: state.goalSessionId, sessionId: state.activeSessionId, runId: state.runId, runGoalId: state.runGoalId, phase: state.phase })
  expect(view.runBelongsToGoal).toBe(false)
  expect(selectAgentActivityRunActive(view, state.phase)).toBe(true)
  expect(selectAgentPanelPhase(view, state.phase)).toBe('running')
})
it('rejects stale versions and foreign task/session events', () => {
  const apply = useAgentStore.getState().applyEvent
  apply({ type: 'goal.snapshot', runId: 'other', seq: 1, ts: snapshot.serverTime, snapshot })
  apply({ type: 'goal.snapshot', runId: 'run', seq: 2, ts: snapshot.serverTime, snapshot: { ...snapshot, sessionId: 'other' } })
  expect(useAgentStore.getState().goal).toBeNull()
  apply({ type: 'goal.snapshot', runId: 'run', seq: 3, ts: snapshot.serverTime, snapshot: { ...snapshot, stateVersion: 2 } })
  apply({ type: 'goal.snapshot', runId: 'run', seq: 4, ts: snapshot.serverTime, snapshot })
  expect(useAgentStore.getState().goal?.stateVersion).toBe(2)
})
