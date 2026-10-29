import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import * as reviewAdmission from '../../api/lib/agent/quality-review-admission.js'
import { readContinuedReviewRecovery } from '../../api/lib/agent/continued-review-recovery.js'
import { readOriginalCycleContinuityVerification } from '../../api/lib/agent/continuity-coordinator.js'
import { beginReviewCycle, advanceReviewCycle } from '../../api/lib/agent/review-cycle.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { legacyContinuityAssessmentKey, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readContinuityRequestBilling } from '../../api/lib/agent/continuity-review.js'
import * as recovery from '../../api/lib/agent/review-request-recovery.js'

afterEach(() => vi.restoreAllMocks())
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

describe('continued tasks retain physical unknowns and original historical CAS evidence', () => {
  it.each(['first', 'paid-without-stage', 'unknown', 'claimed-correction', 'unsent-without-witness'] as const)('reads only physical accounting for %s without inventing a phase', async scenario => {
    const ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'original' } as ToolContext
    const input: LegacyAssessmentInput = { chapterId: 'chapter', revision: 4, bodies: { current: 'The packet remains sealed.', previous: null },
      targetType: 'story_compilation', targetId: 'compilation', system: 'Frozen reviewer.', content: 'Frozen original request.' }
    const fees = scenario === 'unknown' || scenario === 'paid-without-stage' ? [{ id: 'old-fee', billingStatus: scenario === 'unknown' ? 'pending_usage' : 'settled',
      usageSource: scenario === 'unknown' ? 'unknown' : 'reported', requestTokens: scenario === 'unknown' ? null : 12, responseTokens: scenario === 'unknown' ? null : 8,
      creditChargeMilli: scenario === 'unknown' ? 0 : 23, reservedCreditMilli: scenario === 'unknown' ? 17 : 0 }] : []
    const rows = scenario === 'claimed-correction' ? [{ id: 'old-correction', runId: ctx.runId, metadata: { evidenceCorrectionKey: 'original-correction',
      state: 'claimed', chapterId: input.chapterId, revision: input.revision, callId: ctx.callId, targetType: input.targetType, targetId: input.targetId, usageIds: ['missing-fee'] } }]
      : scenario === 'unsent-without-witness' ? [{ id: 'old-reservation', runId: ctx.runId, metadata: { continuityAssessmentRequestKey: legacyContinuityAssessmentKey(ctx, input),
        assessmentChapterId: input.chapterId, callId: ctx.callId, input } }] : []
    const recover = vi.spyOn(recovery, 'readReviewRequestRecoveryEvidence').mockResolvedValue([])
    const db = { agentOperation: { findMany: vi.fn(async () => []) }, agentArtifact: { findMany: vi.fn(async ({ where }) =>
      where.OR?.some(item => item.metadata?.path?.includes('assessmentChapterId')) ? rows : []), create: vi.fn() },
      aiUsageLog: { findMany: vi.fn(async () => fees) } }
    const before = JSON.stringify({ rows, fees })
    expect(await readContinuityRequestBilling(db as unknown as Prisma.TransactionClient, ctx, { runIds: ['run'], chapter: { id: input.chapterId } }))
      .toMatchObject({ known: scenario === 'first' || scenario === 'paid-without-stage' })
    expect(recover).toHaveBeenCalledTimes(scenario === 'claimed-correction' || scenario === 'unsent-without-witness' ? 1 : 0)
    expect(db.agentArtifact.create).not.toHaveBeenCalled()
    expect(JSON.stringify({ rows, fees })).toBe(before)
  })
  it.each(['original-cas', 'same-body', 'external-revision', 'current-already-assessed'] as const)('reads only the actual original verification authority: %s', async scenario => {
    const subject = { userId: 'user', novelId: 'novel', runId: 'run' }, scope = { ...subject, taskId: 'task', chapterId: 'chapter' }
    const before = 'The packet remains sealed.', after = 'The packet remains sealed beside the lamp.'
    const baseline = beginReviewCycle(scope, { compilationId: 'compilation', revision: 3, content: before, ready: true,
      binding: { contentHash: runtimeJson({ content: before }).hash, continuityBinding: 'baseline-report', qualityReportId: null, qualityReportHash: null },
      required: { continuity: true, quality: false }, findings: [] })
    const cycle = scenario === 'original-cas' || scenario === 'current-already-assessed'
      ? advanceReviewCycle(baseline, { beforeRevision: 3, before, afterRevision: 4, after }) : baseline
    const chapter = { id: 'chapter', revision: scenario === 'same-body' ? 3 : 4, content: scenario === 'same-body' ? before : after }
    const saved = { chapter, preparedContext: { reviewCycle: cycle } }
    const known: LegacyAssessmentInput[] = [{ chapterId: chapter.id, revision: 3, bodies: { current: before, previous: null }, targetType: 'story_compilation',
      targetId: 'compilation', system: 'Original frozen review.', content: 'Original frozen request.' }]
    if (scenario === 'current-already-assessed') known.push({ ...known[0], revision: 4, bodies: { current: after, previous: null } })
    const original = vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', prompt: '修复本章', spec: {}, parentRunId: null } as Awaited<ReturnType<typeof originalRequest.readOriginalTaskRequest>>)
    const runs = vi.spyOn(originalRequest, 'originalTaskRunIds').mockResolvedValue(['run'])
    const db = { storyCompilation: { findFirst: vi.fn(async () => saved) } }
    const old = runtimeJson({ saved, known }).hash
    try {
      const result = await readOriginalCycleContinuityVerification(db as unknown as Prisma.TransactionClient, subject,
        { targetId: 'compilation', chapterId: chapter.id, revision: chapter.revision, bodies: { current: chapter.content, previous: null } }, known)
      if (scenario === 'original-cas') expect(result).toMatchObject({ taskId: 'task', step: { contiguous: true, before: { revision: 3 }, after: { revision: 4 } } })
      else expect(result).toBeNull()
      expect(runtimeJson({ saved, known }).hash).toBe(old)
    } finally { original.mockRestore(); runs.mockRestore() }
  })
  it.each(['continuity_validate', 'quality_analyze'] as const)('keeps the exact pending %s producer within its own authority path', async toolName => {
    const subject = { userId: 'user', novelId: 'novel', runId: 'run' }, at = (n: number) => new Date(n)
    const run = { ...subject, id: 'run', sessionId: 'session', taskRootId: null, runtimeProtocolVersion: 0, status: 'running', usage: {}, manuscriptRevision: 0 }
    const history = [
      { id: 'call', runId: 'run', type: 'tool.call', seq: 1, createdAt: at(1), payload: { callId: 'unknown-call', toolName, args: { compilationId: 'compilation' } } },
      { id: 'result', runId: 'run', type: 'tool.result', seq: 2, createdAt: at(2), payload: { callId: 'unknown-call', toolName, ok: false, failureCode: 'AI_PROVIDER_TRANSPORT' } },
      { id: 'pause', runId: 'run', type: 'run.paused', seq: 3, createdAt: at(3), payload: {} },
      { id: 'start', runId: 'run', type: 'run.started', seq: 4, createdAt: at(4), payload: { authorContinue: { eventId: 'pause', afterSeq: 3 } } },
    ]
    const db = { agentRun: { findFirst: vi.fn(async () => run) }, novel: { findFirst: vi.fn(async () => ({ manuscriptRevision: 0 })) },
      agentGoalExecution: { findUnique: vi.fn(async () => null) }, agentRunEvent: { findMany: vi.fn(async () => history) },
      chapter: { findFirst: vi.fn(async () => null) } }
    const original = vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', prompt: '修复本章', parentRunId: null } as Awaited<ReturnType<typeof originalRequest.readOriginalTaskRequest>>)
    const runs = vi.spyOn(originalRequest, 'originalTaskRunIds').mockResolvedValue(['run'])
    const admission = vi.spyOn(reviewAdmission, 'readQualityReviewAdmission').mockResolvedValue({ id: 'author-continue:pause', at: at(4) })
    const before = JSON.stringify({ run, history })
    try {
      const pending = [{ compilationId: 'compilation', chapterId: 'chapter', revision: 8, toolName, callId: 'unknown-call' }]
      expect(await readContinuedReviewRecovery(db as unknown as Prisma.TransactionClient, subject, pending)).toEqual([])
      // No usage/billing/provider delegate exists. The continuity producer must
      // stop before turning the old unknown fee into another dispatch key.
      expect(db.chapter.findFirst).toHaveBeenCalledTimes(toolName === 'continuity_validate' ? 0 : 1)
      expect(JSON.stringify({ run, history })).toBe(before)
    } finally { original.mockRestore(); runs.mockRestore(); admission.mockRestore() }
  })
})
