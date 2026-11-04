import type { AgentUIMessage } from '../../../../../shared/contracts/index'
import { getAgentToolPresentation, hasAgentToolPresentation } from '../../../../../shared/agent-tool-presentation'
import { isResearchCall } from './research-groups'
import { projectAgentAuthorParts } from '../../../../../shared/agent-author-view'

export type AnalysisGroup = { id: string; messageId: string; firstIndex: number; count: number; labels: string[]; actions: string[]; text: string; lastMessageId: string; lastIndex: number }
export type MessageAnalysisGroups = ReadonlyMap<number, AnalysisGroup>

// This classifier is reasoning-only. Ordinary prose, quotations and equations
// such as x=1 continue through the shared author-view without these rules.
const reasoningProtocolField = '(?:[A-Za-z]\\w*(?:Id|Hash)|[A-Za-z]\\w*_(?:id|hash)|planKind|targetOrderIndex|toolName|arguments|args|modelTier|reasoningEffort|thinkingEnabled)'
function sanitizeReasoning(text: string) {
  const assignment = new RegExp(`(?:["'\u0060])?\\b${reasoningProtocolField}(?:["'\u0060])?\\s*[=:：]\\s*`, 'g')
  let clean = '', offset = 0
  for (let match = assignment.exec(text); match; match = assignment.exec(text)) {
    clean += text.slice(offset, match.index)
    let end = assignment.lastIndex, quote = '', depth = 0
    const structured = /[[{"'\u0060]/.test(text[end] ?? '')
    for (; end < text.length; end++) {
      const char = text[end]
      if (quote) {
        if (char === '\\') end++
        else if (char === quote) { quote = ''; if (depth === 0) { end++; break } }
      } else if (/["'\u0060]/.test(char)) quote = char
      else if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') { if (--depth <= 0) { end++; break } }
      else if (!structured && /[\s，,。；;\n]/.test(char)) break
    }
    offset = end
    assignment.lastIndex = end
  }
  clean += text.slice(offset)
  return clean.replace(new RegExp(`\\b${reasoningProtocolField}\\b`, 'g'), field => field === 'planKind' ? '计划类型' : /Hash|_hash$/.test(field) ? '内容版本' : /Id|_id$/.test(field) ? '目标对象' : '执行参数')
    .replace(/\b(?:c[a-z0-9]{20,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi, '')
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, name => hasAgentToolPresentation(name) ? getAgentToolPresentation(name).label : name).trim()
}

/** Only real reasoning-channel prose enters an expandable analysis episode. */
export function projectAnalysisGroups(messages: readonly Pick<AgentUIMessage, 'id' | 'role' | 'runId' | 'goalId' | 'parts'>[], activeMessageId?: string) {
  const result = new Map<string, Map<number, AnalysisGroup>>()
  let active: AnalysisGroup | undefined
  let run: string | undefined, goal: string | null | undefined
  for (const message of messages) {
    if (message.role !== 'assistant' || run !== message.runId || goal !== (message.goalId ?? null)) active = undefined
    run = message.runId; goal = message.goalId ?? null
    if (message.role !== 'assistant') continue
    const groups = new Map<number, AnalysisGroup>()
    result.set(message.id, groups)
    message.parts.forEach((part, index) => {
      if (part.type === 'reasoning') {
        active ??= { id: `${message.id}:analysis:${index}`, messageId: message.id, firstIndex: index, count: 0, labels: [], actions: [], text: '', lastMessageId: message.id, lastIndex: index }
        const visible = projectAgentAuthorParts([{ ...part, text: sanitizeReasoning(part.text) }], message.id === activeMessageId && index === message.parts.length - 1)
          .flatMap(item => item.type === 'reasoning' ? [item.text.trim()] : []).filter(Boolean).join('\n\n')
        // Thinking is not manuscript quotation: redact embedded argument clauses
        // even when a useful explanation precedes the operational identifier.
        if (visible) active.text += `${active.text ? '\n\n' : ''}${visible}`
        active.count++; active.lastMessageId = message.id; active.lastIndex = index
        groups.set(index, active)
      } else if (part.type === 'tool-call') {
        if (active) {
          const label = getAgentToolPresentation(part.toolName).label
          if (!active.labels.includes(label)) active.labels.push(label)
          if (part.toolName !== 'task_respond') active.actions.push(`${label}：${part.status === 'failed' ? '未完成' : part.status === 'denied' ? '未获准' : part.status === 'running' ? '进行中' : '已执行'}`)
        }
        if (!isResearchCall(part)) active = undefined
      } else if (!(part.type === 'text' && !part.text.trim())) active = undefined
    })
  }
  return result
}
