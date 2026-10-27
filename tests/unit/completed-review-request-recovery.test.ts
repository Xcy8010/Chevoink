import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { readCompletedReviewRequestRecovery } from '../../api/lib/agent/review-request-recovery.js'
import * as originals from '../../api/lib/agent/original-request.js'
import * as guard from '../../api/lib/agent/chapter-review-guard.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { bindLegacyContinuityAssessment, legacyContinuityAssessmentKey, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import type { PendingReviewCall } from '../../api/lib/agent/checkpoint.js'

afterEach(() => vi.restoreAllMocks())
function fixture(toolName: PendingReviewCall['toolName']) {
  const subject = { userId: 'user', novelId: 'novel', runId: 'run' }, ctx = { ...subject, callId: 'check' } as ToolContext
  const chapter = { id: 'chapter', revision: 3, orderIndex: 1, content: 'The guard closes the door.' }
  const item: PendingReviewCall = { compilationId: 'comp', chapterId: chapter.id, revision: 3, toolName, callId: 'check' }
  const raw = JSON.stringify({ findings: [] }), input: LegacyAssessmentInput = { chapterId: chapter.id, revision: 3, bodies: { current: chapter.content, previous: null },
    system: 'Frozen reviewer', content: 'Frozen complete input', parserVersion: 7, sourceScope: { currentOrderIndex: 1, previous: [] }, targetType: 'story_compilation', targetId: 'comp' }
  const first = inspectContinuityResponse(raw, input.bodies, true, 7, undefined, input.sourceScope)
  const audit = bindLegacyContinuityAssessment(first, ctx, input).audit
  const usage = [{ id: 'usage', action: toolName === 'continuity_validate' ? 'agent3ContinuityCritic' : 'agent3HumanityCritic',
    usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0,
    creditChargeMilli: 1, durationMs: 1, createdAt: new Date(2000), agentRunId: 'run', targetId: toolName === 'continuity_validate' ? 'comp' : 'chapter' }]
  const payload = { toolName, callId: item.callId, ok: true, reviewRequestFinished: { version: 1, chapterId: chapter.id, revision: 3,
    contentHash: createHash('sha256').update(chapter.content).digest('hex'), usageIds: ['usage'] } }
  const history = [{ id: 'call', runId: 'run', seq: 1, type: 'tool.call', createdAt: new Date(1000), payload: { toolName, callId: 'check', args: { compilationId: 'comp' } } },
    { id: 'result', runId: 'run', seq: 2, type: 'tool.result', createdAt: new Date(3000), payload }]
  const report = { id: 'quality', chapterId: chapter.id, chapterRevision: 3, compilationId: 'comp', runId: 'run', deterministicMetrics: { criticResponse: { callId: 'check' } } }
  const state: guard.ChapterReviewReadiness = { ready: false, checksRequired: true, compilationId: 'comp', chapterId: chapter.id, revision: 3,
    continuity: toolName === 'continuity_validate' ? 'complete' : 'missing', quality: toolName === 'quality_analyze' ? 'complete' : 'missing',
    continuityErrorCount: 1, qualityErrorCount: 0, decisionPending: true, qualityReportId: 'quality', requiredTools: [],
    decisionBinding: { contentHash: runtimeJson({ content: chapter.content }).hash, continuityBinding: 'binding', qualityReportId: 'quality', qualityReportHash: null } }
  const original = { taskId: 'task', sourceRunId: 'run', prompt: 'Revise chapter one.', spec: { id: 'task', scope: { novelId: 'novel', chapterIds: ['chapter'] } } }
  vi.spyOn(originals, 'readOriginalTaskRequest').mockResolvedValue(original as unknown as Awaited<ReturnType<typeof originals.readOriginalTaskRequest>>)
  vi.spyOn(originals, 'originalTaskRunIds').mockResolvedValue(['run'])
  const readiness = vi.spyOn(guard, 'readChapterReviewReadiness').mockImplementation(async () => state)
  const frames = [{ stage: 'first', input, audit: first.audit, usageIds: ['usage'], response: { content: JSON.stringify(raw), finishReason: 'stop', toolCalls: [], transportComplete: true } }]
  const db = { agentRun: { findFirst: vi.fn(async () => ({ id: 'run' })) }, agentProviderAttempt: { count: vi.fn(async () => 0) },
    chapter: { findFirst: vi.fn(async () => chapter) }, storyCompilation: { findFirst: vi.fn(async () => ({ validation: { independentCheck: 'complete', continuityCriticResponse: audit } })) },
    chapterQualityReport: { findFirst: vi.fn(async () => report) }, agentRunEvent: { findMany: vi.fn(async () => history) },
    aiUsageLog: { findMany: vi.fn(async () => usage) }, agentArtifact: { findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: { where: { metadata: { path: string[]; equals: string } } }) => {
        const path = where.metadata.path[0]
        if (path === 'continuityAssessmentRequestKey') return [{ runId: 'run', metadata: { callId: 'check', input } }]
        if (path === 'assessmentKey') return frames.map(metadata => ({ runId: 'run', metadata }))
        if (path === 'assessmentRequestOwnerKey') return [{ metadata: { stage: 'first', usageIds: ['usage'] } }]
        throw Error('Unexpected synthetic metadata query ' + path)
      }) } } as unknown as Prisma.TransactionClient
  expect(legacyContinuityAssessmentKey(ctx, input)).toBe((audit as unknown as { assessmentRequest: { key: string } }).assessmentRequest.key)
  return { subject, item, chapter, state, original, input, history, payload, usage, report, db, readiness, frames }
}

