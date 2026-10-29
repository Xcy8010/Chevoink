import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from '../../api/lib/agent/compiler-continuity-contract.js'
import { commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as manuscript from '../../api/lib/agent/manuscript-scope.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as humanity from '../../api/lib/agent/humanity-quality.js'
import * as locks from '../../api/lib/data/novel-write-lock.js'
import * as goals from '../../api/lib/agent/goal-fence.js'
import { buildContinuitySnapshot, reviewContinuity, readContinuityReport, type ContinuityOpinion } from '../../api/lib/agent/continuity-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readNewDraftWritingAuthority } from '../../api/lib/agent/writing-scope.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const { revisionChannel, currentReadiness } = vi.hoisted(() => ({ revisionChannel: vi.fn(), currentReadiness: vi.fn() }))
vi.mock('../../api/lib/agent/chapter-review-guard.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/chapter-review-guard.js')>(),
  probeChapterReviewRevision: revisionChannel,
  // Real readiness projection is covered in chapter-review-guard. This core
  // fixture derives its decision from the actual shared runner's current report.
  readChapterReviewReadiness: currentReadiness,
}))

afterEach(() => { vi.restoreAllMocks(); revisionChannel.mockReset(); currentReadiness.mockReset() })
const input = () => ({ chapter: { id: 'c', title: '本章', revision: 2, content: '修订后的完整正文', orderIndex: 2 },
  bridge: { fromChapterId: 'source', sourceRevision: 1, location: '城门' }, sceneTasks: [{ ordinal: 1, goal: '寻找钥匙', turn: '发现门已锁' }],
  source: { id: 'source', revision: 1, content: '前章完整正文' } })

