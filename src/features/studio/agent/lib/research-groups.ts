import type { AgentMessagePart, AgentUIMessage } from '../../../../../shared/contracts/index.js'

export type ResearchCall = Extract<AgentMessagePart, { type: 'tool-call' }>
export type ResearchGroup = { id: string; messageId: string; firstCallId: string; calls: ResearchCall[] }
export type MessageResearchGroups = ReadonlyMap<string, ResearchGroup>

export function isResearchCall(part: AgentMessagePart): part is ResearchCall {
  return part.type === 'tool-call' && ['web_search', 'web_read', 'web_fetch'].includes(part.toolName)
}

/** Read-only transcript projection. Model turns may continue one research span;
 * user/run/goal boundaries, author prose and non-web actions close that span.
 * Branch ownership is explicit; query wording is never an identity signal.
 * Call/result updates keep their original ordered position in the transcript.
 */
export function projectResearchGroups(messages: readonly Pick<AgentUIMessage, 'id' | 'role' | 'runId' | 'goalId' | 'parts'>[]) {
  const result = new Map<string, Map<string, ResearchGroup>>()
  const active = new Map<string, ResearchGroup>()
  let previousRun: string | undefined
  let previousGoal: string | null | undefined
  for (const message of messages) {
    if (message.role !== 'assistant' || message.runId !== previousRun || (message.goalId ?? null) !== previousGoal) active.clear()
    previousRun = message.runId
    previousGoal = message.goalId ?? null
    if (message.role !== 'assistant') continue
    const groups = new Map<string, ResearchGroup>()
    result.set(message.id, groups)
    for (const part of message.parts) {
      if (part.type === 'reasoning' || part.type === 'text' && !part.text.trim()) continue
      if (part.type !== 'tool-call') { active.clear(); continue }
      const branch = part.subagentCallId ?? ''
      if (!isResearchCall(part)) { active.delete(branch); continue }
      let group = active.get(branch)
      if (!group) {
        group = { id: JSON.stringify([message.id, branch, part.callId]), messageId: message.id, firstCallId: part.callId, calls: [] }
        active.set(branch, group)
      }
      group.calls.push(part)
      groups.set(part.callId, group)
    }
  }
  return result
}

export function researchCallUnavailable(call: ResearchCall) {
  return call.status === 'failed' || call.status === 'denied'
    || call.display?.kind === 'webSearch' && call.display.provider === 'unavailable'
}

export function researchCallTarget(call: ResearchCall) {
  const args = typeof call.args === 'object' && call.args !== null ? call.args as Record<string, unknown> : null
  if (call.display?.kind === 'webSearch') return call.display.query
  if (typeof args?.query === 'string') return args.query
  if (typeof args?.url === 'string') return args.url
  return ''
}

export function summarizeResearchGroup(calls: readonly ResearchCall[], runActive: boolean) {
  const pending = calls.filter(call => call.status === 'running')
  const current = pending.at(-1) ?? calls.at(-1)
  const running = runActive && pending.length > 0
  const unavailable = calls.filter(researchCallUnavailable).length
  const searchResults = calls.reduce((count, call) => count + (call.status === 'success' && !researchCallUnavailable(call)
    && call.display?.kind === 'webSearch' ? call.display.results.length : 0), 0)
  const reads = calls.filter(call => call.status === 'success' && call.display?.kind === 'markdown' && call.display.markdown.trim()).length
  const hasEvidence = searchResults > 0 || reads > 0
  const empty = calls.some(call => call.status === 'success' && call.display?.kind === 'webSearch' && call.display.results.length === 0)
  const status = running ? current?.preparing ? 'preparing' : 'running' : pending.length ? 'unknown' : hasEvidence ? 'settled' : 'unavailable'
  const outcome = pending.length && !running ? '部分资料获取结果待确认'
    : hasEvidence ? [searchResults ? `${searchResults} 条搜索结果` : '', reads ? `已完成 ${reads} 次资料读取` : ''].filter(Boolean).join(' · ')
      : unavailable ? '本次未取得参考资料' : empty ? '未找到参考资料' : '暂无可展示的参考内容'
  const action = current?.toolName === 'web_search' ? running ? '正在搜索' : '搜索' : running ? '正在读取' : '读取'
  const target = current ? researchCallTarget(current) : ''
  const summary = running && current?.preparing ? '准备查看参考资料…' : target ? `${action}「${target}」` : running ? '正在查看参考资料…' : outcome
  return { current, running, unavailable, hasEvidence, status, outcome, summary }
}
