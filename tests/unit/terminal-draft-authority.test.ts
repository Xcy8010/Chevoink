import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { terminalDraftFixture, terminalDraftRevisionFixture } from '../helpers/terminal-draft-fixture.js'
import { readTerminalDraftBinding } from '../../api/lib/agent/terminal-draft-authority.js'
import { currentTerminalReview, currentCandidateEditAddress, terminalCandidateSchema, terminalReviewFailure } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalProposalCacheMatches } from '../../api/lib/agent/terminal-proposal-context.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey } from '../../api/lib/agent/assessment-response-lifecycle.js'

function pendingOnlyFailure(f: ReturnType<typeof terminalDraftFixture>, second = false) {
  const wire = { ...f.currentWire, findings: [{ signal: 'object', severity: 'warning', evidence: 'The current text says “an invented quotation”.',
    suggestion: 'Check the actual text.', sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: 'an invented quotation' }] }] }
  const original = f.inspect(wire, f.nextInput)
  expect(original.audit.classification).toBe('source_invalid')
  f.add('pending-only-failed', f.nextInput, wire)
  if (second) {
    const key = legacyContinuityAssessmentKey({ ...f.ctx, callId: 'pending-only-failed' }, f.nextInput), usageId = 'pending-only-second-usage'
    const response = { ...wire, decisions: [{ index: 0, action: 'retract', reason: 'The independent quotation remains unverified.',
      sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: f.chapter.content }] }] }
    const at = new Date(100)
    for (const [suffix, metadata] of Object.entries({ claim: { fullReassessmentKey: key, input: f.nextInput, original: original.audit,
      request: continuityReassessmentRequest(f.nextInput.system, f.nextInput.content, original, f.nextInput.bodies, false, 5) },
    owner: { assessmentRequestOwnerKey: key, stage: 'reassessment', usageIds: [usageId] },
    response: { assessmentKey: key, stage: 'reassessment', usageIds: [usageId], input: f.nextInput, audit: f.inspect(response, f.nextInput).audit,
      response: { content: JSON.stringify(JSON.stringify(response)), transportComplete: true, finishReason: 'stop', toolCalls: [] } } })) {
      f.rows.push({ id: `pending-second-${suffix}`, runId: f.ctx.runId, artifactType: 'continuityReview', createdAt: at, metadata: { version: 1, ...metadata } })
    }
    f.usage.push({ ...f.usage[0], id: usageId, action: 'agent3ContinuityCriticSecondPass' })
  }
}

function database(f: ReturnType<typeof terminalDraftFixture>) {
  const run = { id: f.ctx.runId, sessionId: 'session', taskRootId: null, startRequest: { prompt: 'Modify the synthetic chapter.' },
    taskSpec: { id: f.binding.taskId, scope: { terminalCoverageProtocol: 2 } } }
  const tx = { agentRun: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    where.userId !== f.ctx.userId || where.novelId !== f.ctx.novelId ? null : run), findFirstOrThrow: vi.fn(async () => run),
  findMany: vi.fn(async ({ where }: { where: { session?: unknown } }) => where.session ? [] : [run]) },
  agentChildExecutionGrant: { findUnique: vi.fn(async () => null) }, agentSession: { findFirst: vi.fn(async () => null) },
  agentArtifact: { findMany: vi.fn(async (args: { where: { artifactType: string } }) => f.rows.filter(row => row.runId === f.ctx.runId && row.artifactType === args.where.artifactType)) },
  aiUsageLog: { findMany: vi.fn(async () => f.usage) }, chapterQualityReport: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  agentMessage: { findMany: vi.fn(async (): Promise<unknown[]> => []) } }
  const read = (signal = new AbortController().signal) => readTerminalDraftBinding(tx as unknown as Prisma.TransactionClient,
    { ...f.ctx, compilationId: 'compilation', signal }, f.binding, f.chapter, f.validation, f.nextContext)
  return { tx, read, run }
}

