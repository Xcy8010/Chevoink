import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
const execution = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: execution }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(async () => {}), getModelTierRuntime: vi.fn(async () => ({ reasoningEffort: 'high' })) }))
vi.mock('../../api/lib/agent/writing-experiments.js', () => ({ recordSevenDayContinuation: vi.fn(async () => {}) }))
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { actOnQueuedRequest, dispatchQueuedRequests, enqueueRequest, listQueuedRequests } from '../../api/lib/agent/request-queue.js'
import { continueLoopRun, startLoopRun } from '../../api/lib/agent/run-service.js'
import { env } from '../../api/config/env.js'
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })

describe.skipIf(!dbAvailable)('queue database transactions (isolated test DB)', () => {
  let userId = '', novelId = '', sessionId = ''
  beforeEach(async () => {
    execution.mockClear()
    const user = await prisma.user.create({ data: { nickname: 'queue-test', passwordHash: 'not-a-real-password' } })
    userId = user.id
    const novel = await prisma.novel.create({ data: { authorId: userId, title: '队列测试', slug: randomUUID(), summary: '' } })
    novelId = novel.id
    const session = await prisma.agentSession.create({ data: { userId, novelId, title: '源会话' } })
    sessionId = session.id
  })
  const enqueue = async (prompt = '第20章完整要求') => {
    const id = randomUUID()
    await enqueueRequest(userId, id, { sessionId, novelId, mode: 'build', prompt, creativeFreedom: 'bold', qualityMode: 'premium', pinnedSkillIds: ['skill-a'] })
    return id
  }
  it('parallel duplicate admission and dispatch create exactly one run, with atomic linkage', async () => {
    const id = randomUUID(), input = { sessionId, novelId, mode: 'build' as const, prompt: '写第20章' }
    await Promise.all([enqueueRequest(userId, id, input), enqueueRequest(userId, id, input)])
    await Promise.all([dispatchQueuedRequests(), dispatchQueuedRequests()])
    const row = await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('dispatched')
    expect(row.runId).toBeTruthy()
    expect(await prisma.agentRun.count({ where: { sessionId } })).toBe(1)
    expect(await prisma.agentMessage.count({ where: { runId: row.runId!, role: 'user' } })).toBe(1)
    await dispatchQueuedRequests()
    expect(await prisma.agentRun.count({ where: { sessionId } })).toBe(1)
  })
  it('direct admission saves the full request before the asynchronous executor starts', async () => {
    const prompt = '只处理第19章，不继承旧任务。'.repeat(100)
    const result = await startLoopRun(userId, { sessionId, novelId, mode: 'build', prompt })
    const original = await prisma.agentMessage.findFirstOrThrow({ where: { runId: result.runId, sessionId, role: 'user' } })
    expect(original.parts).toEqual([{ type: 'text', text: prompt }])
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ runId: result.runId, admittedMessageId: original.id, prompt }))
    expect(await prisma.agentMessage.count({ where: { runId: result.runId, role: 'user' } })).toBe(1)
  })
  it('serializes direct starts even before a queued run has a local controller', async () => {
    const input = { sessionId, novelId, mode: 'build' as const, prompt: '只执行一次' }
    const results = await Promise.allSettled([startLoopRun(userId, input), startLoopRun(userId, input)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'RUN_IN_PROGRESS' } })
    expect(await prisma.agentRun.count({ where: { sessionId } })).toBe(1)
    expect(execution).toHaveBeenCalledTimes(1)
  })
  it.each(['queued', 'running', 'awaiting_approval'] as const)('counts stored %s work in new-start and continue limits', async status => {
    const input = { sessionId, novelId, mode: 'build' as const, prompt: '保留当前任务' }
    const original = await startLoopRun(userId, input)
    await prisma.agentRun.update({ where: { id: original.runId }, data: { status: 'paused' } })
    const other = await prisma.agentSession.create({ data: { userId, novelId, title: '其他会话' } })
    for (let index = 0; index < env.agentUserMaxConcurrent; index++) {
      await prisma.agentRun.create({ data: { sessionId: other.id, userId, novelId, engine: 'loop', mode: 'act',
        action: 'workspaceAgent', agentType: 'writingOrchestrator', status } })
    }
    execution.mockClear()
    await expect(startLoopRun(userId, input)).rejects.toMatchObject({ code: 'RUN_LIMIT' })
    await expect(continueLoopRun(userId, original.runId)).rejects.toMatchObject({ code: 'RUN_LIMIT' })
    expect(execution).not.toHaveBeenCalled()
    expect(await prisma.agentRun.count({ where: { sessionId } })).toBe(1)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: original.runId } })).status).toBe('paused')
  })
  it('direct resume preserves selection, skills and internal profile/budget without a queue row', async () => {
    const input = { sessionId, novelId, mode: 'build' as const, prompt: '只处理选中的原文',
      selection: { text: '不能从摘要丢失的选区', start: 12, end: 24 }, creativeFreedom: 'stable' as const,
      qualityMode: 'balanced' as const, pinnedSkillIds: ['skill-a'], agentProfile: 'continuity' as const, tokenBudget: 1200 }
    const result = await startLoopRun(userId, input)
    const stored = await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })
    expect(stored.startRequest).toEqual(input)
    expect(await prisma.agentQueuedRequest.count({ where: { runId: result.runId } })).toBe(0)
    await prisma.agentRun.update({ where: { id: result.runId }, data: { status: 'paused' } })
    await continueLoopRun(userId, result.runId)
    expect(execution).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: input.prompt, selection: input.selection,
      creativeFreedom: 'stable', qualityMode: 'balanced', pinnedSkillIds: ['skill-a'], agentType: 'continuity', tokenBudget: 1200, resume: true }))
  })
  it.each(['scope', 'message', 'malformed'] as const)('refuses %s corruption rather than falling back to a display summary', async kind => {
    const input = { sessionId, novelId, mode: 'build' as const, prompt: '本次第19章要求' }
    const result = await startLoopRun(userId, input)
    await prisma.agentRun.update({ where: { id: result.runId }, data: { status: 'paused',
      ...(kind === 'scope' ? { startRequest: { ...input, novelId: randomUUID() } } : {}),
      ...(kind === 'malformed' ? { startRequest: { prompt: input.prompt } } : {}),
    } })
    if (kind === 'message') await prisma.agentMessage.updateMany({ where: { runId: result.runId, role: 'user' }, data: { parts: [{ type: 'text', text: '旧任务要求' }] } })
    execution.mockClear()
    await expect(continueLoopRun(userId, result.runId)).rejects.toMatchObject({ code: 'RUN_INPUT_MISMATCH' })
    expect(execution).not.toHaveBeenCalled()
  })
  it('FIFO waits for terminal completion; paused work requires explicit steer', async () => {
    const first = await enqueue('先完成第20章')
    const second = await enqueue('再完成第21章')
    await dispatchQueuedRequests()
    const runId = (await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id: first } })).runId!
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'paused' } })
    await dispatchQueuedRequests()
    expect((await listQueuedRequests(userId, sessionId)).items[0].id).toBe(second)
    await actOnQueuedRequest(userId, sessionId, second, 'steer', 0)
    await dispatchQueuedRequests()
    expect((await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id: second } })).status).toBe('dispatched')
    expect(await prisma.agentRun.count({ where: { sessionId } })).toBe(2)
  })
  it.each(['new', 'fork'] as const)('moves to %s window atomically and stale retries cannot create extra windows', async action => {
    const id = await enqueue()
    const result = await actOnQueuedRequest(userId, sessionId, id, action, 0)
    expect(result.session?.id).not.toBe(sessionId)
    const row = await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id } })
    expect(row.sessionId).toBe(result.session?.id)
    expect((row.payload as { sessionId: string }).sessionId).toBe(row.sessionId)
    await expect(actOnQueuedRequest(userId, sessionId, id, action, 0)).rejects.toMatchObject({ code: 'QUEUE_CHANGED' })
    expect(await prisma.agentSession.count({ where: { userId } })).toBe(2)
  })
  it('a stale queue claim rolls back run creation, and delete cascades pending entries', async () => {
    const id = await enqueue()
    await actOnQueuedRequest(userId, sessionId, id, 'edit', 0, '修改后的要求')
    await expect(startLoopRun(userId, { sessionId, novelId, mode: 'build', prompt: '旧要求' }, { queuedRequest: { id, revision: 0 } })).rejects.toMatchObject({ code: 'QUEUE_CHANGED' })
    expect(await prisma.agentRun.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.agentMessage.count({ where: { sessionId } })).toBe(0)
    await prisma.agentSession.delete({ where: { id: sessionId } })
    expect(await prisma.agentQueuedRequest.count({ where: { id } })).toBe(0)
  })
  it('resumes full queued input even if a crash preceded the first user message', async () => {
    const prompt = '原始完整要求'.repeat(120)
    const id = await enqueue(prompt)
    await dispatchQueuedRequests()
    const runId = (await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id } })).runId!
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'failed' } })
    await continueLoopRun(userId, runId)
    expect(execution).toHaveBeenLastCalledWith(expect.objectContaining({ prompt, creativeFreedom: 'bold', qualityMode: 'premium', pinnedSkillIds: ['skill-a'], resume: true }))
  })
  it('names a new queued window by its task while preserving the full request and source name', async () => {
    const prompt = '## 第一章 压酱油瓶的那枚铜钱\n林辰这天走过巷口。\n请修订第二章正文。'
    const id = await enqueue(prompt)
    const result = await actOnQueuedRequest(userId, sessionId, id, 'new', 0)
    expect(result.session?.title).toBe('修订第二章正文')
    expect((await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } })).title).toBe('源会话')
    const queued = await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id } })
    expect(queued.payload).toMatchObject({ prompt, sessionId: result.session?.id })
    await expect(actOnQueuedRequest(userId, sessionId, id, 'new', 0)).rejects.toMatchObject({ code: 'QUEUE_CHANGED' })
    expect(await prisma.agentSession.count({ where: { userId } })).toBe(2)
    expect(execution).not.toHaveBeenCalled()
    expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(0)
  })
})
