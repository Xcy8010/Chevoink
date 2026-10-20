import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
const execution = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: execution }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(async () => {}), getModelTierRuntime: vi.fn(async () => ({ reasoningEffort: 'high' })) }))
vi.mock('../../api/lib/agent/writing-experiments.js', () => ({ recordSevenDayContinuation: vi.fn(async () => {}) }))
import { prisma } from '../../api/lib/prisma.js'
import { startLoopRun } from '../../api/lib/agent/run-service.js'
import { enqueueRequest } from '../../api/lib/agent/request-queue.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import * as skillService from '../../api/lib/agent/skills/service.js'
import { chapterEditRangeTool, chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { getToolsForMode } from '../../api/lib/agent/tools/registry.js'
import { restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'

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
        code: prompt.includes('整章') ? 'REPAIR_NOT_AUTHORIZED' : 'AUTHOR_LOCAL_SCOPE',
      })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
      expect(await prisma.chapterQualityReport.count({ where: { runId: result.runId } })).toBe(0)
    }))
  it('does not reinterpret an unmarked original whole-chapter request as a fresh assessment contract', () => fixture(async f => {
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '首段。\n第二段原文。\n末段。' } })
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '检查是否需要修改整章' })
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec)
    delete spec.scope.localEditProtocol
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
