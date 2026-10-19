import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as quality from '../../api/lib/agent/humanity-quality.js'
import * as manuscript from '../../api/lib/agent/manuscript-scope.js'
import { continuityChapterProvenance, continuitySourceSegments } from '../../api/lib/agent/continuity-review-context.js'
import { buildStandaloneContinuityContext, saveStandaloneContinuityReport } from '../../api/lib/agent/tools/story-compiler-tools.js'
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
  vi.spyOn(manuscript, 'assertAgentManuscriptCurrent').mockResolvedValue(undefined)
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
    await saveStandaloneContinuityReport(f.ctx, context, { structured: true, findings: [] }, f.db)
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ metadata:
      expect.objectContaining({ independentCheck: 'complete', sourceProvenance: context.sourceProvenance }) }) }))
  })
  it.each(['revision', 'content', 'title', 'order', 'current'] as const)('rejects a saved report after %s changes, including same-revision body changes', async change => {
    const f = fixture(), context = await buildStandaloneContinuityContext(f.ctx, f.chapter.id, f.db)
    if (change === 'revision') f.preceding[0].revision++
    if (change === 'content') f.preceding[0].content += '她回到仓库。'
    if (change === 'title') f.preceding[0].title = '另一段行程'
    if (change === 'order') f.preceding[0].orderIndex = 5
    if (change === 'current') f.chapter.content += '钥匙被收进箱子。'
    await expect(saveStandaloneContinuityReport(f.ctx, context, { structured: true, findings: [] }, f.db))
      .rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
    expect(f.create).not.toHaveBeenCalled()
  })
  it('preserves original protocol2 frozen hashes and reports while excluding them from protocol3 reuse', async () => {
    const f = fixture(), legacy = await buildStandaloneContinuityContext(f.ctx, f.chapter.id, f.db, 2)
    expect(legacy.contextHash).toBe(sha(JSON.stringify({ chapter: f.chapter, preceding: f.preceding, charter: null })))
    const current = await buildStandaloneContinuityContext(f.ctx, f.chapter.id, f.db)
    expect(current.contextHash).not.toBe(legacy.contextHash)
    expect(legacy.criticInput).not.toContain('"scope":"current_and_previous_3"')
    await saveStandaloneContinuityReport(f.ctx, legacy, { structured: true, findings: [] }, f.db, undefined, true, true, undefined, 2)
    expect(f.create.mock.calls[0][0]).not.toHaveProperty('data.metadata.sourceProvenance')
    expect(f.create.mock.calls[0][0]).toMatchObject({ data: { metadata: { standaloneKey:
      sha(JSON.stringify({ protocol: 2, contextHash: legacy.contextHash, focus: '' })) } } })
  })
  it('retains UTF-16 boundaries and empty chapters without making labels into manuscript', () => {
    const chapter = { id: 'c', title: 'current', revision: 1, orderIndex: 3, content: '正文' }
    const preceding = [{ ...chapter, id: 'b', orderIndex: 2, content: '🌙夜色\n原文' }, { ...chapter, id: 'a', orderIndex: 1, content: '' }]
    const provenance = continuityChapterProvenance(chapter, preceding)
    expect(provenance.previous[0]).toMatchObject({ startOffset: 0, endOffset: 0, charCount: 0 })
    expect(provenance.previous[1]).toMatchObject({ startOffset: 2, endOffset: 2 + preceding[0].content.length })
  })
})
