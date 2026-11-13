import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { AgentQuestionDecision, PendingAgentQuestion } from '../../../../../shared/contracts/agent-events.js'
import { continueAgentLoopRun, resolveAgentApproval, resolveAgentQuestion, stopAgentLoopRun, type ContinueAgentLoopRunModel } from '../agentApi'
import { isRunActive, useAgentStore, type AgentRunPhase, type PendingApproval, type PendingQuestion } from '../agentStore'

/** Commands are bound to a view epoch: late responses must never affect another task. */
export function useRunControls({ runId, resumeableRunId, sessionId, authorId, phase, pendingApproval, pendingQuestion,
  connect, setActionError, selectedModelRef, refreshPendingQuestion, clearPendingQuestion }: {
  runId: string | null
  resumeableRunId: string | null
  sessionId: string | null
  authorId?: string | null
  phase: AgentRunPhase
  pendingApproval: PendingApproval | null
  pendingQuestion: PendingQuestion | PendingAgentQuestion | null
  connect: (runId: string, sinceSeq?: number) => void
  setActionError: (error: string | null) => void
  refreshPendingQuestion?: () => void
  clearPendingQuestion?: (requestId: string) => void
  /** 续跑随请求携带作者当前模型选择：点击时从 ref 读取最新值，避免闭包过期 */
  selectedModelRef?: RefObject<ContinueAgentLoopRunModel | null>
}) {
  const epoch = useRef(0)
  const pending = useRef(new Set<string>())
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  const waitingRunId = pendingQuestion && 'runId' in pendingQuestion && pendingQuestion.state === 'waiting' ? pendingQuestion.runId : null
  const stoppableRunId = isRunActive(phase) ? runId ?? waitingRunId : waitingRunId
  useLayoutEffect(() => {
    const owner = ++epoch.current
    pending.current = new Set()
    setStoppingRunId(null)
    return () => { epoch.current = owner + 1 }
  }, [sessionId, runId, resumeableRunId, authorId])
  useEffect(() => {
    if (stoppingRunId !== stoppableRunId) setStoppingRunId(null)
  }, [stoppableRunId, stoppingRunId])

  const command = useCallback(async <T,>(key: string, request: () => Promise<T>, success: (value: T) => void, fallback?: string, failed?: () => void) => {
    const owner = epoch.current
    const locks = pending.current
    if (locks.has(key)) return
    locks.add(key)
    try {
      const result = await request()
      if (owner === epoch.current) success(result)
      return result
    } catch (error) {
      if (owner !== epoch.current) return
      failed?.()
      if (fallback === undefined) throw error
      setActionError(error instanceof Error ? error.message : fallback)
    } finally {
      locks.delete(key)
    }
  }, [setActionError])

  const handleStop = useCallback(async () => {
    if (!stoppableRunId || stoppingRunId === stoppableRunId) return
    setStoppingRunId(stoppableRunId)
    await command(`stop:${stoppableRunId}`, () => stopAgentLoopRun(stoppableRunId), () => {
      refreshPendingQuestion?.()
    }, '停止失败，请稍后再试。', () => setStoppingRunId(null))
  }, [stoppableRunId, stoppingRunId, command, refreshPendingQuestion])

  const handleContinue = useCallback(async () => {
    const target = runId ?? resumeableRunId
    if (!target) return
    setActionError(null)
    await command(`continue:${target}`, () => continueAgentLoopRun(target, selectedModelRef?.current ?? null), (result) => {
      useAgentStore.getState().resumeRun(result.runId, sessionId, result.runGoalId, result.eventStartSeq)
      connect(result.runId, result.eventStartSeq ?? 0)
    }, '续跑失败，请稍后再试。')
  }, [runId, resumeableRunId, sessionId, connect, command, setActionError, selectedModelRef])

  const handleResolveApproval = useCallback(async (approved: boolean, alwaysAllow: boolean) => {
    if (!runId || !pendingApproval) return
    await command(`approval:${runId}:${pendingApproval.callId}`, () => resolveAgentApproval(runId, {
      callId: pendingApproval.callId, approvalId: pendingApproval.approvalId, approved, alwaysAllow,
    }), () => {}, '提交失败，请稍后再试。')
  }, [runId, pendingApproval, command])

  const handleResolveQuestion = useCallback(async (decision: AgentQuestionDecision) => {
    if (!pendingQuestion) return false
    const authoritative = 'runId' in pendingQuestion
    const target = authoritative ? pendingQuestion.runId : runId
    if (!target) return false
    const result = await command(`question:${target}:${pendingQuestion.requestId ?? pendingQuestion.callId}`, () => resolveAgentQuestion(target, {
      requestId: pendingQuestion.requestId, callId: pendingQuestion.callId, ...decision,
    }), ({ resolved, runId: resumedRunId, messageId }) => {
      if (!resolved || !authoritative) return
      clearPendingQuestion?.(pendingQuestion.requestId)
      const live = useAgentStore.getState()
      if (resumedRunId && messageId && pendingQuestion.state === 'completed' && 'answer' in decision) {
        live.beginRun(resumedRunId, decision.answer, sessionId, undefined, null, messageId, runId)
        const admitted = useAgentStore.getState()
        if (admitted.runId === resumedRunId && isRunActive(admitted.phase)) connect(resumedRunId, 0)
        return
      }
      if (!resumedRunId || live.runId === resumedRunId && isRunActive(live.phase)) return
      if (pendingQuestion.state === 'stopped') live.resumeRun(resumedRunId, sessionId, null, undefined, target)
      else live.resumeRun(resumedRunId, sessionId)
      connect(resumedRunId, 0)
    })
    return result?.resolved === true
  }, [runId, sessionId, pendingQuestion, command, clearPendingQuestion, connect])

  return { stoppingRunId,
    handleStop, handleContinue, handleResolveApproval, handleResolveQuestion }
}
