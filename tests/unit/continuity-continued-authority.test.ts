import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import * as reviewAdmission from '../../api/lib/agent/quality-review-admission.js'
import { readContinuedReviewRecovery } from '../../api/lib/agent/continued-review-recovery.js'
import { readOriginalCycleContinuityVerification, claimLegacyContinuityVerification } from '../../api/lib/agent/continuity-coordinator.js'
import { beginReviewCycle, advanceReviewCycle } from '../../api/lib/agent/review-cycle.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

describe('generic author Continue does not grant a new continuity request', () => {
  it.each(['first', 'paid-without-stage', 'unknown', 'claimed-correction', 'unsent-without-witness'] as const)('actual reservation preserves %s rather than inferring another phase', async scenario => {
    const ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'new-call', signal: new AbortController().signal } as ToolContext
    const input: LegacyAssessmentInput = { chapterId: 'chapter', revision: 4, bodies: { current: 'The packet remains sealed.', previous: null },
      targetType: 'story_compilation', targetId: 'compilation', system: 'Frozen reviewer.', content: 'Frozen original request.' }
    const fees = scenario === 'first' || scenario === 'claimed-correction' ? [] : [{ id: 'old-fee', billingStatus: scenario === 'unsent-without-witness' ? 'not_dispatched' : scenario === 'unknown' ? 'pending_usage' : 'settled',
      usageSource: scenario === 'paid-without-stage' ? 'reported' : 'unknown', requestTokens: scenario === 'paid-without-stage' ? 12 : null,
      responseTokens: scenario === 'paid-without-stage' ? 8 : null, creditChargeMilli: scenario === 'paid-without-stage' ? 23 : 0,
      reservedCreditMilli: scenario === 'unknown' ? 17 : 0 }]
    const rows = scenario === 'claimed-correction' ? [{ metadata: { state: 'claimed', usageIds: ['old-fee'] } }] : []
    const db = { agentOperation: { count: vi.fn(async () => 0) }, agentArtifact: { findMany: vi.fn(async () => rows), create: vi.fn() },
      aiUsageLog: { findMany: vi.fn(async () => fees) } }
    const original = vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', prompt: '修复本章', spec: {}, parentRunId: null } as Awaited<ReturnType<typeof originalRequest.readOriginalTaskRequest>>)
    const runs = vi.spyOn(originalRequest, 'originalTaskRunIds').mockResolvedValue(['run'])
    const before = JSON.stringify({ rows, fees })
    try {
      const result = claimLegacyContinuityVerification(db as unknown as Prisma.TransactionClient, ctx, input, [], 'new-operation')
      if (scenario === 'first') await expect(result).resolves.toBeUndefined()
      else await expect(result).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED', message: expect.stringContaining('冻结执行配置') })
      expect(db.agentArtifact.create).not.toHaveBeenCalled()
      expect(JSON.stringify({ rows, fees })).toBe(before)
    } finally { original.mockRestore(); runs.mockRestore() }
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
