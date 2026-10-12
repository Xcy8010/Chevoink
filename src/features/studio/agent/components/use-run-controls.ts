import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { continueAgentLoopRun, resolveAgentApproval, resolveAgentQuestion, stopAgentLoopRun, type ContinueAgentLoopRunModel } from '../agentApi'
import { isRunActive, useAgentStore, type AgentRunPhase, type PendingApproval, type PendingQuestion } from '../agentStore'
import type { AgentReviewReceiptWait } from '../../../../../shared/contracts'

/** Commands are bound to a view epoch: late responses must never affect another task. */
export function useRunControls({ runId, resumeableRunId, sessionId, phase, pendingApproval, pendingQuestion, connect, setActionError, selectedModelRef }: {
  runId: string | null
  resumeableRunId: string | null
  sessionId: string | null
  phase: AgentRunPhase
  pendingApproval: PendingApproval | null
  pendingQuestion: PendingQuestion | null
  connect: (runId: string, sinceSeq?: number) => void
  setActionError: (error: string | null) => void
  /** 续跑随请求携带作者当前模型选择：点击时从 ref 读取最新值，避免闭包过期 */
  selectedModelRef?: RefObject<ContinueAgentLoopRunModel | null>
}) {
  const epoch = useRef(0)
  const pending = useRef(new Set<string>())
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  const [reviewReceiptWait, setReviewReceiptWait] = useState<AgentReviewReceiptWait | null>(null)
  const [reviewReplacementReady, setReviewReplacementReady] = useState(false)
  useLayoutEffect(() => {
    const owner = ++epoch.current
    pending.current = new Set()
    setStoppingRunId(null)
    setReviewReceiptWait(null)
    setReviewReplacementReady(false)
    return () => { epoch.current = owner + 1 }
  }, [sessionId, runId, resumeableRunId])
  useEffect(() => {
    if (!isRunActive(phase) || stoppingRunId !== runId) setStoppingRunId(null)
    if (isRunActive(phase) || phase === 'succeeded' || phase === 'cancelled') {
      setReviewReceiptWait(null)
      setReviewReplacementReady(false)
    }
  }, [phase, runId, stoppingRunId])

  const command = useCallback(async <T,>(key: string, request: () => Promise<T>, success: (value: T) => void, fallback: string, failed?: () => void) => {
    const owner = epoch.current
    const locks = pending.current
    if (locks.has(key)) return
    locks.add(key)
    try {
      const result = await request()
      if (owner === epoch.current) success(result)
    } catch (error) {
      if (owner !== epoch.current) return
      failed?.()
      setActionError(error instanceof Error ? error.message : fallback)
    } finally {
      locks.delete(key)
    }
  }, [setActionError])

  const handleStop = useCallback(async () => {
    if (!runId || stoppingRunId === runId) return
    setStoppingRunId(runId)
    await command(`stop:${runId}`, () => stopAgentLoopRun(runId), () => {}, '停止失败，请稍后再试。', () => setStoppingRunId(null))
  }, [runId, stoppingRunId, command])

  const handleContinue = useCallback(async () => {
    const target = runId ?? resumeableRunId
    if (!target) return
    setActionError(null)
    await command(`continue:${target}`, () => continueAgentLoopRun(target, selectedModelRef?.current ?? null), (result) => {
      if (result.reviewReceiptWait) {
        setReviewReplacementReady(false)
        if (result.runId === target) setReviewReceiptWait(result.reviewReceiptWait)
        return
      }
      setReviewReceiptWait(null)
      setReviewReplacementReady(false)
      useAgentStore.getState().resumeRun(result.runId, sessionId, result.runGoalId)
      connect(result.runId, result.eventStartSeq ?? 0)
    }, '续跑失败，请稍后再试。')
  }, [runId, resumeableRunId, sessionId, connect, command, setActionError, selectedModelRef])

  const handleResolveApproval = useCallback(async (approved: boolean, alwaysAllow: boolean) => {
    if (!runId || !pendingApproval) return
    await command(`approval:${runId}:${pendingApproval.callId}`, () => resolveAgentApproval(runId, {
      callId: pendingApproval.callId, approvalId: pendingApproval.approvalId, approved, alwaysAllow,
    }), () => {}, '提交失败，请稍后再试。')
  }, [runId, pendingApproval, command])

  const handleResolveQuestion = useCallback(async (answer: string) => {
    if (!runId || !pendingQuestion) return
    await command(`question:${runId}:${pendingQuestion.callId}`, () => resolveAgentQuestion(runId, {
      requestId: pendingQuestion.requestId, callId: pendingQuestion.callId, answer,
    }), () => {}, '提交失败，请稍后再试。')
  }, [runId, pendingQuestion, command])

  const markReviewReplacementReady = useCallback(() => {
    setReviewReceiptWait(null)
    setReviewReplacementReady(true)
    setActionError(null)
  }, [setActionError])

  return { stoppingRunId, reviewReceiptWait, reviewReplacementReady, markReviewReplacementReady,
    handleStop, handleContinue, handleResolveApproval, handleResolveQuestion }
}