function currentFixture() {
  const value = input()
  const chapter = { ...value.chapter, authorId: 'u', novelId: 'n', archivedAt: null as Date | null, createdAt: new Date(2) }
  const previous = { ...value.source, title: '前章', orderIndex: 1 }
  const compilation = { id: 'comp', userId: 'u', novelId: 'n', runId: 'r', chapterId: 'c', chapter,
    createdAt: new Date(1),
    bridge: { id: 'bridge', ...value.bridge, targetRevision: 2, committedAt: null }, sceneTasks: value.sceneTasks,
    status: 'active', stage: 'write', preparedContext: {}, validation: {} as Record<string, unknown> }
  const task = buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'c', prompt: '修复当前章' })
  task.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'c', orderIndex: 2 }], titleAndBodyOnly: false, repairAuthorized: true }
  const origin = { taskId: task.id, sourceRunId: 'r', parentRunId: null, prompt: '修复当前章', spec: task as unknown }
  const run = { id: 'r', userId: 'u', novelId: 'n', status: 'queued', runtimeProtocolVersion: 0, taskRootId: null, sessionId: 's',
    chapterId: 'c', taskSpec: origin.spec, writingBindings: null as unknown, createdAt: new Date(1) }
  const artifacts = new Map<string, Record<string, unknown>>()
  vi.spyOn(original, 'readOriginalTaskRequest').mockImplementation(async () => origin)
  vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['r'])
  const target = vi.spyOn(humanity, 'resolveQualityChapterTarget').mockResolvedValue('c')
  const scope = vi.spyOn(humanity, 'qualityCompilationScope').mockResolvedValue({ runId: 'r' })
  vi.spyOn(locks, 'lockNovelActiveScope').mockResolvedValue(undefined)
  vi.spyOn(goals, 'assertRunGoalFence').mockResolvedValue(undefined)
  const owner = vi.spyOn(manuscript, 'assertAgentManuscriptCurrent').mockResolvedValue(undefined)
  vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{ id: 'n' }])
  vi.spyOn(prisma.chapter, 'findFirst').mockImplementation(async args => args?.where?.id === 'source' ? { ...previous } as never
    : args?.where?.id === 'c' && args.where.authorId === 'u' && !chapter.archivedAt ? { ...chapter } as never : null)
  const chapterWrite = vi.spyOn(prisma.chapter, 'update')
  vi.spyOn(prisma.chapter, 'findMany').mockImplementation(async args => args?.where?.orderIndex ? [{ ...previous }] as never : [{ id: 'c', orderIndex: 2 }] as never)
  const owned = (where: Prisma.StoryCompilationWhereInput | undefined) => where?.userId === 'u' && where.novelId === 'n' && compilation.userId === 'u'
  const findCompilation = vi.spyOn(prisma.storyCompilation, 'findFirst').mockImplementation(async args => {
    const date = args?.where?.createdAt
    const after = date && typeof date === 'object' && 'gt' in date ? date.gt : undefined
    return owned(args?.where) && (!after || compilation.createdAt > new Date(after as string | Date)) ? { ...compilation } as never : null
  })
  vi.spyOn(prisma.storyCompilation, 'findMany').mockImplementation(async args => owned(args?.where) ? [{ ...compilation }] as never : [])
  vi.spyOn(prisma.storyCompilation, 'findUniqueOrThrow').mockImplementation(async () => ({ ...compilation }) as never)
  const update = vi.spyOn(prisma.storyCompilation, 'update').mockImplementation(async ({ data }) => { Object.assign(compilation, data); return { ...compilation } as never })
  const bridgeWrite = vi.spyOn(prisma.chapterBridge, 'update').mockResolvedValue({} as never)
  const scenesWrite = vi.spyOn(prisma.sceneTask, 'updateMany').mockResolvedValue({ count: 1 })
  vi.spyOn(prisma.agentRun, 'findFirst').mockImplementation(async args => args?.where?.id === 'origin' ? { id: 'origin', taskSpec: { ...task, runId: 'origin', goals: ['另一任务'] } } as never : { ...run } as never)
  vi.spyOn(prisma.agentRun, 'findFirstOrThrow').mockImplementation(async () => ({ ...run }) as never)
  vi.spyOn(prisma.agentArtifact, 'findMany').mockResolvedValue([])
  vi.spyOn(prisma.agentArtifact, 'findUnique').mockImplementation(async ({ where }) => artifacts.get(where.id!) as never ?? null)
  vi.spyOn(prisma.agentArtifact, 'create').mockImplementation(async ({ data }) => { const row = { ...data, updatedAt: new Date() }; artifacts.set(data.id!, row); return row as never })
  vi.spyOn(prisma.agentArtifact, 'update').mockImplementation(async ({ where, data }) => { const row = { ...artifacts.get(where.id!), ...data, updatedAt: new Date() }; artifacts.set(where.id!, row); return row as never })
  vi.spyOn(prisma.aiUsageLog, 'findMany').mockResolvedValue([])
  vi.spyOn(prisma.aiUsageLog, 'count').mockResolvedValue(0)
  vi.spyOn(prisma.agentOperation, 'findMany').mockResolvedValue([])
  vi.spyOn(prisma, '$transaction').mockImplementation(async work => typeof work === 'function' ? work(prisma) : Promise.all(work) as never)
  const proposal = vi.spyOn(memory, 'saveStoryMemory').mockResolvedValue({ id: 'memory' } as never)
  const ctx: ToolContext = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's', chapterId: 'c', callId: 'current-check', mode: 'build',
    creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
  const dispatch = vi.fn(async () => ({ content: '{"findings":[]}', usageIds: [], billingKnown: true }))
  const review = (opinions: ContinuityOpinion[] = []) => {
    dispatch.mockResolvedValueOnce({ content: JSON.stringify({ findings: opinions }), usageIds: [], billingKnown: true })
    return reviewContinuity(ctx, { compilationId: 'comp' }, { allowRepair: false, dispatch })
  }
  currentReadiness.mockImplementation(async () => {
    const report = readContinuityReport(compilation.validation, chapter, (await buildContinuitySnapshot(ctx, { compilationId: 'comp' })).contextHash)
    const complete = !!report?.complete && report.billingKnown
    return { ready: complete, chapterId: 'c', revision: chapter.revision, compilationId: 'comp', quality: 'complete', continuity: complete ? 'complete' : 'incomplete',
      decisionPending: !!report?.findings.length, continuityErrorCount: report?.findings.filter(finding => finding.severity === 'error').length ?? 0, qualityErrorCount: 0, requiredTools: complete ? [] : [{ name: 'continuity_validate', args: { compilationId: 'comp' } }] }
  })
  const commit = () => commitChapterBridge({ userId: 'u', novelId: 'n', runId: 'r', compilationId: 'comp', chapterSummary: '章节摘要',
    exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }, lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '',
    openingStructure: '动作', endingStructure: '转折', expectedChapterRevision: 2, expectedContentHash: runtimeJson({ content: value.chapter.content }).hash }, prisma)
  return { ctx, chapter, previous, compilation, origin, run, task, artifacts, dispatch, target, scope, owner, proposal, findCompilation, update, bridgeWrite, scenesWrite, chapterWrite, review, commit }
}

