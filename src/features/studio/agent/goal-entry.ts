import type { AgentGoalSnapshot } from '../../../../shared/contracts/agent-goal.js'

/** A dismissed completion keeps its snapshot, but the menu can start a new draft. */
export function openGoalEntry(
  goal: AgentGoalSnapshot | null,
  dismissed: boolean,
  source: 'menu' | 'command',
  openDetails: () => void,
  startGoal: () => void,
) {
  if (!goal || (source === 'menu' && dismissed && goal.status === 'completed')) startGoal()
  else openDetails()
}
