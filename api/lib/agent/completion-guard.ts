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
  // 明确推进当前待办仍是原任务；询问状态、要求取消或提出新章节不扩大为续跑授权。
  if (/^(?:请|请你|帮我)?\s*(?:把)?(?:当前|这个|这份|之前|剩余)?(?:的)?待办(?:清单|任务)?(?:中|里|里面)?(?:的)?(?:还)?(?:没完成|未完成|剩余)(?:的)?(?:任务|工作|项)?(?:都|全部)?(?:继续)?(?:完成|做完|执行完)(?:一下)?[。！!\s]*$/u.test(prompt.trim())) return true
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
    const completed = new Set(previousTodos.filter(item => item.status === 'completed').flatMap(item => [item.content, ...(item.id ? [item.id] : [])]))
    return display.items.some(item => item.status === 'completed' && !completed.has(item.id ?? item.content) && !completed.has(item.content))
  }
  return display?.kind === 'planFile' || (part.toolName === 'chapter_create' && display?.kind === 'chapterRef')
}

/** Only a fresh authenticated ask_user answer is eligible for this classifier.
 * Conditional future endings and prose/model claims are not cancellation. */
export function isExplicitAuthorEnd(answer: string, options: Array<{ label: string; detail?: string }> = []): boolean {
  const selected = options.find(option => answer === option.label || Boolean(option.detail) && answer === `${option.label}（${option.detail}）`)
  const fullText = (selected?.label ?? answer).trim().replace(/[。！!\s]+$/u, '')
  if (/(?:不要|不许|别|不能|不得).{0,6}(?:结束|停止|取消)|(?:如果|假如|等到|完成后|做完|写完|检查完|之后再)/u.test(fullText)) return false
  const text = fullText.split(/[。！？!?\n]/u).map(part => part.trim()).filter(Boolean).at(-1) ?? ''
  const end = '(?:结束(?:(?:本次|当前|这次|这个|本)?(?:任务|执行|运行|工作))?|停止(?:(?:本次|当前|这次|这个|本)?(?:任务|执行|运行|工作))?|取消(?:剩余|后续|本次|当前)?(?:任务|工作|执行)|到此为止|不再继续(?:执行|工作|任务)?)'
  return new RegExp(`^(?:(?:请|现在|立即|直接|先|就|可以|好了|好的|好)[，,\\s]*)*${end}(?:吧|即可|就好)?$`, 'u').test(text)
    || new RegExp(`^(?:把|将)?(?:全部|所有|剩余)(?:待办|任务|事项|项目|项)?(?:都)?(?:标注|标记|标为|标成)(?:为)?(?:已)?完成[，,、\\s]*(?:然后|并|再)?[，,\\s]*${end}$`, 'u').test(text)
}

export function hasAuthorEnded(usage: unknown): boolean {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || !('authorEnded' in usage)) return false
  const ended = usage.authorEnded
  return Boolean(ended && typeof ended === 'object' && !Array.isArray(ended) && 'fulfilled' in ended && typeof ended.fulfilled === 'boolean')
}
