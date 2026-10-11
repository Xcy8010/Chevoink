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
    await prisma.agentQueuedRequest.deleteMany({ where: { userId } })
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.chapter.deleteMany({ where: { novelId, authorId: userId } })
    await prisma.novel.deleteMany({ where: { id: novelId, authorId: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
}
describe.skipIf(!available)('fresh selected server admission transaction', () => {
  it('freezes owned revision and UTF-16 boundaries before asynchronous execution starts', () => fixture(async f => {
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '修改第一章选区', selection: { start: 5, end: 10, text: '选区原文。' } })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })
    const spec = taskSpecSchema.parse(run.taskSpec)
    expect(spec.scope).toMatchObject({ manuscriptProtocol: 1, selectionBoundary: { version: 1, chapterId: f.chapterId,
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
  it('leaves nonselected fresh startup on the existing protocol', () => fixture(async f => {
    const result = await startLoopRun(f.userId, { ...f, mode: 'build', prompt: '修改第一章' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })).taskSpec).toBeNull()
  }))
})
