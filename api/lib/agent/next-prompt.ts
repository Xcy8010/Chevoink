import type { ChatMessage } from '../ai-service.js'

export const NEXT_PROMPT_MAX_LENGTH = 80
const marker = '[[CHEVOINK_NEXT_PROMPT_91a5ed28]]'

export function addNextPromptInstruction(messages: ChatMessage[]): string {
  const instruction = `【输入框建议】当前请求已完整交付且对话中有一个贴合作者目标的可选下一步时，请在完整答复后另起一行写 ${marker}，同一行在标记后写一条不超过 ${NEXT_PROMPT_MAX_LENGTH} 字的下一条作者指令。用作者当前的语言、口吻和具体目标写成可直接发送的一句话。此行会单独显示在输入框，答复保持正文和指定格式原样。当前任务仍需工具或作者决定，作者明确要求只输出指定内容、明确不要建议，或没有合适的下一步时，省略此行。此建议不会执行，不改变当前任务、权限或交付要求，也不为它补读资料或调用工具。`
  const system = messages.find(message => message.role === 'system')
  if (system) system.content += `\n\n${instruction}`
  else messages.unshift({ role: 'system', content: instruction })
  return marker
}

function lineBreakStart(text: string, newline: number): number {
  return text[newline - 1] === '\r' ? newline - 1 : newline
}

function findFooter(text: string, marker: string) {
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
    const newline = text.lastIndexOf('\n', at)
    if (newline !== -1 && /^[\t ]*$/u.test(text.slice(newline + 1, at))) {
      return { start: lineBreakStart(text, newline), end: at + marker.length }
    }
  }
}

function possibleFooterTail(text: string, marker: string) {
  const newline = text.lastIndexOf('\n')
  if (newline === -1) return
  const token = text.slice(newline + 1).replace(/^[\t ]*/u, '')
  if (marker.startsWith(token)) return { start: lineBreakStart(text, newline), private: token.startsWith('[[CHEVOINK_NEXT_PROMPT_') }
}

/** Hold a potential footer across chunks, including CRLF and indentation. */
export function createNextPromptStream(marker: string) {
  let pending = ''
  let hidden = false
  return {
    push(delta: string): string {
      if (hidden) return ''
      const combined = pending + delta
      const footer = findFooter(combined, marker)
      if (footer) {
        hidden = true
        pending = ''
        return combined.slice(0, footer.start)
      }
      const end = combined.endsWith('\r') ? combined.length - 1 : combined.length
      const boundary = possibleFooterTail(combined, marker)?.start ?? end
      pending = combined.slice(boundary)
      return combined.slice(0, boundary)
    },
    finish(): string {
      // An incomplete delimiter can be the last bytes of a truncated result.
      return possibleFooterTail(pending, marker)?.private ? '' : pending
    },
  }
}

/** Keep the same provider request and usage evidence; strip only its own
 * private separator, and expose a suggestion only from a complete final turn. */
export function splitNextPrompt(content: string, marker: string, completed: boolean): { content: string; nextPrompt?: string } {
  const footer = findFooter(content, marker)
  if (!footer) {
    const tail = possibleFooterTail(content, marker)
    return { content: tail?.private ? content.slice(0, tail.start) : content }
  }
  const answer = content.slice(0, footer.start)
  const nextPrompt = content.slice(footer.end).trim()
  return { content: answer, ...(completed && answer.trim() && nextPrompt && nextPrompt.length <= NEXT_PROMPT_MAX_LENGTH && !/[\r\n\p{Cc}]/u.test(nextPrompt) ? { nextPrompt } : {}) }
}
