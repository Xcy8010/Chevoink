import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn(), report: vi.fn(), find: vi.fn(), create: vi.fn(), update: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
  prisma: { $transaction: async (callback: (tx: object) => unknown) => callback({ $queryRaw: async () => [],
    agentRun: { findFirst: mocks.run }, chapterQualityReport: { findFirst: mocks.report },
    agentArtifact: { findUnique: mocks.find, create: mocks.create, update: mocks.update } }) },
}))
import { persistQualityRepairAttemptAudit, qualityRepairAttemptAuditSchema, type QualityRepairAttemptAudit } from '../../api/lib/agent/quality-repair-audit.js'
const subject = { userId: 'author', novelId: 'novel' }
const audit: QualityRepairAttemptAudit = { version: 1, kind: 'quality_repair_attempt', runId: 'run', callId: 'call', reportId: 'report', chapterId: 'chapter',
  sourceRevision: 4, contextHash: 'a'.repeat(64), attempt: 1, action: 'agent3HumanityRevision', trigger: 'initial',
  state: 'prepared', classifications: [], requests: [] }
const row = (metadata: unknown) => ({ id: 'stored', runId: 'run', artifactType: 'contextCheckpoint', content: '', metadata })
beforeEach(() => { vi.clearAllMocks(); mocks.run.mockResolvedValue({ id: 'run' }); mocks.report.mockResolvedValue({ id: 'report' }); mocks.find.mockResolvedValue(null) })

describe('minimal quality repair attempt audit', () => {
  it('stores only a strictly validated diagnostic artifact in the owning run', async () => {
    await persistQualityRepairAttemptAudit(subject, audit)
    const data = mocks.create.mock.calls[0][0].data
    expect(data).toMatchObject({ runId: 'run', artifactType: 'contextCheckpoint', content: '', metadata: audit })
    expect(data.id).toHaveLength(64)
    expect(mocks.run).toHaveBeenCalledWith({ where: { id: 'run', ...subject }, select: { id: true } })
    expect(mocks.report).toHaveBeenCalledWith({ where: { id: 'report', ...subject, chapterId: 'chapter' }, select: { id: true } })
    for (const forbidden of ['rawResponse', 'prompt', 'apiKey', 'replacement', 'errorMessage']) {
      expect(qualityRepairAttemptAuditSchema.safeParse({ ...audit, [forbidden]: 'secret' }).success).toBe(false)
    }
  })
  it('cannot use a prepared or returned witness as permission to redispatch, and preserves terminal evidence', async () => {
    mocks.find.mockResolvedValue(row(audit))
    await expect(persistQualityRepairAttemptAudit(subject, audit)).rejects.toMatchObject({ code: 'QUALITY_REPAIR_RECONCILIATION_REQUIRED' })
    const returned: QualityRepairAttemptAudit = { ...audit, state: 'returned', classifications: ['parse_error'], response: { contentHash: 'b'.repeat(64), characterCount: 9 } }
    await persistQualityRepairAttemptAudit(subject, returned)
    expect(mocks.update).toHaveBeenCalledOnce()
    mocks.find.mockResolvedValue(row(returned))
    await persistQualityRepairAttemptAudit(subject, returned)
    await expect(persistQualityRepairAttemptAudit(subject, { ...returned, classifications: ['schema_error'] })).rejects.toMatchObject({ code: 'QUALITY_REPAIR_RECONCILIATION_REQUIRED' })
    expect(mocks.update).toHaveBeenCalledOnce()
  })
  it.each(['run', 'report', 'foreign-artifact', 'changed-context'] as const)('rejects %s without writing diagnostic or billing state', async mismatch => {
    if (mismatch === 'run') mocks.run.mockResolvedValue(null)
    if (mismatch === 'report') mocks.report.mockResolvedValue(null)
    if (mismatch === 'foreign-artifact') mocks.find.mockResolvedValue({ ...row(audit), runId: 'other' })
    if (mismatch === 'changed-context') mocks.find.mockResolvedValue(row({ ...audit, contextHash: 'b'.repeat(64) }))
    await expect(persistQualityRepairAttemptAudit(subject, audit)).rejects.toMatchObject({ code: mismatch === 'run' || mismatch === 'report' ? 'QUALITY_RUN_SCOPE_INVALID' : 'RUNTIME_RECEIPT_INVALID' })
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
  })
})
