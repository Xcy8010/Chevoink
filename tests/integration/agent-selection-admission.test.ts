import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
const execution = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: execution }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(async () => {}), getModelTierRuntime: vi.fn(async () => ({ reasoningEffort: 'high' })) }))
vi.mock('../../api/lib/agent/writing-experiments.js', () => ({ recordSevenDayContinuation: vi.fn(async () => {}) }))
import { prisma } from '../../api/lib/prisma.js'
import app from '../../api/app.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { reserveResearchRequest, settleResearchRequest } from '../../api/lib/agent/research-sources.js'
import { startLoopRun } from '../../api/lib/agent/run-service.js'
import { enqueueRequest } from '../../api/lib/agent/request-queue.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import * as skillService from '../../api/lib/agent/skills/service.js'
import { chapterEditRangeTool, chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { getToolsForMode } from '../../api/lib/agent/tools/registry.js'
import { restrictToolsToTask, snapshotToolAuthority, intersectToolAuthority } from '../../api/lib/agent/tool-authority.js'
import { freezeWritingScope, readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { chapterRevisionPrompt } from '../support/writing-target-prompt.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
async function fixture(work: (subject: { userId: string; novelId: string; sessionId: string; chapterId: string }) => Promise<void>) {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID(), volumeId = randomUUID(), chapterId = randomUUID()
  try {
    execution.mockClear()
    await prisma.user.create({ data: { id: userId, nickname: 'selection-admission', passwordHash: 'test-only' } })
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '选区准入测试', slug: randomUUID(), summary: '' } })
    await prisma.volume.create({ data: { id: volumeId, novelId, title: '第一卷', orderIndex: 1 } })
    await prisma.chapter.create({ data: { id: chapterId, novelId, authorId: userId, volumeId, title: '第一章', content: '前😀段。选区原文。后段。', revision: 3, orderIndex: 1, orderInVolume: 1 } })
    await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: '准入测试' } })
    await work({ userId, novelId, sessionId, chapterId })
  } finally {
    await prisma.memoryExtractionJob.deleteMany({ where: { novelId, novel: { authorId: userId } } })
    await prisma.projectMemoryEntry.deleteMany({ where: { novelId, novel: { authorId: userId } } })
    await prisma.agentQueuedRequest.deleteMany({ where: { userId } })
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.chapter.deleteMany({ where: { novelId, authorId: userId } })
    await prisma.novel.deleteMany({ where: { id: novelId, authorId: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
}
describe.skipIf(!available)('fresh selected server admission transaction', () => {
  it.each([
    chapterRevisionPrompt,
    '仅修改第3章。请先读取前两章。不修改第1、2章。',
    '仅修改第3章。请先读取前两章。',
    '请先读取第1章。仅修订第3章。',
    '仅修正第3章。第1章提到一封信。不要跳过检查。',
    '修改第3章时参考第1章。',
  ])('binds fresh HTTP chapter effects independently of reading and factual references: %s', prompt => fixture(async f => {
    const first = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const ids = [first.id, randomUUID(), randomUUID()]
    for (const position of [2, 3]) await prisma.chapter.create({ data: { id: ids[position - 1], novelId: f.novelId,
      authorId: f.userId, volumeId: first.volumeId, title: `第${position}章`, content: `第${position}章测试正文。`, revision: 3,
      orderIndex: position, orderInVolume: position } })
    const before = await prisma.chapter.findMany({ where: { novelId: f.novelId }, orderBy: { orderIndex: 'asc' } })
    const response = await request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(f.userId, 0).accessToken}`)
      .send({ ...f, chapterId: ids[2], prompt, mode: 'build' })
    expect(response.status).toBe(200)
    const runId = response.body.data.runId as string
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    const spec = taskSpecSchema.parse(row.taskSpec)
    expect(spec).toMatchObject({ intent: 'revise', scope: { writingTargetProtocol: 2, continuityEvidenceProtocol: 1,
      writing: { kind: 'bounded', repairAuthorized: true, targets: [{ orderIndex: 3, chapterId: ids[2] }] } } })
    expect(spec.scope.writing?.targets).toHaveLength(1)
    expect(await prisma.chapter.findMany({ where: { novelId: f.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
    const context = { ...f, runId, mode: 'build' as const, creativeFreedom: 'balanced' as const, qualityMode: 'balanced' as const,
      emit: () => {}, signal: new AbortController().signal }
    for (const chapter of before.slice(0, 2)) {
      await expect(chapterEditRangeTool.execute({ ...context, callId: `deny-range-${chapter.id}` },
        { chapterId: chapter.id, oldText: chapter.content, newText: '未授权替换。' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
      await expect(chapterWriteTool.execute({ ...context, callId: `deny-write-${chapter.id}` },
        { chapterId: chapter.id, content: '未授权覆盖。' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    }
    await chapterEditRangeTool.execute({ ...context, callId: 'authorized-third-chapter' },
      { chapterId: ids[2], oldText: before[2].content, newText: '第三章作者授权修正。' })
    expect(await prisma.chapter.findMany({ where: { id: { in: ids.slice(0, 2) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 2))
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: ids[2] } })).content).toBe('第三章作者授权修正。')
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(3)
    expect(await prisma.webToolCall.count({ where: { runId } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    // A frozen contract stays byte-equivalent even if the caller supplies a new
    // prompt or invokes the fresh parser again. Resume is not a new grant.
    const frozen = await prisma.$transaction(tx => freezeWritingScope(tx, { ...f, runId }, spec, '修改所有章节', 1))
    expect(frozen).toEqual(spec)
    const saved = await prisma.$transaction(tx => readWritingScope(tx, { ...f, runId }))
    expect(saved.writing).toEqual(spec.scope.writing)
  }))

  it('retains old needs-input contracts without promoting them to fresh admission', () => fixture(async f => {
    const result = await startLoopRun(f.userId, { ...f, prompt: '修改第一章', mode: 'build' })
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec)
    delete spec.scope.writingTargetProtocol
    delete spec.scope.continuityEvidenceProtocol
    spec.scope.writing = { version: 1, kind: 'needs_input', targets: [], repairAuthorized: true, titleAndBodyOnly: false }
    await prisma.agentRun.update({ where: { id: result.runId }, data: { status: 'running', taskSpec: spec } })
    expect(await prisma.$transaction(tx => freezeWritingScope(tx, { ...f, runId: result.runId }, spec, '修改第一章', 1))).toEqual(spec)
    await expect(chapterEditRangeTool.execute({ ...f, runId: result.runId, mode: 'build', callId: 'old-frozen-denied',
      creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal },
    { chapterId: f.chapterId, oldText: '选区原文。', newText: '不能扩大旧授权。' })).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('前😀段。选区原文。后段。')
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
  }))

  it.each(['不修订第2章', '不动第2章', '不改第2章'])('honors an explicit exclusion inside a broader fresh HTTP range: %s', exclusion => fixture(async f => {
    const first = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const secondId = randomUUID(), thirdId = randomUUID()
    for (const [id, position] of [[secondId, 2], [thirdId, 3]] as const) await prisma.chapter.create({ data: {
      id, novelId: f.novelId, authorId: f.userId, volumeId: first.volumeId, title: `第${position}章`, content: '排除范围测试原文。',
      revision: 2, orderIndex: position, orderInVolume: position } })
    const response = await request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(f.userId, 0).accessToken}`)
      .send({ ...f, prompt: `修改第1至3章。${exclusion}。`, mode: 'build' })
    expect(response.status).toBe(200)
    const runId = response.body.data.runId as string
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec)
    expect(spec.scope.writing?.targets).toEqual([{ orderIndex: 1, chapterId: first.id }, { orderIndex: 3, chapterId: thirdId }])
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: secondId } })
    await expect(chapterEditRangeTool.execute({ ...f, runId, mode: 'build', callId: 'excluded-second-chapter',
      creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal },
    { chapterId: secondId, oldText: before.content, newText: '越过否定限制。' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: secondId } })).toEqual(before)
    await chapterEditRangeTool.execute({ ...f, runId, mode: 'build', callId: 'allowed-third-chapter',
      creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal },
    { chapterId: thirdId, oldText: '排除范围测试原文。', newText: '第三章已按授权修正。' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: thirdId } })).content).toBe('第三章已按授权修正。')
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
  }))

  it.each(['请阅读这句：修改当前章节。', '请读取这句文字：修改第3章。', '引用原文：修改第3章。', '请阅读提示：修改首段。'])(
    'never promotes data after a reading introducer into an HTTP writing grant: %s', prompt => fixture(async f => {
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 3, orderInVolume: 3, content: '首段原文。\n后段原文。' } })
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const response = await request(app).post('/api/agent/runs')
        .set('Cookie', `chevoink_session=${buildSessionTokens(f.userId, 0).accessToken}`)
        .send({ ...f, prompt, mode: 'build' })
      expect(response.status).toBe(200)
      const runId = response.body.data.runId as string
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec)
      expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
      await expect(chapterEditRangeTool.execute({ ...f, runId, mode: 'build', callId: 'reading-is-not-writing',
        creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal },
      { chapterId: f.chapterId, oldText: '首段原文。', newText: '不应执行。' })).rejects.toMatchObject({
        code: 'SCOPE_NEEDS_INPUT',
      })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    }))

  it('freezes continuation and necessary repair while protecting existing chapters through HTTP', () => fixture(async f => {
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const response = await request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(f.userId, 0).accessToken}`)
      .send({ ...f, prompt: '只续写下一章，不修改已经保存的第1章，完成质量与连续性检查并按必要性修订复检。', mode: 'build' })
    expect(response.status).toBe(200)
    const runId = response.body.data.runId as string
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec)
    expect(spec).toMatchObject({ intent: 'write', scope: { writing: { kind: 'bounded', repairAuthorized: true, targets: [{ orderIndex: 2, chapterId: null }] } } })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
  }))

  it.each([
    '只读联网研究，不创建章节、不写小说正文、不改任何稿件，请优先研究番茄小说《样本》，不要在官网首页泛泛搜索，不要只凭简介、搜索摘要或同人文字推断原作，先核官方身份并读公开样本按证据分析',
    '只搜索《样本》官方作者与作品页，读取两章公开正文并按证据分析',
  ])('persists a real HTTP research contract before async bootstrap and freezes 5/8: %s', prompt => fixture(async f => {
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const response = await request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(f.userId, 0).accessToken}`)
      .send({ ...f, prompt, mode: 'build' })
    expect(response.status).toBe(200)
    const runId = response.body.data.runId as string
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec)
    expect(spec).toMatchObject({ runId, intent: 'research_analysis', researchBudget: 'extended', researchTarget: { title: '样本' } })
    expect(spec.writingPacing).toBeUndefined()
    expect(spec.scope.writing).toBeUndefined()
    const names = restrictToolsToTask(getToolsForMode('build'), spec).map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['web_search', 'web_read', 'research_report_save']))
    expect(names).not.toContain('chapter_write')
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
    for (const [kind, limit] of [['search', 5], ['read', 8]] as const) {
      for (let index = 0; index < limit; index++) {
        const scope = { ...f, runId, callId: `${kind}-${index}` }
        expect(await reserveResearchRequest(scope, kind, `request-${index}`)).toBe(true)
        await settleResearchRequest(scope, 'consumed')
      }
      expect(await reserveResearchRequest({ ...f, runId, callId: `${kind}-denied` }, kind, 'over-limit')).toBe(false)
    }
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    expect(await prisma.webToolCall.count({ where: { runId } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
  }))
  it.each(['本次不联网，深度研究《样本》并搜索公开章节', '写一本小说，不要联网', '你好，不要联网'])(
    'persists explicit HTTP denial before async execution, rejecting both paths without reservations/fees: %s', prompt => fixture(async f => {
      const response = await request(app).post('/api/agent/runs')
        .set('Cookie', `chevoink_session=${buildSessionTokens(f.userId, 0).accessToken}`)
        .send({ ...f, prompt, mode: 'build' })
      expect(response.status).toBe(200)
      const runId = response.body.data.runId as string
      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      const spec = taskSpecSchema.parse(row.taskSpec)
      expect(spec).toMatchObject({ networkAccess: 'denied', researchBudget: 'standard' })
      const tools = getToolsForMode('build'), visible = restrictToolsToTask(tools, spec)
      const executable = intersectToolAuthority(tools, 'review', snapshotToolAuthority(visible, 'build')).map(tool => tool.name)
      expect(executable).toContain('chapter_read')
      for (const name of ['web_search', 'web_read']) expect(executable).not.toContain(name)
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
      for (const kind of ['search', 'read'] as const) await expect(reserveResearchRequest({ ...f, runId, callId: kind }, kind, 'denied'))
        .rejects.toMatchObject({ code: 'RESEARCH_NETWORK_DENIED' })
      expect(await prisma.agentResearchRequest.count({ where: { ownerRunId: runId } })).toBe(0)
      expect(await prisma.webToolCall.count({ where: { runId } })).toBe(0)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      expect(taskSpecSchema.parse(JSON.parse(JSON.stringify(row.taskSpec))).networkAccess).toBe('denied')
    }))
  it.each([true, false])('freezes compound external research only for fresh HTTP author admission: %s', human => fixture(async f => {
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '联网搜一篇番茄小说，分析并总结它的写作手法和思路' }, human ? { humanOrigin: 'http' } : {})
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec)
    expect(spec).toMatchObject({ runId: result.runId, intent: human ? 'research_analysis' : 'review', researchBudget: human ? 'extended' : 'standard' })
    if (human) expect(spec.scope.writing).toBeUndefined()
    expect(spec.authorization).toBeUndefined()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ runId: result.runId }))
    const admitted = restrictToolsToTask(getToolsForMode('build'), spec).map(tool => tool.name)
    if (human) {
      expect(admitted).toEqual(expect.arrayContaining(['web_search', 'web_read', 'research_report_save']))
      for (const name of ['chapter_write', 'chapter_create', 'chapter_edit_range', 'chapter_append', 'plan_save', 'task_spawn']) expect(admitted).not.toContain(name)
    } else expect(admitted).not.toContain('research_report_save')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
  }))
  it.each(['检查是否需要修改第二段', '看看需不需要润色第二段', '判断修改第二段有没有必要',
    '评估是否需要重写第二段', '评估第二段有没有必要润色', 'Check whether to edit paragraph 2',
    'Assess if paragraph 2 needs polishing', 'Evaluate if we should rewrite paragraph 2', '检查是否需要修改整章'])(
    'keeps a fresh revision assessment without mutation authority: %s', prompt => fixture(async f => {
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '首段。\n第二段原文。\n末段。' } })
      const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt })
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec)
      expect(spec.scope.localEditProtocol).toBe(1)
      expect(spec.scope.localEditBoundary?.kind).not.toBe('bounded')
      await prisma.agentRun.update({ where: { id: result.runId }, data: { status: 'running' } })
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      await expect(chapterEditRangeTool.execute({ ...f, runId: result.runId, mode: 'build', callId: 'assessment-denied',
        creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal },
      { chapterId: f.chapterId, oldText: '第二段原文。', newText: '模型改写。' })).rejects.toMatchObject({
        code: 'REPAIR_NOT_AUTHORIZED',
      })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
      expect(await prisma.chapterQualityReport.count({ where: { runId: result.runId } })).toBe(0)
    }))
  it('does not reinterpret an unmarked original whole-chapter request as a fresh assessment contract', () => fixture(async f => {
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '首段。\n第二段原文。\n末段。' } })
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '检查是否需要修改整章' })
    // Build the actual historical contract shape. Removing one field from a
    // v2 integrity-protected projection is corruption, not an old admission.
    const legacy = buildTaskSpec({ runId: result.runId, novelId: f.novelId, chapterId: f.chapterId,
      prompt: '检查是否需要修改整章', reviewProtocol: 1 })
    await prisma.agentRun.update({ where: { id: result.runId }, data: { taskSpec: legacy } })
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, { ...f, runId: result.runId }, legacy, '检查是否需要修改整章', 1))
    expect(spec.scope.writingTargetProtocol).toBe(1)
    expect(spec.scope.writingInterpretation).toBeUndefined()
    await prisma.agentRun.update({ where: { id: result.runId }, data: { status: 'running', taskSpec: spec } })
    await chapterEditRangeTool.execute({ ...f, runId: result.runId, mode: 'build', callId: 'old-contract-unchanged',
      creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal },
    { chapterId: f.chapterId, oldText: '第二段原文。', newText: '旧契约行为。' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('首段。\n旧契约行为。\n末段。')
  }))
  it('preserves an explicit fresh check-and-repair grant for a paragraph', () => fixture(async f => {
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '首段。\n第二段原文。\n末段。' } })
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '检查并修复第二段' })
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec)
    expect(spec.scope.localEditBoundary?.kind).toBe('bounded')
    await prisma.agentRun.update({ where: { id: result.runId }, data: { status: 'running' } })
    await chapterEditRangeTool.execute({ ...f, runId: result.runId, mode: 'build', callId: 'check-and-repair-allowed',
      creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal },
    { chapterId: f.chapterId, oldText: '第二段原文。', newText: '作者授权修复。' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('首段。\n作者授权修复。\n末段。')
  }))
  it('propagates fresh built-in persistence failure before author execution or frozen snapshots', () => fixture(async f => {
    const partialSkillId = `admission-rollback-${randomUUID()}`
    const sync = vi.spyOn(skillService, 'syncBuiltinSkillCatalog').mockImplementationOnce(async tx => {
      expect(tx).toBeDefined()
      if (!tx) throw new Error('fresh persistence must share the admission transaction')
      await tx.agentSkillDefinition.create({ data: { id: partialSkillId, name: 'partial admission skill', description: 'test-only', source: 'builtin',
        visibility: 'builtin', license: 'test-only', status: 'active', defaultVersion: 'test-only' } })
      throw new Error('synthetic builtin persistence failure')
    })
    try {
      await expect(startLoopRun(f.userId, { ...f, mode: 'build', prompt: '修改第一章' })).rejects.toThrow('synthetic builtin persistence failure')
      expect(sync).toHaveBeenCalledTimes(1)
      expect(await prisma.agentRun.count({ where: { userId: f.userId } })).toBe(0)
      expect(await prisma.agentMessage.count({ where: { sessionId: f.sessionId } })).toBe(0)
      expect(await prisma.agentSkillDefinition.count({ where: { id: partialSkillId } })).toBe(0)
      expect(execution).not.toHaveBeenCalled()
    } finally { sync.mockRestore(); await prisma.agentSkillDefinition.deleteMany({ where: { id: partialSkillId } }) }
  }))
  it.each(['将“选区原文。”改为“准确的新句。”', '只修改这段，其余保持不变', '缩写第二段', '检查并修复结尾'])(
    'freezes natural-language locality only at genuine fresh admission: %s', prompt => fixture(async f => {
      const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt })
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec)
      expect(spec.scope.localEditProtocol).toBe(1)
      expect(spec.scope.selection).toBeUndefined()
      expect(spec.scope.localEditBoundary).toMatchObject(prompt.startsWith('将') ? { kind: 'bounded', regions: [{ chapterId: f.chapterId,
        revision: 3, start: 5, end: 10, prefix: '前😀段。', suffix: '后段。' }] } : { kind: 'needs_input', regions: [] })
    }))
  it('a fresh readonly review does not authorize editing even before its first report', () => fixture(async f => {
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '只检查当前章节，不给修改建议' })
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec)
    expect(spec.intent).toBe('review')
    expect(spec.scope.reviewProtocol).toBe(1)
    expect(spec.scope.localEditBoundary).toBeUndefined()
    await prisma.agentRun.update({ where: { id: result.runId }, data: { status: 'running' } })
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await expect(chapterWriteTool.execute({ ...f, runId: result.runId, mode: 'build', callId: 'readonly-author-denied',
      creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal },
    { chapterId: f.chapterId, content: '模型想写全章' })).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    expect(await prisma.chapterQualityReport.count({ where: { runId: result.runId } })).toBe(0)
  }))
  it('freezes owned revision and UTF-16 boundaries before asynchronous execution starts', () => fixture(async f => {
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '修改第一章选区', selection: { start: 5, end: 10, text: '选区原文。' } })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })
    const spec = taskSpecSchema.parse(run.taskSpec)
    expect(spec.scope).toMatchObject({ reviewProtocol: 1, manuscriptProtocol: 1, selectionBoundary: { version: 1, chapterId: f.chapterId,
      revision: 3, start: 5, end: 10, prefix: '前😀段。', suffix: '后段。' } })
    expect(await prisma.agentMessage.count({ where: { runId: run.id, role: 'user' } })).toBe(1)
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }))
  }))
  it.each([{ start: 5, end: 10, text: '旧稿选区。' }, { start: 5, end: 500, text: '越界' }, { start: 5, text: '坐标不完整' }])(
    'rolls back stale/malformed admission and the queued claim: %j', selection => fixture(async f => {
      const queuedId = randomUUID()
      const input = { ...f, mode: 'build' as const, prompt: '修改第一章选区', selection }
      await enqueueRequest(f.userId, queuedId, input)
      const queued = await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id: queuedId } })
      await expect(startLoopRun(f.userId, input, { queuedRequest: { id: queuedId, revision: queued.revision } })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_STALE' })
      expect(await prisma.agentRun.count({ where: { userId: f.userId } })).toBe(0)
      expect(await prisma.agentMessage.count({ where: { sessionId: f.sessionId } })).toBe(0)
      expect(await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id: queuedId } })).toEqual(queued)
      expect(execution).not.toHaveBeenCalled()
    }))
  it.each(['修改第一章', '写下一章'])('freezes a fresh whole-chapter review contract for %s without selection interpretation', prompt => fixture(async f => {
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt })
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec)
    expect(spec.scope.reviewProtocol).toBe(1)
    expect(spec.scope.manuscriptProtocol).toBeUndefined()
    expect(spec.scope.selectionBoundary).toBeUndefined()
    expect(spec.scope.writing?.targets).toEqual(prompt === '修改第一章' ? [{ chapterId: f.chapterId, orderIndex: 1 }] : [{ chapterId: null, orderIndex: 2 }])
  }))
  it('does not mint a writing review protocol for a nonwriting fresh request', () => fixture(async f => {
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '你好' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec).toBeNull()
  }))
})