describe('compiler continuity report dependencies', () => {
  it('completes a frozen protocol6 assessment under its own hash, without upgrading it to current protocol8', async () => {
    const current = input(), coverage = compilerContinuityCoverage(current, 6)
    expect(compilerContinuityCoverageMatches(coverage, compilerContinuityCoverage(current, 6))).toBe(true)
    expect(compilerContinuityCoverageMatches(coverage, compilerContinuityCoverage(current))).toBe(false)
    const f = currentFixture()
    f.compilation.validation = { checkRounds: 2, autoRepairRounds: 1, coverage }
    expect(await f.review()).toMatchObject({ reviewCompleted: true })
    expect(f.compilation.validation).toMatchObject({ checkRounds: 2, autoRepairRounds: 1, coverage })
    expect(readContinuityReport(f.compilation.validation, f.chapter)).toMatchObject({ complete: true, revision: 2, rawResponses: ['{"findings":[]}'] })
    expect(f.chapterWrite).not.toHaveBeenCalled()
  })
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
    const f = currentFixture(), coverage = compilerContinuityCoverage(input())
    const historical = scenario === 'missing' ? {} : { coverage: { ...coverage, ...(scenario === 'old-protocol' ? { protocolVersion: 1 } : { reviewHash: '0'.repeat(64) }) } }
    f.compilation.validation = historical
    await f.review(); f.update.mockClear()
    await expect(f.commit()).resolves.toMatchObject({ compilationId: 'comp', chapterId: 'c', chapterRevision: 2 })
    expect(f.update).toHaveBeenCalledOnce(); expect(f.bridgeWrite).toHaveBeenCalledOnce(); expect(f.scenesWrite).toHaveBeenCalledOnce()
    expect(f.compilation.validation).toMatchObject(historical)
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ stage: 'commit', status: 'completed' }) }))
    expect(f.proposal.mock.calls[0]?.[0]).toMatchObject({ memoryType: 'chapterSummary', content: '章节摘要', agentGenerated: true })
    expect(f.proposal.mock.calls[0]?.[1] === prisma).toBe(true)
    expect(f.chapterWrite).not.toHaveBeenCalled()
  })
  it.each(['current', 'stale-body', 'stale-scenes', 'cancelled'] as const)('%s persists only a current compiler CHECK without touching manuscript', async scenario => {
    const f = currentFixture(), frozen = await buildContinuitySnapshot(f.ctx, { compilationId: 'comp' })
    if (scenario === 'stale-body') f.chapter.content += '新文'
    if (scenario === 'stale-scenes') f.compilation.sceneTasks[0].goal = '不同目标'
    if (scenario === 'cancelled') f.ctx.signal = AbortSignal.abort()
    const work = reviewContinuity(f.ctx, { compilationId: 'comp' }, { snapshot: frozen, allowRepair: false, dispatch: f.dispatch })
    if (scenario === 'current' || scenario === 'stale-scenes') {
      await expect(work).resolves.toMatchObject({ reviewCompleted: true })
      expect(readContinuityReport(f.compilation.validation, f.chapter, frozen.contextHash)).toMatchObject({ complete: true, revision: 2 })
      expect(f.dispatch).toHaveBeenCalledOnce()
    } else {
      if (scenario === 'cancelled') await expect(work).rejects.toBeDefined()
      else await expect(work).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
      expect(f.update).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled()
    }
    expect(f.chapterWrite).not.toHaveBeenCalled()
  })
  it('a fresh complete CHECK preserves the consumed new-draft correction marker and the check/paid repair counters', async () => {
    const f = currentFixture(), marker = { version: 1, taskId: 'task', chapterId: 'c', compilationId: 'comp', checkedRevision: 1 }
    const historical = { checkRounds: 2, autoRepairRounds: 1, newDraftRevision: marker }
    f.compilation.validation = historical
    await expect(f.review()).resolves.toMatchObject({ reviewCompleted: true })
    expect(f.compilation.validation).toMatchObject(historical)
    expect(readContinuityReport(f.compilation.validation, f.chapter)).toMatchObject({ complete: true, revision: 2 })
  })
})

