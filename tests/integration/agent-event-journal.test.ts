import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { prisma } from '../../api/lib/prisma.js'
import { createRunEventBus, disposeRunEventBus, loadPersistedEvents, prepareRunEventResume } from '../../api/lib/agent/events.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { streamLoopRun } from '../../api/lib/agent/run-service.js'
import { listLoopSessionMessages } from '../../api/lib/agent/session-messages.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID()
const runIds: string[] = []
const realTransaction = prisma.$transaction.bind(prisma)
const realCreateMany = prisma.agentRunEvent.createMany.bind(prisma.agentRunEvent)
afterEach(() => {
  vi.restoreAllMocks()
  // Prisma exposes client methods through a proxy; restoring a spy can leave
  // its virtual property undefined. Keep later cases and cleanup on the real DB.
  prisma.$transaction = realTransaction
  prisma.agentRunEvent.createMany = realCreateMany
})
afterAll(async () => {
  try {
    for (const id of runIds) await disposeRunEventBus(id)
    if (dbAvailable) await prisma.$transaction([
      prisma.agentRun.deleteMany({ where: { id: { in: runIds }, userId } }),
      prisma.agentSession.deleteMany({ where: { id: sessionId, userId } }),
      prisma.novel.deleteMany({ where: { id: novelId, authorId: userId } }),
      prisma.user.deleteMany({ where: { id: userId } }),
    ])
  } finally { await prisma.$disconnect() }
})

