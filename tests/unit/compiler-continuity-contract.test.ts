import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from '../../api/lib/agent/compiler-continuity-contract.js'
import { commitChapterBridge, isWritingTaskContinuityCompiler, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as manuscript from '../../api/lib/agent/manuscript-scope.js'
import * as memory from '../../api/lib/agent/story-memory.js'

afterEach(() => vi.restoreAllMocks())
const input = () => ({ chapter: { id: 'c', title: '本章', revision: 2, content: '修订后的完整正文', orderIndex: 2 },
  bridge: { fromChapterId: 'source', sourceRevision: 1, location: '城门' }, sceneTasks: [{ ordinal: 1, goal: '寻找钥匙', turn: '发现门已锁' }],
  source: { id: 'source', revision: 1, content: '前章完整正文' } })

describe('compiler continuity report dependencies', () => {
  it.each(['text', 'revision', 'title', 'source', 'bridge', 'scenes', 'focus', 'protocol'] as const)('%s invalidates reuse', change => {
    const before = input(), after = structuredClone(before)
    const coverage = compilerContinuityCoverage(before)
    if (change === 'text') after.chapter.content += '作者新文'
    if (change === 'revision') after.chapter.revision++
    if (change === 'title') after.chapter.title = '新标题'
    if (change === 'source') after.source.content += '作者新文'
    if (change === 'bridge') after.bridge.location = '塔顶'
    if (change === 'scenes') after.sceneTasks[0].goal = '救人'
    if (change === 'protocol') coverage.reviewHash = '0'.repeat(64)
    expect(compilerContinuityCoverageMatches(coverage, compilerContinuityCoverage({ ...after, ...(change === 'focus' ? { focus: '人物知识' } : {}) }))).toBe(false)
  })
  it('bookkeeping does not invalidate a complete review; missing protocol coverage does', () => {
    const value = input(), coverage = compilerContinuityCoverage(value)
    expect(compilerContinuityCoverageMatches(coverage, compilerContinuityCoverage({ ...value,
      bridge: { ...value.bridge, updatedAt: new Date(), createdAt: new Date() }, sceneTasks: value.sceneTasks.map(scene => ({ ...scene, status: 'checked' })) }))).toBe(true)
    expect(compilerContinuityCoverageMatches({ ...coverage, reviewHash: undefined }, coverage)).toBe(false)
    expect(compilerContinuityCoverageMatches({ ...coverage, protocolVersion: undefined }, coverage)).toBe(false)
  })
  it.each(['missing', 'old-protocol', 'wrong-hash'] as const)('current terminal commits while %s optional coverage remains unknown', async scenario => {
    const current = input(), bridge = { ...current.bridge, fromChapterId: null }
    const coverage = compilerContinuityCoverage({ ...current, bridge, source: null })
    const terminalWrite = vi.fn()
    const proposal = vi.spyOn(memory, 'saveStoryMemory').mockResolvedValue({ id: 'memory' } as never)
    const db = { $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?')
      if (sql === 'SELECT id FROM novels WHERE id = ? FOR UPDATE' && values[0] === 'n') return [{ id: 'n' }]
      if (sql === 'SELECT id FROM story_compilations WHERE id = ? AND user_id = ? AND novel_id = ? FOR UPDATE'
        && values[0] === 'comp' && values[1] === 'u' && values[2] === 'n') return [{ id: 'comp' }]
      if (sql === 'SELECT id FROM chapters WHERE id = ? FOR UPDATE' && values[0] === 'c') return [{ id: 'c' }]
      throw new Error(`Unexpected fixture lock: ${sql}`)
    }),
      storyCompilation: { findFirst: vi.fn().mockResolvedValue({ id: 'comp', chapter: current.chapter, bridge, sceneTasks: current.sceneTasks,
        validation: { independentCheck: 'complete', checkedRevision: 2, errorCount: 0,
          ...(scenario === 'missing' ? {} : { coverage: { ...coverage, ...(scenario === 'old-protocol' ? { protocolVersion: 1 } : { reviewHash: '0'.repeat(64) }) } }) } }), update: terminalWrite },
      chapter: { findFirst: vi.fn().mockResolvedValue(current.chapter) }, chapterBridge: { update: terminalWrite }, sceneTask: { updateMany: terminalWrite },
      chapterQualityReport: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as Prisma.TransactionClient
    await expect(commitChapterBridge({ userId: 'u', novelId: 'n', compilationId: 'comp', chapterSummary: '章节摘要',
      exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '转折' }, db)).resolves.toMatchObject({ compilationId: 'comp', chapterId: 'c', chapterRevision: 2 })
    expect(terminalWrite).toHaveBeenCalledTimes(3)
    expect(terminalWrite).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'comp' }, data: expect.objectContaining({ stage: 'commit', status: 'completed' }) }))
    expect(proposal).toHaveBeenCalledWith(expect.objectContaining({ memoryType: 'chapterSummary', content: '章节摘要' }), db)
    for (const [call] of terminalWrite.mock.calls) expect(call.data).not.toHaveProperty('validation')
  })
  it.each(['current', 'stale-body', 'stale-scenes', 'cancelled'] as const)('%s persists only a current compiler CHECK without touching manuscript', async scenario => {
    const frozen = input(), current = structuredClone(frozen)
    const coverage = compilerContinuityCoverage(frozen)
    if (scenario === 'stale-body') current.chapter.content += '新文'
    if (scenario === 'stale-scenes') current.sceneTasks[0].goal = '不同目标'
    const update = vi.fn(), chapterWrite = vi.fn()
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'n' }]),
      storyCompilation: { findFirst: vi.fn().mockResolvedValue({ id: 'comp', targetOrderIndex: 2, ...current }), update },
      chapter: { findFirst: vi.fn().mockImplementation(async ({ where, select }) => where.id === 'source' ? select.title ? { revision: current.source.revision, title: '前章' } : current.source : { id: 'c' }), update: chapterWrite },
    } as unknown as Prisma.TransactionClient
    const work = validateStoryContinuity({ userId: 'u', novelId: 'n', compilationId: 'comp', findings: [], expectedChapterRevision: 2,
      independentCheck: 'complete', coverage, signal: scenario === 'cancelled' ? AbortSignal.abort() : new AbortController().signal }, db)
    if (scenario === 'current') {
      await expect(work).resolves.toMatchObject({ checkedRevision: 2, independentCheck: 'complete', errorCount: 0 })
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'comp' }, data: expect.objectContaining({ stage: 'check', validation: expect.objectContaining({ coverage }) }) }))
    } else {
      if (scenario === 'cancelled') await expect(work).rejects.toBeDefined()
      else await expect(work).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
      expect(update).not.toHaveBeenCalled()
    }
    expect(chapterWrite).not.toHaveBeenCalled()
  })
  it('a fresh complete CHECK preserves the consumed new-draft correction marker and the check/paid repair counters', async () => {
    const current = input()
    const marker = { version: 1, taskId: 'task', chapterId: 'c', compilationId: 'comp', checkedRevision: 1 }
    const update = vi.fn()
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'n' }]), storyCompilation: { findFirst: vi.fn().mockResolvedValue({ id: 'comp', ...current,
      validation: { checkRounds: 2, autoRepairRounds: 1, newDraftRevision: marker } }), update },
      chapter: { findFirst: vi.fn().mockImplementation(async ({ where }) => where.id === 'source' ? current.source : { id: 'c' }) },
    } as unknown as Prisma.TransactionClient
    await validateStoryContinuity({ userId: 'u', novelId: 'n', compilationId: 'comp', expectedChapterRevision: 2, independentCheck: 'complete', findings: [] }, db)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ validation: expect.objectContaining({ newDraftRevision: marker, checkRounds: 2, autoRepairRounds: 1 }) }) }))
  })
})

