import type { ChatMessage } from '../ai-service.js'

export const NEXT_PROMPT_MAX_LENGTH = 80
const marker = '[[CHEVOINK_NEXT_PROMPT_91a5ed28]]'
const skip = '[[CHEVOINK_NO_NEXT_PROMPT]]'

const NOVEL_SETUP_PREDICTION_STATES = ['missing', 'candidate', 'applied', 'general'] as const
const setupPrefix = '[[NP:'
const setupPrefixLength = '[[NP:0]]'.length
type NovelSetupPredictionState = typeof NOVEL_SETUP_PREDICTION_STATES[number]
type NextPromptDecision = { nextPrompt?: string; nextPromptSuppressed?: true }

export function readNextPromptDecision(value: unknown): NextPromptDecision {
  if (typeof value !== 'string') return {}
  const text = value.trim()
  if (text === skip) return { nextPromptSuppressed: true }
  return text && text.length <= NEXT_PROMPT_MAX_LENGTH && !text.includes(setupPrefix)
    && !/[\r\n\p{Cc}]|\[\[CHEVOINK_/u.test(text) ? { nextPrompt: text } : {}
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
  const [call] = calls
  return finishReason === 'tool_calls' && calls.length === 1 && !call.incomplete
    && (call.name === 'novel_create' || call.name === 'novel_update_meta')
}

function readNovelSetupPrediction(raw: string): NextPromptDecision {
  if (raw.trim() === skip) return { nextPromptSuppressed: true }
  try {
    const value = JSON.parse(raw) as { cover?: NovelSetupPredictionState; text?: unknown } | null
    if (!value?.cover || !NOVEL_SETUP_PREDICTION_STATES.includes(value.cover)) return {}
    const { nextPrompt } = readNextPromptDecision(value.text)
    if (!nextPrompt || nextPrompt.length > NEXT_PROMPT_MAX_LENGTH - setupPrefixLength) return {}
    // Keep private tool-turn metadata within the existing receipt/frame field.
    return { nextPrompt: setupPrefix + NOVEL_SETUP_PREDICTION_STATES.indexOf(value.cover) + ']]' + nextPrompt }
  } catch { return {} }
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
  const instruction = `【输入框建议】预测作者最可能发出的下一条消息。依据作者原话、已交付内容和当前作品状态，用作者当前语言和第一人称写一条可直接发送的指令，限 ${NEXT_PROMPT_MAX_LENGTH} 字。说清动作、对象和期待的成果。把讨论方案、生成候选供作者预览、生成并应用区分开。作者更可能想设置缺失的正式封面且暂无候选时，写清生成封面并设为当前作品封面；只有顺着作者已表达的偏好时才写选图委托。有候选时可建议查看、选择或应用已有候选。风格、配色等细节仅在作者明确将它们指定为下一步产物的要求时写入建议。已有作品题材留给执行阶段参考。尊重作者的跳过意愿和当前能力，不默认替换已有封面，不把付费操作写成已获确认。对大纲、正文等也用同样原则，避免空泛的“继续”或“拟个下一步”。
普通答复后另起一行写 ${marker} 和建议。如果本来就用 task_respond 收尾，把建议放入独立的 nextPrompt 参数，answer 保持原样。如果只调用 novel_create 或 novel_update_meta 且这次保存会结束作品初始化，在同次回复的文本中另起一行写 ${marker}，后接单行 JSON，字段 text 是建议（限 ${NEXT_PROMPT_MAX_LENGTH - setupPrefixLength} 字），cover 是建议适用状态。缺少封面且无候选用 missing，有候选未应用用 candidate，已设置用 applied；与封面无关的建议用 general。允许这一行是唯一文本，工具参数照常。应用只会在保存成功、状态匹配且本轮完成后展示它。其他未完成回合不输出建议。没有合适的建议时填 ${skip}。输入框是否显示建议由应用按作者偏好和任务状态决定。建议不属于正文，不改变当前任务、权限或交付要求，也不为此补读资料或调用工具。`
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
