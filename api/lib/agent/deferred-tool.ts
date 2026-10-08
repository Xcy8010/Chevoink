import type { AgentMessagePart, AgentStreamEventBody } from '../../../shared/contracts/index.js'
import type { ToolCallRequest } from '../ai-service.js'

/** Persist a rejected proposal without invoking its handler or recording an effect. */
export function deferredToolPart(call: ToolCallRequest, title: string, args: unknown, reason: string,
  messageId: string, bus: { emit: (event: AgentStreamEventBody) => void }): AgentMessagePart {
  const summary = `未执行：${reason}`
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : null
  bus.emit({ type: 'tool.call', messageId, callId: call.id, toolName: call.name, title, args: safeArgs, autoApproved: false })
  bus.emit({ type: 'tool.result', messageId, callId: call.id, toolName: call.name, ok: false, summary, durationMs: 0 })
  return { type: 'tool-call', callId: call.id, toolName: call.name, title, args: safeArgs, status: 'failed', summary, durationMs: 0 }
}
