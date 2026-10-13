import type { AgentStreamEventBody } from '../../../shared/contracts/index.js'
import type { ToolCallRequest } from '../ai-service.js'

/** Persist a rejected proposal without invoking its handler or recording an effect. */
export function deferToolProposal(call: ToolCallRequest, reason: string,
  messageId: string, bus: { emit: (event: AgentStreamEventBody) => void }): void {
  bus.emit({ type: 'tool.deferred', messageId, callId: call.id, toolName: call.name, reason, execution: 'not_dispatched' })
}
