import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { activeChapterScope } from '../data/internal.js'
import { readTerminalInheritance } from './terminal-inheritance-chain.js'

type Predecessor = { id: string; revision: number; orderIndex: number; content: string }
export type WritingContinuityReference = {
  version: 1
  targetOrderIndex: number
  predecessor: { chapterId: string; revision: number; orderIndex: number; contentHash: string }
  facts: Array<{ field: string; claim: string; proofHash: string; preserved: boolean;
    sources: Array<{ chapterId: string; revision: number; contentHash: string; start: number; end: number }> }>
}

/** Read the existing authenticated chain once. A reference neither accepts
 * editorial memory proposals nor certifies the target chapter's terminal state. */
export async function readWritingContinuityReference(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string }, targetOrderIndex: number,
  selectedPredecessor?: Predecessor | null): Promise<WritingContinuityReference | null> {
  const predecessor = selectedPredecessor === undefined ? await db.chapter.findFirst({
    where: { authorId: subject.userId, ...activeChapterScope(subject.novelId), orderIndex: { lt: targetOrderIndex } },
    orderBy: [{ orderIndex: 'desc' }, { id: 'asc' }],
    select: { id: true, revision: true, orderIndex: true, content: true },
  }) : selectedPredecessor
  if (!predecessor) return null
  const facts = await readTerminalInheritance(db, subject, predecessor)
  return { version: 1, targetOrderIndex,
    predecessor: { chapterId: predecessor.id, revision: predecessor.revision, orderIndex: predecessor.orderIndex,
      contentHash: createHash('sha256').update(predecessor.content).digest('hex') },
    facts: facts.map(fact => ({ field: fact.field, claim: fact.claim, proofHash: fact.proofHash,
      preserved: Boolean(fact.nodes[0]?.preservation),
      sources: fact.anchors.map(({ chapterId, revision, contentHash, start, end }) => ({ chapterId, revision, contentHash, start, end })) })) }
}

export function renderWritingContinuityReference(reference: WritingContinuityReference | null): string | null {
  if (!reference) return null
  const source = reference.predecessor
  return `[写前承接参考；只对应全书第 ${reference.targetOrderIndex} 章，其他目标须各自读取；不是新授权或本章检查通过证明]
前章：全书第 ${source.orderIndex} 章，chapterId=${source.chapterId}@r${source.revision}，正文SHA256=${source.contentHash}。
${reference.facts.length ? `以下来源事实已按读取时的正文版本和原独立审核继承链核验：\n${reference.facts.map(fact =>
    `- [${fact.field}${fact.preserved ? '/保留继承，当前状态未重新证实' : ''}] ${fact.claim}（来源：${fact.sources.map(anchor => `${anchor.chapterId}@r${anchor.revision}:${anchor.start}-${anchor.end}`).join('、')}）`).join('\n')}`
    : '当前没有可验证的前章事实继承链；人物身体、知识、持有物与关系状态仍未知。按需读取前章及相关更早正文核对，不能用待审核记忆、摘要或计划代替事实。'}
未列出的状态不等于健康、恢复、遗忘或丢失；承接伤残和持有物等持续约束，只有正文证据支持变化时才改变。保留继承的事实仍须结合当前剧情核对，不冒充已经重新证实。来源章节或版本变化后须重新读取；本章实际状态仍由本章正文与原检查合同核验。`
}
