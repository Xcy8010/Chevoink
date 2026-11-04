import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
vi.mock('../../api/lib/agent/terminal-inheritance-chain.js', () => ({ readTerminalInheritance: vi.fn(async () => []) }))
import { readTerminalInheritance } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { readWritingContinuityReference, renderWritingContinuityReference } from '../../api/lib/agent/writing-continuity-reference.js'
import { activeChapterScope } from '../../api/lib/data/internal.js'

const subject = { userId: 'author', novelId: 'novel' }
const predecessor = { id: 'chapter-8', revision: 3, orderIndex: 8, content: '人物仍然拄拐。' }
const chapterRead = vi.fn()
const db = { chapter: { findFirst: chapterRead } } as unknown as Prisma.TransactionClient

beforeEach(() => { vi.clearAllMocks(); chapterRead.mockResolvedValue(predecessor); vi.mocked(readTerminalInheritance).mockResolvedValue([]) })

describe('writing predecessor reference', () => {
  it('selects only the author novel active predecessor, never a future or foreign chapter', async () => {
    await readWritingContinuityReference(db, subject, 9)
    expect(chapterRead).toHaveBeenCalledWith({
      where: { authorId: 'author', ...activeChapterScope('novel'), orderIndex: { lt: 9 } },
      orderBy: [{ orderIndex: 'desc' }, { id: 'asc' }],
      select: { id: true, revision: true, orderIndex: true, content: true },
    })
    expect(readTerminalInheritance).toHaveBeenCalledExactlyOnceWith(db, subject, predecessor)
  })

  it('does not fabricate a state for a first chapter or read another novel as fallback', async () => {
    chapterRead.mockResolvedValue(null)
    expect(await readWritingContinuityReference(db, subject, 1)).toBeNull()
    expect(renderWritingContinuityReference(null)).toBeNull()
    expect(readTerminalInheritance).not.toHaveBeenCalled()
    expect(chapterRead).toHaveBeenCalledTimes(1)
  })

  it('reuses an already selected scoped predecessor without a second lookup and keeps absent evidence unknown', async () => {
    const reference = await readWritingContinuityReference(db, subject, 9, predecessor)
    expect(chapterRead).not.toHaveBeenCalled()
    expect(reference?.facts).toEqual([])
    expect(renderWritingContinuityReference(reference)).toContain('不能用待审核记忆、摘要或计划代替事实')
    expect(renderWritingContinuityReference(reference)).toContain('不等于健康、恢复、遗忘或丢失')
    expect(Object.keys(db)).toEqual(['chapter'])
  })

  it('renders preserved canonical facts with their uncertainty and re-reads evidence on the next invocation', async () => {
    const fact = { field: 'body', claim: '人物仍然拄拐', proofHash: 'a'.repeat(64),
      anchors: [{ chapterId: 'chapter-4', revision: 2, contentHash: 'b'.repeat(64), start: 10, end: 17, quote: '人物仍然拄拐' }],
      nodes: [{ preservation: { version: 1 } }] }
    vi.mocked(readTerminalInheritance).mockResolvedValueOnce([fact] as never)
    const before = JSON.stringify(fact)
    const reference = await readWritingContinuityReference(db, subject, 9)
    expect(reference?.facts[0]).toMatchObject({ field: 'body', preserved: true, sources: [{ chapterId: 'chapter-4', revision: 2, start: 10, end: 17 }] })
    expect(renderWritingContinuityReference(reference)).toContain('[body/保留继承，当前状态未重新证实] 人物仍然拄拐')
    expect(JSON.stringify(fact)).toBe(before)
    const invalidated = await readWritingContinuityReference(db, subject, 9)
    expect(invalidated?.facts).toEqual([])
    expect(readTerminalInheritance).toHaveBeenCalledTimes(2)
  })
})
