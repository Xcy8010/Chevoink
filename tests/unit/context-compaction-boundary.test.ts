import { afterEach, describe, expect, it, vi } from 'vitest'

import { getContextState, isAfterCheckpointBoundary } from '../../api/lib/agent/context-engine.js'
import { prisma } from '../../api/lib/prisma.js'

afterEach(() => vi.restoreAllMocks())

it('reads the measured model window for new clients and keeps the saved-history view for legacy clients', async () => {
  vi.spyOn(prisma.agentSession, 'findFirst').mockResolvedValue({ novelId: 'book' } as never)
  vi.spyOn(prisma.contextCheckpoint, 'findFirst').mockResolvedValue(null)
  vi.spyOn(prisma.userDirective, 'findMany').mockResolvedValue([])
  const modelUsage = { estimatedTokens: 90000, contextWindowTokens: 128000, compactAtTokens: 99840 }
  const runs = vi.spyOn(prisma.agentRun, 'findFirst').mockResolvedValueOnce({
    id: 'run', status: 'completed', events: [{ seq: 15, createdAt: new Date(), payload: modelUsage }],
  } as never).mockResolvedValue(null)
  const messages = vi.spyOn(prisma.agentMessage, 'findMany').mockResolvedValue([])
  expect(await getContextState('owner', 'session', true)).toMatchObject({
    estimatedTokens: 90000, contextWindowTokens: 128000, compactionThreshold: 0.78, requestSample: { runId: 'run', seq: 15 },
  })
  expect(messages).not.toHaveBeenCalled()
  expect(runs).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
    userId: 'owner', sessionId: 'session', events: { some: { type: 'context.usage' } },
  }) }))
  for (const preferRequest of [false, true]) {
    const historic = await getContextState('owner', 'session', preferRequest)
    expect(historic.estimatedTokens).toBe(0)
    expect(historic.requestSample).toBeUndefined()
  }
})

describe('上下文检查点边界', () => {
  const timestamp = new Date('2026-09-04T12:00:00.000Z')

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
