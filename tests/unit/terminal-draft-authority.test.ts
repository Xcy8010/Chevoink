import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { terminalDraftFixture } from '../helpers/terminal-draft-fixture.js'
import { readTerminalDraftBinding } from '../../api/lib/agent/terminal-draft-authority.js'
import { currentTerminalReview, currentCandidateEditAddress, terminalCandidateSchema, terminalReviewFailure } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalProposalCacheMatches } from '../../api/lib/agent/terminal-proposal-context.js'

function database(f: ReturnType<typeof terminalDraftFixture>) {
  const run = { id: f.ctx.runId, sessionId: 'session', taskRootId: null, startRequest: { prompt: 'Modify the synthetic chapter.' },
    taskSpec: { id: f.binding.taskId, scope: { terminalCoverageProtocol: 2 } } }
  const tx = { agentRun: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    where.userId !== f.ctx.userId || where.novelId !== f.ctx.novelId ? null : run), findFirstOrThrow: vi.fn(async () => run),
  findMany: vi.fn(async ({ where }: { where: { session?: unknown } }) => where.session ? [] : [run]) },
  agentChildExecutionGrant: { findUnique: vi.fn(async () => null) }, agentSession: { findFirst: vi.fn(async () => null) },
  agentArtifact: { findMany: vi.fn(async () => f.rows.filter(row => row.runId === f.ctx.runId)) },
  aiUsageLog: { findMany: vi.fn(async () => f.usage) } }
  const read = (signal = new AbortController().signal) => readTerminalDraftBinding(tx as unknown as Prisma.TransactionClient,
    { ...f.ctx, compilationId: 'compilation', signal }, f.binding, f.chapter, f.validation, f.nextContext)
  return { tx, read }
}

const review = (f: ReturnType<typeof terminalDraftFixture>, binding: Awaited<ReturnType<typeof readTerminalDraftBinding>>) =>
  currentTerminalReview(f.validation, f.chapter.content, f.nextContext, binding)

describe('authenticated never-verified terminal drafts', () => {
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
