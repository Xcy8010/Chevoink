import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as quality from '../../api/lib/agent/humanity-quality.js'
import { continuityChapterProvenance, continuitySourceSegments } from '../../api/lib/agent/continuity-review-context.js'
import { readHistoricalStandaloneContinuityContext as buildStandaloneContinuityContext, readHistoricalStandaloneContinuityReport } from '../../api/lib/agent/continuity-history.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(() => vi.restoreAllMocks())
function fixture() {
  const chapter = { id: 'c4', title: '归还', revision: 7, orderIndex: 4, content: '她把钥匙交还船夫。' }
  const preceding = [
    { id: 'c3', title: '渡口', revision: 4, orderIndex: 3, content: '她在渡口等船。' },
    { id: 'c2', title: '借物', revision: 3, orderIndex: 2, content: '船夫借给她钥匙。' },
    { id: 'c1', title: '启程', revision: 2, orderIndex: 1, content: '她离开旧仓库。' },
  ]
  const create = vi.fn(async (_query: unknown) => ({ id: 'artifact' }))
  const db = { $queryRaw: vi.fn(async () => [{ id: chapter.id }]), chapter: {
    findFirst: vi.fn(async () => structuredClone(chapter)), findMany: vi.fn(async () => structuredClone(preceding)),
  }, storyCharter: { findUnique: vi.fn(async () => null) }, agentArtifact: { findFirst: vi.fn(async () => null), create } } as unknown as Prisma.TransactionClient
  vi.spyOn(quality, 'resolveQualityChapterTarget').mockResolvedValue(chapter.id)
  const ctx = { userId: 'u', novelId: 'n', runId: 'r', signal: new AbortController().signal } as ToolContext
  return { chapter, preceding, create, db, ctx }
}

describe('bounded standalone continuity provenance', () => {
  it('addresses each prior chapter in the exact evidence body, retaining chronological and revision identity', async () => {
    const f = fixture(), context = await buildStandaloneContinuityContext(f.ctx, f.chapter.id, f.db)
    expect(f.db.chapter.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3,
      select: { id: true, title: true, revision: true, content: true, orderIndex: true } }))
    expect(context.sourceProvenance.scope).toBe('current_and_previous_3')
    expect(context.sourceProvenance.previous.map(row => row.chapterId)).toEqual(['c1', 'c2', 'c3'])
    for (const row of context.sourceProvenance.previous) {
      const original = f.preceding.find(chapter => chapter.id === row.chapterId)!
      expect(context.precedingBodies.slice(row.startOffset, row.endOffset)).toBe(original.content)
      expect(row).toMatchObject({ title: original.title, revision: original.revision, orderIndex: original.orderIndex,
        charCount: original.content.length, contentHash: sha(original.content) })
      expect(context.criticInput).toContain(JSON.stringify(row))
    }
    expect(context.sourceProvenance.current).toMatchObject({ chapterId: 'c4', revision: 7, contentHash: sha(f.chapter.content) })
    expect(continuitySourceSegments({ previous: context.precedingBodies, current: f.chapter.content })
      .filter(row => row.source === 'previous').map(row => row.quote).join('')).toBe(context.precedingBodies)
    const artifact = { id: 'original', metadata: { independentCheck: 'complete', findings: [], sourceProvenance: context.sourceProvenance } }
    vi.mocked(f.db.agentArtifact.findFirst).mockResolvedValue(artifact as never)
    expect(await readHistoricalStandaloneContinuityReport(f.ctx, context.contextHash, undefined, f.db)).toMatchObject({ artifact, findings: [] })
    expect(f.create).not.toHaveBeenCalled()
  })
  it.each(['revision', 'content', 'title', 'order', 'current'] as const)('keeps frozen historical context distinct after %s changes, including same-revision body changes', async change => {
    const f = fixture(), context = await buildStandaloneContinuityContext(f.ctx, f.chapter.id, f.db)
    if (change === 'revision') f.preceding[0].revision++
    if (change === 'content') f.preceding[0].content += '她回到仓库。'
    if (change === 'title') f.preceding[0].title = '另一段行程'
    if (change === 'order') f.preceding[0].orderIndex = 5
    if (change === 'current') f.chapter.content += '钥匙被收进箱子。'
    const fresh = await buildStandaloneContinuityContext(f.ctx, f.chapter.id, f.db)
    expect(fresh.contextHash).not.toBe(context.contextHash)
    expect(f.create).not.toHaveBeenCalled()
  })
  it('preserves original protocol2 frozen hashes and reports while excluding them from protocol3 reuse', async () => {
    const f = fixture(), legacy = await buildStandaloneContinuityContext(f.ctx, f.chapter.id, f.db, 2)
    expect(legacy.contextHash).toBe(sha(JSON.stringify({ chapter: f.chapter, preceding: f.preceding, charter: null })))
    const current = await buildStandaloneContinuityContext(f.ctx, f.chapter.id, f.db)
    expect(current.contextHash).not.toBe(legacy.contextHash)
    expect(legacy.criticInput).not.toContain('"scope":"current_and_previous_3"')
    await readHistoricalStandaloneContinuityReport(f.ctx, legacy.contextHash, undefined, f.db, 2)
    expect(f.db.agentArtifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ metadata: { path: ['standaloneKey'], equals:
      sha(JSON.stringify({ protocol: 2, contextHash: legacy.contextHash, focus: '' })) } }) }))
    expect(f.create).not.toHaveBeenCalled()
  })
  it('retains UTF-16 boundaries and empty chapters without making labels into manuscript', () => {
    const chapter = { id: 'c', title: 'current', revision: 1, orderIndex: 3, content: '正文' }
    const preceding = [{ ...chapter, id: 'b', orderIndex: 2, content: '🌙夜色\n原文' }, { ...chapter, id: 'a', orderIndex: 1, content: '' }]
    const provenance = continuityChapterProvenance(chapter, preceding)
    expect(provenance.previous[0]).toMatchObject({ startOffset: 0, endOffset: 0, charCount: 0 })
    expect(provenance.previous[1]).toMatchObject({ startOffset: 2, endOffset: 2 + preceding[0].content.length })
  })
})