describe('successful journal results retire only their authenticated pending request', () => {
  it.each(['continuity_validate', 'quality_analyze'] as const)('retires %s despite another missing check and ordinary opinions, with no new fee or write', async toolName => {
    const f = fixture(toolName), before = JSON.stringify({ history: f.history, frames: f.frames, usage: f.usage })
    expect(await readCompletedReviewRequestRecovery(f.db, f.subject, [f.item])).toEqual([f.item])
    expect(f.state.ready).toBe(false); expect(f.state.decisionPending).toBe(true)
    expect(JSON.stringify({ history: f.history, frames: f.frames, usage: f.usage })).toBe(before)
    expect(f.readiness).toHaveBeenCalledOnce()
  })
  it.each(['missing-result', 'duplicate-result', 'wrong-call', 'wrong-tool', 'old-revision', 'changed-body', 'outside-scope', 'missing-owner',
    'unknown-attempt', 'unknown-billing', 'missing-usage', 'wrong-proof', 'incomplete-report', 'stale-input', 'wrong-reservation'] as const)(
    'keeps continuity pending after %s', async kind => {
      const f = fixture('continuity_validate')
      if (kind === 'missing-result') f.history.pop()
      if (kind === 'duplicate-result') f.history.push({ ...f.history[1] })
      if (kind === 'wrong-call') f.payload.callId = 'another-call'
      if (kind === 'wrong-tool') f.payload.toolName = 'quality_analyze'
      if (kind === 'old-revision') f.chapter.revision++
      if (kind === 'changed-body') f.chapter.content += ' Changed.'
      if (kind === 'outside-scope') f.original.spec.scope.chapterIds = []
      if (kind === 'missing-owner') vi.mocked(f.db.agentRun.findFirst).mockResolvedValue(null)
      if (kind === 'unknown-attempt') vi.mocked(f.db.agentProviderAttempt.count).mockResolvedValue(1)
      if (kind === 'unknown-billing') { f.usage[0].usageSource = 'unknown'; f.usage[0].billingStatus = 'pending_usage' }
      if (kind === 'missing-usage') f.usage.splice(0)
      if (kind === 'wrong-proof') f.payload.reviewRequestFinished.usageIds = ['wrong-usage']
      if (kind === 'incomplete-report') f.state.continuity = 'incomplete'
      if (kind === 'stale-input') f.input.revision++
      if (kind === 'wrong-reservation') vi.mocked(f.db.agentArtifact.findMany).mockResolvedValue([])
      expect(await readCompletedReviewRequestRecovery(f.db, f.subject, [f.item])).toEqual([])
    })
  it.each(['wrong-report-call', 'unknown-billing', 'missing-usage', 'wrong-proof', 'incomplete-report'] as const)('keeps quality pending after %s', async kind => {
    const f = fixture('quality_analyze')
    if (kind === 'wrong-report-call') f.report.deterministicMetrics.criticResponse.callId = 'other'
    if (kind === 'unknown-billing') f.usage[0].usageSource = 'unknown'
    if (kind === 'missing-usage') f.usage.splice(0)
    if (kind === 'wrong-proof') f.payload.reviewRequestFinished.usageIds = []
    if (kind === 'incomplete-report') f.state.quality = 'incomplete'
    expect(await readCompletedReviewRequestRecovery(f.db, f.subject, [f.item])).toEqual([])
  })
})

