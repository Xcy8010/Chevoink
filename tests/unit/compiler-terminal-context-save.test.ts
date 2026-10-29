import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { buildContinuityReviewManifest } from '../../api/lib/agent/continuity-review-v4.js'
import { inspectAuthenticatedContinuityAssessment } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import { bindLegacyContinuityAssessment, legacyContinuityAssessmentKey, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import * as authority from '../../api/lib/agent/terminal-draft-authority.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as manuscript from '../../api/lib/agent/manuscript-scope.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

afterEach(() => vi.restoreAllMocks())

function fixture(parser: 8 | 9 = 9) {
  const subject = { userId: 'user', novelId: 'novel', runId: 'run', compilationId: 'compilation' }
  const spec = { ...buildTaskSpec({ runId: subject.runId, novelId: subject.novelId, chapterId: 'chapter', prompt: '修改第一章',
    continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2 }), id: 'task' }
  const chapter = { id: 'chapter', revision: 4, orderIndex: 1, title: 'First', content: 'The packet remains sealed.' }
  const bridge = { fromChapterId: null }, sceneTasks = [{ ordinal: 1, goal: 'Wait', turn: 'Keep the packet sealed.' }]
  const candidate = terminalCandidateSchema.parse({ exitState: { objects: [chapter.content] } })
  const context = terminalEvidenceContext(chapter, null, 2, undefined, undefined, 6, 2)
  const bodies = { current: chapter.content, previous: null, terminalEvidence: context }, sourceScope = { currentOrderIndex: 1, previous: [] }
  const manifest = buildContinuityReviewManifest({ subject: { userId: subject.userId, novelId: subject.novelId, taskId: spec.id,
    targetType: 'story_compilation', targetId: subject.compilationId, chapterId: chapter.id, revision: chapter.revision }, bodies, candidate, sourceScope,
    sourceHash: null, sourceVersions: { current: context.current, previous: null }, verifiedCoverage: null, draftProposals: null })
  const input: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies, terminalCandidate: candidate,
    sourceScope, targetType: 'story_compilation', targetId: subject.compilationId, bindingHash: runtimeJson({ chapter: context.current }).hash,
    system: 'Frozen synthetic system.', content: 'Frozen synthetic review.', parserVersion: parser,
    reassessmentProtocol: parser === 9 ? 6 : 5, ...(parser === 9 ? { continuityManifest: manifest } : {}) }
  const wire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Reviewed the whole source.',
    ...(parser === 9 ? { findingIds: [] } : { findingIndexes: [] }) })), terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }],
  terminalProofVerdicts: [], terminalDispositions: [] }
  const raw = JSON.stringify(wire), inspected = inspectAuthenticatedContinuityAssessment(raw, input, true)
  expect(inspected.complete).toBe(true)
  const ctx = { ...subject, callId: 'original-review' } as ToolContext
  const key = legacyContinuityAssessmentKey(ctx, input), bound = bindLegacyContinuityAssessment(inspected, ctx, input)
  const rows = [
    { id: 'reservation', runId: subject.runId, artifactType: 'continuityReview', metadata: { version: 1, continuityAssessmentRequestKey: key,
      assessmentChapterId: chapter.id, input, callId: ctx.callId, admissionId: null } },
    { id: 'owner', runId: subject.runId, artifactType: 'continuityReview', metadata: { version: 1, assessmentRequestOwnerKey: key, stage: 'first', callId: ctx.callId, usageIds: ['usage'] } },
    { id: 'response', runId: subject.runId, artifactType: 'continuityReview', metadata: { version: 1, assessmentKey: key, input, stage: 'first', callId: ctx.callId,
      usageIds: ['usage'], response: { content: JSON.stringify(raw), transportComplete: true, finishReason: 'stop', toolCalls: [] }, audit: inspected.audit } },
  ]
  const usage = { id: 'usage', userId: subject.userId, novelId: subject.novelId, agentRunId: subject.runId, targetType: input.targetType, targetId: input.targetId,
    action: 'agent3ContinuityCritic', usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, creditChargeMilli: 17,
    requestTokens: 12, responseTokens: 8 }
  const update = vi.fn(), run = { id: subject.runId, userId: subject.userId, novelId: subject.novelId, taskRootId: null,
    runtimeProtocolVersion: 0, taskSpec: spec, sessionId: 'session', status: 'running' }
  // Only original admission/manuscript scope are isolated here. The actual
  // lifecycle reader and DB-minted opaque authority authenticate the raw pair.
  vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ prompt: '修改第一章', spec, taskId: spec.id, sourceRunId: subject.runId, parentRunId: null })
  vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue([subject.runId])
  vi.spyOn(manuscript, 'assertAgentManuscriptCurrent').mockResolvedValue(undefined as never)
  const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: subject.novelId }]),
    agentRun: { findFirst: vi.fn(async ({ where }) => where.id === subject.runId && where.userId === subject.userId && where.novelId === subject.novelId ? run : null) },
    storyCompilation: { findFirst: vi.fn().mockResolvedValue({ id: subject.compilationId, chapter, bridge, sceneTasks, preparedContext: {}, validation: {}, status: 'active' }), update },
    chapter: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue({ id: chapter.id }) },
    agentArtifact: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(async ({ where }) => rows.filter(row => {
      const owned = typeof where.runId === 'string' ? row.runId === where.runId : where.runId.in.includes(row.runId)
      return owned && row.artifactType === where.artifactType && (!where.metadata || (row.metadata as Record<string, unknown>)[where.metadata.path[0]] === where.metadata.equals)
    })) },
    aiUsageLog: { findMany: vi.fn(async ({ where }) => where.id.in.includes(usage.id) && where.userId === usage.userId && where.novelId === usage.novelId
      && where.agentRunId === usage.agentRunId && where.targetId === usage.targetId && where.targetType === usage.targetType ? [usage] : []) },
  }
  const coverage = compilerContinuityCoverage({ chapter, bridge, sceneTasks, source: null, terminalCandidate: candidate }, 11)
  const validation = { checkedChapterId: chapter.id, checkedRevision: chapter.revision, terminalCandidate: candidate, coverage,
    independentCheck: 'complete', findings: [], continuityCriticResponse: bound.audit }
  const read = async () => {
    const binding = await authority.readTerminalDraftBinding(db as unknown as Prisma.TransactionClient, subject,
      { taskId: spec.id, preparedContext: {} }, chapter, validation, context)
    return { binding, review: currentTerminalReview(validation, chapter.content, context, binding) }
  }
  return { subject, spec, chapter, candidate, context, rows, usage, db, update, read, bound, validation }

}

