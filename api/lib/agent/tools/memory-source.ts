import { createHash } from 'node:crypto'
import { DataAccessError, prisma } from '../../prisma.js'
import type { ToolContext } from './types.js'

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
  const start = quote ? chapter.content.indexOf(quote) : -1
  if (quote && start < 0) throw new DataAccessError(409, 'MEMORY_EVIDENCE_MISMATCH', '记忆依据与当前章节原文不符，未写入记忆。')
  return { sourceType: 'chapter' as const, sourceId: chapter.id, revision: chapter.revision, confidence: 0.8,
    ...(quote ? { span: { start, end: start + quote.length, quoteHash: createHash('sha256').update(quote).digest('hex') } } : {}) }
}
