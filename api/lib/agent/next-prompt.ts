import type { ChatMessage } from '../ai-service.js'

export const NEXT_PROMPT_MAX_LENGTH = 80
const marker = '[[CHEVOINK_NEXT_PROMPT_91a5ed28]]'

export function addNextPromptInstruction(messages: ChatMessage[]): string {
  const instruction = `【输入框建议】当你已正常完成当前请求、无需调用工具或等待作者决定，且已有明确的下一步时，请在完整答复后另起一行写 ${marker}，同一行在标记后写一条不超过 ${NEXT_PROMPT_MAX_LENGTH} 字的下一条作者指令。用作者当前的语言、口吻和具体目标写成可直接发送的一句话。完整答复保持正文和指定格式原样，不要把建议混进正文、代码或数据。作者只要指定内容或不要建议，或没有合适的下一步时，省略此行。此建议不会执行，不改变当前任务、权限或交付要求，也不为它补读资料或调用工具。`
  const system = messages.find(message => message.role === 'system')
  if (system) system.content += `\n\n${instruction}`
  else messages.unshift({ role: 'system', content: instruction })
  return marker
}

/** Hold only a possible separator suffix across provider chunk boundaries. */
export function createNextPromptStream(marker: string) {
  const separator = `\n${marker}`
  let pending = ''
  let hidden = false
  return {
    push(delta: string): string {
      if (hidden) return ''
      const combined = pending + delta
      const at = combined.indexOf(separator)
      if (at !== -1) {
        hidden = true
        pending = ''
        return combined.slice(0, at)
      }
      let held = Math.min(combined.length, separator.length - 1)
      while (held > 0 && !combined.endsWith(separator.slice(0, held))) held -= 1
      pending = held ? combined.slice(-held) : ''
      return held ? combined.slice(0, -held) : combined
    },
    finish(): string {
      // An incomplete delimiter can be the last bytes of a truncated result.
      return pending.startsWith('\n[[CHEVOINK_NEXT_PROMPT_') ? '' : pending
    },
  }
}

/** Keep the same provider request and usage evidence; strip only its own
 * private separator, and expose a suggestion only from a complete final turn. */
export function splitNextPrompt(content: string, marker: string, completed: boolean): { content: string; nextPrompt?: string } {
  const separator = `\n${marker}`
  const at = content.indexOf(separator)
  if (at === -1) {
    const partialAt = content.lastIndexOf('\n[[CHEVOINK_NEXT_PROMPT_')
    return { content: partialAt !== -1 && separator.startsWith(content.slice(partialAt)) ? content.slice(0, partialAt) : content }
  }
  const answer = content.slice(0, at)
  const nextPrompt = content.slice(at + separator.length).trim()
  return { content: answer, ...(completed && answer.trim() && nextPrompt && nextPrompt.length <= NEXT_PROMPT_MAX_LENGTH && !/[\r\n\p{Cc}]/u.test(nextPrompt) ? { nextPrompt } : {}) }
}
