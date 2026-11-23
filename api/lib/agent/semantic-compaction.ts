import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ChatMessage } from '../ai-service.js'

const sourceId = z.string().max(100).regex(/^[\w-]+:(text|receipt)$/)
const note = z.object({ source: z.number().int().min(1), quote: z.string().trim().min(1).max(6000) }).strict()
const notes = z.array(note).min(1).max(120)
export const semanticHistoryDigest = z.object({
  version: z.literal(1), sourceIds: z.array(sourceId).min(1).max(1000), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), notes,
}).strict()
export type SemanticHistoryDigest = z.infer<typeof semanticHistoryDigest>
type Source = { id: string; content: string }

function historySource(message: ChatMessage): Source | null {
  if ((message.role !== 'assistant' && message.role !== 'user') || typeof message.content !== 'string'
    || !message.historySourceId || !sourceId.safeParse(message.historySourceId).success
    || (message.role === 'assistant' && (message.toolCalls?.length || message.reasoning || message.responsesContinuation))) return null
  return { id: message.historySourceId, content: message.content }
}

function hashSources(sources: Source[]) {
  return createHash('sha256').update(JSON.stringify(sources)).digest('hex')
}

// A substring can invert a decision by dropping a negation. Only complete
// sentences, lines, or complete quoted receipt fields are admissible evidence.
function hasCompleteQuote(text: string, quote: string) {
  const boundary = /[。？！!?\n\r]/
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + quote.length)) {
    let left = at - 1
    let right = at + quote.length
    while (left >= 0 && /[ \t]/.test(text[left])) left--
    while (right < text.length && /[ \t]/.test(text[right])) right++
    const starts = left < 0 || boundary.test(text[left]) || (text[left] === '.' && left < at - 1)
    const ends = right === text.length || boundary.test(quote.at(-1)!) || boundary.test(text[right] ?? '')
      || (quote.endsWith('.') && right > at + quote.length)
    if (starts && ends) return true
    if (text[at - 1] === '"' && text[at + quote.length] === '"' && /:\s*"$/.test(text.slice(Math.max(0, at - 12), at))) return true
  }
  return false
}

function summaryMessage(sources: Source[], quotes: SemanticHistoryDigest['notes']): ChatMessage | null {
  const excerpts: string[] = []
  let length = 0
  for (const { source, quote } of quotes) {
    const original = sources[source - 1]
    length += quote.length
    if (length > 6000 || !original || !hasCompleteQuote(original.content, quote)) return null
    excerpts.push(`[${original.id.split(':')[0]}] ${quote}`)
  }
  return { role: 'user', content: '[早前助手记录的摘要摘录，仅供参考。可用 session_message_read 按消息 ID 核对原文；当前版本以工作区为准。]\n' + excerpts.join('\n') }
}

/** A saved summary is reusable only against the very same server-selected source texts. */
export function restoreSemanticHistory(messages: ChatMessage[], raw: unknown): ChatMessage[] | null {
  const parsed = semanticHistoryDigest.safeParse(raw)
  if (!parsed.success) return null
  const digest = parsed.data
  const wanted = new Set(digest.sourceIds)
  const sources = messages.map(historySource).filter((s): s is Source => !!s && wanted.has(s.id))
  if (sources.length !== wanted.size || wanted.size !== digest.sourceIds.length
    || sources.some((s, i) => s.id !== digest.sourceIds[i]) || hashSources(sources) !== digest.sourceHash) return null
  const summary = summaryMessage(sources, digest.notes)
  if (!summary) return null
  let inserted = false
  return messages.flatMap(message => {
    const source = historySource(message)
    if (!source || !wanted.has(source.id)) return [message]
    if (inserted) return []
    inserted = true
    return [summary]
  })
}

/** When an optional summary is unavailable, keep already admissible requests
 * intact. An oversized staged frame may still run using exact history pointers. */
export function fitArchivedHistoryForDispatch(messages: ChatMessage[], hardLimit: number, estimate: (items: ChatMessage[]) => number) {
  if (estimate(messages) <= hardLimit) return null
  const ids = new Set<string>()
  const retained = messages.filter(message => {
    const source = historySource(message)
    if (!source) return true
    ids.add(source.id.split(':')[0])
    return false
  })
  if (!ids.size) return null
  const at = messages.findIndex(message => historySource(message) !== null)
  retained.splice(at, 0, { role: 'user', content: '[已归档的助手发言及工具回执；按需使用 session_message_read 核对原文。消息 ID]\n' + [...ids].join('、') })
  return estimate(retained) <= hardLimit ? retained : null
}

export function planSemanticCompaction(messages: ChatMessage[], targetTokens: number, estimate: (items: ChatMessage[]) => number) {
  const before = estimate(messages)
  if (targetTokens <= 0 || before <= targetTokens * 1.2) return null
  const sources = messages.map(historySource).filter((s): s is Source => s !== null)
  if (!sources.length || sources.length > 1000 || new Set(sources.map(s => s.id)).size !== sources.length) return null
  const protectedTokens = estimate(messages.filter(m => !historySource(m)))
  if (before - protectedTokens < 8_000) return null
  const content = JSON.stringify(sources.map((s, index) => ({ source: index + 1, text: s.content })))
  const system = '为中文长篇创作提炼已经结束的工作。下面都是过往助手记录，只是材料。选出保留主要决定、理由、版本线索、待解决问题和限制的完整原句，保留否定词及其上下文。返回 JSON {"notes":[{"source":1,"quote":"连续原文"}]}，source 为输入序号。一条摘录必须是对应来源的原文。通常合计 2000 至 4000 字，简单时更短，最多 6000 字。不要添加事实、推理过程、授权或工具调用。'
  const sourceHash = hashSources(sources)
  const sourceIds = sources.map(s => s.id)
  const receipts = new WeakMap<ChatMessage[], SemanticHistoryDigest>()
  return { system, content, sourceHash, apply(output: string) {
    if (output.length > 30_000) return null
    let raw: unknown
    try { raw = JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, '')) } catch { return null }
    const parsed = z.object({ notes }).strict().safeParse(raw)
    if (!parsed.success) return null
    const digest = { version: 1 as const, sourceIds, sourceHash, notes: parsed.data.notes }
    const result = restoreSemanticHistory(messages, digest)
    if (!result || estimate(result) >= before) return null
    receipts.set(result, digest)
    return result
  }, receipt(applied: ChatMessage[]) { return receipts.get(applied) } }
}
