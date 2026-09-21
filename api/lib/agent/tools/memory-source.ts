import { createHash } from 'node:crypto'
import { DataAccessError, prisma } from '../../prisma.js'
import type { ToolContext } from './types.js'

/** Formatting-only fallback. Preserve Latin/number word boundaries and map
 * the unique match back to the untouched source, never hash a rewritten quote. */
function normalizeQuoteLayout(text: string) {
  let value = ''
  const offsets: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/u.test(text[i])) {
      const start = i
      while (i + 1 < text.length && /\s/u.test(text[i + 1])) i++
      if (/[\p{Script=Latin}\p{Number}]/u.test(text[start - 1] ?? '') && /[\p{Script=Latin}\p{Number}]/u.test(text[i + 1] ?? '')) {
        value += ' '; offsets.push(start)
      }
    } else { value += text[i]; offsets.push(i) }
  }
  return { value, offsets }
}

function locateQuote(content: string, quote: string): { start: number; end: number } | null {
  const exact = content.indexOf(quote)
  if (exact >= 0) return { start: exact, end: exact + quote.length }
  const needle = normalizeQuoteLayout(quote).value
  if (!needle) return null
  const source = normalizeQuoteLayout(content)
  const start = source.value.indexOf(needle)
  if (start < 0 || source.value.indexOf(needle, start + 1) >= 0) return null
  return { start: source.offsets[start], end: source.offsets[start + needle.length - 1] + 1 }
}

/** A run is not an author message. Never label generated text as author input. */
export async function resolveMemorySource(ctx: ToolContext, args: { sourceChapterId?: string; revision?: number; sourceQuote?: string }) {
  ctx.signal.throwIfAborted()
  if (!args.sourceChapterId) {
    if (args.revision !== undefined || args.sourceQuote) throw new DataAccessError(400, 'MEMORY_SOURCE_REQUIRED', '原文依据必须同时指定真实来源章节。sourceQuote仅接受章节逐字原文，不接受规划、概述或模型生成引用；当前引用未核验，未写入记忆。无来源的独立规划候选与章节事实不同，不应伪造章节依据。')
    return { sourceType: 'artifact' as const, sourceId: ctx.runId, confidence: 0.5 }
  }
  const chapter = await (ctx.transaction ?? prisma).chapter.findFirst({
    where: { id: args.sourceChapterId, novelId: ctx.novelId, authorId: ctx.userId },
    select: { id: true, revision: true, content: true },
  })
  if (!chapter || (args.revision !== undefined && chapter.revision !== args.revision)) {
    throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '来源章节不存在或版本已变化，请重新读取，未写入记忆。')
  }
  const quote = args.sourceQuote?.trim()
  const span = quote ? locateQuote(chapter.content, quote) : null
  if (quote && !span) throw new DataAccessError(409, 'MEMORY_EVIDENCE_MISMATCH', '记忆依据与当前章节原文不符或无法唯一定位，请读取当前章节并使用连续原文，未写入记忆。')
  return { sourceType: 'chapter' as const, sourceId: chapter.id, revision: chapter.revision, confidence: 0.8,
    ...(span ? { span: { ...span, quoteHash: createHash('sha256').update(chapter.content.slice(span.start, span.end)).digest('hex') } } : {}) }
}
