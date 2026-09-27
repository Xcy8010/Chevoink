const goalReasonLabels: Record<string, string> = {
  AUTHOR_PAUSED: '已暂停',
  AUTHOR_CANCELLED: '已取消',
  GOAL_BUDGET_EXHAUSTED: '预算已用完',
  GOAL_COMPLETION_REVIEW_REQUIRED: '等待你确认完成',
  GOAL_SCOPE_DECISION_REQUIRED: '请明确目标范围',
  GOAL_CHILD_EXECUTING: '等待子任务完成',
  GOAL_RECONCILIATION_REQUIRED: '等待核对执行结果',
  GOAL_RUN_HANDLE_MISSING: '等待恢复执行句柄',
  GOAL_NO_PROGRESS: '进度暂未变化',
  GOAL_IMPORT_AWAITING_AUTHOR: '等待导入确认',
  GOAL_IMPORT_CANCELLED: '导入已取消',
  GOAL_IMPORT_FAILED: '导入失败',
  GOAL_IMPORT_EXPIRED: '导入已过期',
}

/** Credits are persisted as integer micros (1 Credit = 1,000,000 micros). */
export function formatCreditsMicros(value: string): string {
  try {
    const micros = BigInt(value)
    const sign = micros < 0n ? '-' : ''
    const absolute = micros < 0n ? -micros : micros
    const whole = absolute / 1_000_000n
    const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/u, '')
    return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ''}`
  } catch {
    return '—'
  }
}

export function formatGoalReason(reasonCode: string | null): string {
  if (!reasonCode) return '—'
  return goalReasonLabels[reasonCode] ?? '等待处理'
}
