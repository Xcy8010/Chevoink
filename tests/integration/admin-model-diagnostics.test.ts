import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { startAdminModelDiagnostic, getAdminModelDiagnostic, cancelAdminModelDiagnostic } from '../../api/lib/admin-model-diagnostics.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })

describe.runIf(available)('admin model diagnostic persistence on isolated PostgreSQL', () => {
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
