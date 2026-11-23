import { afterEach, describe, expect, it, vi } from 'vitest'

import { compactSessionContext, getContextState, isAfterCheckpointBoundary } from '../../api/lib/agent/context-engine.js'
import { prisma } from '../../api/lib/prisma.js'

afterEach(() => vi.restoreAllMocks())

it('reads the measured model window for new clients and keeps the saved-history view for legacy clients', async () => {
  vi.spyOn(prisma.agentSession, 'findFirst').mockResolvedValue({ novelId: 'book' } as never)
  vi.spyOn(prisma.contextCheckpoint, 'findFirst').mockResolvedValue(null)
  vi.spyOn(prisma.userDirective, 'findMany').mockResolvedValue([])
  const modelUsage = { estimatedTokens: 90000, contextWindowTokens: 128000, compactAtTokens: 99840 }
  const events = vi.spyOn(prisma.agentRunEvent, 'findFirst').mockResolvedValueOnce({
    runId: 'resumed-older-run', seq: 15, createdAt: new Date(), payload: modelUsage,
  } as never).mockResolvedValue(null)
  const messages = vi.spyOn(prisma.agentMessage, 'findMany').mockResolvedValue([])
  expect(await getContextState('owner', 'session', true)).toMatchObject({
    estimatedTokens: 90000, contextWindowTokens: 228000, compactionThreshold: 1, requestSample: { runId: 'resumed-older-run', seq: 15 },
  })
  events.mockResolvedValueOnce({ runId: 'small-model', seq: 1, createdAt: new Date(), payload: {
    ...modelUsage, contextWindowTokens: 64000, compactAtTokens: 50000,
  } } as never)
  expect(await getContextState('owner', 'session', true)).toMatchObject({
    estimatedTokens: 90000, contextWindowTokens: 228000, usageRatio: 90000 / 228000,
  })
  expect(messages).not.toHaveBeenCalled()
  expect(events).toHaveBeenCalledWith(expect.objectContaining({
    where: { type: 'context.usage', run: expect.objectContaining({ userId: 'owner', sessionId: 'session' }) },
    orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }, { id: 'desc' }],
  }))
  for (const preferRequest of [false, true]) {
    const historic = await getContextState('owner', 'session', preferRequest)
    expect(historic.estimatedTokens).toBe(0)
    expect(historic.requestSample).toBeUndefined()
  }
})

it('counts retained history and discards older samples even if the run is active', async () => {
  const createdAt = new Date('2026-11-24T01:00:00Z')
  vi.spyOn(prisma.agentSession, 'findFirst').mockResolvedValue({ novelId: 'book' } as never)
  vi.spyOn(prisma.contextCheckpoint, 'findFirst').mockResolvedValue({ id: 'checkpoint', sessionId: 's', version: 1,
    sourceEndedAt: new Date('2026-11-23'), sourceMessageIds: ['source'], createdAt, summaryTokens: 20 } as never)
  vi.spyOn(prisma.userDirective, 'findMany').mockResolvedValue([])
  vi.spyOn(prisma.agentRunEvent, 'findFirst').mockResolvedValueOnce({
    runId: 'r', seq: 15, createdAt: new Date('2026-11-23'), payload: { estimatedTokens: 103082, contextWindowTokens: 128000, compactAtTokens: 99840 },
  } as never).mockResolvedValue(null)
  vi.spyOn(prisma.agentMessage, 'findMany').mockResolvedValue([
    { createdAt, parts: [{ type: 'text', text: '旧' }] },
    { createdAt: new Date(createdAt.getTime() + 100), parts: [{ type: 'text', text: '新内容' }] },
  ] as never)
  const state = await getContextState('owner', 's', true)
  expect(state).toMatchObject({ estimatedTokens: 25 })
  expect(state.requestSample).toBeUndefined()
})

describe('上下文检查点边界', () => {
  const timestamp = new Date('2026-09-04T12:00:00.000Z')

  it('keeps a recent verbatim tail and reports its real size together with the new checkpoint', async () => {
    const rows = Array.from({ length: 24 }, (_, index) => ({
      id: String(index), runId: 'completed', role: index % 2 ? 'assistant' : 'user',
      parts: [{ type: 'text', text: '文'.repeat(10000) }], createdAt: new Date(timestamp.getTime() + index),
      run: { status: 'completed', outputSummary: '本轮已完成' },
    }))
    vi.spyOn(prisma.agentSession, 'findFirst').mockResolvedValue({ novelId: 'book' } as never)
    vi.spyOn(prisma.userDirective, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([])
    vi.spyOn(prisma, '$transaction').mockImplementation(async work => (work as (tx: typeof prisma) => Promise<unknown>)(prisma))
    const fetch = vi.spyOn(prisma.agentMessage, 'findMany').mockResolvedValueOnce(rows as never)
    const read = vi.spyOn(prisma.contextCheckpoint, 'findFirst').mockResolvedValue(null)
    const write = vi.spyOn(prisma.contextCheckpoint, 'create').mockImplementation(async ({ data }) =>
      ({ ...data, id: 'checkpoint', createdAt: new Date() }) as never)
    const result = await compactSessionContext('owner', 's', 102600)
    expect(result?.version).toBe(1)
    const stored = write.mock.calls[0][0].data
    const tail = rows.slice(stored.sourceMessageCount)
    expect(tail).toHaveLength(10)
    read.mockResolvedValue({ ...stored, id: 'checkpoint', createdAt: new Date() } as never)
    fetch.mockResolvedValue(tail as never)
    const state = await getContextState('owner', 's')
    expect(state.estimatedTokens).toBeGreaterThanOrEqual(100000 + result!.summaryTokens)
    expect(state.usageRatio).toBeGreaterThan(0.4)
    expect(state.usageRatio).toBeLessThan(0.5)
  })

  it('同毫秒消息使用 id 作为稳定次序，不会静默漏掉边界后的消息', () => {
    const boundary = { createdAt: timestamp, messageId: 'message-b' }
    expect(isAfterCheckpointBoundary({ id: 'message-a', createdAt: timestamp }, boundary)).toBe(false)
    expect(isAfterCheckpointBoundary({ id: 'message-b', createdAt: timestamp }, boundary)).toBe(false)
    expect(isAfterCheckpointBoundary({ id: 'message-c', createdAt: timestamp }, boundary)).toBe(true)
  })

  it('兼容旧检查点无末条消息 id 的时间边界', () => {
    const boundary = { createdAt: timestamp, messageId: null }
    expect(isAfterCheckpointBoundary({ id: 'message-z', createdAt: timestamp }, boundary)).toBe(false)
    expect(isAfterCheckpointBoundary({ id: 'message-a', createdAt: new Date(timestamp.getTime() + 1) }, boundary)).toBe(true)
  })
})