const review = (f: ReturnType<typeof terminalDraftFixture>, binding: Awaited<ReturnType<typeof readTerminalDraftBinding>>) =>
  currentTerminalReview(f.validation, f.chapter.content, f.nextContext, binding)

describe('authenticated never-verified terminal drafts', () => {
  it.each([false, true])('ignores only an authenticated pending-only source failure, with second claimed=%s', async second => {
    const f = terminalDraftFixture(), db = database(f)
    pendingOnlyFailure(f, second)
    const before = JSON.stringify({ rows: f.rows, usage: f.usage, prepared: f.preparedContext })
    expect(review(f, await db.read())?.deliveryEligibility.eligible).toBe(true)
    expect(JSON.stringify({ rows: f.rows, usage: f.usage, prepared: f.preparedContext })).toBe(before)
  })

  it.each(['pending-drift', 'candidate-mention', 'billing', 'missing-raw', 'corrupt-audit', 'second-unknown', 'second-request'] as const)(
    'does not exempt pending-only history after %s', async scenario => {
      const f = terminalDraftFixture(); pendingOnlyFailure(f, true)
      const response = f.rows.find(row => row.id === 'pending-only-failed-response')!
      if (scenario === 'pending-drift') {
        // Even a self-consistent different pending origin is not this object.
        const input = structuredClone(f.nextInput)
        input.bodies.terminalEvidence!.proposalChanges!.proposals[0].origin.auditHash = 'f'.repeat(64)
        f.add('pending-drift', input, { ...f.currentWire, findings: [{ signal: 'object', severity: 'warning', evidence: '“Missing”',
          suggestion: 'Check.', sourceEvidence: [{ source: 'current', quote: 'Missing' }] }] })
      }
      if (scenario === 'candidate-mention') f.add('candidate-mentioned-failure', f.input, {})
      if (scenario === 'billing') Object.assign(f.usage.find(row => row.id === 'usage-pending-only-failed')!, { billingStatus: 'pending_usage', usageSource: 'unknown' })
      if (scenario === 'missing-raw') f.rows.splice(f.rows.indexOf(response), 1)
      if (scenario === 'corrupt-audit') (response.metadata.audit as { contentHash: string }).contentHash = 'f'.repeat(64)
      if (scenario === 'second-unknown') (f.rows.find(row => row.id === 'pending-second-response')!.metadata.response as { transportComplete: boolean }).transportComplete = false
      if (scenario === 'second-request') (f.rows.find(row => row.id === 'pending-second-claim')!.metadata.request as { content: string }).content += ' changed'
      expect(review(f, await database(f).read())?.deliveryEligibility.eligible).toBe(false)
    })

  it('authenticates one consumed new-draft quality repair across revisions, without enlarging writing permission', async () => {
    const q = terminalDraftRevisionFixture(), { f } = q, db = database(f)
    Object.assign(db.run, { taskSpec: q.spec, startRequest: { prompt: q.prompt }, writingBindings: { version: 1, taskId: q.spec.id,
      targets: [{ orderIndex: 1, chapterId: f.chapter.id }] } })
    f.rows.push(q.artifact)
    db.tx.chapterQualityReport.findMany.mockResolvedValue([q.report])
    db.tx.agentMessage.findMany.mockResolvedValue([{ runId: f.ctx.runId, parts: [q.part] }])
    const before = JSON.stringify({ rows: f.rows, usage: f.usage, prepared: f.preparedContext, receipt: q.receipt })
    expect(q.spec.scope.writing?.repairAuthorized).toBe(false)
    const binding = await db.read()
    expect(review(f, binding)).toMatchObject({ supported: false, proposals: { complete: false }, deliveryEligibility: { eligible: true } })
    expect(JSON.stringify({ rows: f.rows, usage: f.usage, prepared: f.preparedContext, receipt: q.receipt })).toBe(before)
  })

  it.each(['missing-receipt', 'wrong-receipt', 'unbound-target', 'duplicate-artifact', 'missing-message', 'wrong-before', 'wrong-patch', 'overlap',
    'wrong-owner', 'wrong-report-owner', 'revision-jump', 'wrong-after'] as const)('keeps cross-revision drafts blocked after %s', async scenario => {
    const q = terminalDraftRevisionFixture(), { f } = q, db = database(f)
    Object.assign(db.run, { taskSpec: q.spec, startRequest: { prompt: q.prompt }, writingBindings: { version: 1, taskId: q.spec.id,
      targets: [{ orderIndex: 1, chapterId: f.chapter.id }] } })
    f.rows.push(q.artifact)
    if (scenario === 'missing-receipt') delete (f.validation as Record<string, unknown>).newDraftRevision
    if (scenario === 'wrong-receipt') q.receipt.compilationId = 'another-compilation'
    if (scenario === 'unbound-target') Object.assign(db.run, { writingBindings: { version: 1, taskId: q.spec.id, targets: [] } })
    if (scenario === 'duplicate-artifact') f.rows.push({ ...q.artifact, id: 'duplicate-repair-artifact' })
    if (scenario === 'wrong-before') q.part.snapshot.previousValue += ' changed'
    if (scenario === 'wrong-patch') q.artifact.content = JSON.stringify([{ findingId: 'missing', replacement: 'carefully sealed' }])
    if (scenario === 'overlap') {
      q.report.findings.push({ ...q.report.findings[0], id: 'overlap' })
      q.artifact.metadata.findingIds.push('overlap')
      q.artifact.content = JSON.stringify([{ findingId: 'repair-finding', replacement: 'carefully sealed' }, { findingId: 'overlap', replacement: 'sealed' }])
    }
    if (scenario === 'wrong-owner') q.report.findings[0].userId = 'another-owner'
    if (scenario === 'wrong-report-owner') q.report.userId = 'another-owner'
    if (scenario === 'revision-jump') q.receipt.checkedRevision = 2
    if (scenario === 'wrong-after') q.report.deterministicMetrics.repairedContentHash = 'f'.repeat(64)
    db.tx.chapterQualityReport.findMany.mockResolvedValue([q.report])
    db.tx.agentMessage.findMany.mockResolvedValue(scenario === 'missing-message' ? [] : [{ runId: f.ctx.runId, parts: [q.part] }])
    expect(review(f, await db.read())?.deliveryEligibility.eligible).toBe(false)
  })

  it.each(['missing', 'tampered'])('rebinds both token and invocation cache when the consumed receipt is %s after minting', async scenario => {
    const q = terminalDraftRevisionFixture(), { f } = q, db = database(f), scope = new WeakMap()
    Object.assign(db.run, { taskSpec: q.spec, startRequest: { prompt: q.prompt }, writingBindings: { version: 1, taskId: q.spec.id,
      targets: [{ orderIndex: 1, chapterId: f.chapter.id }] } })
    f.rows.push(q.artifact); db.tx.chapterQualityReport.findMany.mockResolvedValue([q.report])
    db.tx.agentMessage.findMany.mockResolvedValue([{ runId: f.ctx.runId, parts: [q.part] }])
    const read = () => readTerminalDraftBinding(db.tx as unknown as Prisma.TransactionClient, { ...f.ctx, compilationId: 'compilation' },
      f.binding, f.chapter, f.validation, f.nextContext, scope)
    const first = await read()
    expect(review(f, first)?.deliveryEligibility.eligible).toBe(true)
    if (scenario === 'missing') delete (f.validation as Record<string, unknown>).newDraftRevision
    else q.receipt.afterHash = 'f'.repeat(64)
    expect(review(f, first)?.deliveryEligibility.eligible).toBe(false)
    expect(review(f, await read())?.deliveryEligibility.eligible).toBe(false)
    expect(db.tx.agentArtifact.findMany.mock.calls.filter(([args]) => args.where.artifactType === 'continuityReview')).toHaveLength(2)
  })
  it.each(['knowledge', 'body', 'objects', 'relationships', 'openLoops'])('preserves an unknown %s draft without turning it into an established fact', async field => {
    const f = terminalDraftFixture(field), db = database(f), before = JSON.stringify({ rows: f.rows, usage: f.usage, prepared: f.preparedContext, validation: f.validation })
    expect(currentTerminalReview(f.validation, f.chapter.content, f.nextContext, f.binding)?.deliveryEligibility.eligible).toBe(false)
    const binding = await db.read()
    expect(review(f, binding)).toMatchObject({ supported: false, proposals: { complete: false },
      deliveryEligibility: { eligible: true, basis: 'current_supported_with_preserved_drafts', preservedUnknownProposalIds: [f.proposal.id] } })
    expect(db.tx.agentArtifact.findMany).toHaveBeenCalledOnce()
    expect(db.tx.aiUsageLog.findMany).toHaveBeenCalledOnce()
    expect(JSON.stringify({ rows: f.rows, usage: f.usage, prepared: f.preparedContext, validation: f.validation })).toBe(before)
  })

  it('rejects JSON, copied and plain objects instead of trusting a serialized certificate', async () => {
    const f = terminalDraftFixture(), binding = await database(f).read()
    for (const token of [{}, { ...binding.draftAuthority }, JSON.parse(JSON.stringify(binding.draftAuthority)), { eligible: true, ids: [f.proposal.id] }]) {
      expect(review(f, { ...binding, draftAuthority: token })?.deliveryEligibility.eligible).toBe(false)
    }
  })

  it.each(['task', 'owner', 'novel', 'compilation', 'prepared'] as const)('rebinds minted authority after %s drift', async scenario => {
    const f = terminalDraftFixture(), binding = await database(f).read(), changed = { ...binding }
    if (scenario === 'task') changed.taskId = 'other-task'
    if (scenario === 'owner') changed.userId = 'other-owner'
    if (scenario === 'novel') changed.novelId = 'other-novel'
    if (scenario === 'compilation') changed.compilationId = 'other-compilation'
    if (scenario === 'prepared') changed.preparedContext = { ...f.preparedContext, changed: true }
    expect(review(f, changed)?.deliveryEligibility.eligible).toBe(false)
  })

  it.each(['raw', 'audit', 'billing', 'missing-response', 'missing-reservation', 'wrong-origin', 'wrong-owner', 'overflow'] as const)('keeps the old strict block for %s', async scenario => {
    const f = terminalDraftFixture(), db = database(f)
    const frame = f.rows.find(row => row.id === 'origin-response')!
    if (scenario === 'raw') (frame.metadata.response as { content: string }).content = JSON.stringify('{}')
    if (scenario === 'audit') (frame.metadata.audit as { contentHash: string }).contentHash = 'f'.repeat(64)
    if (scenario === 'billing') Object.assign(f.usage[0], { usageSource: 'unknown', billingStatus: 'pending_usage' })
    if (scenario === 'missing-response') f.rows.splice(f.rows.indexOf(frame), 1)
    if (scenario === 'missing-reservation') f.rows.splice(f.rows.findIndex(row => row.id === 'origin-reservation'), 1)
    if (scenario === 'wrong-origin') for (const row of f.rows.filter(row => row.id.startsWith('origin-'))) row.runId = 'foreign-run'
    if (scenario === 'wrong-owner') db.tx.agentRun.findFirst.mockResolvedValue(null)
    if (scenario === 'overflow') db.tx.agentArtifact.findMany.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => ({ ...f.rows[0], id: `overflow-${i}` })))
    if (scenario === 'wrong-owner') await expect(db.read()).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    else expect(review(f, await db.read())?.deliveryEligibility.eligible).toBe(false)
  })

  it('rejects a previously supported exact fact even when the present ledger omitted it', async () => {
    const f = terminalDraftFixture(), wire = structuredClone(f.originWire)
    wire.terminalVerdicts[0] = { claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] } as typeof wire.terminalVerdicts[number]
    f.add('earlier-supported', f.input, wire)
    expect(review(f, await database(f).read())?.deliveryEligibility.eligible).toBe(false)
  })

  it('rejects a relevant unresolved assessment but ignores a failure for a different exact fact', async () => {
    const f = terminalDraftFixture(), unrelated = terminalDraftFixture('knowledge')
    const input = { ...unrelated.input, terminalCandidate: terminalCandidateSchema.parse({ exitState: { knowledge: ['A different historical claim.'] } }) }
    f.add('unrelated-failure', input, {})
    expect(review(f, await database(f).read())?.deliveryEligibility.eligible).toBe(true)
    f.add('related-failure', f.input, {})
    expect(review(f, await database(f).read())?.deliveryEligibility.eligible).toBe(false)
  })

  it('does not treat a fact in the verified ledger as a disposable draft', async () => {
    const f = terminalDraftFixture()
    Object.assign(f.preparedContext, { terminalFactCoverage: { version: 1, taskId: f.binding.taskId, chapterId: f.chapter.id,
      facts: [{ id: f.proposal.id, field: f.proposal.field, claim: f.proposal.claim }], lastReview: { bodyHash: f.context.current.contentHash,
        candidateHash: runtimeJson(f.base).hash, input: f.context.factCoverage } } })
    expect(review(f, await database(f).read())?.deliveryEligibility.eligible).toBe(false)
  })

  it('retains the last unfinished action boundary and cancellation', async () => {
    const f = terminalDraftFixture('lastUnfinishedAction'), db = database(f)
    expect(review(f, await db.read())?.deliveryEligibility.eligible).toBe(false)
    const controller = new AbortController(); controller.abort()
    await expect(db.read(controller.signal)).rejects.toThrow()
  })

  it('loads fresh evidence on repeated invocations instead of caching a past authentication', async () => {
    const f = terminalDraftFixture(), db = database(f), first = await db.read(), second = await db.read()
    expect(first.draftAuthority).not.toBe(second.draftAuthority)
    expect(db.tx.agentArtifact.findMany).toHaveBeenCalledTimes(2)
    expect(db.tx.aiUsageLog.findMany).toHaveBeenCalledTimes(2)
    Object.assign(f.usage[0], { usageSource: 'unknown', billingStatus: 'pending_usage' })
    expect(review(f, await db.read())?.deliveryEligibility.eligible).toBe(false)
  })

  it('does not carry an incoming token through missing fresh evidence', async () => {
    const f = terminalDraftFixture(), db = database(f), prior = await db.read()
    f.rows.splice(f.rows.findIndex(row => row.id === 'origin-response'), 1)
    const fresh = await readTerminalDraftBinding(db.tx as unknown as Prisma.TransactionClient, { ...f.ctx, compilationId: 'compilation' }, prior,
      f.chapter, f.validation, f.nextContext)
    expect(fresh.draftAuthority).toBeUndefined()
    expect(review(f, fresh)?.deliveryEligibility.eligible).toBe(false)
  })

  it('binds the current saved audit to the actual current independent response', async () => {
    const f = terminalDraftFixture(), wire = { ...f.currentWire, terminalVerdicts: [{ claimIndex: 0, verdict: 'unknown', sourceEvidence: [] }] }
    const frame = f.rows.find(row => row.id === 'current-response')!
    frame.metadata.audit = f.inspect(wire, f.nextInput).audit
    ;(frame.metadata.response as { content: string }).content = JSON.stringify(JSON.stringify(wire))
    // The stored report is still a self-consistent supported response. It is
    // not the response belonging to this frozen request's actual observation.
    expect(review(f, f.binding)?.verdicts).toMatchObject([{ verdict: 'supported' }])
    expect(review(f, await database(f).read())?.deliveryEligibility.eligible).toBe(false)
  })

  it('cannot reuse an origin token after replacing only the current audit', async () => {
    const f = terminalDraftFixture(), binding = await database(f).read(), wire = structuredClone(f.currentWire)
    wire.semanticChecks[0].reason = 'A different independently reported relation.'
    const audit = f.inspect(wire, f.nextInput).audit
    Object.assign(f.validation, { continuityCriticResponse: { ...audit,
      assessmentRequest: (f.validation.continuityCriticResponse as unknown as Record<string, unknown>).assessmentRequest } })
    expect(review(f, binding)?.deliveryEligibility.eligible).toBe(false)
  })

  it('shares one aggregate authentication only inside the explicit invocation and database handle', async () => {
    const f = terminalDraftFixture(), db = database(f), scope = new WeakMap()
    const read = (tx = db.tx) => readTerminalDraftBinding(tx as unknown as Prisma.TransactionClient, { ...f.ctx, compilationId: 'compilation' }, f.binding,
      f.chapter, f.validation, f.nextContext, scope)
    const first = await read(), second = await read()
    expect(first.draftAuthority).toBe(second.draftAuthority)
    expect(db.tx.agentArtifact.findMany).toHaveBeenCalledOnce()
    const fullChapterRow = { ...f.chapter, createdAt: new Date(), updatedAt: new Date() }
    const sameChapter = await readTerminalDraftBinding(db.tx as unknown as Prisma.TransactionClient, { ...f.ctx, compilationId: 'compilation' }, f.binding,
      fullChapterRow, f.validation, f.nextContext, scope)
    expect(sameChapter.draftAuthority).toBe(first.draftAuthority)
    expect(db.tx.agentArtifact.findMany).toHaveBeenCalledOnce()
    const otherTransaction = await read({ ...db.tx })
    expect(otherTransaction.draftAuthority).not.toBe(first.draftAuthority)
    expect(db.tx.agentArtifact.findMany).toHaveBeenCalledTimes(2)
  })

  it('admits a current cache before rebuilding a growing verified catalogue', async () => {
    const f = terminalDraftFixture()
    Object.assign(f.preparedContext, { terminalFactCoverage: { version: 1, taskId: f.binding.taskId, chapterId: f.chapter.id,
      facts: [{ id: runtimeJson({ field: 'objects', claim: f.chapter.content }).hash, field: 'objects', claim: f.chapter.content }],
      lastReview: { bodyHash: f.context.current.contentHash, candidateHash: runtimeJson(f.candidate).hash, input: f.context.factCoverage } } })
    const binding = await database(f).read()
    expect(terminalProposalCacheMatches({ spec: { id: f.binding.taskId, scope: { terminalEvidenceProtocol: 2, terminalCoverageProtocol: 2 } },
      preparedContext: f.preparedContext, validation: f.validation, chapter: f.chapter, source: null, candidate: f.candidate, nextContext: f.nextContext }, binding)).toBe(true)
  })
})

