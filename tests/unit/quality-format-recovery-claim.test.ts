import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { hasQualityFormatRecoveryClaim } from '../../api/lib/agent/quality-format-recovery.js'

vi.mock('../../api/lib/agent/original-request.js', () => ({
  readOriginalTaskRequest: vi.fn().mockResolvedValue({ taskId: 'original' }),
  originalTaskRunIds: vi.fn().mockResolvedValue(['run']),
}))
vi.mock('../../api/lib/agent/quality-review-admission.js', () => ({
  readQualityReviewAdmission: vi.fn().mockResolvedValue({ id: 'admission', at: new Date('2026-01-02') }),
}))
vi.mock('../../api/lib/agent/quality-orphan-recovery.js', () => ({ readOrphanQualityRecoveryProofs: vi.fn().mockResolvedValue(new Map()) }))

const subject = { userId: 'u', novelId: 'n', runId: 'run' }
describe('durable format recovery reservations without a parent report effect', () => {
  it.each(['unknown', 'failed', 'prepared', 'parent-pending', 'succeeded-current', 'succeeded-old', 'same-parent', 'other-parent'])(
    '%s preserves the single recovery allowance for work 11', async scenario => {
      const operation = { id: 'recovery', parentOperationId: 'parent', createdAt: new Date(scenario === 'succeeded-current' ? '2026-01-03' : '2026-01-01'),
        status: ['unknown', 'failed', 'prepared'].includes(scenario) ? scenario : 'succeeded',
        parent: { status: scenario === 'parent-pending' ? 'prepared' : 'succeeded', inputSnapshot: { input: { work: {
          kind: 'check', version: 11, chapter: { id: 'c', revision: 4 },
        } } } } }
      const db = { agentRun: { findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'run' }) },
        chapterQualityReport: { findMany: vi.fn().mockResolvedValue([]) }, agentOperation: { findMany: vi.fn().mockResolvedValue([operation]) } } as unknown as Prisma.TransactionClient
      const except = scenario === 'same-parent' ? 'parent' : scenario === 'other-parent' ? 'other' : undefined
      if (scenario === 'same-parent' || scenario === 'other-parent') operation.status = 'unknown'
      expect(await hasQualityFormatRecoveryClaim(db, subject, 'c', 4, except))
        .toBe(!['succeeded-old', 'same-parent'].includes(scenario))
      expect(await hasQualityFormatRecoveryClaim(db, subject, 'another-chapter', 4)).toBe(false)
      expect(await hasQualityFormatRecoveryClaim(db, subject, 'c', 5)).toBe(false)
    })
})