describe('terminal commit gate is independent of paid revision availability', () => {
  const fixture = async () => {
    const f = currentFixture(), snapshot = await buildContinuitySnapshot(f.ctx, { compilationId: 'comp' })
    const sourceId = snapshot.sources[0].table.entries[0].id.slice(0, 13)
    await f.review((['object', 'knowledge'] as const).map(signal => ({ signal, severity: 'error', explanation: signal === 'object' ? '合成门锁状态冲突' : '合成人物知情状态冲突',
      suggestion: '保留原事实', evidence: [{ sourceId }] })))
    f.update.mockClear()
    return { ...f, terminalWrite: f.update }
  }
  it('holds the commit while one merged correction is still reachable', async () => {
    revisionChannel.mockResolvedValue(true)
    const f = await fixture()
    await expect(f.commit()).rejects.toMatchObject({ code: 'CONTINUITY_ERRORS_REMAIN' })
    expect(revisionChannel).not.toHaveBeenCalled()
    expect(f.terminalWrite).not.toHaveBeenCalled()
  })
  it('keeps unhandled findings pending when automatic revision is unavailable', async () => {
    revisionChannel.mockResolvedValue(false)
    const f = await fixture()
    await expect(f.commit()).rejects.toMatchObject({ code: 'CONTINUITY_ERRORS_REMAIN' })
    expect(revisionChannel).not.toHaveBeenCalled()
    expect(f.terminalWrite).not.toHaveBeenCalled()
    expect(f.proposal).not.toHaveBeenCalled()
  })
})

describe('chapter-only compiler admission from frozen writing authority', () => {
  it.each(['write', 'review', 'proposal', 'selection', 'invalid', 'foreign', 'archived', 'wrong-target', 'changed-origin'] as const)('%s preserves the original task boundary', async scenario => {
    const f = currentFixture(), prompt = scenario === 'review' ? '检查当前章节' : scenario === 'proposal' ? '写一本小说' : '写下一章'
    const task = buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'c', prompt })
    task.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: null, orderIndex: scenario === 'wrong-target' ? 3 : 2 }], titleAndBodyOnly: false, repairAuthorized: false }
    if (scenario === 'selection') task.scope.selection = { chapterId: 'c', start: 0, end: 1 }
    if (scenario === 'wrong-target') { task.goals = ['完成当前章节']; task.scope.chapterIds = ['other-chapter'] }
    if (scenario === 'changed-origin') task.runId = 'origin'
    f.origin.prompt = prompt; f.origin.spec = scenario === 'invalid' ? {} : task; f.origin.taskId = task.id
    f.run.taskSpec = f.origin.spec
    f.run.writingBindings = { version: 1, taskId: task.id, targets: [{ orderIndex: scenario === 'wrong-target' ? 3 : 2, chapterId: scenario === 'wrong-target' ? 'other-chapter' : 'c' }] }
    if (scenario === 'foreign') f.compilation.userId = 'other-author'
    if (scenario === 'archived') f.chapter.archivedAt = new Date()
    f.target.mockRestore(); f.scope.mockRestore()
    const work = buildContinuitySnapshot(f.ctx, { chapterId: 'c', compilationId: 'comp' })
    if (scenario === 'changed-origin') await expect(work).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    else if (scenario === 'foreign') await expect(work).rejects.toMatchObject({ code: 'QUALITY_TASK_TARGET_REQUIRED' })
    else if (scenario === 'archived') await expect(work).rejects.toMatchObject({ code: 'CHAPTER_NOT_FOUND' })
    else {
      const snapshot = await work
      expect(snapshot.chapter).toMatchObject({ id: 'c', revision: 2, content: input().chapter.content })
      expect(snapshot.original.taskId).toBe(task.id)
      // Reading this author's source never grants manuscript effects. Only the
      // original bounded, server-bound new-draft authority authorizes revision.
      const authority = await readNewDraftWritingAuthority(prisma, f.ctx, f.chapter)
      expect(authority).toEqual(scenario === 'write' ? { taskId: task.id } : null)
      expect(f.findCompilation).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'comp', userId: 'u', novelId: 'n',
        run: expect.objectContaining(scenario === 'invalid' ? { id: 'r' } : { taskSpec: { path: ['id'], equals: task.id } }) }) }))
    }
    expect(f.chapterWrite).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()

  })
  it('rechecks the current run and manuscript fence before promoting a cached CHECK', async () => {
    const f = currentFixture()
    await f.review(); f.update.mockClear()
    const originalRaw = JSON.stringify([...f.artifacts.values()])
    f.owner.mockClear(); f.owner.mockRejectedValue(new DataAccessError(409, 'RUNTIME_PARENT_LEASE_LOST', 'stale owner'))
    await expect(f.review()).rejects.toThrow('stale owner')
    expect(f.owner.mock.calls[0]?.[0] === prisma).toBe(true)
    expect(f.owner.mock.calls[0]?.[1]).toMatchObject({ userId: 'u', novelId: 'n', runId: 'r' })
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.update).not.toHaveBeenCalled()
    expect(JSON.stringify([...f.artifacts.values()])).toBe(originalRaw)
    expect(f.chapterWrite).not.toHaveBeenCalled()
  })
})
