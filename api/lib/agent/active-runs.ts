import type { RunEventBus } from './events.js'

/**
 * 进行中 Agent run 的进程内登记表（自 loop.ts 模块级拆分而来，行为原样保留）。
 * 纯 Map 逻辑：注册/注销/计数/会话查询/停止，执行内核与路由层共享同一份状态。
 */

export type ActiveRun = {
  controller: AbortController
  /** Protocol-zero runs use an in-memory journal; durable runs stream from DB. */
  bus?: RunEventBus
  sessionId: string
  userId: string
  /** Same-session delegated execution is discovered for stop/recovery, but is
   * never presented as the session's main run or its interactive admission. */
  internalChild?: boolean
}

const activeRuns = new Map<string, ActiveRun>()

export function registerActiveRun(runId: string, run: ActiveRun): void {
  activeRuns.set(runId, run)
}

export function deregisterActiveRun(runId: string): void {
  activeRuns.delete(runId)
}

export function getActiveRun(runId: string): ActiveRun | undefined {
  return activeRuns.get(runId)
}

export function countActiveRunsByUser(userId: string): number {
  let count = 0
  for (const run of activeRuns.values()) {
    if (run.userId === userId && !run.internalChild) {
      count += 1
    }
  }
  return count
}

export function hasActiveRunInSession(sessionId: string): boolean {
  for (const run of activeRuns.values()) {
    if (run.sessionId === sessionId && !run.internalChild) {
      return true
    }
  }
  return false
}

/** 查询会话内进行中的 run id：前端刷新后恢复直播/停止入口用 */
export function getActiveRunIdBySession(sessionId: string): string | null {
  for (const [runId, run] of activeRuns) {
    if (run.sessionId === sessionId && !run.internalChild) {
      return runId
    }
  }
  return null
}

/** 停止会话内全部进行中的 run：删除会话前清理，避免孤儿任务阻塞删除或继续写库 */
export function stopActiveRunsInSession(sessionId: string): number {
  let stopped = 0
  for (const run of activeRuns.values()) {
    if (run.sessionId === sessionId) {
      run.controller.abort()
      stopped += 1
    }
  }
  return stopped
}

/** 用户点击停止：abort 上游请求 + 唤醒挂起审批，循环自行收尾为 paused */
export function stopAgentRun(runId: string): boolean {
  const active = activeRuns.get(runId)

  if (!active) {
    return false
  }

  active.controller.abort()
  return true
}

export function stopActiveRunsByUser(userId: string): number {
  let stopped = 0
  for (const run of activeRuns.values()) {
    if (run.userId !== userId) continue
    run.controller.abort()
    stopped += 1
  }
  return stopped
}

export function stopAllActiveRuns(): number {
  let stopped = 0
  for (const run of activeRuns.values()) {
    run.controller.abort()
    stopped += 1
  }
  return stopped
}
