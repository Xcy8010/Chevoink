import type { ChatMessage } from '../ai-service.js'
import {
  NEXT_PROMPT_MAX_LENGTH, NOVEL_SETUP_PREDICTION_STATES, readNextPromptText, readNovelSetupPredictionPayload,
  readPlainNextPrompt, type NovelSetupPredictionState,
} from '../../../shared/contracts/agent-next-prompt.js'

export { NEXT_PROMPT_MAX_LENGTH }
const marker = '[[CHEVOINK_NEXT_PROMPT_91a5ed28]]'
const skip = '[[CHEVOINK_NO_NEXT_PROMPT]]'

const setupPrefix = '[[NP:'
const setupPrefixLength = '[[NP:0]]'.length
type NextPromptDecision = { nextPrompt?: string; nextPromptSuppressed?: true }

export function readNextPromptDecision(value: unknown): NextPromptDecision {
  if (typeof value === 'string' && value.trim() === skip) return { nextPromptSuppressed: true }
  const nextPrompt = readNextPromptText(value)
  return nextPrompt ? { nextPrompt } : {}
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

export function modelNextPrompt(proposal?: NextPromptDecision): string | undefined {
  if (!proposal || proposal.nextPromptSuppressed) return
  return readNextPromptDecision(proposal.nextPrompt).nextPrompt
}

export function isNovelSetupPredictionTurn(finishReason: string, calls: ReadonlyArray<{ name: string; incomplete?: boolean }>): boolean {
  if (finishReason !== 'tool_calls' || calls.some(call => call.incomplete)) return false
  if (calls.length === 1) return ['novel_create', 'novel_update_meta'].includes(calls[0].name)
  return calls.length === 2 && calls[0].name === 'novel_rename' && calls[1].name === 'novel_update_meta'
}

function readNovelSetupPrediction(raw: string): NextPromptDecision {
  if (raw.trim() === skip) return { nextPromptSuppressed: true }
  const value = readNovelSetupPredictionPayload(raw)
  if (!value?.cover) return {}
  const nextPrompt = readPlainNextPrompt(value.text)
  if (!nextPrompt || nextPrompt.length > NEXT_PROMPT_MAX_LENGTH - setupPrefixLength) return {}
  // Keep private tool-turn metadata within the existing receipt/frame field.
  return { nextPrompt: setupPrefix + NOVEL_SETUP_PREDICTION_STATES.indexOf(value.cover) + ']]' + nextPrompt }
}

export function modelNovelSetupNextPrompt(proposal: NextPromptDecision, recap: {
  cover?: Exclude<NovelSetupPredictionState, 'general'>
  skipCover?: true
  skipFollowup?: true
}): string | undefined {
  if (recap.skipFollowup || proposal.nextPromptSuppressed) return
  const match = proposal.nextPrompt?.match(/^\[\[NP:([0-3])\]\](.+)$/u)
  if (!match) return
  const state = NOVEL_SETUP_PREDICTION_STATES[Number(match[1])]
  if (state === 'general' || !recap.skipCover && state === recap.cover) return modelNextPrompt({ nextPrompt: match[2] })
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
  const instruction = `【输入框建议】每个成功完成的作者回合，在收尾时亲自写一句作者可以直接发送的下一步指令，限 ${NEXT_PROMPT_MAX_LENGTH} 字。先核对作者最近的请求、你刚交付的内容以及本轮工具已确认的作品状态。用作者自己的语言和口吻，说清要对哪个对象做什么；只保留执行所需的范围。若回复以询问收尾，建议应直接承接其中一个可执行选项。省去复述、解释和泛泛索要下一步建议。资料不足时，针对本轮交付写一个有明确对象的核对请求。作品信息齐备、尚无大纲时可承接建立大纲；已有大纲或作者已指定下一步时遵从实际进度。涉及封面时区分讨论方向、生成、选择候选和设为作品封面，尊重作者的跳过与选图意愿、已有成果和费用确认流程。仅在下一步确实需要时带上题材或风格。
普通答复后另起一行写 ${marker} 和一条纯文本建议。如果本来就用 task_respond 收尾，只将纯文本建议放入 nextPrompt，answer 保持原样。这两种情况只写作者会发送的话，不加 JSON、字段名或 Markdown 包装。作品初始化将在这次保存后结束时（单独 novel_create、novel_update_meta，或同批先 novel_rename 再 novel_update_meta），在同次回复的文本中另起一行写 ${marker}，后接单行 JSON，字段 text 是建议（限 ${NEXT_PROMPT_MAX_LENGTH - setupPrefixLength} 字），cover 是建议适用状态。缺少封面且无候选用 missing，有候选未应用用 candidate，已设置用 applied；与封面无关的建议用 general。允许这一行是唯一文本，工具参数照常。应用只会在保存成功、状态匹配且本轮完成后展示它。其他未完成回合不输出建议。输入框是否显示建议由应用按作者偏好和任务状态决定。建议不属于正文，不改变当前任务、权限或交付要求，也不为此补读资料或调用工具。`
  const system = messages.find(message => message.role === 'system')
  if (system) system.content += `\n\n${instruction}`
  else messages.unshift({ role: 'system', content: instruction })
  return marker
}

function lineBreakStart(text: string, newline: number): number {
  return text[newline - 1] === '\r' ? newline - 1 : newline
}

function findFooter(text: string, marker: string, startsAtLineBoundary = true) {
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
    const newline = text.lastIndexOf('\n', at)
    if ((newline >= 0 || startsAtLineBoundary) && /^[\t ]*$/u.test(text.slice(newline + 1, at))) {
      return { start: newline < 0 ? 0 : lineBreakStart(text, newline), end: at + marker.length }
    }
  }
}

