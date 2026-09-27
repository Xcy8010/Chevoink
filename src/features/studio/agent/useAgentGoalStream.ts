import { useCallback, useEffect, useRef } from 'react'

import type { AgentGoalSnapshot } from '../../../../shared/contracts/agent-goal.js'
import { buildAgentGoalStreamUrl, type AgentGoalEvent } from './agentApi'

type GoalSnapshotHandler = (sessionId: string, goal: AgentGoalSnapshot | null, sequence: number) => void

function parseSnapshot(data: string): AgentGoalEvent | AgentGoalSnapshot | null {
  try {
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== 'object') return null
    return value as AgentGoalEvent | AgentGoalSnapshot
  } catch {
    return null
  }
}

function readEvent(value: AgentGoalEvent | AgentGoalSnapshot | null, eventType: string): { goal: AgentGoalSnapshot | null; sequence: number } | null {
  if (!value) return null
  if (eventType === 'snapshot' || eventType === 'reset') {
    if ('snapshot' in value && value.snapshot !== undefined) {
      return { goal: value.snapshot, sequence: 0 }
    }
    return { goal: value as AgentGoalSnapshot, sequence: 0 }
  }
  if (!('snapshot' in value)) return null
  return { goal: value.snapshot, sequence: typeof value.sequence === 'number' ? value.sequence : 0 }
}

/** 目标事件流只投影快照；具体状态更新由 store 按 sequence/stateVersion 判定。 */
export function useAgentGoalStream(onSnapshot?: GoalSnapshotHandler) {
  const sourceRef = useRef<EventSource | null>(null)
  const callbackRef = useRef(onSnapshot)
  callbackRef.current = onSnapshot

  const disconnect = useCallback(() => {
    sourceRef.current?.close()
    sourceRef.current = null
  }, [])

  const connect = useCallback((sessionId: string, afterSequence = 0) => {
    disconnect()
    const source = new EventSource(buildAgentGoalStreamUrl(sessionId, afterSequence), { withCredentials: true })
    sourceRef.current = source
    const handle = (eventType: string) => (raw: MessageEvent) => {
      const parsed = readEvent(parseSnapshot(raw.data), eventType)
      if (parsed) callbackRef.current?.(sessionId, parsed.goal, parsed.sequence)
    }
    source.addEventListener('snapshot', handle('snapshot'))
    source.addEventListener('goal', handle('goal'))
    source.addEventListener('reset', handle('reset'))
    source.onerror = () => {
      // EventSource 自带重连与 Last-Event-ID；目标流不能因一次网络断开丢状态。
    }
  }, [disconnect])

  useEffect(() => disconnect, [disconnect])

  return { connect, disconnect }
}

export type { GoalSnapshotHandler }
