import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({
  agentRun: { findFirst: vi.fn(), findMany: vi.fn() },
  agentSession: { findUnique: vi.fn(), findMany: vi.fn() },
  agentArtifact: { findMany: vi.fn() }, projectMemoryEntry: { findMany: vi.fn() }, $transaction: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(), prisma: db }))
import { continueLoopRun, listAgentSessionHistoryData, listSessionRunStatuses } from '../../api/lib/agent/run-service.js'
const ended = { fulfilled: false, todoItems: [{ id: 'todo-1', content: '剩余工作', status: 'cancelled', reason: '作者要求结束' }] }
const record = { id: 'run', userId: 'user', sessionId: 'session', novelId: 'novel', chapterId: null, agentType: 'writingOrchestrator', mode: 'act', action: 'workspaceAgent', status: 'cancelled', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, authorEnded: ended } }
beforeEach(() => {
  vi.clearAllMocks()
  db.agentRun.findFirst.mockResolvedValue(record)
  db.agentRun.findMany.mockResolvedValue([record])
  db.agentSession.findMany.mockResolvedValue([{ id: 'session' }])
  db.agentSession.findUnique.mockResolvedValue({ id: 'session', userId: 'user' })
  db.agentArtifact.findMany.mockResolvedValue([])
  db.projectMemoryEntry.findMany.mockResolvedValue([])
  db.$transaction.mockImplementation(async work => Array.isArray(work) ? Promise.all(work) : Promise.reject(new Error('resume proceeded')))
})
describe('author-ended run API boundary', () => {
  it('rejects resume before mutation or paid execution', async () => {
    await expect(continueLoopRun('user', 'run')).rejects.toMatchObject({ code: 'RUN_AUTHOR_ENDED', status: 409 })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
  it('polls only the newest run disposition and clears ending when a new task starts', async () => {
    expect((await listSessionRunStatuses('user', ['session'])).statuses.session?.authorEnded).toEqual(ended)
    db.agentRun.findMany.mockResolvedValue([{ ...record, id: 'new', status: 'running', usage: {} }, record])
    expect((await listSessionRunStatuses('user', ['session'])).statuses.session).toMatchObject({ runId: 'new', status: 'running' })
    expect((await listSessionRunStatuses('user', ['session'])).statuses.session?.authorEnded).toBeUndefined()
  })
  it('restores author-ended disposition and cancelled items on history refresh', async () => {
    const history = await listAgentSessionHistoryData('user', 'session')
    expect(history.items[0].run.authorEnded).toEqual(ended)
    expect(history.items[0].run.status).toBe('cancelled')
  })
})
