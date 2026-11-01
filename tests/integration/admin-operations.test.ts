import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { listAdminOperationCalls, listAdminOperationRuns, getAdminOperationsHealth } from '../../api/lib/admin-operations.js'
import { adminOperationCallsQuerySchema, adminOperationRunsQuerySchema, adminOperationsHealthQuerySchema } from '../../shared/contracts/admin-operations.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })
describe.runIf(available)('admin operations safe record queries on isolated PostgreSQL', () => {
  it('pages/filter actual attempts, preserves usage unknowns and reports source-scoped health without reading bodies', async () => {
    const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID(), runId = randomUUID(), rootId = randomUUID(), operationId = randomUUID()
    const attemptIds = [randomUUID(), randomUUID(), randomUUID()]
    const createdAt = new Date('2026-10-31T16:00:00.000Z') // Exactly UTC+8 midnight.
    const window = { from: '2026-11-01T00:00:00+08:00', to: '2026-11-02T00:00:00+08:00' }
    await prisma.user.create({ data: { id: userId, nickname: '运营检索合成作者', passwordHash: 'synthetic-only' } })
    try {
      await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '运营检索合成作品', slug: novelId, summary: 'synthetic-only' } })
      await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: '运营检索合成会话' } })
      await prisma.agentTaskRoot.create({ data: { id: rootId, userId, sessionId, novelId, sourceMessageId: 'synthetic-source', inputHash: '0'.repeat(64), specSnapshot: {}, requestSnapshot: { body: 'synthetic-private-request' } } })
      await prisma.agentRun.create({ data: { id: runId, userId, novelId, sessionId, taskRootId: rootId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'failed', modelTier: 'speed', createdAt, inputSummary: 'synthetic-private-input', outputSummary: 'synthetic-private-output', errorMessage: 'synthetic-private-error' } })
      await prisma.agentOperation.create({ data: { id: operationId, taskRootId: rootId, operationKey: 'synthetic-operation', originRunId: runId, kind: 'provider', action: 'workspaceAgent', inputHash: '0'.repeat(64) } })
      for (const [index, status] of ['succeeded', 'failed', 'unknown'].entries()) await prisma.agentProviderAttempt.create({ data: { id: attemptIds[index], operationId, attemptKey: `attempt-${index}`, runId, ownerEpoch: 1n, provider: 'synthetic-channel', model: 'synthetic-model', requestHash: '0'.repeat(64), requestSnapshot: { prompt: 'synthetic-private-prompt' }, result: { text: 'synthetic-private-result' }, status, dispatchedAt: new Date(createdAt.getTime() - 20), completedAt: status === 'unknown' ? null : createdAt, createdAt } })
      for (const [index, date] of [new Date(createdAt.getTime() - 1), new Date(createdAt.getTime() + 86400000)].entries()) await prisma.agentProviderAttempt.create({ data: { id: randomUUID(), operationId, attemptKey: `outside-boundary-${index}`, runId, ownerEpoch: 1n, provider: 'synthetic-channel', model: 'synthetic-model', requestHash: '0'.repeat(64), status: 'succeeded', createdAt: date } })
      await prisma.agentProviderUsageReceipt.create({ data: { attemptId: attemptIds[0], source: 'unknown', observationHash: '0'.repeat(64), promptTokens: null, completionTokens: null } })
      await prisma.aiUsageLog.create({ data: { userId, novelId, targetType: 'agentRun', targetId: runId, agentRunId: runId, providerType: 'text', providerMode: 'platform', providerName: 'synthetic-channel', modelName: 'synthetic-model', action: 'workspaceAgent', durationMs: 42, billingStatus: 'settled', usageSource: 'unknown', requestTokens: null, responseTokens: null, createdAt } })
      await prisma.webToolCall.create({ data: { id: randomUUID(), runId, kind: 'search', requestHash: '0'.repeat(64), amountMilli: 100, multiplierBps: 10000, status: 'completed', outcome: { text: 'synthetic-private-tool-result' }, createdAt } })
      const common = { ...window, runId, taskId: rootId }
      const first = await listAdminOperationCalls(adminOperationCallsQuerySchema.parse({ ...common, page: 1, pageSize: 1 }))
      const second = await listAdminOperationCalls(adminOperationCallsQuerySchema.parse({ ...common, page: 2, pageSize: 1 }))
      expect(first.pagination).toMatchObject({ total: 3, pageSize: 1, hasMore: true })
      expect(first.window).toMatchObject({ from: '2026-10-31T16:00:00.000Z', to: '2026-11-01T16:00:00.000Z' })
      expect(first.items[0].id).not.toBe(second.items[0].id)
      expect(first.items[0].id).toBe([...attemptIds].sort().reverse()[0])
      const failed = await listAdminOperationCalls(adminOperationCallsQuerySchema.parse({ ...common, model: 'synthetic-model', provider: 'synthetic-channel', errorCategory: 'known_failure' }))
      expect(failed.items.map(item => item.status)).toEqual(['failed'])
      const local = await listAdminOperationCalls(adminOperationCallsQuerySchema.parse({ ...common, source: 'usage' }))
      expect(local.items[0]).toMatchObject({ status: 'settled', outcome: 'unknown', requestTokens: null, responseTokens: null })
      const tools = await listAdminOperationCalls(adminOperationCallsQuerySchema.parse({ ...common, source: 'web_tools' }))
      expect(tools.items[0]).toMatchObject({ action: 'search', status: 'completed', outcome: 'unknown', provider: null, model: null, chargedCreditsMilli: null })
      const health = await getAdminOperationsHealth(adminOperationsHealthQuerySchema.parse(common))
      expect(health).toMatchObject({ observation: 'attention', counts: { total: 3, success: 1, failure: 1, pending: 0, cancelled: 0, unknown: 1 }, firstTextMs: null, p50Ms: null, p95Ms: null })
      expect((await getAdminOperationsHealth(adminOperationsHealthQuerySchema.parse({ ...common, source: 'usage' }))).counts).toMatchObject({ total: 1, success: 0, failure: 0, unknown: 1 })
      const runs = await listAdminOperationRuns(adminOperationRunsQuerySchema.parse({ ...common, user: userId, status: 'failed', provider: 'synthetic-channel', model: 'synthetic-model' }))
      expect(runs.items[0]).toMatchObject({ id: runId, modelTier: 'speed', user: { id: userId, nickname: '运营检索合成作者' }, session: { id: sessionId, title: '运营检索合成会话' } })
      const serialized = JSON.stringify({ first, second, failed, local, tools, health, runs })
      expect(serialized).not.toContain('synthetic-private')
      expect(serialized).not.toContain('passwordHash')
    } finally {
      await prisma.aiUsageLog.deleteMany({ where: { userId } })
      await prisma.webToolCall.deleteMany({ where: { runId } })
      await prisma.agentRun.deleteMany({ where: { id: runId } })
      await prisma.agentTaskRoot.deleteMany({ where: { id: rootId } })
      await prisma.agentSession.deleteMany({ where: { id: sessionId } })
      await prisma.novel.deleteMany({ where: { id: novelId } })
      await prisma.user.deleteMany({ where: { id: userId } })
    }
  })
})
