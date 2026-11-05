import { beforeEach, expect, it, vi } from 'vitest'
import { historyClientRequest } from '../../api/lib/agent/message-client-request'
import { startAgentLoopRunSchema } from '../../shared/contracts/schemas'
import { agentGoalExecutionOptionsSchema } from '../../shared/contracts/agent-goal'
import { withHumanAdmission, readHumanAdmission } from '../../api/lib/agent/goal-activation-authority'

const marker = 'c92a0a12-3af7-4e28-bd14-22ec51f7834c'
const request = { sessionId: 'session', novelId: 'novel', mode: 'build' as const, prompt: '合成作者请求', clientRequestId: marker }
const record = (overrides: Partial<Parameters<typeof historyClientRequest>[0]> = {}): Parameters<typeof historyClientRequest>[0] => ({ id: 'author', role: 'user', run: { userId: 'owner', startRequest: request, messages: [{ id: 'author' }] }, ...overrides })
it('validates only a UUID at the public boundary and leaves legacy requests optional', () => {
  expect(startAgentLoopRunSchema.parse(request).clientRequestId).toBe(marker)
  expect(startAgentLoopRunSchema.safeParse({ ...request, clientRequestId: 'not-a-uuid' }).success).toBe(false)
  const { clientRequestId: _marker, ...legacy } = request
  expect(startAgentLoopRunSchema.parse(legacy)).not.toHaveProperty('clientRequestId')
})
it('preserves the original server admission envelope while persisting display correlation', () => {
  const saved = withHumanAdmission(startAgentLoopRunSchema.parse(request))
  expect(saved.clientRequestId).toBe(marker)
  expect(saved.humanAdmission.origin).toBe('http')
  expect(readHumanAdmission(JSON.parse(JSON.stringify(saved)))?.request.clientRequestId).toBe(marker)
  expect(readHumanAdmission(request)).toBeNull()
  expect(agentGoalExecutionOptionsSchema.parse({ mode: 'build', clientRequestId: marker })).not.toHaveProperty('clientRequestId')
})
it('projects only the owned first author message and never an assistant, later author, or foreign run', () => {
  expect(historyClientRequest(record(), 'owner')).toEqual({ clientRequestId: marker })
  expect(historyClientRequest(record({ role: 'assistant' }), 'owner')).toEqual({})
  expect(historyClientRequest(record({ id: 'later-author' }), 'owner')).toEqual({})
  expect(historyClientRequest(record(), 'another-user')).toEqual({})
  expect(historyClientRequest(record({ run: { userId: 'owner', messages: [{ id: 'author' }], startRequest: {} } }), 'owner')).toEqual({})
})
it('binds an explicit steering message to its own saved source id without leaking it onto automatic goal input', () => {
  const steering = record({ id: 'steering', run: { userId: 'owner', messages: [{ id: 'system-auto' }], startRequest: { mode: 'build', authorSteering: { sourceMessageId: 'steering', admission: request } } } })
  expect(historyClientRequest(steering, 'owner')).toEqual({ clientRequestId: marker })
  expect(historyClientRequest({ ...steering, id: 'system-auto', role: 'system' }, 'owner')).toEqual({})
  expect(historyClientRequest({ ...steering, id: 'another-author' }, 'owner')).toEqual({})
})

