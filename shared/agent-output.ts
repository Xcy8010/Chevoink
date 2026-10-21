import { fromMarkdown } from 'mdast-util-from-markdown'

/** Report length only: Han characters in visible prose, excluding code, URLs,
 * image descriptions and duplicate blocks. This is not a quality certificate. */
export function countReportChineseCharacters(markdown: string): number {
  type Node = { type: string; value?: string; children?: Node[] }
  const blocks: string[][] = []
  const stack: Array<{ node: Node; block: string[] | null }> = [{ node: fromMarkdown(stripAgentProtocolArtifacts(markdown)), block: null }]
  while (stack.length) {
    const item = stack.pop()!
    const { node } = item
    if (['code', 'inlineCode', 'html', 'image', 'imageReference', 'definition'].includes(node.type)) continue
    let block = item.block
    if (node.type === 'paragraph' || node.type === 'heading') { block = []; blocks.push(block) }
    if (node.type === 'text' && block) block.push(node.value ?? '')
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) stack.push({ node: node.children![i], block })
  }
  const seen = new Set<string>()
  let count = 0
  for (const block of blocks) {
    const text = block.join('').replace(/https?:\/\/\S+/gu, '').replace(/\s+/gu, '')
    if (!text || seen.has(text)) continue
    seen.add(text)
    count += text.match(/\p{Script=Han}/gu)?.length ?? 0
  }
  return count
}

/**
 * 清理模型供应商偶发泄漏到正文信道的工具协议标记。
 * 这些标记不是作者内容，也不代表工具已经真实执行。
 */
const PROTOCOL_BLOCK_PATTERNS = [
  /<\s*(?:invoke|tool_call|tool-call|function_call|function-call)\b[^>]*>[\s\S]*?<\s*\/\s*(?:invoke|tool_call|tool-call|function_call|function-call)\s*>/gi,
  /<\s*\|\s*\|\s*DSML\s*\|\s*\|\s*tool_calls?\b[^>]*>[\s\S]*?<\s*\/\s*\|\s*\|\s*DSML\s*\|\s*\|\s*tool_calls?\s*>/gi,
]

const PROTOCOL_TOKEN_PATTERNS = [
  /<\s*\/?\s*(?:invoke|tool_call|tool-call|function_call|function-call|tool_calls|tool-calls|parameter|parameters)\b[^>]*>/gi,
  /<\s*\/?\s*\|\s*\|\s*DSML\s*\|\s*\|\s*(?:invoke|tool_calls?|parameter|parameters)\b[^>]*>/gi,
  /<\|[^>\n]*(?:tool|function|invoke)[^>\n]*\|>/gi,
  /^\s*\[\/?(?:tool[_ -]?calls?|function[_ -]?calls?|invoke)\]\s*$/gim,
]

const PROTOCOL_INVOCATION_PATTERNS = [
  /<\s*(?:invoke|tool_call|tool-call|function_call|function-call|parameter|parameters)\b[^>]*>/i,
  /<\s*\|\s*\|\s*DSML\s*\|\s*\|\s*(?:invoke|tool_calls?|parameter|parameters)\b[^>]*>/i,
  /<\|[^>\n]*(?:tool|function|invoke)[^>\n]*(?:begin|start|call)[^>\n]*\|>/i,
  /^\s*\[(?:tool[_ -]?calls?|function[_ -]?calls?|invoke)\]\s*$/im,
]

export type RecoveredAgentToolCall = {
  name: string
  arguments: string
}

/** Use CommonMark source positions, not fence regexes: nested lists, indented
 * code, variable fence lengths and incomplete streamed fences remain examples. */
