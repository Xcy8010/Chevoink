import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adminOperationCallsQuerySchema, adminOperationRunsQuerySchema, adminOperationsHealthQuerySchema } from '../../shared/contracts/admin-operations.js'
const mocks = vi.hoisted(() => ({ raw: vi.fn(), transaction: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: { $queryRaw: mocks.raw, $transaction: mocks.transaction } }))
import { getAdminOperationsHealth, listAdminOperationCalls, listAdminOperationRuns } from '../../api/lib/admin-operations.js'

beforeEach(() => { vi.clearAllMocks(); mocks.transaction.mockImplementation(async work => work({ $queryRaw: mocks.raw })) })
const window = { from: '2026-11-01T00:00:00+08:00', to: '2026-11-02T00:00:00+08:00' }
function callRow() { return { id: 'attempt-a', action: 'workspaceAgent', createdAt: new Date('2026-11-01T01:00:00Z'), provider: 'synthetic-channel', model: 'synthetic-model', runId: 'run-a', taskId: 'task-a', operationId: 'operation-a', status: 'succeeded', outcome: 'success', errorCategory: null, billingStatus: 'pending', usageSource: 'unknown', requestTokens: null, responseTokens: null, cacheHitTokens: null, cacheMissTokens: null, durationMs: 42, chargedCreditsMilli: null } }
describe('admin operations query contracts and safe paged SELECTs', () => {
  it('bounds pages and validates paired ISO windows and coded status values', () => {
    expect(adminOperationCallsQuerySchema.parse({}).pageSize).toBe(20)
    for (const invalid of [{ pageSize: 101 }, { page: 0 }, { from: window.from }, { from: window.to, to: window.from }, { status: "failed' OR 1=1" }]) expect(adminOperationCallsQuerySchema.safeParse(invalid).success).toBe(false)
    expect(adminOperationRunsQuerySchema.safeParse({ status: 'completed', ...window }).success).toBe(true)
    expect(adminOperationRunsQuerySchema.safeParse({ status: 'settled' }).success).toBe(false)
  })
  it('pages provider attempts with deterministic order, bound filters and no request/result/body fields', async () => {
    mocks.raw.mockImplementation(async sql => sql.sql.includes('COUNT(*)') ? [{ total: 3 }] : [callRow()])
    const query = adminOperationCallsQuerySchema.parse({ ...window, page: 2, pageSize: 1, model: "model' OR true", provider: 'channel', runId: 'run-a', taskId: 'task-a', status: 'succeeded' })
    const result = await listAdminOperationCalls(query)
    expect(result.pagination).toMatchObject({ total: 3, page: 2, pageSize: 1, hasMore: true })
    expect(result.items[0]).toMatchObject({ source: 'provider_attempts', requestTokens: null, responseTokens: null, operationId: 'operation-a' })
    const sql = mocks.raw.mock.calls.find(([value]) => value.sql.includes('ORDER BY'))![0]
    expect(sql.sql).toContain('ORDER BY a.created_at DESC, a.id DESC')
    expect(sql.values).toContain(query.model)
    expect(sql.sql).toContain('::timestamp')
    expect(sql.values).toContain('2026-10-31T16:00:00.000Z')
    expect(sql.values.some((value: unknown) => value instanceof Date)).toBe(false)
    expect(sql.sql).not.toContain(query.model)
    for (const privateField of ['request_snapshot','a.result','input_summary','output_summary','api_key']) expect(sql.sql).not.toContain(privateField)
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' })
  })
  it('keeps usage nulls and billing settlement separate from model outcome', async () => {
    mocks.raw.mockImplementation(async sql => sql.sql.includes('COUNT(*)') ? [{ total: 1 }] : [{ ...callRow(), id: 'usage-a', status: 'settled', outcome: 'unknown', billingStatus: 'settled', operationId: null }])
    const result = await listAdminOperationCalls(adminOperationCallsQuerySchema.parse({ source: 'usage', ...window }))
    expect(result.items[0]).toMatchObject({ source: 'usage', status: 'settled', outcome: 'unknown', requestTokens: null })
    const sql = mocks.raw.mock.calls.find(([value]) => value.sql.includes('ORDER BY'))![0]
    expect(sql.sql).toContain("'unknown'::text")
    expect(sql.sql).toContain('LEFT JOIN agent_runs r ON r.id = u.agent_run_id')
    expect(result.coverage.join('')).toContain('不是模型能力成功')
  })
  it('exposes actual web-tool receipt coverage without reading outcome or inventing model IDs', async () => {
    mocks.raw.mockImplementation(async sql => sql.sql.includes('COUNT(*)') ? [{ total: 1 }] : [{ ...callRow(), id: 'tool-a', action: 'search', model: null, provider: null, status: 'completed', outcome: 'unknown' }])
    const result = await listAdminOperationCalls(adminOperationCallsQuerySchema.parse({ source: 'web_tools', ...window }))
    expect(result.items[0]).toMatchObject({ model: null, provider: null, action: 'search', outcome: 'unknown' })
    const sql = mocks.raw.mock.calls.find(([value]) => value.sql.includes('ORDER BY'))![0]
    expect(sql.sql).not.toContain('w.outcome')
    expect(result.coverage.join('')).toContain('空结果')
  })
  it('does not render no samples or incomplete usage observations as healthy or invent latency distributions', async () => {
    mocks.raw.mockResolvedValue([{ total: 0, success: 0, failure: 0, pending: 0, cancelled: 0, unknown: 0, lastSampleAt: null }])
    expect(await getAdminOperationsHealth(adminOperationsHealthQuerySchema.parse({ ...window }))).toMatchObject({ observation: 'no_samples', lastSampleAt: null, firstTextMs: null, p50Ms: null, p95Ms: null, tokensPerSecond: null })
    mocks.raw.mockResolvedValue([{ total: 3, success: 0, failure: 0, pending: 0, cancelled: 0, unknown: 3, lastSampleAt: new Date('2026-11-01T01:00:00Z') }])
    expect((await getAdminOperationsHealth(adminOperationsHealthQuerySchema.parse({ source: 'usage', ...window }))).observation).toBe('unknown')
  })
  it('filters run/task/model/provider/user in the database and selects only safe author/session fields', async () => {
    mocks.raw.mockImplementation(async sql => sql.sql.includes('COUNT(*)') ? [{ total: 1 }] : [{ id: 'run-a', taskId: 'task-a', status: 'failed', action: 'workspaceAgent', modelTier: 'speed', customModelId: null, createdAt: new Date(), startedAt: null, finishedAt: null, userId: 'author-a', nickname: '合成作者', sessionId: 'session-a', sessionTitle: '合成会话标题' }])
    const result = await listAdminOperationRuns(adminOperationRunsQuerySchema.parse({ ...window, runId: 'run-a', taskId: 'task-a', status: 'failed', model: 'speed', provider: 'channel', user: '合成作者' }))
    expect(result.items[0]).toMatchObject({ user: { id: 'author-a', nickname: '合成作者' }, session: { id: 'session-a', title: '合成会话标题' }, modelTier: 'speed' })
    const sql = mocks.raw.mock.calls.find(([value]) => value.sql.includes('ORDER BY'))![0]
    expect(sql.sql).toContain('EXISTS (SELECT 1 FROM agent_provider_attempts')
    expect(sql.sql).toContain('ORDER BY r.created_at DESC, r.id DESC')
    for (const privateField of ['input_summary','output_summary','error_message','task_spec','password','email','phone']) expect(sql.sql).not.toContain(privateField)
  })
})
