import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { readGoalSavedProgress } from '../../api/lib/agent/goal-saved-progress.js'

const goal = { id: 'goal', userId: 'owner', novelId: 'novel', currentRevision: 2 }
function fixture() {
  const chapter = { id: 'chapter', authorId: 'owner', novelId: 'novel', archivedAt: null, title: '第一章', revision: 3, content: '已保存的正文' }
  const compilation = { id: 'compile', runId: 'old-run', chapterId: 'chapter', chapter, bridge: { toChapterId: 'chapter', targetRevision: 3 } }
  const queries = {
    agentGoalExecution: { findMany: vi.fn().mockResolvedValue([{ runId: 'old-run', goalRevision: 1 }]) },
    storyCompilation: { findMany: vi.fn().mockResolvedValue([compilation]) },
    agentArtifact: { findMany: vi.fn().mockResolvedValue([{ id: 'plan', runId: 'old-run', artifactType: 'chapterPlan', title: '保存大纲', content: '保存计划', metadata: { savedAsPlan: true } }]) },
    novelImportJob: { findMany: vi.fn().mockResolvedValue([{ id: 'import', agentRunId: 'old-run', commit: { jobId: 'import' } }]) },
    agentGoalEvidence: { findMany: vi.fn().mockResolvedValue([{ revision: 1, targetId: 'cover' }]) },
    novel: { findFirst: vi.fn().mockResolvedValue({ coverAssetId: 'cover' }) },
  }
  return { queries, chapter, compilation, tx: queries as unknown as Prisma.TransactionClient }
}

describe('prior goal revision saved result navigation', () => {
  it('reads owned prior objects with fresh revisions while keeping old task authority and completion facts out of the result', async () => {
    const { queries, tx } = fixture()
    const result = await readGoalSavedProgress(tx, goal)
    expect(result).toMatchObject({ completionCredit: false, truncated: false, entries: [
      { kind: 'chapter', id: 'chapter', sourceRevision: 1, runId: 'old-run', verification: 'current', currentRevision: 3, committedRevision: 3, requiresRevalidation: true },
      { kind: 'plan', id: 'plan', sourceRevision: 1, verification: 'current', requiresRevalidation: true },
      { kind: 'import', id: 'import', sourceRevision: 1, verification: 'historical_commit', requiresRevalidation: true },
      { kind: 'cover', id: 'cover', sourceRevision: 1, verification: 'current', requiresRevalidation: true },
    ] })
    expect(JSON.stringify(result)).not.toContain('已保存的正文')
    expect(JSON.stringify(result)).not.toContain('保存计划')
    expect(result).not.toHaveProperty('taskSpec')
    expect(result).not.toHaveProperty('progressHash')
    expect(result.entries[0].provenanceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.entries[0]).not.toHaveProperty('contentHash')
    expect(queries.agentGoalExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      goalId: 'goal', goalRevision: { lt: 2 }, goal: { userId: 'owner', novelId: 'novel' }, run: { userId: 'owner', novelId: 'novel' },
    }, take: 21 }))
    expect(queries.storyCompilation.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'owner', novelId: 'novel', runId: { in: ['old-run'] } })
    expect(queries.agentArtifact.findMany.mock.calls[0][0].where).toMatchObject({ runId: { in: ['old-run'] }, run: { userId: 'owner', novelId: 'novel' } })
    expect(queries.novel.findFirst).toHaveBeenCalledWith({ where: { id: 'novel', authorId: 'owner' }, select: { coverAssetId: true } })
  })

  it('distinguishes changed, archived, removed and foreign chapter targets without exposing foreign content', async () => {
    const { queries, tx, compilation, chapter } = fixture()
    queries.storyCompilation.findMany.mockResolvedValue([
      { ...compilation, chapter: { ...chapter, revision: 4 } },
      { ...compilation, id: 'archived', chapterId: 'archived', chapter: { ...chapter, id: 'archived', archivedAt: new Date() } },
      { ...compilation, id: 'removed', chapterId: null, chapter: null },
      { ...compilation, id: 'foreign', chapterId: 'foreign', chapter: { ...chapter, id: 'foreign', authorId: 'another', content: 'private-other-content', title: 'private-other-title' } },
    ])
    queries.agentArtifact.findMany.mockResolvedValue([{ id: 'plan', runId: 'old-run', artifactType: 'chapterPlan', title: '旧计划', content: '正文', metadata: { savedAsPlan: false } }])
    queries.novel.findFirst.mockResolvedValue({ coverAssetId: 'new-cover' })
    const result = await readGoalSavedProgress(tx, goal)
    expect(result.entries.filter(item => item.kind === 'chapter').map(item => item.verification)).toEqual(['changed', 'unavailable', 'unavailable', 'unavailable'])
    expect(result.entries.find(item => item.kind === 'plan')?.verification).toBe('unavailable')
    expect(result.entries.find(item => item.kind === 'cover')?.verification).toBe('changed')
    expect(JSON.stringify(result)).not.toContain('private-other')
  })

  it('bounds every query, reports truncated history, and rejects objects outside the selected prior runs', async () => {
    const { queries, tx, compilation } = fixture()
    queries.agentGoalExecution.findMany.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ runId: `run-${index}`, goalRevision: 1 })))
    queries.storyCompilation.findMany.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ ...compilation, id: `compile-${index}`, runId: 'run-0' })))
    queries.agentArtifact.findMany.mockResolvedValue([{ id: 'unowned', runId: 'other-run', artifactType: 'researchReport', title: '私密', content: '不属于目标', metadata: null }])
    const result = await readGoalSavedProgress(tx, goal)
    expect(result.truncated).toBe(true)
    expect(result.entries.filter(item => item.kind === 'chapter')).toHaveLength(20)
    expect(result.entries.some(item => item.id === 'unowned')).toBe(false)
    for (const query of [queries.storyCompilation.findMany, queries.agentArtifact.findMany, queries.novelImportJob.findMany, queries.agentGoalEvidence.findMany]) {
      expect(query.mock.calls[0][0].take).toBe(21)
    }
    expect(queries.storyCompilation.findMany.mock.calls[0][0].where.runId.in).toHaveLength(20)
  })

  it('does not read prior authority for an initial revision or return provenance for an inaccessible novel', async () => {
    const { queries, tx } = fixture()
    expect(await readGoalSavedProgress(tx, { ...goal, currentRevision: 1 })).toEqual({ completionCredit: false, entries: [], truncated: false })
    expect(queries.agentGoalExecution.findMany).not.toHaveBeenCalled()
    queries.novel.findFirst.mockResolvedValue(null)
    expect(await readGoalSavedProgress(tx, goal)).toEqual({ completionCredit: false, entries: [], truncated: false })
  })

  it('returns no saved objects for an edited goal with no prior executions or receipts', async () => {
    const { queries, tx } = fixture()
    queries.agentGoalExecution.findMany.mockResolvedValue([])
    queries.storyCompilation.findMany.mockResolvedValue([])
    queries.agentArtifact.findMany.mockResolvedValue([])
    queries.novelImportJob.findMany.mockResolvedValue([])
    queries.agentGoalEvidence.findMany.mockResolvedValue([])
    expect(await readGoalSavedProgress(tx, goal)).toEqual({ completionCredit: false, entries: [], truncated: false })
    expect(queries.storyCompilation.findMany.mock.calls[0][0].where.runId.in).toEqual([])
  })
})