describe('chapter-only compiler admission from frozen writing authority', () => {
  it.each(['write', 'review', 'proposal', 'selection', 'invalid', 'foreign', 'archived', 'wrong-target', 'changed-origin'] as const)('%s preserves the original task boundary', async scenario => {
    const task = buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'c', prompt: scenario === 'review' ? '检查当前章节' : scenario === 'proposal' ? '写一本小说' : '写下一章' })
    if (scenario === 'selection') task.scope.selection = { chapterId: 'c', start: 0, end: 1 }
    if (scenario === 'wrong-target') { task.goals = ['完成当前章节']; task.scope.chapterIds = ['other-chapter'] }
    if (scenario === 'changed-origin') task.runId = 'origin'
    const run = { runtimeProtocolVersion: 0, taskRootId: null, sessionId: 's', taskSpec: scenario === 'invalid' ? {} : task }
    const find = vi.fn().mockResolvedValue(scenario === 'foreign' ? null : { id: 'comp' })
    const db = { agentRun: { findFirst: vi.fn().mockImplementation(async ({ where, select }) => where.id === 'origin' ? { id: 'origin', taskSpec: { ...task, goals: ['另一任务'] } }
      : select.createdAt ? { createdAt: new Date() } : run) }, storyCompilation: { findFirst: find },
      chapter: { findFirst: vi.fn().mockResolvedValue(scenario === 'archived' ? null : { id: 'c' }) } } as unknown as Prisma.TransactionClient
    const work = isWritingTaskContinuityCompiler(db, { userId: 'u', novelId: 'n', runId: 'r', compilationId: 'comp', chapterId: 'c' })
    if (scenario === 'changed-origin') await expect(work).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    else await expect(work).resolves.toBe(scenario === 'write')
    if (scenario === 'write') expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'comp', chapterId: 'c', userId: 'u', novelId: 'n', status: 'active',
      run: expect.objectContaining({ taskSpec: { path: ['id'], equals: task.id } }), AND: expect.any(Array) }) }))
  })
  it('rechecks the current run and manuscript fence before promoting a cached CHECK', async () => {
    const assert = vi.spyOn(manuscript, 'assertAgentManuscriptCurrent').mockRejectedValue(new Error('stale owner'))
    const update = vi.fn(), db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'n' }]), storyCompilation: { update } } as unknown as Prisma.TransactionClient
    await expect(validateStoryContinuity({ userId: 'u', novelId: 'n', runId: 'r', compilationId: 'comp', findings: [], independentCheck: 'complete' }, db)).rejects.toThrow('stale owner')
    expect(assert).toHaveBeenCalledWith(db, { userId: 'u', novelId: 'n', runId: 'r' })
    expect(update).not.toHaveBeenCalled()
  })
})