describe('candidate edit addresses are separate from read-only history IDs', () => {
  it('only maps one exact same-field current claim, never a synonym or another field', () => {
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet is sealed.'], knowledge: ['The packet is sealed.'] } })
    expect(currentCandidateEditAddress(candidate, 'objects', 'The packet is sealed.')).toEqual({ factId: runtimeJson({ field: 'objects', claim: 'The packet is sealed.' }).hash })
    expect(currentCandidateEditAddress(candidate, 'openLoops', 'The packet is sealed.')).toBeNull()
    expect(currentCandidateEditAddress(candidate, 'objects', 'A sealed packet.')).toBeNull()
    candidate.exitState.objects.push('The packet is sealed.')
    expect(currentCandidateEditAddress(candidate, 'objects', 'The packet is sealed.')).toBeNull()
  })

  it('labels pending proposal IDs as read-only and supplies no invented current edit address', () => {
    const f = terminalDraftFixture(), failure = terminalReviewFailure(f.validation, f.chapter.content, f.nextContext, undefined, f.binding)!
    expect(failure.output).toContain('readOnlyProposalId')
    expect(failure.output).toContain('"currentCandidateEditAddress":null')
    expect(failure.output).toContain('删除候选不解除持续事实或旧提议的独立处置要求')
  })
})