it.each(['repaired', 'wrong-after', 'wrong-artifact', 'wrong-anchor', 'unknown-repair-fee', 'cancelled'] as const)(
  'retires the already completed quality request without certifying the new revision: %s', async scenario => {
    const f = fixture('quality_analyze'), before = f.chapter.content, after = before.replace('guard', 'clerk')
    const finding = { id: 'finding', startOffset: 4, endOffset: 9, evidenceHash: createHash('sha256').update('guard').digest('hex'), disposition: 'repaired' }
    f.chapter.content = after; f.chapter.revision = 4; f.state.revision = 4; f.state.quality = 'stale'
    f.state.decisionBinding!.contentHash = runtimeJson({ content: after }).hash
    Object.assign(f.report, { chapterRevision: 4, repairRound: 1, status: 'repaired', chapter: { title: 'Synthetic chapter' }, findings: [finding] })
    Object.assign(f.report.deterministicMetrics, { independentCheck: 'complete', sourceRevision: 3,
      contentHash: createHash('sha256').update(before).digest('hex'), repairedContentHash: createHash('sha256').update(after).digest('hex') })
    const display = { kind: 'qualityReport', reportId: 'quality', chapterId: 'chapter', chapterRevision: 4, repairRound: 1, status: 'repaired',
      appliedBodyChange: { version: 1, chapterId: 'chapter', chapterTitle: 'Synthetic chapter', before, after, sourceRevision: 3, targetRevision: 4 } }
    Object.assign(f.payload, { display })
    const artifact = { runId: 'run', content: JSON.stringify([{ findingId: 'finding', replacement: 'clerk' }]),
      metadata: { phase: 'humanity_revision_auto', reportId: 'quality', findingIds: ['finding'], sourceRevision: 3, targetRevision: 4 } }
    vi.mocked(f.db.agentArtifact.findMany).mockResolvedValue([artifact] as never)
    f.usage.push({ ...f.usage[0], id: 'repair-usage', action: 'agent3HumanityRevision', targetId: 'quality' })
    f.payload.reviewRequestFinished.usageIds.push('repair-usage')
    if (scenario === 'wrong-after') display.appliedBodyChange.after += ' wrong'
    if (scenario === 'wrong-artifact') artifact.content = JSON.stringify([{ findingId: 'finding', replacement: 'stranger' }])
    if (scenario === 'wrong-anchor') finding.evidenceHash = '0'.repeat(64)
    if (scenario === 'unknown-repair-fee') f.usage[1].usageSource = 'unknown'
    if (scenario === 'cancelled') vi.mocked(f.db.agentRun.findFirst).mockResolvedValue(null)
    const protectedRows = JSON.stringify({ report: f.report, artifact, usage: f.usage, payload: f.payload })
    expect(await readCompletedReviewRequestRecovery(f.db, f.subject, [f.item])).toEqual(scenario === 'repaired' ? [f.item] : [])
    expect(f.state.quality).toBe('stale')
    expect(JSON.stringify({ report: f.report, artifact, usage: f.usage, payload: f.payload })).toBe(protectedRows)
  })


it.each(['quality_analyze', 'continuity_validate'] as const)('authenticates older successful %s journals without a synthetic receipt', async name => {
  const f = fixture(name)
  delete (f.payload as Record<string, unknown>).reviewRequestFinished
  expect(await readCompletedReviewRequestRecovery(f.db, f.subject, [f.item])).toEqual([f.item])
})

it.each(['quality_analyze', 'continuity_validate'] as const)(
  'accepts only a genuinely free %s cache, never an old known report masking a new unknown request', async name => {
    for (const scenario of ['free', 'new-unknown-fee', 'new-reservation', 'unknown-source'] as const) {
      const f = fixture(name), sourceHistory = structuredClone(f.history), oldArtifacts = vi.mocked(f.db.agentArtifact.findMany).getMockImplementation()!
      f.item.callId = 'cache-check'; f.history[0].seq = 3; f.history[0].createdAt = new Date(4000); f.history[0].payload.callId = 'cache-check'
      f.history[1].seq = 4; f.history[1].createdAt = new Date(6000); f.payload.callId = 'cache-check'
      delete (f.payload as Record<string, unknown>).reviewRequestFinished
      const all = [...sourceHistory, ...f.history]
      vi.mocked(f.db.agentRunEvent.findMany).mockImplementation((async ({ where }: { where: { payload?: { equals: string }; OR?: Array<{ payload: { equals: string } }> } }) =>
        all.filter(row => where.payload ? row.payload.callId === where.payload.equals : where.OR?.some(value => row.payload.callId === value.payload.equals))) as never)
      if (scenario === 'new-unknown-fee') f.usage.push({ ...f.usage[0], id: 'new-unknown', usageSource: 'unknown', billingStatus: 'pending_usage', createdAt: new Date(5000) })
      if (scenario === 'unknown-source') { f.usage[0].usageSource = 'unknown'; f.usage[0].billingStatus = 'pending_usage' }
      vi.mocked(f.db.aiUsageLog.findMany).mockImplementation((async ({ where }: { where: { id?: { in: string[] }; createdAt?: { gte: Date; lte: Date } } }) =>
        f.usage.filter(row => where.id ? where.id.in.includes(row.id) : !where.createdAt || row.createdAt >= where.createdAt.gte && row.createdAt <= where.createdAt.lte)) as never)
      vi.mocked(f.db.agentArtifact.findMany).mockImplementation((async (query: { where: { metadata: { path: string[]; equals: string } } }) => {
        if (query.where.metadata.path[0] === 'callId') return scenario === 'new-reservation' ? [{ metadata: { callId: 'cache-check' } }] : []
        return oldArtifacts(query as never)
      }) as never)
      // Quality has no continuity reservation; its own zero-dispatch proof is
      // absence of any paid usage in this exact call interval.
      if (name === 'quality_analyze' && scenario === 'new-reservation') continue
      expect(await readCompletedReviewRequestRecovery(f.db, f.subject, [f.item]), scenario).toEqual(scenario === 'free' ? [f.item] : [])
      vi.restoreAllMocks()
    }
  })
