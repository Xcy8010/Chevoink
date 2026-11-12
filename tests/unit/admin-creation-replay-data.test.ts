import { beforeEach, expect, it, vi } from 'vitest'
import { getAdminAgentRunDetailsData, getAdminAgentSessionMessagesData } from '../../api/lib/data/admin.js'

const db = vi.hoisted(() => ({
  session: vi.fn(), run: vi.fn(), relatedRuns: vi.fn(), pendingHistory: vi.fn(),
  events: vi.fn(), usage: vi.fn(), attempts: vi.fn(),
  timings: vi.fn(), notices: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async original => ({
  ...await original<object>(),
  prisma: {
    agentSession: { findUnique: db.session }, agentRun: { findFirst: db.run, findMany: db.relatedRuns },
    agentExecutionOutbox: { findFirst: db.pendingHistory },
    agentRunEvent: { findMany: db.events }, aiUsageLog: { groupBy: db.usage },
    agentProviderAttempt: { findMany: db.attempts },
  },
}))
vi.mock('../../api/lib/agent/message-timing.js', () => ({ loadMessageTimings: db.timings }))
vi.mock('../../api/lib/agent/events.js', async original => ({ ...await original<object>(), loadServerRunNotices: db.notices }))

const time = new Date('2026-11-12T16:04:21Z')
const message = (id: string, role: string, parts: unknown[]) => ({ id, role, parts, runId: 'run', createdAt: time })

beforeEach(() => {
  vi.clearAllMocks()
  db.timings.mockResolvedValue(new Map())
  db.notices.mockResolvedValue(new Map())
  db.relatedRuns.mockResolvedValue([])
  db.pendingHistory.mockResolvedValue(null)
})

it('includes original durable messages beyond the physical page and reports a known history gap without writing', async () => {
  const resumed = {
    id: 'resume-21', mode: 'act', action: 'workspaceAgent', status: 'completed', createdAt: time,
    finishedAt: time, startedAt: time, usage: null, goalExecution: null, taskRootId: 'root',
    runtimeProtocolVersion: 1, taskRoot: { status: 'completed' }, messages: [],
  }
  db.session.mockResolvedValue({
    id: 'session', userId: 'owner', title: '合成会话', createdAt: time,
    novel: { title: '合成作品', displayTitle: null },
    runs: [resumed, { ...resumed, id: 'resume-20' }],
  })
  db.relatedRuns.mockResolvedValue([{
    ...resumed, id: 'original', createdAt: new Date(time.getTime() - 60_000),
    messages: [{ ...message('original-request', 'user', [{ type: 'text', text: '原始作者输入' }]), runId: 'original' }],
  }])
  db.pendingHistory.mockResolvedValue({ id: 'pending-source' })
  const payload = await getAdminAgentSessionMessagesData('session', { replay: true, pageSize: 1 })
  expect(payload).toMatchObject({ hasMore: true, nextCursor: 'resume-21', historyPending: true })
  expect(payload?.runs.map(run => run.id)).toEqual(['original', 'resume-21'])
  expect(payload?.runs[0].messages[0].parts).toEqual([{ type: 'text', text: '原始作者输入' }])
  expect(db.relatedRuns.mock.lastCall?.[0].where).toMatchObject({
    sessionId: 'session', userId: 'owner', id: { notIn: ['resume-21'] }, taskRootId: { in: ['root'] },
    runtimeProtocolVersion: 1, messages: { some: {} },
  })
  expect(db.pendingHistory.mock.lastCall?.[0].where).toMatchObject({
    taskRootId: { in: ['root'] }, projections: { none: {} },
  })
  expect(db.timings).toHaveBeenCalledWith('owner', 'session', ['original', 'resume-21'])
})

it('keeps legacy transcript compatibility and projects replay messages to the requested author and session', async () => {
  const privateTool = {
    type: 'tool-call', toolName: 'chapter_write', title: '写入正文', callId: 'tool', status: 'success',
    args: { chapterId: 'chapter', internalSecret: 'synthetic-argument' },
    snapshot: { id: 'synthetic-snapshot' },
  }
  db.session.mockResolvedValue({
    id: 'session', userId: 'owner', title: '合成会话', createdAt: time,
    novel: { title: '合成作品', displayTitle: null },
    runs: [{
      id: 'run', mode: 'act', action: 'workspaceAgent', status: 'completed', createdAt: time,
      finishedAt: time, startedAt: time, usage: { outcome: 'completed', deliveryProof: { id: 'synthetic-proof' } },
      goalExecution: { goalId: 'goal', trigger: 'goal_auto' },
      runtimeProtocolVersion: 1, taskRoot: { status: 'completed' },
      messages: [
        message('system', 'user', [{ type: 'text', text: '合成自动续跑输入' }]),
        message('user', 'user', [{ type: 'text', text: '作者输入' }]),
        message('assistant', 'assistant', [privateTool, { type: 'reasoning', text: '合成思考' }]),
      ],
    }],
  })
  const legacy = await getAdminAgentSessionMessagesData('session')
  expect(legacy?.runs[0].messages[2].parts[0]).toEqual(privateTool)
  expect(db.timings).not.toHaveBeenCalled()

  const result = await getAdminAgentSessionMessagesData('session', { replay: true, userId: 'owner' })
  expect(db.session).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'session', userId: 'owner' } }))
  expect(db.timings).toHaveBeenCalledWith('owner', 'session', ['run'])
  expect(result?.runs[0]).toMatchObject({ usageRecorded: false, startedAt: time.toISOString() })
  expect(result?.runs[0].messages[0]).toMatchObject({ goalContinuation: true, parts: [] })
  expect(result?.runs[0].messages[1]).toMatchObject({ goalContinuation: false, parts: [{ text: '作者输入' }] })
  expect(result?.runs[0].messages[2].parts).toMatchObject([{ type: 'tool-call', args: { chapterId: 'chapter' } }])
  expect(JSON.stringify(result)).not.toMatch(/合成自动续跑输入|合成思考|synthetic-argument|synthetic-snapshot/)
})

