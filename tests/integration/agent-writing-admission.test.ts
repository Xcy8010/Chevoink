import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { assertWritingTarget, freezeWritingScope, readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
async function fixture(prompt: string, positions: number[], work: (subject: { userId: string; novelId: string; runId: string }, chapters: Awaited<ReturnType<typeof prisma.chapter.create>>[], volumeIds: string[]) => Promise<void>) {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID(), runId = randomUUID()
  try {
    await prisma.user.create({ data: { id: userId, nickname: 'synthetic-admission', passwordHash: 'test-only' } })
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '合成冻结范围', slug: `admission-${novelId}`, summary: 'test-only' } })
    const volumes = await Promise.all([1, 2].map(orderIndex => prisma.volume.create({ data: { novelId, title: `合成卷${orderIndex}`, orderIndex } })))
    const chapters = await Promise.all(positions.map((orderIndex, i) => prisma.chapter.create({ data: { novelId, authorId: userId, volumeId: volumes[i < 2 ? 0 : 1].id,
      orderIndex, orderInVolume: i < 2 ? i + 1 : i - 1, title: `合成章${orderIndex}`, content: `合成原文${orderIndex}` } })))
    await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: 'synthetic-admission' } })
    await prisma.agentRun.create({ data: { id: runId, sessionId, userId, novelId, chapterId: chapters[0]?.id,
      engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', startRequest: { prompt } } })
    await work({ userId, novelId, runId }, chapters, volumes.map(item => item.id))
  } finally {
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.chapter.deleteMany({ where: { authorId: userId } })
    await prisma.novel.deleteMany({ where: { id: novelId, authorId: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
}
describe.skipIf(!available)('fresh original writing admission snapshots', () => {
  it.each([
    ['第71、72章是空壳的问题帮我解决', [70, 71, 72, 73], [71, 72]],
    ['优化第150、161章', [149, 150, 155, 161, 162], [150, 161]],
    ['不要改第71,72章。请改第73章', [71, 72, 73], [73]],
  ] as const)('freezes only the named chapters from the authenticated request: %s', (prompt, positions, expected) => fixture(prompt, [...positions], async (subject, chapters) => {
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, chapterId: chapters[0].id, prompt }), '模型摘要：修改所有章节'))
    expect(spec.scope.writing).toMatchObject({ kind: 'bounded', repairAuthorized: true, targets: expected.map(orderIndex => ({ orderIndex, chapterId: chapters.find(chapter => chapter.orderIndex === orderIndex)!.id })) })
    await prisma.agentRun.update({ where: { id: subject.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    for (const chapter of chapters) {
      const invocation = prisma.$transaction(tx => assertWritingTarget(tx, subject, { chapterId: chapter.id }))
      if ((expected as readonly number[]).includes(chapter.orderIndex)) await expect(invocation).resolves.toBeTruthy()
      else await expect(invocation).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    }
    expect(await prisma.chapter.findMany({ where: { novelId: subject.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(chapters)
  }))
  it('freezes first through last to exact active existing rows and never mints future slots', () => fixture('你这样吧，开始从第一章改，一直到最后，检查剧情连贯性', [1, 2, 4], async (subject, chapters, volumeIds) => {
    const prompt = '你这样吧，开始从第一章改，一直到最后，检查剧情连贯性'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, chapterId: chapters[0].id, prompt }), prompt))
    expect(spec.scope.writing).toEqual({ version: 1, kind: 'bounded', titleAndBodyOnly: false, repairAuthorized: true,
      targets: chapters.map(chapter => ({ orderIndex: chapter.orderIndex, chapterId: chapter.id })) })
    await prisma.agentRun.update({ where: { id: subject.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const later = await prisma.chapter.create({ data: { novelId: subject.novelId, authorId: subject.userId, volumeId: volumeIds[1], orderIndex: 5, orderInVolume: 2, title: '合成后来章', content: '新增合成正文' } })
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: subject.runId } })
    expect(await prisma.$transaction(tx => freezeWritingScope(tx, subject, spec, '继续改全书'))).toEqual(spec)
    expect((await prisma.$transaction(tx => readWritingScope(tx, subject))).writing).toEqual(spec.scope.writing)
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, subject, { chapterId: later.id }))).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, subject, { orderIndex: 3 }))).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: subject.runId } })).toEqual(before)
  }))
  it.each(['检查第二卷', '修改第二卷第1、2章'])('preserves explicit volume ordinals: %s', prompt => fixture(prompt, [1, 2, 3, 4], async (subject, chapters, volumeIds) => {
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, prompt }), prompt))
    expect(spec.scope.writing?.targets).toEqual(chapters.slice(2).map(chapter => ({ orderIndex: chapter.orderIndex, chapterId: chapter.id, volumeId: volumeIds[1], positionInVolume: chapter.orderInVolume })))
    expect(spec.scope.writing?.repairAuthorized).toBe(prompt.startsWith('修改'))
  }))
  it('does not infer an editor target when the explicit volume is missing', () => fixture('修改第三卷第1、2章', [1], async (subject, chapters) => {
    const prompt = '修改第三卷第1、2章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, chapterId: chapters[0].id, prompt }), prompt))
    expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
  }))
  it('cannot fabricate an existing full-book target in an empty manuscript', () => fixture('从第一章改一直到最后', [], async subject => {
    const prompt = '从第一章改一直到最后'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, prompt }), prompt))
    expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
  }))
  it('keeps caller-protected chapters unchanged despite explicit repair authority', () => fixture('修改第71、72章', [71, 72], async (subject, chapters) => {
    const prompt = '修改第71、72章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: subject.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: subject.runId } })
    await expect(chapterWriteTool.execute({ ...subject, sessionId: run.sessionId, chapterId: chapters[0].id, callId: 'synthetic-protected',
      mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', protectedChapterIds: new Set([chapters[0].id]), emit: () => {}, signal: new AbortController().signal },
    { chapterId: chapters[0].id, content: '不得保存的合成内容' })).rejects.toMatchObject({ code: 'AUTHOR_SCOPE_PROTECTED' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapters[0].id } })).toEqual(chapters[0])
  }))
  it('inherits only the verified parent snapshot, never the child model brief', () => fixture('修改第71、72章', [70, 71, 72, 73], async (subject, chapters) => {
    const prompt = '修改第71、72章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: subject.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const parent = await prisma.agentRun.findUniqueOrThrow({ where: { id: subject.runId } })
    const session = await prisma.agentSession.create({ data: { userId: subject.userId, novelId: subject.novelId, title: 'synthetic-derived',
      spawnedFromRunId: subject.runId, spawnedFromSessionId: parent.sessionId } })
    const child = await prisma.agentRun.create({ data: { userId: subject.userId, novelId: subject.novelId, sessionId: session.id, chapterId: chapters[0].id,
      engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', startRequest: { prompt: '模型生成：从第70章修复到第73章' } } })
    const childSubject = { ...subject, runId: child.id }
    const childSpec = await prisma.$transaction(tx => freezeWritingScope(tx, childSubject, buildTaskSpec({ ...childSubject, chapterId: chapters[0].id, prompt: '修改第70至73章' }), '修改第70至73章'))
    expect(childSpec.scope).toEqual(spec.scope)
    expect(childSpec.hardConstraints).toEqual(spec.hardConstraints)
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, childSubject, { chapterId: chapters[0].id }))).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: subject.runId } })).toEqual(parent)
  }))
  it.each(['从第一章改到最后，不要修改第2、4章', '从第一章改到最后，不要修改第二卷第1、2章'])(
    'preserves explicit chapter exceptions in the broad original snapshot: %s', prompt => fixture(prompt, [1, 2, 3, 4], async (subject, chapters) => {
      const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, prompt }), prompt))
      const allowed = prompt.includes('第二卷') ? chapters.slice(0, 2) : [chapters[0], chapters[2]]
      expect(spec.scope.writing?.targets).toEqual(allowed.map(chapter => ({ orderIndex: chapter.orderIndex, chapterId: chapter.id })))
      await prisma.agentRun.update({ where: { id: subject.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
      const denied = chapters.find(chapter => !allowed.some(item => item.id === chapter.id))!
      await expect(prisma.$transaction(tx => assertWritingTarget(tx, subject, { chapterId: denied.id }))).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
      expect(await prisma.chapter.findMany({ where: { novelId: subject.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(chapters)
    }))
  it.each(['修改第71、72章', '从第一章改到最后'])(
    'does not rebuild unfrozen historical authority from current editor IDs: %s', prompt => fixture(prompt, [70, 71, 72], async (subject, chapters) => {
      const legacy = buildTaskSpec({ ...subject, chapterId: chapters[0].id, prompt })
      await prisma.agentRun.update({ where: { id: subject.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(legacy))).value } })
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: subject.runId } })
      expect((await prisma.$transaction(tx => readWritingScope(tx, subject))).writing).toMatchObject({ kind: 'needs_input', targets: [] })
      await expect(prisma.$transaction(tx => assertWritingTarget(tx, subject, { chapterId: chapters[0].id }))).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: subject.runId } })).toEqual(before)
    }))
})
