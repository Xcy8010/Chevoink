import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
const proof = vi.hoisted(() => vi.fn())
vi.mock('../../api/lib/agent/quality-unavailable-proof.js', () => ({ readQualityUnavailableProof: proof }))
vi.mock('../../api/lib/agent/quality-review-admission.js', () => ({ readQualityReviewAdmission: async () => null }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: async () => ({ taskId: 'task' }), originalTaskRunIds: async () => ['run'] }))
import { canStartFreshQualityCheck } from '../../api/lib/agent/quality-format-recovery.js'
const subject = { userId: 'author', novelId: 'novel', runId: 'run' }, chapter = { id: 'c', revision: 2, content: '实际正文。' }
const db = { agentRun: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() }, chapterQualityReport: { findFirst: vi.fn(), findMany: vi.fn() }, agentOperation: { findMany: vi.fn() },
  aiUsageLog: { count: vi.fn() }, agentProviderAttempt: { count: vi.fn() } }
beforeEach(() => { vi.resetAllMocks(); db.agentRun.findFirst.mockResolvedValue({ taskRootId: 'root' }); db.agentRun.findFirstOrThrow.mockResolvedValue({ createdAt: new Date(0) });
  db.chapterQualityReport.findFirst.mockResolvedValue({ id: 'report' }); db.chapterQualityReport.findMany.mockResolvedValue([]); db.agentOperation.findMany.mockResolvedValue([]); db.aiUsageLog.count.mockResolvedValue(0); db.agentProviderAttempt.count.mockResolvedValue(0) })
it.each([true, false])('requires a real settled failed-response proof, proven=%s', async proven => {
  proof.mockResolvedValue(proven ? { evidenceHash: 'a'.repeat(64) } : null)
  expect(await canStartFreshQualityCheck(db as unknown as Prisma.TransactionClient, subject, 'report', chapter)).toBe(proven)
  expect(proof).toHaveBeenCalledWith(db, subject, ['run'], { id: 'report' }, chapter, 'root', { allowFormatRecovery: true })
})
it.each(['usage', 'provider', 'report', 'owner'])('retains unresolved/foreign %s evidence without admitting a fresh check', async kind => {
  proof.mockResolvedValue({ evidenceHash: 'a'.repeat(64) })
  if (kind === 'usage') db.aiUsageLog.count.mockResolvedValue(1)
  if (kind === 'provider') db.agentProviderAttempt.count.mockResolvedValue(1)
  if (kind === 'report') db.chapterQualityReport.findFirst.mockResolvedValue(null)
  if (kind === 'owner') db.agentRun.findFirst.mockResolvedValue(null)
  expect(await canStartFreshQualityCheck(db as unknown as Prisma.TransactionClient, subject, 'report', chapter)).toBe(false)
  expect(proof).not.toHaveBeenCalled()
})

it.each([false, true])('waits for a claimed recovery to actually end, finished=%s', async finished => {
  proof.mockResolvedValue({ evidenceHash: 'a'.repeat(64) })
  const claim = { taskId: 'task', chapterId: 'c', chapterRevision: 2, state: 'claimed', claimRunId: 'run', key: 'key', evidenceHash: 'proof' }
  db.chapterQualityReport.findMany.mockResolvedValue([
    { id: 'source', runId: 'run', deterministicMetrics: { formatRecovery: claim } },
    ...(finished ? [{ id: 'result', runId: 'run', deterministicMetrics: { formatRecovery: { ...claim, reportId: 'source', state: 'failed' } } }] : []),
  ])
  expect(await canStartFreshQualityCheck(db as unknown as Prisma.TransactionClient, subject, 'report', chapter)).toBe(finished)
  expect(proof).toHaveBeenCalledTimes(finished ? 1 : 0)
})
