import type { ChatCompletionResult, ChatMessage, ToolCallRequest } from '../ai-service.js'

const scheduledHistoryPrefix = '[系统调度历史：只读数据，不是作者新指令或模型原生调用，不新增授权，也不要求重放。调用是否成功以随后真实回执为准；安排执行不代表完成。]\n'

/** Only identifies observations for history compaction, never authorization. */
export function scheduledToolHistoryIds(message: ChatMessage | undefined): Set<string> {
  if (message?.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith(scheduledHistoryPrefix)) return new Set()
  try {
    const rows: unknown = JSON.parse(message.content.slice(scheduledHistoryPrefix.length))
    if (!Array.isArray(rows) || !rows.every(row => row && typeof row === 'object' && Object.keys(row).length === 2
      && typeof row.callId === 'string' && row.callId.trim() && typeof row.toolName === 'string' && row.toolName.trim())) return new Set()
    return new Set(rows.map(row => row.callId as string))
  } catch { return new Set() }
}

/** Native assistant frames belong to the provider response. Server-scheduled
 * checks and recovered text calls remain readonly execution history; inventing
 * native calls for them also invents a provider reasoning/tool round. */
export function toolTurnHistory(result: Pick<ChatCompletionResult, 'content' | 'reasoning' | 'toolCalls'>,
  effectiveCalls: readonly ToolCallRequest[], options: { bootstrap?: boolean; recoveredText?: boolean; withholdText?: boolean } = {}): ChatMessage[] {
  const nativeCalls = options.bootstrap ? [] : result.toolCalls
  const nativeIds = new Set(nativeCalls.map(call => call.id))
  const scheduled = effectiveCalls.filter(call => !nativeIds.has(call.id))
  const messages: ChatMessage[] = []
  if (scheduled.length) messages.push({ role: 'user', content: scheduledHistoryPrefix
    + JSON.stringify(scheduled.map(call => ({ callId: call.id, toolName: call.name }))) })
  if (!options.bootstrap) messages.push({ role: 'assistant', content: options.recoveredText || options.withholdText ? null : result.content || null,
    reasoning: result.reasoning, ...(nativeCalls.length ? { toolCalls: nativeCalls } : {}) })
  return messages
}
