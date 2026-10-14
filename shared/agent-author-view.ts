import type { AgentMessagePart, AgentUIMessage } from './contracts/index.js'
import { containsAgentProtocolArtifact, mapAgentVisibleProse, stripAgentProtocolArtifacts } from './agent-output.js'
import { getAgentToolPresentation, hasAgentToolPresentation } from './agent-tool-presentation.js'
import { fromMarkdown } from 'mdast-util-from-markdown'

const parameterLabels: Record<string, string> = {
  compilationId: '编译任务', sceneTaskId: '场景任务', chapterId: '目标章节',
  sessionId: '任务窗口', novelId: '作品', runId: '当前任务', taskId: '当前任务',
  reportId: '检查报告', findingId: '检查意见', changeSetId: '作品变更',
}
const operationalCue = /^\s*(?:(?:现在|接下来|正在|已经|然后|我(?:将|会|先|需要|已)?|我们(?:将|会|先|需要|已)?)\s*)*(?:调用|工具参数|调用参数|参数|编译|校验|重新发起|落库|协议|执行|提交|读取|写入|进入|拿到|正文完成|正文已完成)|^\s*(?:I|We) (?:will|need to)\b|^\s*(?:call|invoke|arguments|function)\b/i
const protocolAssignment = /^\s*(?:[a-z][\w]*Id|arguments|toolName|function_call|tool_call)\s*[=:：]/
const protocolJson = /[[{]\s*"(?:tool|name|arguments|chapterId|compilationId|model|reasoningEffort|thinkingEnabled|provider|apiKey)"\s*:/
const opaqueId = /\b(?:c[a-z0-9]{20,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi

function isOperational(text: string): boolean {
  // Markdown list/heading syntax is structure, not part of the statement.
  // Quoted blocks remain author/source quotations and are never normalized.
  text = text.trimStart().replace(/^(?:(?:[-*+] |\d+[.)、] |#{1,6} )\s*)+/, '')
  if (text.startsWith('>')) return false
  if (operationalCue.test(text) || protocolAssignment.test(text)) return true
  const first = /^\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/.exec(text)?.[1]
  return Boolean(first && hasAgentToolPresentation(first))
}

/** Generated parameter blocks use the same positive operational boundary as
 * prose. Manuscript code, examples and user quotations stay byte-for-byte. */
function removeOperationalCode(text: string): string {
  if (!/[`~]/.test(text) && !/^(?: {4}|\t)/m.test(text)) return text
  type Node = { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] }
  const stack: Node[] = [fromMarkdown(text)]
  const ranges: Array<{ start: number; end: number }> = []
  while (stack.length) {
    const node = stack.pop()!
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset, end = node.position?.end.offset
      if (start === undefined || end === undefined) continue
      const introduction = text.slice(0, start).split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).at(-1) ?? ''
      const payload = node.value ?? ''
      if (isOperational(introduction) && !/示例|例子|引用|原文|作者|小说|对话|example|quote/i.test(introduction)
        && (/^\s*[[{]/.test(payload) || /\b(?:\w+Id|arguments|toolName|reasoningEffort|thinkingEnabled)\b/.test(payload)
          || hasAgentToolPresentation(payload.trim()))) ranges.push({ start, end })
    } else if (node.children) stack.push(...node.children)
  }
  ranges.sort((a, b) => b.start - a.start)
  for (const range of ranges) text = text.slice(0, range.start) + text.slice(range.end)
  return text
}

/** Presentation only: never model context, manuscript storage or an execution
 * decision. Identifier shape alone cannot classify author prose as protocol. */
function authorQuoteRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"/g)) {
    const boundary = text.lastIndexOf('\n\n', match.index)
    const paragraphStart = boundary < 0 ? 0 : boundary + 2
    const paragraphEnd = text.indexOf('\n\n', match.index)
    const paragraph = text.slice(paragraphStart, paragraphEnd < 0 ? text.length : paragraphEnd)
    if (/^\s*[[{]/.test(paragraph) && protocolJson.test(paragraph)) continue
    const prefix = text.slice(0, match.index).split(/\n\s*\n/).at(-1) ?? ''
    // A value in a positively operational parameter assignment is protocol,
    // not an author quotation. All genuine complete quote spans are protected
    // before paragraph classification, including multiline dialogue.
    if (isOperational(prefix) && /\b\w+\s*[=:：]\s*$/.test(prefix)) continue
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

export function projectAgentAuthorText(text: string): string {
  const protocolClean = containsAgentProtocolArtifact(text)
    && (isOperational(text) || /^\s*<(?:invoke|tool[_-]?call|function[_-]?call|\|\|DSML)/im.test(text))
    ? stripAgentProtocolArtifacts(text) : text
  const clean = removeOperationalCode(protocolClean)
  return mapAgentVisibleProse(clean, prose => prose
    .split(/(\n\s*\n)/).map(paragraph => {
      if (!isOperational(paragraph)) {
        return protocolJson.test(paragraph) && /^\s*[[{]/.test(paragraph) ? '' : paragraph
      }
      // Parameter clauses are operational input, even after translation. Hold
      // unsafe progress and rely on actual tool stages; never infer success.
      if (/\b[A-Za-z]\w*\s*[=:：]|(?:编译任务|编译编号|目标章节|章节编号|场景任务|任务窗口|任务编号)\s*[=＝:：]/.test(paragraph)
        || protocolJson.test(paragraph)) return ''
      let visible = paragraph.replace(opaqueId, '')
        .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, name =>
          hasAgentToolPresentation(name) ? getAgentToolPresentation(name).label
            : /调用|工具|协议|\bcall\b/i.test(paragraph) ? '推进创作' : name)
        .replace(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, name => parameterLabels[name] ?? name)
      visible = visible.replace(/Story\s*Compiler/gi, '剧情编译').replace(/Chapter\s*Bridge/gi, '章节衔接')
        .replace(/Scene\s*Task/gi, '场景任务').replace(/Story\s*Charter/gi, '创作设定')
      return visible
    }).join(''), authorQuoteRanges(clean))
}

/** Partial progress has no stable classification. Keep it private until a
 * complete paragraph, or text.final. An emitted prefix is never rewritten. */
export function createAgentAuthorTextStream() {
  let pending = ''
  return {
    push(delta: string): string {
      pending += delta
      const boundary = [...pending.matchAll(/\n[\t ]*\n/g)].at(-1)
      if (!boundary) return ''
      const end = boundary.index + boundary[0].length
      const complete = pending.slice(0, end)
      const introduction = complete.trimEnd().split(/\n\s*\n/).at(-1) ?? ''
      // An operation introduction ending in a colon owns the following payload;
      // publishing it now would lose classification context for that payload.
      if (isOperational(introduction) && /[=:：]\s*$/.test(introduction)) return ''
      // Examples and quotes can cross paragraph boundaries; wait for final.
      if ((complete.match(/```/g)?.length ?? 0) % 2 || (complete.match(/"/g)?.length ?? 0) % 2
        || (complete.match(/“/g)?.length ?? 0) !== (complete.match(/”/g)?.length ?? 0)
        || (complete.match(/「/g)?.length ?? 0) !== (complete.match(/」/g)?.length ?? 0)
        || (complete.match(/『/g)?.length ?? 0) !== (complete.match(/』/g)?.length ?? 0)
        || (complete.match(/‘/g)?.length ?? 0) !== (complete.match(/’/g)?.length ?? 0)
        || /<(?:invoke|tool_call|function_call|\|\|DSML)/i.test(complete)
        || /<[^>]*$/.test(complete)
        || /^(?: {0,3})(?:`{3,}|~{3,})/m.test(complete)) return ''
      pending = pending.slice(end)
      return projectAgentAuthorText(complete)
    },
    finish(): string {
      const text = projectAgentAuthorText(pending)
      pending = ''
      return text
    },
  }
}

export function projectAgentAuthorParts(parts: readonly AgentMessagePart[], streamingReasoning = false): AgentMessagePart[] {
  const visible: AgentMessagePart[] = []
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'reasoning') {
      // Classify complete accumulated paragraphs while thinking is streaming.
      // An incomplete protocol/quote prefix must never escape expanded UI.
      const text = part.type === 'reasoning' && streamingReasoning
        ? createAgentAuthorTextStream().push(part.text) : projectAgentAuthorText(part.text)
      if (text.trim() || part.type === 'reasoning' && streamingReasoning && part.text.trim()) {
        visible.push(text === part.text ? part : { ...part, text })
      }
    } else if (part.type === 'tool-call') {
      // Argument generation is a model stage, not an execution witness.
      if (part.preparing) continue
      const title = getAgentToolPresentation(part.toolName).label
      const summary = part.summary ? projectAgentToolSummary(part.summary, part.status) : undefined
      visible.push(title === part.title && summary === part.summary ? part
        : { ...part, title, ...(summary !== undefined ? { summary } : {}) })
    } else visible.push(part)
  }
  return visible
}

export function projectAgentToolSummary(summary: string, status: string): string {
  const visible = projectAgentAuthorText(summary)
  if (/\b(?:Error|Exception|P\d{4}|HTTP|attempt|parser|workVersion)\b|\bat \S+\([^\n]+:\d+|[{}]/.test(visible)
    || !/[\p{Script=Han}]/u.test(visible)) {
    return status === 'failed' ? '本次操作未完成。请核对当前成果后重试，或调整要求。'
      : status === 'denied' ? '这项操作未获允许。请确认是否需要继续。' : ''
  }
  return visible
}

export function projectAgentAuthorMessage(message: AgentUIMessage): AgentUIMessage {
  return message.role === 'assistant' ? { ...message, parts: projectAgentAuthorParts(message.parts) } : message
}

export function getAgentAuthorMessageText(parts: readonly AgentMessagePart[]): string {
  return projectAgentAuthorParts(parts).flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n').trim()
}
