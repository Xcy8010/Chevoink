import { useCallback, useEffect, useRef } from 'react'

import type { AgentStreamEvent } from '../../../../shared/contracts/index.js'
import { buildAgentStreamUrl } from './agentApi'
import { isRunActive, useAgentStore } from './agentStore'

/**
 * SSE 客户端（plan/13 §5.4 + plan/20 §3.1）：
 * - 原生 EventSource：断线自动重连并自带 Last-Event-ID 续传
 * - 终态事件（run.finished / run.paused / 不可恢复 error）后手动关闭，避免无谓重连
 * - 高频 delta 事件帧级批处理：同一帧内的多条 delta 合并后一次性进 store，
 *   把全局状态更新频率从「每秒几十上百次」压到渲染帧级别，避免手机端主线程被长任务占满
 */

const EVENT_TYPES = [
  'run.started',
  'message.start',
  'execution.progress',
  'text.delta',
  'text.final',
  'reasoning.delta',
  'tool.call',
  'tool.delta',
  'tool.result',
  'permission.ask',
  'permission.resolved',
  'step.finish',
  'run.paused',
  'run.finished',
  // 跨任务编排新增窗口：侧栏据此当帧登记任务窗并点亮运行中标记，漏订会导致派生窗口刷新后才可见
  'task.spawned',
  'error',
] as const

function isTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === 'run.finished' ||
    event.type === 'run.paused' ||
    (event.type === 'error' && !event.recoverable)
  )
}

/** 高频流式事件：先进队列，按渲染帧合并后再进 store */
function isDeltaEvent(event: AgentStreamEvent): boolean {
  return event.type === 'text.delta' || event.type === 'reasoning.delta' || event.type === 'tool.delta'
}

/** 合并同一帧内相邻的同源 delta：text/reasoning 拼接文本，tool.delta 取最新进度；跨源保持原顺序 */
function mergePendingEvents(pending: AgentStreamEvent[]): AgentStreamEvent[] {
  const merged: AgentStreamEvent[] = []

  for (const event of pending) {
    const last = merged[merged.length - 1]

    if (
      last &&
      (event.type === 'text.delta' || event.type === 'reasoning.delta') &&
      last.type === event.type &&
      last.messageId === event.messageId
    ) {
      // 用后一条的 seq/ts，保证 store 的 lastSeq 正确推进
      merged[merged.length - 1] = { ...event, delta: last.delta + event.delta }
      continue
    }

    if (
      last &&
      event.type === 'tool.delta' &&
      last.type === 'tool.delta' &&
      last.messageId === event.messageId &&
      last.callId === event.callId
    ) {
      // argsChars 是累计值，只保留最新一条
      merged[merged.length - 1] = event
      continue
    }

    merged.push(event)
  }

  return merged
}

export function useAgentStream(
  onEvent?: (event: AgentStreamEvent) => void,
  onActiveConnectionError?: (runId: string) => void,
) {
  const sourceRef = useRef<EventSource | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const onActiveConnectionErrorRef = useRef(onActiveConnectionError)
  onActiveConnectionErrorRef.current = onActiveConnectionError

  // delta 批处理队列：每帧（页面后台时降级 100ms 定时器）冲刷一次
  const pendingRef = useRef<AgentStreamEvent[]>([])
  const flushHandleRef = useRef<number | null>(null)
  const flushViaRafRef = useRef(false)

  const flushPending = useCallback(() => {
    if (flushHandleRef.current !== null) {
      if (flushViaRafRef.current) {
        cancelAnimationFrame(flushHandleRef.current)
      } else {
        window.clearTimeout(flushHandleRef.current)
      }
      flushHandleRef.current = null
    }

    if (pendingRef.current.length === 0) {
      return
    }
    const pending = pendingRef.current
    pendingRef.current = []

    const { applyEvent } = useAgentStore.getState()
    for (const event of mergePendingEvents(pending)) {
      applyEvent(event)
      onEventRef.current?.(event)
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushHandleRef.current !== null) {
      return
    }
    if (typeof document !== 'undefined' && document.hidden) {
      flushViaRafRef.current = false
      flushHandleRef.current = window.setTimeout(() => {
        flushHandleRef.current = null
        flushPending()
      }, 100)
    } else {
      flushViaRafRef.current = true
      flushHandleRef.current = requestAnimationFrame(() => {
        flushHandleRef.current = null
        flushPending()
      })
    }
  }, [flushPending])

  const disconnect = useCallback(() => {
    // 关连接前先冲刷残留 delta，避免丢尾部文本
    flushPending()
    sourceRef.current?.close()
    sourceRef.current = null
  }, [flushPending])

  const connect = useCallback(
    (runId: string, sinceSeq = 0) => {
      disconnect()

      const source = new EventSource(buildAgentStreamUrl(runId, sinceSeq), {
        withCredentials: true,
      })
      sourceRef.current = source

      const handleEvent = (raw: MessageEvent) => {
        if (!raw.data) {
          return
        }

        let event: AgentStreamEvent
        try {
          event = JSON.parse(raw.data) as AgentStreamEvent
        } catch {
          return
        }

        // 高频 delta：只入队 + 预约下一帧冲刷，不直接触发全局状态更新
        if (isDeltaEvent(event)) {
          pendingRef.current.push(event)
          scheduleFlush()
          return
        }

        // 低频事件：先冲刷队列再同步应用，保证事件顺序语义不变
        flushPending()
        useAgentStore.getState().applyEvent(event)
        onEventRef.current?.(event)

        if (isTerminalEvent(event)) {
          disconnect()
        }
      }

      for (const type of EVENT_TYPES) {
        source.addEventListener(type, handleEvent)
      }

      // 连接层错误（非业务 error 事件）：EventSource 自带重连 + Last-Event-ID，无需干预；
      // 仅在 run 已终结时主动关闭，避免死循环重连；等待回答/审批（awaiting_input/awaiting_approval）
      // 期间长时间无事件可能被代理掰断，必须保持重连才能收到后续事件
      source.onerror = () => {
        if (sourceRef.current !== source) return
        const { phase, runId: currentRunId } = useAgentStore.getState()
        if (!isRunActive(phase) || currentRunId !== runId) {
          disconnect()
          return
        }
        // 服务端已经提交终态而 SSE 最后一个帧因连接关闭丢失时，立即由调用方读取
        // 已持久化的状态；网络短暂断开仍保持 EventSource 自带的重连，不猜测任务结果。
        onActiveConnectionErrorRef.current?.(runId)
      }
    },
    [disconnect, flushPending, scheduleFlush],
  )

  useEffect(() => disconnect, [disconnect])

  return { connect, disconnect }
}