function outputSegments(text: string, protectLinks = false, protectedRanges: readonly { start: number; end: number }[] = []): Array<{ code: boolean; text: string }> {
  if (protectedRanges.length === 0 && !/[`~]/.test(text) && !/^(?: {4}|\t)/m.test(text) && !(protectLinks && /[[<]|https?:\/\//i.test(text))) return [{ code: false, text }]
  type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] }
  const ranges: Array<{ start: number; end: number }> = [...protectedRanges]
  const pending: Node[] = [fromMarkdown(text)]
  while (pending.length) {
    const node = pending.pop()!
    if (node.type === 'code' || node.type === 'inlineCode' || protectLinks && ['link', 'image', 'definition', 'linkReference', 'imageReference'].includes(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset
      if (start !== undefined && end !== undefined) ranges.push({ start, end })
    } else if (node.children) for (const child of node.children) pending.push(child)
  }
  if (protectLinks) for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  if (protectLinks) {
    const escaped = (offset: number) => {
      let slashes = 0
      while (offset > 0 && text[--offset] === '\\') slashes++
      return slashes % 2 === 1
    }
    // Reference labels may become links only after a later definition arrives.
    // Do not translate their contents now and then revert that text on closure.
    for (const match of text.matchAll(/\[[^\]\r\n]*(?:\](?:\[[^\]\r\n]*\]?)?)?/g)) {
      if (!escaped(match.index)) ranges.push({ start: match.index, end: match.index + match[0].length })
    }
    // A pending inline-code opener is still literal text in CommonMark's AST.
    // Preserve its tail while streaming; complete spans/fences are already above.
    for (const match of text.matchAll(/`+/g)) {
      if (!escaped(match.index) && !ranges.some(range => range.start <= match.index && range.end > match.index)) {
        ranges.push({ start: match.index, end: text.length })
        break
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start)
  const segments: Array<{ code: boolean; text: string }> = []
  let cursor = 0
  for (const range of ranges) {
    if (range.end <= cursor) continue
    if (range.start > cursor) segments.push({ code: false, text: text.slice(cursor, range.start) })
    segments.push({ code: true, text: text.slice(Math.max(cursor, range.start), range.end) })
    cursor = range.end
  }
  if (cursor < text.length) segments.push({ code: false, text: text.slice(cursor) })
  return segments
}

/** Human-readable labels belong in prose, never in code or source URLs. */
export function mapAgentVisibleProse(text: string, transform: (prose: string) => string, protectedRanges: readonly { start: number; end: number }[] = []): string {
  return outputSegments(text, true, protectedRanges).map(segment => segment.code ? segment.text : transform(segment.text)).join('')
}

function decodeProtocolEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function parseProtocolScalar(raw: string, forceString: boolean): unknown {
  const value = decodeProtocolEntities(raw.trim())
  if (forceString) return value
  if (!value) return ''
  try {
    return JSON.parse(value)
  } catch {
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
    if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true'
    if (/^null$/i.test(value)) return null
    return value
  }
}

/**
 * 部分 OpenAI 兼容供应商会把原生 function call 降级成 DSML/XML 文本。
 * 这里只恢复结构完整、参数名明确的调用；残缺协议仍交给循环重试，绝不把文本视为已执行。
 */
export function recoverAgentProtocolToolCalls(text: string): RecoveredAgentToolCall[] {
  const calls: RecoveredAgentToolCall[] = []
  for (const segment of outputSegments(text)) {
    if (!segment.code) calls.push(...recoverProtocolSegment(segment.text).slice(0, 8 - calls.length))
    if (calls.length === 8) break
  }
  return calls
}

function recoverProtocolSegment(text: string): RecoveredAgentToolCall[] {
  const calls: RecoveredAgentToolCall[] = []
  const invokePattern = /<\s*(?:\|\s*\|\s*DSML\s*\|\s*\|\s*)?invoke\b([^>]*)>([\s\S]*?)<\s*\/\s*(?:\|\s*\|\s*DSML\s*\|\s*\|\s*)?invoke\s*>/gi
  let invocation: RegExpExecArray | null
  while ((invocation = invokePattern.exec(text)) && calls.length < 8) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(invocation[1])?.[1]?.trim()
    if (!name || !/^[a-z][a-z0-9_]{1,63}$/i.test(name)) continue
    const args: Record<string, unknown> = {}
    const parameterPattern = /<\s*(?:\|\s*\|\s*DSML\s*\|\s*\|\s*)?parameter\b([^>]*)>([\s\S]*?)<\s*\/\s*(?:\|\s*\|\s*DSML\s*\|\s*\|\s*)?parameter\s*>/gi
    let parameter: RegExpExecArray | null
    while ((parameter = parameterPattern.exec(invocation[2]))) {
      const parameterName = /\bname\s*=\s*["']([^"']+)["']/i.exec(parameter[1])?.[1]?.trim()
      if (!parameterName || !/^[a-z][a-z0-9_]{0,63}$/i.test(parameterName)) continue
      const forceString = /\bstring\s*=\s*["']true["']/i.test(parameter[1])
      args[parameterName] = parseProtocolScalar(parameter[2], forceString)
    }
    calls.push({ name, arguments: JSON.stringify(args) })
  }
  return calls
}

export function containsAgentProtocolArtifact(text: string): boolean {
  return outputSegments(text).some(segment => !segment.code && containsProtocolSegment(segment.text))
}

function containsProtocolSegment(text: string): boolean {
  return PROTOCOL_BLOCK_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  }) || PROTOCOL_TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/**
 * 判断正文是否在尝试发起工具调用，而不把孤立的关闭标签当成重试依据。
 * 例如供应商偶发附加的 `</invoke>` 只需清洗；若因此重跑工具，反而可能重复写入。
 */
