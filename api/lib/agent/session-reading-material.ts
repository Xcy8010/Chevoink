import { createHash } from 'node:crypto'
import type { AgentMessagePart } from '../../../shared/contracts/index.js'
import type { ChatMessage } from '../ai-service.js'
import { activeChapterScope } from '../data/internal.js'
import { prisma } from '../prisma.js'
import { estimateChatMessageTokens, estimateTextTokens } from './context-budget.js'

type Range = { start: number; end: number }
type Reading = { kind: 'chapter'; id: string; revision: number; range: Range }
  | { kind: 'plan'; id: string; hash: string; range: Range }
  | { kind: 'saved-plan'; id: string; content: string }
  | { kind: 'plan-preview'; id: string; offset: number; preview: string }

function collectReadings(parts: readonly AgentMessagePart[], allowedReads: readonly string[]) {
  const readings: Reading[] = []
  for (const part of parts) {
    if (part.type !== 'tool-call' || part.status !== 'success' || part.subagentCallId) continue
    const display = part.display
    if (part.toolName === 'chapter_read' && allowedReads.includes('chapter_read') && display?.kind === 'chapterRef'
      && !display.archiveOnly && display.range && display.revision !== undefined) {
      readings.push({ kind: 'chapter', id: display.chapterId, revision: display.revision, range: display.range })
    }
    if (!allowedReads.includes('plan_read')) continue
    if (part.toolName === 'plan_save' && (display?.kind === 'planFile' || display?.kind === 'planDiff')) {
      readings.push({ kind: 'saved-plan', id: display.artifactId, content: display.kind === 'planFile' ? display.content : display.after })
    }
    if (part.toolName === 'plan_read' && display?.kind === 'readSources') {
      for (const item of display.items) {
        if (item.target?.kind !== 'plan') continue
        if (item.readingRange) {
          readings.push({ kind: 'plan', id: item.target.id, hash: item.readingRange.contentHash, range: item.readingRange })
        } else if (item.readingRange === undefined && item.preview) {
          const offset = part.args && typeof part.args === 'object' && 'offset' in part.args ? part.args.offset : 0
          if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) {
            const preview = item.preview.length === 121 && item.preview.endsWith('…') ? item.preview.slice(0, -1) : item.preview
            readings.push({ kind: 'plan-preview', id: item.target.id, offset, preview })
          }
        }
      }
    }
  }
  return readings
}

function mergeRanges(ranges: Range[], length: number) {
  const merged: Range[] = []
  for (const { start, end } of ranges.sort((a, b) => a.start - b.start)) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > length || start >= end) continue
    const last = merged.at(-1)
    if (last && last.end >= start) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  return merged
}

// Each UTF-16 code unit costs at most one estimated token. Start with a
// guaranteed fit, then spend the unused budget on more of the same excerpt.
function fitExcerpt(content: string, range: Range, budget: number) {
  let end = range.start
  while (budget > 0 && end < range.end) {
    let next = Math.min(end + budget, range.end)
    if (next < range.end && /[\uD800-\uDBFF]/.test(content[next - 1]) && /[\uDC00-\uDFFF]/.test(content[next])) next++
    budget -= estimateTextTokens(content.slice(end, next))
    end = next
  }
  return end
}

export async function readSessionReadingMaterial(input: {
  userId: string; novelId: string; parts: readonly AgentMessagePart[]; allowedReads: readonly string[]; tokenBudget: number
}): Promise<ChatMessage[]> {
  let remaining = input.tokenBudget
  if (remaining <= 0) return []
  const readings = collectReadings(input.parts, input.allowedReads)
  // Select newer objects first when the remaining request budget is tight.
  const objects = new Map<string, Reading[]>()
  for (const reading of readings.reverse()) {
    const key = (reading.kind === 'chapter' ? 'chapter:' : 'plan:') + reading.id
    const entries = objects.get(key)
    if (entries) entries.push(reading)
    else objects.set(key, [reading])
  }
  const pending = [...objects.values()]
  const groups: ChatMessage[][] = []
  // Load small batches so a full window never fetches all older manuscripts.
  for (let i = 0; i < pending.length && remaining > 0; i += 12) {
    const batch = pending.slice(i, i + 12)
    const chapters = batch.filter(([reading]) => reading.kind === 'chapter').map(([reading]) => reading.id)
    const plans = batch.filter(([reading]) => reading.kind !== 'chapter').map(([reading]) => reading.id)
    const [chapterRows, planRows] = await Promise.all([
      chapters.length ? prisma.chapter.findMany({
        where: { ...activeChapterScope(input.novelId), authorId: input.userId, id: { in: chapters } },
        select: { id: true, title: true, revision: true, content: true },
      }) : [],
      plans.length ? prisma.agentArtifact.findMany({
        where: { artifactType: 'chapterPlan', metadata: { path: ['savedAsPlan'], equals: true },
          run: { novelId: input.novelId, userId: input.userId }, id: { in: plans } },
        select: { id: true, title: true, content: true },
      }) : [],
    ])
    for (const entries of batch) {
      const first = entries[0]
      const row = first.kind === 'chapter' ? chapterRows.find(chapter => chapter.id === first.id) : planRows.find(plan => plan.id === first.id)
      if (!row) continue
      const ranges: Range[] = []
      let hash: string | undefined
      for (const reading of entries) {
        if (reading.kind === 'chapter' && 'revision' in row && row.revision === reading.revision) ranges.push(reading.range)
        if (reading.kind === 'plan') {
          hash ??= createHash('sha256').update(row.content).digest('hex')
          if (hash === reading.hash) ranges.push(reading.range)
        }
        if (reading.kind === 'saved-plan' && row.content === reading.content) ranges.push({ start: 0, end: row.content.length })
        if (reading.kind === 'plan-preview' && row.content.startsWith(reading.preview, reading.offset)) {
          ranges.push({ start: reading.offset, end: reading.offset + reading.preview.length })
        }
      }
      const messages: ChatMessage[] = []
      for (const range of mergeRanges(ranges, row.content.length)) {
        const heading = (end: number) => `[会话已核对的${first.kind === 'chapter' ? '章节' : '计划'}节选，仅供阅读参考；本轮写入须按当前请求核验] 《${row.title}》 id=${row.id} [${range.start},${end})\n`
        const available = remaining - estimateChatMessageTokens({ role: 'user', content: heading(range.end) })
        if (available < 1) break
        const end = fitExcerpt(row.content, range, available)
        const message = { role: 'user' as const, content: heading(end) + row.content.slice(range.start, end), sessionReadingMaterial: true as const }
        messages.push(message)
        remaining -= estimateChatMessageTokens(message)
      }
      if (messages.length) groups.push(messages)
    }
  }
  return groups.reverse().flat()
}
