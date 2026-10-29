import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { PendingReviewCall } from '../../api/lib/agent/checkpoint.js'
import { readReviewRequestRecoveryEvidence } from '../../api/lib/agent/review-request-recovery.js'
import * as originals from '../../api/lib/agent/original-request.js'
import * as retirements from '../../api/lib/agent/cancelled-review-recovery.js'

afterEach(() => vi.restoreAllMocks())
function fixture() {
  const subject = { userId: 'author', novelId: 'novel', runId: 'run' }
  const item: PendingReviewCall = { toolName: 'continuity_validate', callId: 'third-check', compilationId: 'comp', chapterId: 'chapter', revision: 5 }
  const chapter = { id: 'chapter', revision: 5, orderIndex: 17, content: '合成的当前第五版正文。', updatedAt: new Date(1000) }
  const run = { id: 'run', taskRootId: null, runtimeProtocolVersion: 0 }
  const original = { taskId: 'task', sourceRunId: 'run', prompt: '修复第十七章并完成当前版本检查。',
    spec: { id: 'task', scope: { novelId: 'novel', chapterIds: ['chapter'], continuityReportProtocol: 5 } } }
  const history = [{ id: 'call', runId: 'run', seq: 4830, type: 'tool.call', createdAt: new Date(2000),
    payload: { toolName: 'continuity_validate', callId: 'third-check', args: { compilationId: 'comp' } } },
  { id: 'result', runId: 'run', seq: 4831, type: 'tool.result', createdAt: new Date(3130),
    payload: { toolName: 'continuity_validate', callId: 'third-check', ok: false, failureCode: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' } }]
  const usage = [{ id: 'old-settled-review', agentRunId: 'run', action: 'agent3ContinuityCritic', chapterId: 'chapter', targetId: 'comp',
    createdAt: new Date(1500), durationMs: 10, usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8,
    reservedCreditMilli: 0, creditChargeMilli: 7 }]
  vi.spyOn(originals, 'readOriginalTaskRequest').mockResolvedValue(original as unknown as Awaited<ReturnType<typeof originals.readOriginalTaskRequest>>)
  vi.spyOn(originals, 'originalTaskRunIds').mockResolvedValue(['run'])
  vi.spyOn(retirements, 'readRetiredReviewUsageIds').mockResolvedValue(new Set())
  const artifact = vi.fn(async () => null as { id: string } | null)
  const attempt = vi.fn(async () => 0)
  const compiler = vi.fn(async () => ({ id: 'comp', chapterId: 'chapter' }))
  const db = { agentRun: { findFirst: vi.fn(async () => run), findFirstOrThrow: vi.fn(async () => ({ createdAt: new Date(0) })),
    findUniqueOrThrow: vi.fn(async () => run) },
    agentProviderAttempt: { count: attempt }, agentRunEvent: { findMany: vi.fn(async () => history) },
    chapter: { findFirst: vi.fn(async () => chapter) }, storyCompilation: { findFirst: compiler },
    agentArtifact: { findFirst: artifact }, chapterQualityReport: { findMany: vi.fn(async () => []) },
    aiUsageLog: { findMany: vi.fn(async () => usage) } } as unknown as Prisma.TransactionClient
  return { subject, item, chapter, run, original, history, usage, db, artifact, attempt, compiler }
}

describe('old body-only phase refusal is an audit rather than an unknown provider request', () => {
  it('retires only the proven unexecuted r5 call while preserving earlier r4 fees and every original error', async () => {
    const f = fixture(), before = JSON.stringify({ history: f.history, usage: f.usage, chapter: f.chapter })
    const result = await readReviewRequestRecoveryEvidence(f.db, f.subject, [f.item])
    expect(result).toEqual([expect.objectContaining({ ...f.item, notDispatched: true, receipt: expect.objectContaining({
      status: 'terminal_failed_billing_known', sourceResultId: 'result', usageIds: [], currentRevision: 5 }) })])
    expect(JSON.stringify({ history: f.history, usage: f.usage, chapter: f.chapter })).toBe(before)
  })
  it.each(['reservation', 'prepared-provider', 'unknown-provider', 'pending-usage', 'pending-settlement', 'other-unresolved-call',
    'missing-result', 'duplicate-result', 'wrong-code', 'wrong-scope', 'wrong-compilation', 'changed-revision', 'changed-body', 'usage-during-call'] as const)(
    'retains pending and original evidence after %s', async scenario => {
      const f = fixture()
      if (scenario === 'reservation') f.artifact.mockResolvedValue({ id: 'real-reservation' })
      if (scenario === 'prepared-provider' || scenario === 'unknown-provider') f.attempt.mockResolvedValue(1)
      if (scenario === 'pending-usage') { f.usage[0].usageSource = 'unknown'; f.usage[0].billingStatus = 'pending_usage' }
      if (scenario === 'pending-settlement') f.usage[0].billingStatus = 'pending_settlement'
      if (scenario === 'missing-result') f.history.pop()
      if (scenario === 'duplicate-result') f.history.push({ ...f.history[1] })
      if (scenario === 'wrong-code') f.history[1].payload.failureCode = 'AI_PROVIDER_TIMEOUT'
      if (scenario === 'wrong-scope') f.original.spec.scope.chapterIds = ['another-chapter']
      if (scenario === 'wrong-compilation') f.compiler.mockResolvedValue(null as never)
      if (scenario === 'changed-revision') f.chapter.revision++
      if (scenario === 'changed-body') { f.chapter.content += '当前变化。'; f.chapter.updatedAt = new Date(4000) }
      if (scenario === 'usage-during-call') f.usage[0].createdAt = new Date(2100)
      const pending = scenario === 'other-unresolved-call' ? [f.item, { ...f.item, callId: 'another-real-call' }] : [f.item]
      const before = JSON.stringify({ history: f.history, usage: f.usage, chapter: f.chapter, pending })
      expect(await readReviewRequestRecoveryEvidence(f.db, f.subject, pending)).toEqual([])
      expect(JSON.stringify({ history: f.history, usage: f.usage, chapter: f.chapter, pending })).toBe(before)
    })
})