export function containsAgentProtocolInvocation(text: string): boolean {
  return outputSegments(text).some(segment => !segment.code && (
    PROTOCOL_INVOCATION_PATTERNS.some(pattern => pattern.test(segment.text)) ||
    /^[\t ]*(?:历史工具记录[\t ]*[（(](?:success|failed|running)[）)]\s*[：:]|\[调用\s*(?:工具|tool))/im.test(segment.text)
  ))
}

/** Remove only generated receipt-shaped prose, never quoted code or author data. */
export function stripAgentHistoryEchoes(text: string): string {
  return outputSegments(text).map(segment => segment.code ? segment.text : segment.text.replace(
    /^[\t ]*(?:历史工具记录[\t ]*[（(](?:success|failed|running)[）)]\s*[：:]|\[调用\s*(?:工具|tool))[^\r\n]*(?:\r?\n|$)/gim, '',
  )).join('').trim()
}

export function stripAgentProtocolArtifacts(text: string): string {
  const segments = outputSegments(text)
  return segments.map((segment, index) => {
    if (segment.code) return segment.text
    let clean = stripProtocolSegment(segment.text)
    if (index === 0) clean = clean.trimStart()
    if (index === segments.length - 1) clean = clean.trimEnd()
    return clean
  }).join('')
}

/** Delimit bare citations before GFM autolinking can absorb adjacent Chinese
 * punctuation/prose. Existing links, literal examples and quoted source stay intact. */
export function normalizeAgentCitationLinks(text: string): string {
  if (!/https?:\/\/[^\s<>"'）】]+[）】][：；，。！？]/u.test(text)) return text
  type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] }
  const containsHtml = (node: Node): boolean => node.type === 'html' || !!node.children?.some(containsHtml)
  const protectedRanges: Array<{ start: number; end: number }> = [...text.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }))
  const stack: Node[] = [fromMarkdown(text)]
  while (stack.length) {
    const node = stack.pop()!
    if (['paragraph', 'heading'].includes(node.type) && containsHtml(node)
      || ['code', 'inlineCode', 'link', 'image', 'linkReference', 'imageReference', 'definition', 'html', 'blockquote'].includes(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset
      if (start !== undefined && end !== undefined) protectedRanges.push({ start, end })
    } else if (node.children) stack.push(...node.children)
  }
  return outputSegments(text, false, protectedRanges).map(segment => segment.code ? segment.text : segment.text.replace(
    /https?:\/\/[^\s<>"'）】]+(?=[）】][：；，。！？])/gu, url => {
      try { const parsed = new URL(url); return parsed.username || parsed.password ? url : `<${url}>` } catch { return url }
    })).join('')
}

function stripProtocolSegment(text: string): string {
  let cleaned = text
  for (const pattern of PROTOCOL_BLOCK_PATTERNS) {
    pattern.lastIndex = 0
    cleaned = cleaned.replace(pattern, '')
  }
  for (const pattern of PROTOCOL_TOKEN_PATTERNS) {
    pattern.lastIndex = 0
    cleaned = cleaned.replace(pattern, '')
  }
  return cleaned
    .replace(/\uFFFD+/g, '')
    .replace(/\n{3,}/g, '\n\n')
}
