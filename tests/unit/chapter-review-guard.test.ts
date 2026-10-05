import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as original from '../../api/lib/agent/original-request.js'
import * as lock from '../../api/lib/data/novel-write-lock.js'
import { assertChapterReviewRevision } from '../../api/lib/agent/chapter-review-guard.js'

afterEach(() => vi.restoreAllMocks())
describe('review driven manuscript mutation admission', () => {
  function fixture(prompt: string, validation: Record<string, unknown> | null, reports: Array<{ chapterRevision: number }> = []) {
    vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ prompt, spec: null, taskId: 'task', sourceRunId: 'original-run', parentRunId: null })
    vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['original-run', 'resumed-run'])
    const db = { storyCompilation: { findMany: vi.fn().mockResolvedValue(validation ? [{ validation }] : []) },
      chapterQualityReport: { findMany: vi.fn().mockResolvedValue(reports) } } as unknown as Prisma.TransactionClient
    return { db, subject: { userId: 'u', novelId: 'n', runId: 'resumed-run' }, chapter: { id: 'c', revision: 4 } }
  }
  it.each([null, {}])('allows a first draft without an assessment: %s', async validation => {
    const f = fixture('写下一章', validation)
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).resolves.toBeUndefined()
  })
  it.each([
    { checkedRevision: 4, checkRounds: 1, independentCheck: 'complete', errorCount: 0, warningCount: 6 },
    { checkedRevision: 3, checkRounds: 2, independentCheck: 'complete', errorCount: 1 },
    { checkRounds: 1, independentCheck: 'unavailable' },
  ])('a warning, stale error or failed attempt adds no repair authority: %j', async validation => {
    const f = fixture('写下一章', validation)
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
  })
  it.each(['写下一章', '检查并修复当前章'])('exhaustion stops mutation even with an original repair request: %s', async prompt => {
    const f = fixture(prompt, { checkRounds: 3, checkedRevision: 3, errorCount: 1 })
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
  })
  it.each(['continuity', 'quality'])('allows one explicitly authorized atomic revision, then blocks reuse of old %s evidence', async kind => {
    const f = fixture('检查并修复当前章', kind === 'continuity' ? { checkRounds: 1, checkedRevision: 4 } : null,
      kind === 'quality' ? [{ chapterRevision: 4 }] : [])
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).resolves.toBeUndefined()
    f.chapter.revision++
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
    expect(f.db.storyCompilation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original-run', 'resumed-run'] }, chapterId: 'c', userId: 'u', novelId: 'n' }) }))
    expect(f.db.chapterQualityReport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original-run', 'resumed-run'] } }) }))
  })
  it.each(['parent', 'child'])('inherits continuity evidence across the original %s lineage without collecting unrelated work', async direction => {
    const f = fixture('写下一章', null)
    f.subject.runId = direction === 'parent' ? 'original-run' : 'child-run'
    vi.mocked(original.originalTaskRunIds).mockResolvedValue(['original-run', 'child-run'])
    vi.mocked(f.db.storyCompilation.findMany).mockImplementation(async args => {
      const ids = (args?.where?.runId as { in: string[] }).in
      const evidenceRun = direction === 'parent' ? 'child-run' : 'original-run'
      return ids.includes(evidenceRun) ? [{ validation: { checkedRevision: 4, checkRounds: 1, warningCount: 6 } }] as never : []
    })
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(f.db.storyCompilation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      runId: { in: ['original-run', 'child-run'] }, userId: 'u', novelId: 'n', chapterId: 'c',
    }) }))
  })
  it('repreparing cannot hide the old checked revision that already drove one patch', async () => {
    const f = fixture('检查并修复当前章', null)
    f.chapter.revision = 5
    vi.mocked(f.db.storyCompilation.findMany).mockImplementation(async args => [
      ...(!args?.where?.status ? [{ validation: { checkedRevision: 4, checkRounds: 1 } }] : []),
      { validation: { checkRounds: 1 } },
    ] as never)
    await expect(assertChapterReviewRevision(f.db, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
  })
})
