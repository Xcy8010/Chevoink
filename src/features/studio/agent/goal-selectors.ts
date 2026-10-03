import { agentGoalPresentation } from '../../../../shared/contracts/agent-goal.js'
import type { AgentGoalSnapshot } from '../../../../shared/contracts/agent-goal.js'

import { isRunActive, type AgentRunPhase } from './agentStore'

export type AgentGoalView = {
  /** 只保留属于当前会话的目标，避免旧窗口的 SSE/轮询状态污染当前窗口。 */
  goal: AgentGoalSnapshot | null
  presentation: ReturnType<typeof agentGoalPresentation> | null
  ownedRun: boolean
  /** 当前 run 是否由该目标创建；可由服务端 run 归属字段覆盖本地 currentRunId 兜底。 */
  runBelongsToGoal: boolean
  waiting: boolean
  running: boolean
  canPauseOwnedRun: boolean
  terminal: boolean
}

type SelectAgentGoalViewInput = {
  goal: AgentGoalSnapshot | null
  goalSessionId: string | null
  sessionId: string | null
  runId: string | null
  /** 刷新后没有直播 run 时，服务端确认可继续的历史 run。 */
  resumeableRunId?: string | null
  phase: AgentRunPhase
  /** 服务端确认的当前 run 目标归属；null 明确表示普通 run，undefined 兼容旧接口。 */
  runGoalId?: string | null
}

/**
 * Goal UI 的唯一投影入口。
 *
 * goal phase 负责说明目标所处的业务状态，agent run phase 只用于判断当前
 * 浏览器是否仍持有这个目标的 run。等待作者输入/确认时目标保持可见，
 * 但不能被其它表面显示成“正在运行”。
 */
export function selectAgentGoalView({ goal, goalSessionId, sessionId, runId, resumeableRunId, phase, runGoalId }: SelectAgentGoalViewInput): AgentGoalView {
  const scopedGoal = goal && goalSessionId === sessionId && sessionId === goal.sessionId ? goal : null
  if (!scopedGoal) {
    return { goal: null, presentation: null, ownedRun: false, runBelongsToGoal: false, waiting: false, running: false, canPauseOwnedRun: false, terminal: false }
  }

  const presentation = agentGoalPresentation(scopedGoal)
  const terminal = scopedGoal.status === 'completed' || scopedGoal.status === 'cancelled'
  const waiting = scopedGoal.status === 'active' && ['awaiting_input', 'awaiting_approval', 'awaiting_provider', 'reconciling'].includes(scopedGoal.phase)
  const ownedRun = Boolean(scopedGoal.currentRunId && scopedGoal.currentRunId === runId)
  const restoredGoalRun = Boolean(!runId && resumeableRunId && resumeableRunId === scopedGoal.currentRunId)
  const runBelongsToGoal = restoredGoalRun || (runGoalId === undefined ? ownedRun : runGoalId === scopedGoal.id)
  const running = ownedRun && isRunActive(phase) && presentation.running && !waiting

  return {
    goal: scopedGoal,
    presentation,
    ownedRun,
    runBelongsToGoal,
    waiting,
    running,
    canPauseOwnedRun: ownedRun && !terminal && scopedGoal.status === 'active' && isRunActive(phase),
    terminal,
  }
}

/**
 * 给待办条、侧栏等“是否正在运行”的表面使用。
 * 终态目标仍拥有旧 run 时压制迟到事件；已确认属于普通新 run 时交还给普通 run 状态。
 */
export function selectAgentActivityRunActive(view: AgentGoalView, phase: AgentRunPhase): boolean {
  if (!view.goal) return isRunActive(phase)
  if (!view.runBelongsToGoal) return isRunActive(phase)
  if (view.terminal) return view.runBelongsToGoal ? false : isRunActive(phase)
  return view.running
}

/** Goal control is authoritative before the old run's terminal SSE arrives. */
export function selectAgentPanelPhase(view: AgentGoalView, phase: AgentRunPhase): AgentRunPhase {
  if (!view.goal || !view.runBelongsToGoal) return phase
  if (view.goal.status === 'completed') return 'succeeded'
  if (view.goal.status === 'cancelled') return 'cancelled'
  if (['paused', 'blocked', 'usage_limited', 'budget_limited', 'updating'].includes(view.goal.status)) return 'paused'
  return phase
}

export function keepInterruptedRunExpanded(phase: AgentRunPhase, messageRunId: string, runId: string | null): boolean {
  return messageRunId === runId && (phase === 'paused' || phase === 'failed' || phase === 'cancelled')
}
