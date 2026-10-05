import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as original from '../../api/lib/agent/original-request.js'
import * as lock from '../../api/lib/data/novel-write-lock.js'
import { assertChapterReviewRevision } from '../../api/lib/agent/chapter-review-guard.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { readNewDraftWritingAuthority, prohibitsNewDraftRevision } from '../../api/lib/agent/writing-scope.js'

afterEach(() => vi.restoreAllMocks())
describe('review driven manuscript mutation admission', () => {
  function fixture(prompt: string, validation: Record<string, unknown> | null, reports: Array<{ chapterRevision: number }> = []) {
    vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ prompt, spec: null, taskId: 'task', sourceRunId: 'original-run', parentRunId: null })
    vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['original-run', 'resumed-run'])
    const db = { $queryRaw: vi.fn().mockResolvedValue([]), chapter: { findFirst: vi.fn().mockResolvedValue(null) },
      storyCompilation: { findMany: vi.fn().mockResolvedValue(validation ? [{ validation }] : []) },
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

describe('one atomic factual correction in the original new draft', () => {
  function fixture(prompt = '写下一章') {
    vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
    const spec = buildTaskSpec({ runId: 'original-run', novelId: 'n', prompt })
    spec.intent = 'write'
    spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 41, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
    const request = { prompt, spec, taskId: spec.id, sourceRunId: 'original-run', parentRunId: null }
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue(request)
    vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['original-run', 'child-run'])
    const chapter = { id: 'new41', title: '合成新章', revision: 3, orderIndex: 41, content: '门先锁着，随后却说从未锁门。' }
    const binding = { version: 1, taskId: spec.id, targets: [{ orderIndex: 41, chapterId: chapter.id }] }
    const bridge = { toChapterId: chapter.id, targetRevision: chapter.revision, fromChapterId: null, sourceRevision: null, committedAt: null }
    const scenes = [{ ordinal: 1, goal: '开门', turn: '发现门锁' }]
    const validation = { checkRounds: 1, autoRepairRounds: 0, checkedChapterId: chapter.id, checkedRevision: chapter.revision,
      independentCheck: 'complete', errorCount: 1, warningCount: 0, findings: [{ signal: 'object', severity: 'error', evidence: '同一扇门锁着却从未锁门', suggestion: '保留门锁事实' }],
      coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks: scenes, source: null }) }
    const compilation = { id: 'compiler', status: 'active', stage: 'check', validation, bridge, sceneTasks: scenes }
    const rows = [compilation]
    const source = { writingBindings: binding }
    const db = { $queryRaw: vi.fn().mockResolvedValue([]), agentRun: { findFirstOrThrow: vi.fn().mockResolvedValue(source) },
      chapter: { findFirst: vi.fn().mockResolvedValue(chapter) }, chapterQualityReport: { findMany: vi.fn().mockResolvedValue([]) },
      storyCompilation: { findMany: vi.fn().mockImplementation(async () => rows), update: vi.fn().mockImplementation(async ({ data }) => { compilation.validation = data.validation; return compilation }) },
    }
    const tx = db as unknown as Prisma.TransactionClient
    const subject = { userId: 'u', novelId: 'n', runId: 'child-run' }
    return { tx, db, subject, chapter, request, spec, binding, source, validation, compilation, rows }
  }
  it('admits one merged correction without changing original authority or counters, consumes after CAS and blocks a fresh recheck', async () => {
    const f = fixture(), frozenSpec = structuredClone(f.spec)
    const consume = await assertChapterReviewRevision(f.tx, f.subject, f.chapter)
    expect(consume).toBeTypeOf('function')
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    await consume?.()
    expect(f.compilation.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0, newDraftRevision: { taskId: f.spec.id, chapterId: 'new41', compilationId: 'compiler', checkedRevision: 3 } })
    f.chapter.revision++
    Object.assign(f.compilation.validation, { checkedRevision: 4, checkRounds: 2 })
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
    expect(f.spec).toEqual(frozenSpec)
  })
  it.each(['parent', 'child', 'reprepare'] as const)('cannot hide consumption with %s execution', async direction => {
    const f = fixture()
    await (await assertChapterReviewRevision(f.tx, f.subject, f.chapter))?.()
    if (direction === 'parent') f.subject.runId = 'original-run'
    if (direction === 'reprepare') {
      f.compilation.status = 'abandoned'
      f.rows.unshift({ ...f.compilation, id: 'new-compiler', status: 'active', validation: f.validation })
    }
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
    expect(f.db.storyCompilation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['original-run', 'child-run'] }, chapterId: 'new41' }) }))
  })
  it.each(['existing', 'missing-binding', 'foreign-binding', 'wrong-slot', 'wrong-novel', 'wrong-intent', 'proposal', 'selection', 'no-frozen-scope',
    'warning', 'stale', 'failed', 'wrong-chapter', 'coverage', 'scenes', 'source', 'committed', 'completed', 'later-failure', 'later-prepare', 'no-body', 'paid-repair-reserved'] as const)(
    'denies %s evidence without consuming a correction', async scenario => {
      const f = fixture()
      if (scenario === 'existing') f.spec.scope.writing!.targets[0].chapterId = f.chapter.id
      if (scenario === 'missing-binding') f.source.writingBindings = null as never
      if (scenario === 'foreign-binding') f.binding.taskId = 'foreign-task'
      if (scenario === 'wrong-slot') f.chapter.orderIndex = 42
      if (scenario === 'wrong-novel') f.spec.scope.novelId = 'foreign-novel'
      if (scenario === 'wrong-intent') f.spec.intent = 'review'
      if (scenario === 'proposal') f.spec.writingPacing = 'proposal_only'
      if (scenario === 'selection') f.spec.scope.selection = { chapterId: f.chapter.id, start: 0, end: 1 }
      if (scenario === 'no-frozen-scope') delete f.spec.scope.writing
      if (scenario === 'warning') { f.validation.errorCount = 0; f.validation.findings[0].severity = 'warning' }
      if (scenario === 'stale') f.validation.checkedRevision--
      if (scenario === 'failed') f.validation.independentCheck = 'unavailable'
      if (scenario === 'wrong-chapter') f.validation.checkedChapterId = 'different'
      if (scenario === 'coverage') f.validation.coverage.contentHash = '0'.repeat(64)
      if (scenario === 'scenes') f.compilation.sceneTasks = []
      if (scenario === 'source') Object.assign(f.compilation.bridge, { fromChapterId: 'source', sourceRevision: 1 })
      if (scenario === 'committed') f.compilation.bridge.committedAt = new Date() as never
      if (scenario === 'completed') f.compilation.status = 'completed'
      if (scenario === 'later-failure') f.rows.unshift({ ...f.compilation, id: 'later', validation: { ...f.validation, independentCheck: 'unavailable' } })
      if (scenario === 'later-prepare') f.rows.unshift({ ...f.compilation, id: 'later', validation: { checkRounds: 1 } as never })
      if (scenario === 'no-body') f.chapter.content = ''
      if (scenario === 'paid-repair-reserved') f.validation.autoRepairRounds = 1
      await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: scenario === 'foreign-binding' ? 'RUNTIME_RECEIPT_INVALID' : 'REPAIR_NOT_AUTHORIZED' })
      expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
    })
  it.each(['写下一章，不要修改正文', 'Write the next chapter. Do not edit the draft.', '写下一章。不要做任何改写',
    '写下一章，不要修改前文和新稿', 'Write the next chapter. Do not edit previous chapters or the draft.', '写下一章，不要修改已有章节及本章正文'])('preserves explicit no-change requests: %s', async prompt => {
    const f = fixture(prompt)
    await expect(assertChapterReviewRevision(f.tx, f.subject, f.chapter)).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(f.db.storyCompilation.update).not.toHaveBeenCalled()
  })
  it('respects frozen hard constraints, while earlier chapter protection does not forbid correction of this new chapter', async () => {
    const f = fixture()
    f.spec.hardConstraints.push({ id: 'keep-draft', kind: 'author_directive', text: '不要修改本章正文' })
    await expect(readNewDraftWritingAuthority(f.tx, f.subject, f.chapter)).resolves.toBeNull()
    expect(prohibitsNewDraftRevision('不要修改前文')).toBe(false)
  })
})