function possibleFooterTail(text: string, marker: string, startsAtLineBoundary = true) {
  const newline = text.lastIndexOf('\n')
  if (newline < 0 && !startsAtLineBoundary) return
  const token = text.slice(newline + 1).replace(/^[\t ]*/u, '')
  if (marker.startsWith(token)) return { start: newline < 0 ? 0 : lineBreakStart(text, newline), private: token.startsWith('[[CHEVOINK_NEXT_PROMPT_') }
}

/** Hold a potential footer across chunks, including CRLF and indentation. */
export function createNextPromptStream(marker: string) {
  let pending = ''
  let hidden = false
  let startsAtLineBoundary = true
  return {
    push(delta: string): string {
      if (hidden) return ''
      const combined = pending + delta
      const footer = findFooter(combined, marker, startsAtLineBoundary)
      if (footer) {
        hidden = true
        pending = ''
        return combined.slice(0, footer.start)
      }
      const end = combined.endsWith('\r') ? combined.length - 1 : combined.length
      const boundary = possibleFooterTail(combined, marker, startsAtLineBoundary)?.start ?? end
      pending = combined.slice(boundary)
      const visible = combined.slice(0, boundary)
      if (visible) startsAtLineBoundary = visible.endsWith('\n')
      return visible
    },
    finish(): string {
      // An incomplete delimiter can be the last bytes of a truncated result.
      return possibleFooterTail(pending, marker, startsAtLineBoundary)?.private ? '' : pending
    },
  }
}

/** Keep the same provider request and usage evidence; strip only its own
 * private separator, and expose a suggestion only from a complete final turn. */
export function splitNextPrompt(content: string, marker: string, completed: boolean, setupWrite = false): { content: string } & NextPromptDecision {
  const footer = findFooter(content, marker)
  if (!footer) {
    const tail = possibleFooterTail(content, marker)
    return { content: tail?.private ? content.slice(0, tail.start) : content }
  }
  const answer = content.slice(0, footer.start)
  const suggestion = content.slice(footer.end)
  return { content: answer, ...(setupWrite ? readNovelSetupPrediction(suggestion) : completed && answer.trim() ? readNextPromptDecision(suggestion) : {}) }
}
