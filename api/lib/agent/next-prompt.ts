import type { ChatMessage } from '../ai-service.js'

export const NEXT_PROMPT_MAX_LENGTH = 80
const marker = '[[CHEVOINK_NEXT_PROMPT_91a5ed28]]'
const skip = '[[CHEVOINK_NO_NEXT_PROMPT]]'

type NextPromptDecision = { nextPrompt?: string; nextPromptSuppressed?: true }
type NextPromptDeliverable = { kind: 'plan' | 'chapter'; title: string }

export function readNextPromptDecision(value: unknown): NextPromptDecision {
  if (typeof value !== 'string') return {}
  const text = value.trim()
  if (text === skip) return { nextPromptSuppressed: true }
  return text && text.length <= NEXT_PROMPT_MAX_LENGTH && !/[\r\n\p{Cc}]/u.test(text) ? { nextPrompt: text } : {}
}

function suggestionPreferences(prompt: string) {
  const text = prompt.replace(/```[\s\S]*?```|`[^`\n]*`|^>[^\n]*|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gmu, '〈引用〉')
  const noTip = /(?:不要|不必|无需|不用|不需要|别|请勿|禁止|免去)[^。！!？?\r\n；;]{0,18}(?:建议|推荐|下一步|后续提示|补全提示|提示词)|不(?:加|附|给|提供|输出)(?:任何|额外|后续)?(?:建议|下一步|后续提示|补全提示)|(?:别|不要|请勿)(?:再)?(?:引导|提示|催促)(?:我)?(?:再)?(?:继续|追问)/u
  const exactOutput = /(?:只|仅)(?:需(?:要)?|要|能|可)?\s*(?:回复|回答|答复|输出|返回|给(?:我|出)?|交付|提供)|(?:只|仅)\s*(?:要|需)\s*(?:标题|正文|答案|结果|JSON|〈引用〉)/iu
  const noTipEnglish = /\b(?:no (?:suggestions?|follow[- ]?ups?|next steps?)|(?:don't|do not|never) [^.!?\r\n]{0,32}(?:suggestions?|follow[- ]?ups?|next steps?))\b/iu
  const exactEnglish = /\b(?:only|just) (?:respond|reply|output|return|the (?:answer|text|result)|json)\b/iu
  return { optedOut: noTip.test(text) || noTipEnglish.test(text), exact: exactOutput.test(text) || exactEnglish.test(text) }
}

/** Presentation opt-outs only. They do not decide tool authority or task completion. */
export function allowsNextPrompt(prompt: string | null): boolean {
  return Boolean(prompt?.trim() && !suggestionPreferences(prompt).optedOut)
}

export function allowsModelNextPrompt(prompt: string): boolean {
  return !suggestionPreferences(prompt).exact
}

/** Only reuse a concrete follow-up explicitly offered by the closing reply. */
function readOfferedNextPrompt(answer: string): string | undefined {
  const lastLine = answer.trimEnd().split(/\r?\n/u).at(-1)?.trim()
  const offered = lastLine?.match(/^(?:[-*]\s+)?(?:\*\*)?(?:下一步建议|可选下一步|可继续做)(?:\*\*)?[：:](?:\*\*)?\s*(\S.*)$/u)?.[1]
    ?? lastLine?.match(/^(?:如果你愿意[，,]\s*)?(?:接下来[，,]?\s*)?你可以(?:接着|继续)?让我(\S.*)$/u)?.[1]
    ?? lastLine?.match(/^(?:下一步[，,]?\s*|接下来[，,]?\s*)?(?:你|我们)?可以(?:先|接着|继续)(\S.*)$/u)?.[1]
    ?? lastLine?.match(/^如果(?:你)?愿意[，,]\s*我可以(?:接着|继续)?(?:帮你)?(\S.*)$/u)?.[1]
  if (!offered) return
  const action = offered.replace(/^[“「]|[”」]$/gu, '').replace(/^帮你/u, '帮我')
  // A question, conditional invitation or another explanation is not a ready-to-send request.
  if (/[？?]$/u.test(action) || /^(?:如果|是否|要不要|可以吗|暂无|无[。.]?$)/u.test(action)) return
  return readNextPromptDecision(/^(?:请|帮我|给我)/u.test(action) ? action : '帮我' + action).nextPrompt
}

export function selectCompletedNextPrompt(answer: string, proposal: NextPromptDecision, deliverable?: NextPromptDeliverable): string | undefined {
  if (proposal.nextPromptSuppressed) return
  const offered = proposal.nextPrompt ?? readOfferedNextPrompt(answer)
  if (offered || !deliverable) return offered
  const name = deliverable.title.trim()
  if (!name || /[\p{Cc}《》]/u.test(name)) return
  return readNextPromptDecision(deliverable.kind === 'plan' ? `帮我核对计划《${name}》与已有创作设定是否一致。`
    : `帮我核对《${name}》与前文的衔接和人物动机。`).nextPrompt
}

export const DEFAULT_COMPLETED_NEXT_PROMPT = '根据刚才的结果，帮我拟一个具体的下一步。'
export const LIMITED_COMPLETED_NEXT_PROMPT = '帮我核对这次交付里仍需确认的事项。'

export function selectInteractiveNextPrompt(answer: string, proposal: NextPromptDecision, deliverable?: NextPromptDeliverable): string {
  return selectCompletedNextPrompt(answer, proposal.nextPromptSuppressed ? {} : proposal, deliverable) ?? DEFAULT_COMPLETED_NEXT_PROMPT
}

/** Remove private metadata before the terminal tool validates or journals its exact answer. */
export function readTaskResponseNextPrompt(raw: string): { args: string; proposal: NextPromptDecision } {
  try {
    const input: unknown = JSON.parse(raw)
    if (input && typeof input === 'object' && !Array.isArray(input) && 'nextPrompt' in input) {
      const { nextPrompt, ...answerArgs } = input
      return { args: JSON.stringify(answerArgs), proposal: readNextPromptDecision(nextPrompt) }
    }
  } catch { /* The existing tool validator handles malformed arguments. */ }
  return { args: raw, proposal: {} }
}

export function addNextPromptInstruction(messages: ChatMessage[]): string {
  const instruction = `【输入框建议】当前请求已完整交付时，同时准备一条贴合作者目标、可直接发送的下一步作者指令。用作者当前的语言和口吻，限 ${NEXT_PROMPT_MAX_LENGTH} 字。普通答复后另起一行写 ${marker} 和建议。如果本来就用 task_respond 收尾，把建议放入独立的 nextPrompt 参数，answer 保持原样。没有合适的模型建议时，建议位置填 ${skip}。输入框是否显示建议由应用按作者偏好和任务状态决定。任务未完成时不输出建议。建议单独显示在输入框，不属于正文，不改变当前任务、权限或交付要求，也不为它补读资料或调用工具。`
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
export function splitNextPrompt(content: string, marker: string, completed: boolean): { content: string } & NextPromptDecision {
  const footer = findFooter(content, marker)
  if (!footer) {
    const tail = possibleFooterTail(content, marker)
    return { content: tail?.private ? content.slice(0, tail.start) : content }
  }
  const answer = content.slice(0, footer.start)
  return { content: answer, ...(completed && answer.trim() ? readNextPromptDecision(content.slice(footer.end)) : {}) }
}