it('returns paginated chronological receipts and recorded model/charge evidence without raw payloads', async () => {
  db.run.mockResolvedValue({ userId: 'owner', novelId: 'novel' })
  db.events.mockResolvedValue([
    { seq: 1, type: 'tool.call', createdAt: time, payload: { toolName: 'ask_user', callId: 'ask', args: { hidden: 'synthetic-argument' } } },
    { seq: 2, type: 'tool.result', createdAt: time, payload: { toolName: 'ask_user', callId: 'ask', ok: true,
      display: { kind: 'question', unanswered: true, question: '合成问题' }, summary: '提问未获回答', durationMs: 600_000 } },
    ...Array.from({ length: 99 }, (_, index) => ({ seq: index + 3, type: 'tool.result', createdAt: time,
      payload: { toolName: 'novel_create', callId: `create-${index}`, ok: false, failureCode: 'NOVEL_DIRECTION_REQUIRED', summary: '请先确认方向' } })),
  ])
  db.usage.mockResolvedValue([
    { modelName: 'legacy-model', billingStatus: 'settled', _sum: { creditChargeMilli: 450_000 } },
    { modelName: 'legacy-model', billingStatus: 'pending_usage', _sum: { creditChargeMilli: 0 } },
  ])
  db.attempts.mockResolvedValue([{ model: 'durable-model' }])
  const details = await getAdminAgentRunDetailsData('session', 'run')
  expect(details).toMatchObject({ models: ['durable-model', 'legacy-model'], creditsMilli: 450_000, nextAfter: 100 })
  expect(details?.events).toHaveLength(100)
  expect(details?.events.slice(0, 3)).toMatchObject([
    { seq: 1, outcome: 'dispatched' }, { seq: 2, outcome: 'unanswered', durationMs: 600_000 },
    { seq: 3, outcome: 'failed', failureCode: 'NOVEL_DIRECTION_REQUIRED' },
  ])
  expect(JSON.stringify(details)).not.toMatch(/synthetic-argument|合成问题/)
  expect(db.events).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { seq: 'asc' }, take: 101 }))

  await getAdminAgentRunDetailsData('session', 'run', 100)
  expect(db.events.mock.lastCall?.[0].where.seq).toEqual({ gt: 100 })
  expect(db.usage).toHaveBeenCalledTimes(1)
  db.run.mockResolvedValue(null)
  await expect(getAdminAgentRunDetailsData('other-session', 'run')).resolves.toBeNull()
  expect(db.run.mock.lastCall?.[0].where).toEqual({ id: 'run', sessionId: 'other-session' })
  expect(db.events).toHaveBeenCalledTimes(2)
})