describe('read-only compiler history preserves optional terminal coverage', () => {
  it('authenticates the stored parser9 report without inventing optional coverage or saving it as current', async () => {
    const f = fixture(), original = JSON.stringify({ rows: f.rows, usage: f.usage, validation: f.validation })
    const result = await f.read()
    expect(result.binding.reviewAuthority).toBeDefined()
    expect(result.review).toMatchObject({ supported: true })
    expect(f.db.aiUsageLog.findMany).toHaveBeenCalledOnce()
    expect(f.context).not.toHaveProperty('factCoverage')
    expect(f.update).not.toHaveBeenCalled()
    expect(JSON.stringify({ rows: f.rows, usage: f.usage, validation: f.validation })).toBe(original)
  })
  it.each(['missing-grant', 'unknown-billing', 'context-drift'] as const)('cannot interpret %s as an authenticated historical report', async fault => {
    const f = fixture()
    if (fault === 'missing-grant') f.rows.splice(0, 1)
    if (fault === 'unknown-billing') f.usage.usageSource = 'unknown'
    if (fault === 'context-drift') f.context.current.revision++
    const result = await f.read()
    expect(result.review).toBeNull()
    expect(result.binding.reviewAuthority).toBeUndefined()
    expect(f.update).not.toHaveBeenCalled()
  })
  it('retains the exact parser8 audit and optional-coverage absence without applying or upgrading it', async () => {
    const f = fixture(8), before = JSON.stringify(f.bound.audit)
    expect(f.bound).toMatchObject({ complete: true, audit: { parserVersion: 8 } })
    expect(f.context).not.toHaveProperty('factCoverage')
    expect(inspectAuthenticatedContinuityAssessment(JSON.parse(f.bound.audit.rawResponse.content), f.rows[0].metadata.input!, true).audit.parserVersion).toBe(8)
    expect(JSON.stringify(f.bound.audit)).toBe(before)
    expect(f.update).not.toHaveBeenCalled()
  })
})
