import type { AgentMessagePart, AgentTodoItem } from '../../../shared/contracts/index.js'

/** Empty/thinking-only responses are provider non-delivery, not unfinished todos.
 * One correction is allowed, without changing the selected model or reasoning. */
export function createEmptyResponseGuard() {
  let consecutive = 0
  return {
    observe(content: string, toolCount: number): 'continue' | 'retry' | 'stop' {
      if (content.trim() || toolCount > 0) { consecutive = 0; return 'continue' }
      return ++consecutive < 2 ? 'retry' : 'stop'
    },
  }
}

/** Recovery is bounded both per consecutive failure and per run. A real call
 * breaks the streak, but never replenishes the total paid correction budget. */
export function createProtocolRecoveryGuard() {
  let consecutive = 0
  let total = 0
  return {
    observe(validCall: boolean, invalidProtocol: boolean): 'continue' | 'retry' | 'stop' {
      if (validCall) consecutive = 0
      if (!invalidProtocol) return 'continue'
      consecutive += 1
      total += 1
      return consecutive <= 2 && total <= 6 ? 'retry' : 'stop'
    },
  }
}

/** Only unambiguous continuation commands inherit the previous task. */
export function isContinuationRequest(prompt: string): boolean {
  return /^(?:请|请你|帮我)?\s*(?:继续|接着)(?:(?:执行|完成|处理)?(?:之前|此前|刚才|上次|上一轮|剩余|未完成)的?(?:任务|工作|整改|内容)?|执行|完成)?[。！!\s]*$/u.test(prompt.trim())
}

export function promisesFurtherAction(text: string): boolean {
  const lastSentence = text.trim().split(/[。！!\n]/u).filter(Boolean).at(-1) ?? ''
  if (/(?:无需|不需要|不必|如需|如果|你可以|您可以|可以继续|是否|已经|已完成)/u.test(lastSentence)) return false
  return /(?:接下来|下一步|现在|马上|先|继续|直接)(?:我会|我将|会|将|去)?[^。\n]{0,24}(?:写入|写正文|修订|修复|检查|校验|整改|重建|补齐|读取|读回)/u.test(lastSentence)
}

/** Narrow to an explicit next-chapter instruction, not the legacy "write"
 * default intent (which also contains questions and explanations). */
export function requiresNextChapterDelivery(goals: string[]): boolean {
  return goals.some(goal => /^(?:(?:请|帮我|请帮我|继续|接着)\s*)*(?:写|续写)(?:下[一1]|新的一)章(?:[。！!\s]|$)/u.test(goal.trim()))
}

const checkpointReadTools = new Set([
  'chapter_read', 'plan_read', 'novel_get_context', 'chapter_list_summaries', 'memory_search',
  'volume_list', 'structure_outline', 'web_read', 'platform_novel_read', 'research_report_read',
])

/** Only content observations, not workflow/status/audit tools, can extend a
 * read-only task. The caller deduplicates by tool name and returned observation,
 * not by model-supplied arguments (rephrasing a query is not new evidence). */
export function hasReadProgress(part: Extract<AgentMessagePart, { type: 'tool-call' }>): boolean {
  return part.status === 'success' && checkpointReadTools.has(part.toolName)
}

/** No-op diffs and repeated todo snapshots must not buy another budget slice. */
export function hasDurableProgress(part: Extract<AgentMessagePart, { type: 'tool-call' }>, previousTodos: AgentTodoItem[]): boolean {
  if (part.status !== 'success') return false
  const display = part.display
  if (display?.kind === 'chapterDiff') return display.appliedDirectly && display.before !== display.after
  // Quality tools retain the report card after an actual atomic rewrite.
  // Only the accompanying undo snapshot proves a write; a report alone does not.
  if (display?.kind === 'qualityReport') return part.snapshot?.target === 'chapter' && part.snapshot.field === 'content'
  if (display?.kind === 'planDiff') return display.before !== display.after
  if (display?.kind === 'todoList') {
    const completed = new Set(previousTodos.filter(item => item.status === 'completed').map(item => item.content))
    return display.items.some(item => item.status === 'completed' && !completed.has(item.content))
  }
  return display?.kind === 'planFile' || (part.toolName === 'chapter_create' && display?.kind === 'chapterRef')
}