const db = vi.hoisted(() => ({ agentSession: { findFirst: vi.fn() }, agentRun: { findMany: vi.fn(), findFirst: vi.fn() }, agentMessage: { findMany: vi.fn(), findFirst: vi.fn() }, $transaction: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: db, DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } } }))
vi.mock('../../api/lib/agent/events.js', () => ({ loadServerRunNotices: async () => new Set() }))
vi.mock('../../api/lib/agent/message-timing.js', () => ({ loadMessageTimings: async () => new Map() }))
vi.mock('../../api/lib/agent/quality-body-change-history.js', () => ({ projectLegacyQualityBodyChanges: async (_user: string, records: unknown[]) => records }))
vi.mock('../../api/lib/agent/runtime-event-projection.js', () => ({ publishDurableEvents: vi.fn() }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ getActiveRunIdBySession: () => null, hasActiveRunInSession: () => false }))
vi.mock('../../api/lib/agent/runtime-child.js', () => ({ MAIN_RUN_FILTER: { incomingChildGrant: { is: null } }, prepareChildGrantDeletion: vi.fn() }))
import { listLoopSessionMessages } from '../../api/lib/agent/session-messages'
beforeEach(() => {
  vi.clearAllMocks()
  db.agentSession.findFirst.mockResolvedValue({ id: 'session', forkedFromSessionId: null })
  db.agentRun.findFirst.mockResolvedValue(null)
  db.agentRun.findMany.mockImplementation(async (query: { where: { runtimeProtocolVersion?: number } }) => query.where.runtimeProtocolVersion === 1 ? [] : [{ id: 'run', runtimeProtocolVersion: 0, taskRootId: null, createdAt: new Date('2026-11-05T00:00:00Z') }])
  db.$transaction.mockImplementation(async (body: (tx: typeof db) => unknown) => body(db))
  const run = { userId: 'owner', startRequest: request, runtimeProtocolVersion: 0, taskRoot: null, status: 'completed', finishedAt: null, goalExecution: null, messages: [{ id: 'author' }] }
  const author = { id: 'author', role: 'user', runId: 'run', parts: [{ type: 'text', text: request.prompt }], createdAt: new Date('2026-11-05T00:00:00Z'), run }
  const assistant = { ...author, id: 'assistant', role: 'assistant', createdAt: new Date('2026-11-05T00:00:01Z') }
  db.agentMessage.findMany.mockImplementation(async (query: { orderBy: Array<{ createdAt?: string }> }) => query.orderBy[0].createdAt === 'desc' ? [assistant, author] : [author, assistant])
  db.agentMessage.findFirst.mockResolvedValue({ id: 'author' })
})
it.each([undefined, 20])('returns correlation only on the author in actual owned history projection (runLimit=%s)', async runLimit => {
  const history = await listLoopSessionMessages('owner', 'session', { runLimit })
  expect(history.messages.map(message => message.clientRequestId)).toEqual([marker, undefined])
  expect(db.agentSession.findFirst.mock.calls[0][0].where).toEqual({ id: 'session', userId: 'owner' })
  const query = db.agentMessage.findMany.mock.calls[0][0]
  expect(query.include.run.select).toMatchObject({ startRequest: true, userId: true })
  expect(JSON.stringify(history)).not.toContain('startRequest')
})
it('rejects a different owner before loading any run correlation or messages', async () => {
  db.agentSession.findFirst.mockResolvedValueOnce(null)
  await expect(listLoopSessionMessages('another-owner', 'session')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(db.agentMessage.findMany).not.toHaveBeenCalled()
  expect(db.agentRun.findMany).not.toHaveBeenCalled()
})


it.each([undefined, 20])('restores receipt progress without exposing private reasoning or changing user/input escapes (runLimit=%s)', async runLimit => {
  const literal = '第一行\\n第二行'
  const run = { userId: 'owner', startRequest: request, runtimeProtocolVersion: 0, taskRoot: null, status: 'completed', finishedAt: null, goalExecution: null, messages: [{ id: 'author' }] }
  const records = [
    { id: 'author', role: 'user', runId: 'run', parts: [{ type: 'text', text: literal }], createdAt: new Date('2026-11-05T00:00:00Z'), run },
    { id: 'assistant', role: 'assistant', runId: 'run', parts: [
      { type: 'reasoning', text: '好。开始。private analysis。' },
      { type: 'tool-call', callId: 'saved', toolName: 'chapter_write', title: '写入正文', status: 'success', summary: '已保存正文。\\n检查尚未完成。', args: { content: literal } },
    ], createdAt: new Date('2026-11-05T00:00:01Z'), run },
  ]
  const original = structuredClone(records)
  db.agentMessage.findMany.mockImplementation(async (query: { orderBy: Array<{ createdAt?: string }> }) => query.orderBy[0].createdAt === 'desc' ? [...records].reverse() : records)
  const history = await listLoopSessionMessages('owner', 'session', { runLimit })
  expect(history.messages[0].parts).toEqual([{ type: 'text', text: literal }])
  expect(history.messages[1].parts).toEqual([
    { type: 'reasoning', text: '', activity: true },
    { ...records[1].parts[1], summary: '已保存正文。\n检查尚未完成。' },
  ])
  expect(JSON.stringify(history)).not.toContain('private analysis')
  expect(records).toEqual(original)
})
