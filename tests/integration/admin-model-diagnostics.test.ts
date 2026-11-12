import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Response } from 'undici'
import { prisma } from '../../api/lib/prisma.js'
import { startAdminModelDiagnostic, getAdminModelDiagnostic, cancelAdminModelDiagnostic } from '../../api/lib/admin-model-diagnostics.js'
import { encryptSecret } from '../../api/lib/secret-box.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'

const post = vi.hoisted(() => vi.fn())
vi.mock('undici', async importOriginal => ({
  ...await importOriginal<typeof import('undici')>(), fetch: post,
}))

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })

describe.runIf(available)('admin model diagnostic persistence on isolated PostgreSQL', () => {
  it('dispatches a single saved-model connection for an admin and persists the real mocked HTTP receipt', async () => {
    const adminId = randomUUID(), outsiderId = randomUUID(), modelId = randomUUID(), requestKey = randomUUID()
    const key = 'synthetic-upstream-only'
    await prisma.user.createMany({ data: [
      { id: adminId, nickname: 'connection-fixture-admin', role: 'admin', passwordHash: 'synthetic-only' },
      { id: outsiderId, nickname: 'connection-fixture-member', role: 'user', passwordHash: 'synthetic-only' },
    ] })
    try {
      await prisma.aiModelConfig.create({ data: { id: modelId, key: `connection-${modelId}`, provider: 'fixture', displayName: '连接样本',
        modelName: 'synthetic-model', baseUrl: 'https://gateway.example.com/v1', apiKeyCiphertext: encryptSecret(key), metadata: { reasoningParameterMode: 'omit' } } })
      const request = { requestKey, mode: 'connection', expectedRevision: '1' } as const
      await expect(startAdminModelDiagnostic(outsiderId, modelId, request)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' })
      await expect(startAdminModelDiagnostic(adminId, modelId, { ...request, expectedRevision: '2' })).rejects.toMatchObject({ code: 'MODEL_DIAGNOSTIC_CONFIG_CHANGED' })
      expect(post).not.toHaveBeenCalled()
      post.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: { completion_tokens: 128 } })))
      const [a, b] = await Promise.all([startAdminModelDiagnostic(adminId, modelId, request), startAdminModelDiagnostic(adminId, modelId, request)])
      expect(a.id).toBe(b.id)
      await vi.waitFor(async () => {
        const result = await getAdminModelDiagnostic(adminId, modelId, requestKey)
        expect(result).toMatchObject({ status: 'failed', upstreamHttpStatus: 200, failure: { code: 'CAPABILITY_RESPONSE_INVALID' },
          metrics: { outputTokens: 128 }, fee: { owner: 'platform', status: 'unknown', amountMicros: null } })
        expect(JSON.stringify(result)).not.toContain(key)
      })
      expect(post).toHaveBeenCalledExactlyOnceWith('https://gateway.example.com/v1/chat/completions', expect.objectContaining({
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      }))
      expect((await startAdminModelDiagnostic(adminId, modelId, request)).id).toBe(a.id)
      expect(post).toHaveBeenCalledOnce()
      expect(await prisma.creditLedgerEntry.count({ where: { userId: adminId } })).toBe(0)
      expect(await prisma.aiUsageLog.count({ where: { userId: adminId } })).toBe(0)
    } finally {
      await prisma.adminModelDiagnostic.deleteMany({ where: { modelConfigId: modelId } })
      await prisma.aiModelConfig.deleteMany({ where: { id: modelId } })
      await prisma.user.deleteMany({ where: { id: { in: [adminId, outsiderId] } } })
    }
  })
  it('persists owner/version/independent fee evidence without author usage or Credits mutation and keeps history after archive', async () => {
    const adminId = randomUUID(), otherId = randomUUID(), modelId = randomUUID(), requestKey = randomUUID()
    await prisma.user.createMany({ data: [{ id: adminId, nickname: 'diagnostic-fixture-admin', role: 'admin', passwordHash: 'synthetic-only' }, { id: otherId, nickname: 'diagnostic-fixture-other', role: 'admin', passwordHash: 'synthetic-only' }] })
    try {
      await prisma.aiModelConfig.create({ data: { id: modelId, key: `diagnostic-${modelId}`, provider: 'fixture-channel', displayName: '本地诊断样本', modelName: 'synthetic-model', baseUrl: 'https://gateway.example.com/v1', apiKeyCiphertext: 'synthetic-configured-never-decrypted', enabled: false, selectable: false, metadata: { modelKind: 'text', contextWindowTokens: 128000 } } })
      const result = await startAdminModelDiagnostic(adminId, modelId, { requestKey, mode: 'configuration', expectedRevision: '1' })
      expect(result).toMatchObject({ status: 'configuration_passed', configRevision: '1', fee: { owner: 'platform', status: 'not_requested', amountMicros: null } })
      const saved = await prisma.adminModelDiagnostic.findUniqueOrThrow({ where: { adminId_requestKey: { adminId, requestKey } } })
      expect(saved).toMatchObject({ adminId, modelConfigId: modelId, feeOwner: 'platform', feeIdentity: result.fee.identity })
      expect(JSON.stringify(saved.result)).not.toContain('synthetic-configured-never-decrypted')
      expect(await prisma.creditLedgerEntry.count({ where: { userId: { in: [adminId, otherId] } } })).toBe(0)
      expect(await prisma.aiUsageLog.count({ where: { userId: { in: [adminId, otherId] } } })).toBe(0)
      expect((await startAdminModelDiagnostic(adminId, modelId, { requestKey, mode: 'configuration', expectedRevision: '1' })).id).toBe(result.id)
      await expect(getAdminModelDiagnostic(otherId, modelId, requestKey)).rejects.toMatchObject({ code: 'MODEL_DIAGNOSTIC_NOT_FOUND' })
      await prisma.aiModelConfig.update({ where: { id: modelId }, data: { revision: { increment: 1 }, archivedAt: new Date(), archiveReason: 'synthetic-test-only' } })
      expect(await getAdminModelDiagnostic(adminId, modelId, requestKey)).toMatchObject({ id: result.id, configRevision: '1', stale: true })
      expect((await cancelAdminModelDiagnostic(adminId, modelId, requestKey)).status).toBe('configuration_passed')
      await expect(startAdminModelDiagnostic(adminId, modelId, { requestKey, mode: 'gateway', expectedRevision: '1' })).rejects.toMatchObject({ code: 'MODEL_DIAGNOSTIC_IDENTITY_CONFLICT' })
    } finally {
      await prisma.adminModelDiagnostic.deleteMany({ where: { adminId: { in: [adminId, otherId] } } })
      await prisma.aiModelConfigVersion.deleteMany({ where: { modelConfigId: modelId } })
      await prisma.aiModelSystemBinding.deleteMany({ where: { modelConfigId: modelId } })
      await prisma.aiModelConfig.deleteMany({ where: { id: modelId } })
      await prisma.user.deleteMany({ where: { id: { in: [adminId, otherId] } } })
    }
  })
})
