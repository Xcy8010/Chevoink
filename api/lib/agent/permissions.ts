/**
 * 权限裁决与审批信箱（plan/13 §4.3 / §4.9）。
 * - 'ask' 工具触发 permission.ask 事件后，循环在此挂起等待前端批复
 * - POST /api/agent/runs/:runId/approvals 调 resolveApproval 唤醒
 * - 超时视为拒绝（优雅收尾）；run 停止时全部挂起审批立即拒绝
 * - "总是允许"按 session 记忆（高危工具不允许）
 */

export type ApprovalDecision = {
  approved: boolean
  alwaysAllow: boolean
  timedOut: boolean
}

type PendingApproval = {
  toolName: string
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

const pendingByRun = new Map<string, Map<string, PendingApproval>>()
const alwaysAllowBySession = new Map<string, Set<string>>()

export function hasAlwaysAllow(sessionId: string, toolName: string): boolean {
  return alwaysAllowBySession.get(sessionId)?.has(toolName) ?? false
}

export function grantAlwaysAllow(sessionId: string, toolName: string) {
  let names = alwaysAllowBySession.get(sessionId)

  if (!names) {
    names = new Set()
    alwaysAllowBySession.set(sessionId, names)
  }

  names.add(toolName)
}

export function waitForApproval(
  runId: string,
  callId: string,
  toolName: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    let pending = pendingByRun.get(runId)

    if (!pending) {
      pending = new Map()
      pendingByRun.set(runId, pending)
    }

    const settle = (decision: ApprovalDecision) => {
      const entry = pendingByRun.get(runId)?.get(callId)
      if (!entry) {
        return
      }
      clearTimeout(entry.timer)
      pendingByRun.get(runId)?.delete(callId)
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }

    const onAbort = () => settle({ approved: false, alwaysAllow: false, timedOut: false })

    const timer = setTimeout(
      () => settle({ approved: false, alwaysAllow: false, timedOut: true }),
      timeoutMs,
    )

    pending.set(callId, {
      toolName,
      resolve: settle,
      timer,
    })

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 前端批复入口：返回 false 表示没有对应的挂起审批（已超时/已处理） */
export function resolveApproval(
  runId: string,
  callId: string,
  approved: boolean,
  alwaysAllow: boolean,
): boolean {
  const entry = pendingByRun.get(runId)?.get(callId)

  if (!entry) {
    return false
  }

  entry.resolve({ approved, alwaysAllow, timedOut: false })
  return true
}

/** run 收尾时清理：所有挂起审批按拒绝处理 */
export function rejectAllApprovals(runId: string) {
  const pending = pendingByRun.get(runId)

  if (!pending) {
    return
  }

  for (const entry of [...pending.values()]) {
    entry.resolve({ approved: false, alwaysAllow: false, timedOut: false })
  }

  pendingByRun.delete(runId)
}

export function getPendingApprovalCallIds(runId: string): string[] {
  return [...(pendingByRun.get(runId)?.keys() ?? [])]
}

/**
 * 提问信箱（ask_user 工具）：与审批信箱同构的挂起-唤醒模式。
 * - 工具 execute 内 waitForQuestionAnswer 挂起循环，等待作者作答
 * - POST /api/agent/runs/:runId/questions 调 resolveQuestionAnswer 唤醒
 * - 超时和取消都没有回答；只有真正的超时可触发本轮直接收尾
 */

export type QuestionAnswer = {
  answer: string | null
  timedOut: boolean
}

type PendingQuestion = {
  resolve: (result: QuestionAnswer) => void
  timer: NodeJS.Timeout
  expiresAt: number
}

const pendingQuestionsByRun = new Map<string, Map<string, PendingQuestion>>()

export function waitForQuestionAnswer(
  runId: string,
  callId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<QuestionAnswer> {
  return new Promise((resolve) => {
    let pending = pendingQuestionsByRun.get(runId)

    if (!pending) {
      pending = new Map()
      pendingQuestionsByRun.set(runId, pending)
    }

    const settle = (result: QuestionAnswer) => {
      const entry = pendingQuestionsByRun.get(runId)?.get(callId)
      if (!entry) {
        return
      }
      clearTimeout(entry.timer)
      pendingQuestionsByRun.get(runId)?.delete(callId)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const onAbort = () => settle({ answer: null, timedOut: false })

    const expiresAt = Date.now() + timeoutMs
    const timer = setTimeout(() => settle({ answer: null, timedOut: true }), timeoutMs)

    pending.set(callId, {
      resolve: settle,
      timer,
      expiresAt,
    })

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 前端作答入口：返回 false 表示没有对应的挂起提问（已超时/已处理） */
export function resolveQuestionAnswer(runId: string, callId: string, answer: string): boolean {
  const entry = pendingQuestionsByRun.get(runId)?.get(callId)

  if (!entry) {
    return false
  }
  if (Date.now() >= entry.expiresAt) {
    entry.resolve({ answer: null, timedOut: true })
    return false
  }

  entry.resolve({ answer, timedOut: false })
  return true
}

/** run 收尾时清理：所有挂起提问按未回答处理 */
export function cancelAllQuestions(runId: string) {
  const pending = pendingQuestionsByRun.get(runId)
  questionCountByRun.delete(runId)
  webSearchCacheByRun.delete(runId)
  platformSearchCountByRun.delete(runId)
  platformReadCountByRun.delete(runId)
  platformReadCacheByRun.delete(runId)

  if (!pending) {
    return
  }

  for (const entry of [...pending.values()]) {
    entry.resolve({ answer: null, timedOut: false })
  }

  pendingQuestionsByRun.delete(runId)
}

// ---------------------------------------------------------------------------
// 提问预算（plan/14 §四 B2）：每个 run 最多提问 3 次，防止反复追问拖垮体验
// ---------------------------------------------------------------------------

export const ASK_USER_BUDGET_PER_RUN = 3

const questionCountByRun = new Map<string, number>()

/** 尝试消耗一次提问额度：返回是否允许本次提问 */
export function consumeQuestionBudget(runId: string): boolean {
  const used = questionCountByRun.get(runId) ?? 0

  if (used >= ASK_USER_BUDGET_PER_RUN) {
    return false
  }

  questionCountByRun.set(runId, used + 1)
  return true
}

// ---------------------------------------------------------------------------
// 联网搜索去重缓存：同一 run 内归一化 query 命中缓存时直接返回，不扣搜索预算
// ---------------------------------------------------------------------------

const webSearchCacheByRun = new Map<string, Map<string, unknown>>()

export function getCachedWebSearch(runId: string, normalizedQuery: string): unknown | undefined {
  return webSearchCacheByRun.get(runId)?.get(normalizedQuery)
}

export function setCachedWebSearch(runId: string, normalizedQuery: string, outcome: unknown): void {
  let cache = webSearchCacheByRun.get(runId)

  if (!cache) {
    cache = new Map()
    webSearchCacheByRun.set(runId, cache)
  }

  cache.set(normalizedQuery, outcome)
}

// ---------------------------------------------------------------------------
// 站内作品搜索预算：每个 run 最多搜索 5 次，防止循环滥用拖慢任务
// ---------------------------------------------------------------------------

export const PLATFORM_SEARCH_BUDGET_PER_RUN = 5

const platformSearchCountByRun = new Map<string, number>()

/** 尝试消耗一次站内作品搜索额度：返回是否允许本次搜索 */
export function consumePlatformSearchBudget(runId: string): boolean {
  const used = platformSearchCountByRun.get(runId) ?? 0

  if (used >= PLATFORM_SEARCH_BUDGET_PER_RUN) {
    return false
  }

  platformSearchCountByRun.set(runId, used + 1)
  return true
}

// ---------------------------------------------------------------------------
// 站内作品深读预算：每个 run 最多读取 8 次，配合 platform_novel_search 使用
// ---------------------------------------------------------------------------

export const PLATFORM_READ_BUDGET_PER_RUN = 8

const platformReadCountByRun = new Map<string, number>()

/** 尝试消耗一次站内作品深读额度：返回是否允许本次读取 */
export function consumePlatformReadBudget(runId: string): boolean {
  const used = platformReadCountByRun.get(runId) ?? 0

  if (used >= PLATFORM_READ_BUDGET_PER_RUN) {
    return false
  }

  platformReadCountByRun.set(runId, used + 1)
  return true
}

// ---------------------------------------------------------------------------
// 站内作品深读去重缓存：同一 run 内相同 novelId/chapterId/offset/limit 命中
// 缓存时直接返回，不扣深读预算
// ---------------------------------------------------------------------------

const platformReadCacheByRun = new Map<string, Map<string, unknown>>()

export function getCachedPlatformRead(runId: string, cacheKey: string): unknown | undefined {
  return platformReadCacheByRun.get(runId)?.get(cacheKey)
}

export function setCachedPlatformRead(runId: string, cacheKey: string, outcome: unknown): void {
  let cache = platformReadCacheByRun.get(runId)

  if (!cache) {
    cache = new Map()
    platformReadCacheByRun.set(runId, cache)
  }

  cache.set(cacheKey, outcome)
}
