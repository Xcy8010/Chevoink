import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { continueAgentLoopRun, resolveAgentApproval, resolveAgentQuestion, stopAgentLoopRun, type ContinueAgentLoopRunModel } from '../agentApi'
import { isRunActive, useAgentStore, type AgentRunPhase, type PendingApproval, type PendingQuestion } from '../agentStore'

/** Commands are bound to a view epoch: late responses must never affect another task. */
export function useRunControls({ runId, resumeableRunId, sessionId, phase, pendingApproval, pendingQuestion, connect, setActionError, selectedModelRef }: {
  runId: string | null
  resumeableRunId: string | null
  sessionId: string | null
  phase: AgentRunPhase
  pendingApproval: PendingApproval | null
  pendingQuestion: PendingQuestion | null
  connect: (runId: string) => void
  setActionError: (error: string | null) => void
  /** 续跑随请求携带作者当前模型选择：点击时从 ref 读取最新值，避免闭包过期 */
  selectedModelRef?: RefObject<ContinueAgentLoopRunModel | null>
}) {
  const epoch = useRef(0)
  const pending = useRef(new Set<string>())
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  useLayoutEffect(() => {
    const owner = ++epoch.current
    pending.current = new Set()
    setStoppingRunId(null)
    return () => { epoch.current = owner + 1 }
  }, [sessionId])
  useEffect(() => {
    if (!isRunActive(phase) || stoppingRunId !== runId) setStoppingRunId(null)
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
      useAgentStore.getState().beginRun(result.runId, '请继续完成之前的任务。', sessionId)
      connect(result.runId)
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

  return { stoppingRunId, handleStop, handleContinue, handleResolveApproval, handleResolveQuestion }
}