describe.skipIf(!dbAvailable)('R01 real PostgreSQL journal commit and resume', () => {
  beforeAll(async () => {
    await prisma.$transaction(async tx => {
      await tx.user.create({ data: { id: userId, nickname: 'journal-fixture', passwordHash: 'fixture-only' } })
      await tx.novel.create({ data: { id: novelId, authorId: userId, title: 'journal-fixture', slug: randomUUID(), summary: '' } })
      await tx.agentSession.create({ data: { id: sessionId, userId, novelId, title: 'journal-fixture' } })
    })
  })
  async function newRun() {
    const run = await prisma.agentRun.create({ data: {
      sessionId, userId, novelId, engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'paused',
    } })
    runIds.push(run.id)
    return run.id
  }

  it('commits the legacy run state and final event together before live publication', async () => {
    const runId = await newRun()
    const bus = createRunEventBus(runId)
    const listener = vi.fn()
    bus.subscribe(listener)
    const final = await bus.commitTerminal({ type: 'run.finished', status: 'succeeded',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, artifacts: [], outputSummary: '已保存' },
      tx => tx.agentRun.update({ where: { id: runId }, data: { status: 'completed' } }))
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('completed')
    expect(await loadPersistedEvents(runId)).toEqual([expect.objectContaining({ type: 'run.finished', status: 'succeeded' })])
    expect(listener).not.toHaveBeenCalled()
    final.publish()
    final.publish()
    expect(listener).toHaveBeenCalledOnce()
    await disposeRunEventBus(runId)
    expect(await prisma.agentRunEvent.count({ where: { runId } })).toBe(1)
  })

  it.each(['commit', 'journal-rollback'] as const)('%s keeps server-projected message and ordered terminal journal in the same transaction', async scenario => {
    const runId = await newRun(), messageId = randomUUID()
    const bus = createRunEventBus(runId), listener = vi.fn()
    bus.subscribe(listener)
    if (scenario === 'journal-rollback') await prisma.agentRunEvent.create({ data: { runId, seq: 2, type: 'fixture.conflict', payload: {} } })
    const write = bus.commitTerminal({ type: 'run.finished', status: 'succeeded', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, artifacts: [], outputSummary: '章标题' }, async tx => {
      await tx.agentMessage.create({ data: { id: messageId, runId, sessionId, role: 'assistant', parts: [{ type: 'text', text: '章标题\n\n当前正文' }] } })
      await tx.agentRun.update({ where: { id: runId }, data: { status: 'completed' } })
    }, [{ type: 'message.start', messageId, role: 'assistant' }, { type: 'text.final', messageId, text: '章标题\n\n当前正文', asReasoning: false }])
    if (scenario === 'journal-rollback') {
      await expect(write).rejects.toThrow()
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('paused')
      expect(await prisma.agentMessage.count({ where: { id: messageId } })).toBe(0)
      expect(await prisma.agentRunEvent.count({ where: { runId, type: { in: ['message.start', 'text.final', 'run.finished'] } } })).toBe(0)
      expect(listener).not.toHaveBeenCalled()
    } else {
      const final = await write
      expect(listener).not.toHaveBeenCalled()
      expect((await loadPersistedEvents(runId)).map(event => [event.seq, event.type])).toEqual([[1, 'message.start'], [2, 'text.final'], [3, 'run.finished']])
      expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: messageId } })).parts).toEqual([{ type: 'text', text: '章标题\n\n当前正文' }])
      final.publish()
      final.publish()
      expect(listener.mock.calls.map(([event]) => event.type)).toEqual(['message.start', 'text.final', 'run.finished'])
    }
    await disposeRunEventBus(runId)
  })

  it.each(['commit', 'journal-rollback', 'lost-acknowledgement'] as const)('%s keeps the failed reason, conversation explanation and ordered events atomic', async scenario => {
    const runId = await newRun(), messageId = randomUUID()
    const reason = '合成模型连续两轮未返回有效内容，任务未完成，已保存内容保留。'
    const usage = { promptTokens: 20, completionTokens: 0, totalTokens: 20 }
    const bus = createRunEventBus(runId), listener = vi.fn()
    bus.subscribe(listener)
    if (scenario === 'journal-rollback') await prisma.agentRunEvent.create({ data: { runId, seq: 2, type: 'fixture.conflict', payload: {} } })
    if (scenario === 'lost-acknowledgement') vi.spyOn(prisma, '$transaction').mockImplementationOnce(work =>
      realTransaction(work).then(() => { throw new Error('synthetic lost failure commit acknowledgement') }))
    const write = bus.commitTerminal({ type: 'run.finished', status: 'failed', usage, artifacts: [], outputSummary: '' }, async tx => {
      await tx.agentMessage.create({ data: { id: messageId, runId, sessionId, role: 'assistant', parts: [{ type: 'text', text: reason }] } })
      return tx.agentRun.update({ where: { id: runId, runtimeProtocolVersion: 0, taskRootId: null },
        data: { status: 'failed', errorMessage: reason, outputSummary: null, usage, currentTurn: 2, finishedAt: new Date() } })
    }, [{ type: 'message.start', messageId, role: 'assistant' }, { type: 'text.final', messageId, text: reason, asReasoning: false }])
    if (scenario === 'journal-rollback') {
      await expect(write).rejects.toThrow()
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'paused', errorMessage: null, currentTurn: 0 })
      expect(await prisma.agentMessage.count({ where: { id: messageId } })).toBe(0)
      expect(await prisma.agentRunEvent.count({ where: { runId, type: { in: ['message.start', 'text.final', 'run.finished'] } } })).toBe(0)
      expect(listener).not.toHaveBeenCalled()
    } else {
      if (scenario === 'lost-acknowledgement') await expect(write).rejects.toThrow('commit acknowledgement')
      else {
        const final = await write
        expect(listener).not.toHaveBeenCalled()
        final.publish()
        final.publish()
        expect(listener.mock.calls.map(([event]) => event.type)).toEqual(['message.start', 'text.final', 'run.finished'])
      }
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'failed', errorMessage: reason, currentTurn: 2, usage })
      expect((await loadPersistedEvents(runId)).map(event => [event.seq, event.type])).toEqual([[1, 'message.start'], [2, 'text.final'], [3, 'run.finished']])
      for (const options of [{}, { runLimit: 20 }]) {
        const history = await listLoopSessionMessages(userId, sessionId, options)
        expect(history.messages.filter(message => message.id === messageId)).toEqual([
          expect.objectContaining({ role: 'assistant', parts: [{ type: 'text', text: reason }] }),
        ])
      }
      if (scenario === 'lost-acknowledgement') expect(listener).not.toHaveBeenCalled()
    }
    await disposeRunEventBus(runId)
    if (scenario === 'lost-acknowledgement') expect(await prepareRunEventResume(runId)).toBe(3)
  })

  it('returns real completion timestamps in full and paged history without changing send times', async () => {
    const runId = await newRun()
    const createdAt = new Date('2026-09-09T10:00:00Z'), finishedAt = new Date('2026-09-09T10:05:00Z')
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'completed', finishedAt } })
    const userMessage = await prisma.agentMessage.create({ data: { runId, sessionId, role: 'user', parts: [], createdAt } })
    const assistant = await prisma.agentMessage.create({ data: { runId, sessionId, role: 'assistant', parts: [{ type: 'text', text: '完成' }], createdAt } })
    for (const options of [{}, { runLimit: 20 }]) {
      const { messages } = await listLoopSessionMessages(userId, sessionId, options)
      expect(messages.find(message => message.id === assistant.id)).toMatchObject({ createdAt: createdAt.toISOString(), completedAt: finishedAt.toISOString() })
      expect(messages.find(message => message.id === userMessage.id)).toMatchObject({ createdAt: createdAt.toISOString(), completedAt: null })
    }
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'failed' } })
    expect((await listLoopSessionMessages(userId, sessionId)).messages.find(message => message.id === assistant.id)?.completedAt).toBeNull()
  })

  it('rolls the state update back when the terminal event insert fails', async () => {
    const runId = await newRun()
    await prisma.agentRunEvent.create({ data: { runId, seq: 1, type: 'text.delta', payload: { fixture: 'sequence conflict' } } })
    const bus = createRunEventBus(runId)
    const listener = vi.fn()
    bus.subscribe(listener)
    await expect(bus.commitTerminal({ type: 'run.paused', reason: 'user_stop' },
      tx => tx.agentRun.update({ where: { id: runId }, data: { status: 'completed' } }))).rejects.toThrow()
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('paused')
    expect(listener).not.toHaveBeenCalled()
    expect(await prisma.agentRunEvent.count({ where: { runId, type: 'run.paused' } })).toBe(0)
    await disposeRunEventBus(runId)
  })

  it('retains both committed facts when the transaction acknowledgement is lost', async () => {
    const runId = await newRun()
    const transact = prisma.$transaction.bind(prisma)
    vi.spyOn(prisma, '$transaction').mockImplementationOnce(work =>
      transact(work).then(() => { throw new Error('lost terminal commit acknowledgement') }))
    const bus = createRunEventBus(runId)
    const listener = vi.fn()
    bus.subscribe(listener)
    await expect(bus.commitTerminal({ type: 'run.paused', reason: 'user_stop' },
      tx => tx.agentRun.update({ where: { id: runId }, data: { status: 'paused', outputSummary: '已保存' } }))).rejects.toThrow('commit acknowledgement')
    expect(listener).not.toHaveBeenCalled()
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).outputSummary).toBe('已保存')
    expect(await loadPersistedEvents(runId)).toEqual([expect.objectContaining({ type: 'run.paused', seq: 1 })])
    await disposeRunEventBus(runId)
    expect(await prepareRunEventResume(runId)).toBe(1)
  })

  it.each(['running', 'queued', 'awaiting_approval', 'completed'] as const)('R09: replay without a local bus respects stored %s state', async status => {
    const runId = await newRun()
    const usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 }
    await prisma.agentRun.update({ where: { id: runId }, data: { status, usage } })
    const chunks: string[] = []
    const response = { writeHead: vi.fn(), write: (chunk: string) => { chunks.push(chunk); return true }, end: vi.fn(), on: vi.fn() }
    await streamLoopRun(userId, runId, 0, response as unknown as import('express').Response)
    const events = chunks.flatMap(chunk => chunk.startsWith('data: ') ? [JSON.parse(chunk.slice(6)) as { type: string; status?: string; usage?: unknown }] : [])
    if (status === 'completed') expect(events).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded', usage }))
    else expect(events.some(event => event.type === 'run.finished' || event.type === 'run.paused')).toBe(false)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(status)
    expect(response.end).toHaveBeenCalledOnce()
  })

  it('commits all bursts before dispose and appends resumed events without colliding with old seq', async () => {
    const runId = await newRun()
    const bus = createRunEventBus(runId)
    const expected = Array.from({ length: 100 }, () => bus.emit({ type: 'run.paused', reason: 'user_stop' }))
    await Promise.all([disposeRunEventBus(runId), disposeRunEventBus(runId)])
    expect(await loadPersistedEvents(runId)).toEqual(expected)
    const startSeq = await prepareRunEventResume(runId)
    expect(startSeq).toBe(100)
    const resumed = createRunEventBus(runId, startSeq)
    const added = resumed.emit({ type: 'run.paused', reason: 'user_stop' })
    await disposeRunEventBus(runId)
    expect(added.seq).toBe(101)
    expect(await loadPersistedEvents(runId, 100)).toEqual([added])
    expect(await prisma.agentRunEvent.count({ where: { runId } })).toBe(101)
  })

  it.each(['before', 'after'] as const)('retries a failure %s the real commit without losing or duplicating rows', async boundary => {
    const runId = await newRun()
    const createMany = prisma.agentRunEvent.createMany.bind(prisma.agentRunEvent)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(prisma.agentRunEvent, 'createMany').mockImplementation(createMany).mockImplementationOnce(args => {
      const fault = boundary === 'before'
        ? Promise.reject(new Error('injected failure before COMMIT'))
        : createMany(args).then(() => { throw new Error('injected acknowledgement failure after COMMIT') })
      // The journal awaits this call directly, not as an array transaction.
      // Preserve Prisma's promise surface while injecting a post-commit failure.
      return {
        then: fault.then.bind(fault), catch: fault.catch.bind(fault), finally: fault.finally.bind(fault),
        [Symbol.toStringTag]: 'PrismaPromise',
      }
    })
    const bus = createRunEventBus(runId)
    const event = bus.emit({ type: 'run.paused', reason: 'user_stop' })
    await expect(disposeRunEventBus(runId)).rejects.toThrow(`${boundary} COMMIT`)
    expect(await loadPersistedEvents(runId)).toEqual(boundary === 'before' ? [] : [event])
    await disposeRunEventBus(runId)
    expect(await loadPersistedEvents(runId)).toEqual([event])
    expect(await prisma.agentRunEvent.count({ where: { runId } })).toBe(1)
  })
})
