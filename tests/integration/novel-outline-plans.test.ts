import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { createNovelPlanArtifact, listNovelPlanArtifacts, updateNovelPlanArtifact } from '../../api/lib/agent/plan-artifacts.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { assertWritingPlanContextCurrent, bindFutureWritingPlan, readWritingPlanContext } from '../../api/lib/agent/writing-plan-context.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })

async function fixture(work: (data: { userId: string; novelId: string; runId: string; chapterId: string }) => Promise<void>) {
  const user = await prisma.user.create({ data: { nickname: 'outline-plan-fixture', passwordHash: 'test-only-unusable' } })
  try {
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: '合成提纲测试', slug: randomUUID(), summary: '' } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '测试卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { novelId: novel.id, authorId: user.id, volumeId: volume.id, title: '测试章',
      orderIndex: 1, orderInVolume: 1, content: '人物来到门前。', wordCount: 7 } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '提纲测试' } })
    const runId = randomUUID(), prompt = '授权自主创作全书，并修改已有章节。'
    await prisma.agentRun.create({ data: { id: runId, userId: user.id, novelId: novel.id, sessionId: session.id, chapterId: chapter.id,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'running', manuscriptRevision: novel.manuscriptRevision,
      startRequest: { prompt }, taskSpec: buildTaskSpec({ runId, novelId: novel.id, chapterId: chapter.id, prompt, mode: 'build' }) } })
    await work({ userId: user.id, novelId: novel.id, runId, chapterId: chapter.id })
  } finally {
    await prisma.agentArtifact.deleteMany({ where: { run: { userId: user.id } } })
    await prisma.agentRun.deleteMany({ where: { userId: user.id } })
    await prisma.agentSession.deleteMany({ where: { userId: user.id } })
    await prisma.storyCompilation.deleteMany({ where: { userId: user.id } })
    await prisma.chapter.deleteMany({ where: { authorId: user.id } })
    await prisma.novel.deleteMany({ where: { authorId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
  }
}

describe.skipIf(!available)('outline/detail metadata persistence and compiler dependencies (PostgreSQL)', () => {
  it('keeps identically titled kinds, semantic CAS, explicit parent review and missing-parent drafts', async () => fixture(async f => {
    const outline = (await createNovelPlanArtifact(f.userId, f.novelId, '同名计划', { planKind: 'outline' })).item
    const parent = (await updateNovelPlanArtifact(f.userId, outline.id, { content: '本阶段取得钥匙，最后返回故乡。', expectedPlanHash: outline.planHash })).item
    const detail = (await createNovelPlanArtifact(f.userId, f.novelId, '同名计划', { planKind: 'detail', parentPlanId: parent.id,
      expectedParentPlanHash: parent.planHash, target: { kind: 'chapter', chapterId: f.chapterId } })).item
    expect((await listNovelPlanArtifacts(f.userId, f.novelId)).items.map(item => item.id)).toEqual([outline.id, detail.id])
    expect(detail.reviewState).toBe('current')
    const races = await Promise.allSettled(['甲版本', '乙版本'].map(content => updateNovelPlanArtifact(f.userId, detail.id, { content, expectedPlanHash: detail.planHash })))
    expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(races.filter(result => result.status === 'rejected')).toHaveLength(1)
    const current = (await listNovelPlanArtifacts(f.userId, f.novelId)).items.find(item => item.id === detail.id)!
    const changedParent = (await updateNovelPlanArtifact(f.userId, parent.id, { content: '本阶段改为交还钥匙，最后返回故乡。', expectedPlanHash: parent.planHash })).item
    expect((await listNovelPlanArtifacts(f.userId, f.novelId)).items.find(item => item.id === detail.id)).toMatchObject({ reviewState: 'stale', parentPlanHash: parent.planHash })
    const reviewed = (await updateNovelPlanArtifact(f.userId, detail.id, { expectedPlanHash: current.planHash, expectedParentPlanHash: changedParent.planHash })).item
    expect(reviewed.reviewState).toBe('current')
    await updateNovelPlanArtifact(f.userId, parent.id, { saved: false })
    expect((await listNovelPlanArtifacts(f.userId, f.novelId)).items.find(item => item.id === detail.id)).toMatchObject({ reviewState: 'missing_parent' })
    expect(await prisma.agentArtifact.count({ where: { id: detail.id } })).toBe(1)
    await expect(listNovelPlanArtifacts('foreign-user', f.novelId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }))

  it('freezes full plans and rejects subsequent semantic changes before scenes/effects, preserving old compilations', async () => fixture(async f => {
    const old = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '改写本章' })
    expect(readWritingPlanContext(old.compilation.preparedContext)).toBeNull()
    const outline = (await createNovelPlanArtifact(f.userId, f.novelId, '大纲', { planKind: 'outline' })).item
    const parent = (await updateNovelPlanArtifact(f.userId, outline.id, { content: '本章取得钥匙。终局返回故乡。', expectedPlanHash: outline.planHash })).item
    await expect(prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '改写本章' })).rejects.toMatchObject({ code: 'DETAIL_PLAN_REQUIRED' })
    const detail = (await createNovelPlanArtifact(f.userId, f.novelId, '细纲', { planKind: 'detail', parentPlanId: parent.id,
      expectedParentPlanHash: parent.planHash, target: { kind: 'chapter', chapterId: f.chapterId } })).item
    const saved = (await updateNovelPlanArtifact(f.userId, detail.id, { content: '本章人物取得钥匙，留下一封信。', expectedPlanHash: detail.planHash })).item
    const prepared = await prepareStoryCompilation({ ...f, detailPlanId: saved.id, mode: 'balanced', intentSummary: '改写本章' })
    expect(readWritingPlanContext(prepared.compilation.preparedContext)).toMatchObject({ outline: { content: parent.content }, detail: { content: saved.content } })
    await updateNovelPlanArtifact(f.userId, saved.id, { content: '作者新的细纲内容。', expectedPlanHash: saved.planHash })
    await expect(prisma.$transaction(tx => assertWritingPlanContextCurrent(tx, { userId: f.userId, novelId: f.novelId }, prepared.compilation.preparedContext))).rejects.toMatchObject({ code: 'PLAN_CONTEXT_STALE' })
    await expect(saveSceneTasks({ userId: f.userId, novelId: f.novelId, compilationId: prepared.compilation.id,
      tasks: [{ purpose: '取得钥匙', goal: '拿到钥匙', obstacle: '门锁', choice: '绕行', cost: '留下痕迹', turn: '找到钥匙', entryState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }, exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })).rejects.toMatchObject({ code: 'PLAN_CONTEXT_STALE' })
    expect(await prisma.sceneTask.count({ where: { compilationId: prepared.compilation.id } })).toBe(0)
  }))

  it('binds a future plan to one real chapter atomically and keeps that identity after reordering', async () => fixture(async f => {
    const outline = (await createNovelPlanArtifact(f.userId, f.novelId, '未来大纲', { planKind: 'outline' })).item
    const parent = (await updateNovelPlanArtifact(f.userId, outline.id, { content: '下一章取得钥匙。', expectedPlanHash: outline.planHash })).item
    const detail = (await createNovelPlanArtifact(f.userId, f.novelId, '未来细纲', { planKind: 'detail', parentPlanId: parent.id,
      expectedParentPlanHash: parent.planHash, target: { kind: 'future', targetOrderIndex: 2 } })).item
    await updateNovelPlanArtifact(f.userId, detail.id, { content: '人物在第二章取得钥匙。', expectedPlanHash: detail.planHash })
    const prepared = await prepareStoryCompilation({ userId: f.userId, novelId: f.novelId, runId: f.runId, targetOrderIndex: 2, mode: 'balanced', intentSummary: '本章取得钥匙' })
    const existing = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const created = await prisma.$transaction(async tx => {
      await lockNovelActiveScope(tx, f.novelId)
      const chapter = await tx.chapter.create({ data: { novelId: f.novelId, authorId: f.userId, volumeId: existing.volumeId,
        orderIndex: 2, orderInVolume: 2, title: '下一章', content: '', wordCount: 0 } })
      await bindFutureWritingPlan(tx, { userId: f.userId, novelId: f.novelId }, prepared.compilation, chapter)
      return chapter
    })
    await prisma.chapter.update({ where: { id: created.id }, data: { orderIndex: 3, orderInVolume: 3 } })
    const stored = (await listNovelPlanArtifacts(f.userId, f.novelId)).items.find(item => item.id === detail.id)!
    expect(stored.target).toEqual({ kind: 'chapter', chapterId: created.id })
    const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    expect(readWritingPlanContext(compilation.preparedContext)?.target).toEqual(stored.target)
    await expect(prisma.$transaction(tx => assertWritingPlanContextCurrent(tx, { userId: f.userId, novelId: f.novelId }, compilation.preparedContext))).resolves.not.toBeNull()
  }))
})
