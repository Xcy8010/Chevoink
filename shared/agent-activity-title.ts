import type { AgentMessagePart } from './contracts/agent-events.js'

const opening = '<activity-title>'
const closing = '</activity-title>'

/** Generic narration is not a creative activity. Keep titles for the author's
 * actual subject, including requested chapter summaries and research reports. */
export function visibleAgentActivityTitle(title: string): string | undefined {
  const meta = /^(?:正在|已)?(?:准备|开始|收尾)?(?:总结|汇总|整理|梳理|汇报|撰写|生成|输出)(?:一下)?(?:这一步|本步骤|当前步骤|本阶段|当前阶段|本次任务|本轮任务|本次|本轮|最终|最后|结尾|收尾)?(?:的)?(?:执行结果|阶段结果|工作进展|进度汇报|最终回复|最终答复|收尾总结|结果|汇报|总结|答复|回复)?[。…]*$/u
  return meta.test(title.trim()) ? undefined : title
}

/** Metadata occupies one complete leading line of an assistant response. */
export function readAgentActivityTitle(content: string): { title?: string; text: string } {
  const newline = content.indexOf('\n')
  const line = (newline < 0 ? content : content.slice(0, newline)).trim()
  if (!line.startsWith(opening) || !line.endsWith(closing)) return { text: content }
  const title = line.slice(opening.length, -closing.length).trim()
  if (!title || /[<>\r]/u.test(title)) return { text: content }
  return { title, text: newline < 0 ? '' : content.slice(newline + 1) }
}

/** Hold a possible metadata line until the provider identifies the round as
 * tool-bearing. In a plain reply the same characters can be literal prose. */
export function createAgentActivityTextStream() {
  let prefix: string | undefined = ''
  return {
    push(delta: string) {
      if (prefix === undefined) return delta
      prefix += delta
      const candidate = prefix.trimStart()
      if (!prefix.includes('\n') && (opening.startsWith(candidate) || candidate.startsWith(opening))) return ''
      if (readAgentActivityTitle(prefix).title) return ''
      const text = prefix
      prefix = undefined
      return text
    },
    finish(toolBearing: boolean) {
      const buffered = prefix ?? ''
      prefix = undefined
      return toolBearing ? readAgentActivityTitle(buffered).text : buffered
    },
  }
}

/** Markdown keeps HTML disabled. A literal reserved line still renders as text. */
export function escapeLiteralActivityLine(content: string) {
  if (!readAgentActivityTitle(content).title) return content
  const newline = content.indexOf('\n')
  const end = newline < 0 ? content.length : newline
  return content.slice(0, end).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + content.slice(end)
}

export function prependAgentActivityTitle(parts: AgentMessagePart[], title: string): AgentMessagePart[] {
  return parts.some(part => part.type === 'activity-title') ? parts : [{ type: 'activity-title', title }, ...parts]
}
