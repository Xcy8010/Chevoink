import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { emptyProposalFixture } from '../helpers/empty-proposal-fixture.js'
import { continuityRecoveryFixture } from '../helpers/continuity-recovery-fixture.js'
import { recoverEmptyOptionalProposalTable, sameEmptyOptionalProposalInput, validEmptyOptionalProposalProjection } from '../../api/lib/agent/continuity-empty-proposal-projection.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey, readLegacyContinuityAssessment, readReusableLegacyContinuityAssessment, runContinuityReassessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { buildContinuityReviewManifest } from '../../api/lib/agent/continuity-review-v4.js'
import { readKnownContinuityReplay } from '../../api/lib/agent/continuity-coordinator.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import * as writingScope from '../../api/lib/agent/writing-scope.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

function cachedPair(bindingHash = 'b'.repeat(64)) {
  const base = emptyProposalFixture(), scope = { currentOrderIndex: base.chapter.orderIndex, previous: [] }
  const inspect = (raw: string) => inspectContinuityResponse(raw, base.bodies, true, 8, base.candidate, scope, { responseContract: 3 })
  const f = { ...base, inspect, original: inspect(base.raw) }, ctx = { userId: 'owner', novelId: 'novel', runId: 'run', callId: 'old-call' } as ToolContext
  const input: LegacyAssessmentInput = { chapterId: f.chapter.id, revision: 1, bodies: f.bodies, terminalCandidate: f.candidate,
    parserVersion: 8, sourceScope: scope, reassessmentProtocol: 5, bindingHash, system: 'Frozen synthetic reviewer.', content: 'Frozen synthetic request.', targetType: 'story_compilation', targetId: 'compilation' }
  const key = legacyContinuityAssessmentKey(ctx, input)
  const usage = ['first', 'second'].map((id, i) => ({ id, action: i ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic', usageSource: 'reported',
    billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0, creditChargeMilli: 23 }))
  const response = { content: JSON.stringify(f.raw), encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] }
  const frames = ['first', 'reassessment'].map((stage, i) => ({ id: stage, metadata: { input, stage, usageIds: [usage[i].id], response: { ...response }, audit: f.original.audit } }))
  const owners = ['first', 'reassessment'].map((stage, i) => ({ metadata: { stage, usageIds: [usage[i].id] } }))
  const claim = { metadata: { input, original: f.original.audit, request: continuityReassessmentRequest(input.system, input.content, f.original, f.bodies, false, 5) } }
  const tx = { agentArtifact: { findMany: vi.fn(async ({ where }: { where: { metadata: { path: string[] } } }) => where.metadata.path[0] === 'assessmentKey' ? frames : owners),
    findFirst: vi.fn(async () => claim) }, aiUsageLog: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => usage.filter(row => where.id.in.includes(row.id))) } }
  return { ...f, ctx, input, key, usage, frames, claim, tx, read: () => readLegacyContinuityAssessment(tx as unknown as Prisma.TransactionClient, ctx, input) }
}

function cacheReader(f: ReturnType<typeof cachedPair>) {
  const run = { id: f.ctx.runId, sessionId: 'session', taskRootId: null, startRequest: { prompt: 'Write the synthetic chapter.' }, taskSpec: { id: 'task' } }
  const reservations = [{ id: 'reservation', runId: f.ctx.runId, metadata: { input: f.input, callId: f.ctx.callId, continuityAssessmentRequestKey: f.key } }]
  const frames = f.tx.agentArtifact.findMany
  const tx = { ...f.tx, agentRun: { findFirst: vi.fn(async () => run), findFirstOrThrow: vi.fn(async () => run),
    findMany: vi.fn(async ({ where }: { where: { session?: unknown } }) => where.session ? [] : [run]) },
    agentChildExecutionGrant: { findUnique: vi.fn(async () => null) }, agentSession: { findFirst: vi.fn(async () => null) },
    agentArtifact: { ...f.tx.agentArtifact, findMany: vi.fn(async (args: Parameters<typeof frames>[0]) => args.where.metadata.path[0] === 'assessmentChapterId' ? reservations : frames(args)) } }
  return { tx, reservations, read: (input = { ...f.input, content: 'New rendered guidance.' }) => readReusableLegacyContinuityAssessment(tx as unknown as Prisma.TransactionClient,
    { ...f.ctx, callId: 'new-call' }, input) }
}

describe('versioned empty optional proposal table projection', () => {
  it('binds free whole replay to the physical original raw, not the different rendered projection hash', async () => {
    const base = emptyProposalFixture(), bridge = { fromChapterId: null }, sceneTasks: unknown[] = []
    const coverage = compilerContinuityCoverage({ chapter: base.chapter, bridge, sceneTasks, source: null, terminalCandidate: base.candidate }, 11)
    const f = cachedPair(runtimeJson(coverage).hash), cache = cacheReader(f)
    const spec = buildTaskSpec({ runId: 'task', novelId: 'novel', prompt: '修改第一章', terminalEvidenceProtocol: 2,
      terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 })
    spec.id = 'task'
    const original = vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', spec } as Awaited<ReturnType<typeof originalRequest.readOriginalTaskRequest>>)
    const runs = vi.spyOn(originalRequest, 'originalTaskRunIds').mockResolvedValue(['run'])
    const scope = vi.spyOn(writingScope, 'assertWritingTarget').mockResolvedValue(
      { taskId: 'task', spec } as Awaited<ReturnType<typeof writingScope.assertWritingTarget>>)
    const saved = { id: 'compilation', runId: 'run', chapter: f.chapter, bridge, sceneTasks, preparedContext: {},
      validation: { independentCheck: 'unavailable', checkedRevision: 1, terminalCandidate: f.candidate, continuityCriticResponse: f.original.audit, coverage } }
    const db = { ...cache.tx, storyCompilation: { findFirst: vi.fn(async () => saved) }, chapter: { findMany: vi.fn(async () => []) } }
    const before = JSON.stringify({ saved, frames: f.frames, claim: f.claim, usage: f.usage })
    try {
      const result = await readKnownContinuityReplay(db as unknown as Prisma.TransactionClient, f.ctx, 'compilation')
      expect(result).toEqual({ assessmentKey: f.key, inputHash: runtimeJson(f.input).hash })
      expect(JSON.stringify({ saved, frames: f.frames, claim: f.claim, usage: f.usage })).toBe(before)
      for (const fault of ['raw', 'hash', 'key'] as const) {
        saved.validation.continuityCriticResponse = structuredClone(f.original.audit)
        if (fault === 'raw') saved.validation.continuityCriticResponse.rawResponse.content += ' '
        if (fault === 'hash') saved.validation.continuityCriticResponse.contentHash = 'f'.repeat(64)
        if (fault === 'key') Object.assign(saved.validation.continuityCriticResponse, { assessmentRequest: { key: 'f'.repeat(64) } })
        expect(await readKnownContinuityReplay(db as unknown as Prisma.TransactionClient, f.ctx, 'compilation')).toBeNull()
      }
    } finally { original.mockRestore(); runs.mockRestore(); scope.mockRestore() }
  })
  it('keeps the strict old audit and every judgment while omitting only an empty unbound table', () => {
    const f = emptyProposalFixture(), before = JSON.stringify(f.original), projected = recoverEmptyOptionalProposalTable(f.original, f.bodies)!
    expect(f.original).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid' } })
    expect(projected).toMatchObject({ complete: true, audit: { formatProjection: { version: 1, kind: 'empty_optional_proposal_table', original: f.original.audit } } })
    const { proposalDispositions: empty, ...unchanged } = f.wire
    expect(empty).toEqual([])
    expect(JSON.parse(JSON.parse(projected.audit.rawResponse.content))).toEqual(unchanged)
    expect(JSON.stringify(f.original)).toBe(before)
    expect(f.inspect(f.raw).audit).toEqual(f.original.audit)
    expect(validEmptyOptionalProposalProjection(projected.audit, f.chapter.content, f.context)).toBe(true)
    expect(currentTerminalReview({ terminalCandidate: f.candidate, independentCheck: 'complete', continuityCriticResponse: projected.audit }, f.chapter.content, f.context))
      .toMatchObject({ supported: true, deliveryEligibility: { eligible: true } })
  })

  it.each([null, {}, '[]', [{ proposalIndex: 0, outcome: 'unknown' }]])('does not omit a nonempty or nonarray table: %j', value => {
    const f = emptyProposalFixture(), raw = JSON.stringify({ ...f.wire, proposalDispositions: value })
    expect(recoverEmptyOptionalProposalTable(f.inspect(raw), f.bodies)).toBeNull()
  })

  it('does not omit a table when the frozen context owns proposalChanges, even undefined', () => {
    const f = emptyProposalFixture()
    expect(recoverEmptyOptionalProposalTable(f.original, { ...f.bodies, terminalEvidence: { ...f.context, proposalChanges: undefined } })).toBeNull()
  })

  it('does not discharge a real frozen proposal catalogue by omitting its empty response table', () => {
    const f = continuityRecoveryFixture(), raw = JSON.stringify({ ...f.wire, proposalDispositions: [] })
    const original = inspectContinuityResponse(raw, f.bodies, true, 8, f.candidate, undefined, { responseContract: 3 })
    expect(f.context.proposalChanges!.proposals.length).toBeGreaterThan(0)
    expect(recoverEmptyOptionalProposalTable(original, f.bodies)).toBeNull()
  })

  it.each(['duplicate', 'duplicate-root-escaped', 'duplicate-nested', 'truncated', 'bad-evidence', 'extra-judgment'] as const)('preserves strict rejection of %s', scenario => {
    const f = emptyProposalFixture(), wire = structuredClone(f.wire)
    if (scenario === 'bad-evidence') wire.terminalVerdicts[0].sourceEvidence[0].segmentId = 'c999'
    if (scenario === 'extra-judgment') wire.terminalVerdicts.push({ ...wire.terminalVerdicts[0], verdict: 'unknown' })
    const raw = scenario === 'duplicate' ? f.raw.replace('"proposalDispositions":[]', '"proposalDispositions":[],"proposalDispositions":[]')
      : scenario === 'duplicate-root-escaped' ? f.raw.replace('"proposalDispositions":[]', '"proposalDispositions":[{"proposalIndex":0}],"proposalDispositi\\u006fns":[]')
        : scenario === 'duplicate-nested' ? f.raw.replace('"result":"clear"', '"result":"unknown","result":"clear"')
      : scenario === 'truncated' ? f.raw.slice(0, -1) : JSON.stringify(wire)
    expect(recoverEmptyOptionalProposalTable(f.inspect(raw), f.bodies)).toBeNull()
  })

  it('preserves an independently unknown current fact as unknown', () => {
    const f = emptyProposalFixture(), wire = { ...f.wire, terminalVerdicts: [{ claimIndex: 0, verdict: 'unknown', sourceEvidence: [] }] }
    const projected = recoverEmptyOptionalProposalTable(f.inspect(JSON.stringify(wire)), f.bodies)!
    expect(projected.complete).toBe(true)
    expect(currentTerminalReview({ terminalCandidate: f.candidate, independentCheck: 'complete', continuityCriticResponse: projected.audit }, f.chapter.content, f.context))
      .toMatchObject({ supported: false, verdicts: [{ verdict: 'unknown' }], deliveryEligibility: { eligible: false } })
  })

  it.each(['kind', 'version', 'body', 'marker', 'raw', 'source', 'missing-marker', 'missing-marker-unknown-kind'] as const)('requires shared current/proof verification after %s tampering', scenario => {
    const f = emptyProposalFixture(), projected = recoverEmptyOptionalProposalTable(f.original, f.bodies)!, audit = structuredClone(projected.audit) as typeof projected.audit & {
      formatProjection?: { kind: string; version: number; projectedAuditHash: string; frozenBodies: { previous: string | null } }; reassessment: { kind: string }
    }
    if (scenario === 'kind') audit.formatProjection!.kind = 'unknown'
    if (scenario === 'version') audit.formatProjection!.version = 2
    if (scenario === 'marker') audit.formatProjection!.projectedAuditHash = 'f'.repeat(64)
    if (scenario === 'raw') audit.rawResponse.content = JSON.stringify('{}')
    if (scenario === 'source') audit.formatProjection!.frozenBodies.previous = 'Changed source.'
    if (scenario === 'missing-marker' || scenario === 'missing-marker-unknown-kind') delete audit.formatProjection
    if (scenario === 'missing-marker-unknown-kind') audit.reassessment.kind = 'unknown'
    const body = scenario === 'body' ? f.chapter.content + 'Changed.' : f.chapter.content
    expect(validEmptyOptionalProposalProjection(audit, body, f.context)).toBe(false)
    expect(currentTerminalReview({ terminalCandidate: f.candidate, independentCheck: 'complete', continuityCriticResponse: audit }, body, f.context)).toBeNull()
  })

  it('authenticates and reuses the actual settled final response without losing either raw audit or second slot', async () => {
    const f = cachedPair(), before = JSON.stringify({ frames: f.frames, claim: f.claim, usage: f.usage })
    const result = await f.read()
    expect(result).toMatchObject({ billingKnown: true, providerComplete: true, recoveryReady: true, slotUsed: true,
      inspected: { complete: true, audit: { formatProjection: { second: { protocol: 5, audit: f.original.audit } } } } })
    expect(result.usageIds).toEqual(['first', 'second'])
    expect(validEmptyOptionalProposalProjection(result.inspected.audit, f.chapter.content, f.context)).toBe(true)
    expect(JSON.stringify({ frames: f.frames, claim: f.claim, usage: f.usage })).toBe(before)
    expect((await f.read()).inspected.audit).toEqual(result.inspected.audit)
  })

  it('reuses only this authenticated projection under a new call and content while binding the original request', async () => {
    const f = cachedPair(), cache = cacheReader(f), result = await cache.read()
    expect(result).toMatchObject({ complete: true, audit: { assessmentRequest: { key: f.key, inputHash: runtimeJson(f.input).hash },
      formatProjection: { kind: 'empty_optional_proposal_table', version: 1 } } })
    expect(validEmptyOptionalProposalProjection(result!.audit, f.chapter.content, f.context)).toBe(true)
  })
  it.each(['valid', 'unknown-second', 'missing-second', 'body', 'candidate', 'source', 'binding', 'tampered-audit'] as const)('authenticates the original projected parser8 pair before cross-wire reuse: %s', async fault => {
    const f = cachedPair(), cache = cacheReader(f)
    const manifest = buildContinuityReviewManifest({ subject: { userId: 'owner', novelId: 'novel', taskId: 'task', targetType: 'story_compilation',
      targetId: f.input.targetId, chapterId: f.chapter.id, revision: f.input.revision }, bodies: f.bodies, candidate: f.candidate, sourceScope: f.input.sourceScope!,
      sourceHash: null, sourceVersions: f.context.current, verifiedCoverage: f.context.factCoverage, draftProposals: null })
    const input: LegacyAssessmentInput = structuredClone({ ...f.input, parserVersion: 9, reassessmentProtocol: 6, continuityManifest: manifest,
      system: 'New protocol reviewer.', content: 'New protocol request.' })
    if (fault === 'unknown-second') Object.assign(f.usage[1], { usageSource: 'unknown', billingStatus: 'pending_usage' })
    if (fault === 'missing-second') f.frames.pop()
    if (fault === 'body') input.bodies.current += ' Changed.'
    if (fault === 'candidate') input.terminalCandidate!.exitState.objects.push('Another object.')
    if (fault === 'source') input.sourceScope!.currentOrderIndex++
    if (fault === 'binding') input.bindingHash = 'c'.repeat(64)
    if (fault === 'tampered-audit') f.frames[1].metadata.audit = { ...f.original.audit, contentHash: 'f'.repeat(64) }
    const before = JSON.stringify({ input: f.input, frames: f.frames, claim: f.claim, usage: f.usage, reservations: cache.reservations })
    const result = await cache.read(input)
    if (fault === 'valid') {
      expect(result).toMatchObject({ complete: true, audit: { parserVersion: 8, assessmentRequest: { key: f.key, inputHash: runtimeJson(f.input).hash },
        formatProjection: { kind: 'empty_optional_proposal_table', version: 1 } } })
      expect(validEmptyOptionalProposalProjection(result!.audit, f.chapter.content, f.context)).toBe(true)
    } else expect(result).toBeNull()
    expect(JSON.stringify({ input: f.input, frames: f.frames, claim: f.claim, usage: f.usage, reservations: cache.reservations })).toBe(before)
  })

  it.each(['system', 'binding', 'missing-binding', 'body', 'candidate', 'revision', 'target', 'protocol', 'parser', 'extra-model', 'source', 'cross-run', 'unbound-key', 'ordinary-response'] as const)('does not widen the content-only cache for %s', async scenario => {
    const f = cachedPair(), cache = cacheReader(f), input = { ...f.input, bodies: { ...f.bodies }, content: 'New guidance.' }
    if (scenario === 'system') input.system += 'New reviewer rule.'
    if (scenario === 'binding') input.bindingHash = 'c'.repeat(64)
    if (scenario === 'missing-binding') delete input.bindingHash
    if (scenario === 'body') input.bodies.current += 'Changed.'
    if (scenario === 'candidate') input.terminalCandidate = { ...f.candidate, lastUnfinishedAction: 'Changed.' }
    if (scenario === 'revision') input.revision++
    if (scenario === 'target') input.targetType = 'chapter'
    if (scenario === 'protocol') input.reassessmentProtocol = 4
    if (scenario === 'parser') input.parserVersion = 7
    if (scenario === 'extra-model') Object.assign(input, { modelId: 'new-model' })
    if (scenario === 'source') input.bodies.previous = 'Changed source.' as never
    if (scenario === 'cross-run') cache.reservations[0].runId = 'another-run'
    if (scenario === 'unbound-key') cache.reservations[0].metadata.continuityAssessmentRequestKey = 'f'.repeat(64)
    if (scenario === 'ordinary-response') {
      const { proposalDispositions: _empty, ...wire } = f.wire
      void _empty
      const raw = JSON.stringify(wire)
      for (const frame of f.frames) { frame.metadata.response.content = JSON.stringify(raw); frame.metadata.audit = f.inspect(raw).audit }
    }
    expect(await cache.read(input)).toBeNull()
    if (!['cross-run', 'unbound-key', 'ordinary-response'].includes(scenario)) expect(sameEmptyOptionalProposalInput(f.input, input)).toBe(false)
  })

  it('never falls back to an older good projection after the latest same-input reservation is unresolved', async () => {
    const f = cachedPair(), cache = cacheReader(f), input = { ...f.input, content: 'Latest frozen content.' }
    cache.reservations.unshift({ id: 'latest', runId: f.ctx.runId, metadata: { input, callId: 'latest-call',
      continuityAssessmentRequestKey: legacyContinuityAssessmentKey({ runId: f.ctx.runId, callId: 'latest-call' }, input) } })
    // The latest record intentionally cannot authenticate the older pair's
    // frozen frame input. Returning null must not try the older valid pair.
    expect(await cache.read()).toBeNull()
    expect(f.tx.agentArtifact.findFirst).not.toHaveBeenCalled()
  })

  it.each(['unknown-second', 'missing-second', 'truncated-second', 'nonempty-second', 'changed-fixed', 'bad-second-raw-good-audit', 'changed-second-raw-good-audit', 'tampered-first-audit', 'tampered-second-audit', 'changed-request'] as const)('cannot choose the first response over %s', async scenario => {
    const f = cachedPair()
    if (scenario === 'unknown-second') Object.assign(f.usage[1], { usageSource: 'unknown', billingStatus: 'pending_usage' })
    if (scenario === 'missing-second') f.frames.pop()
    if (scenario === 'truncated-second') Object.assign(f.frames[1].metadata.response, { transportComplete: false, finishReason: 'length' })
    if (scenario === 'nonempty-second' || scenario === 'changed-fixed' || scenario === 'bad-second-raw-good-audit' || scenario === 'changed-second-raw-good-audit') {
      const wire = structuredClone(f.wire)
      if (scenario === 'nonempty-second' || scenario === 'bad-second-raw-good-audit') (wire.proposalDispositions as unknown[]).push({ proposalIndex: 0 })
      else wire.semanticChecks.action_direction.reason = 'Changed independent semantic judgment.'
      const raw = JSON.stringify(wire)
      f.frames[1].metadata.response.content = JSON.stringify(raw)
      if (scenario === 'nonempty-second' || scenario === 'changed-fixed') f.frames[1].metadata.audit = f.inspect(raw).audit
    }
    if (scenario === 'tampered-first-audit') f.frames[0].metadata.audit = { ...f.original.audit, contentHash: 'f'.repeat(64) }
    if (scenario === 'tampered-second-audit') f.frames[1].metadata.audit = { ...f.original.audit, contentHash: 'f'.repeat(64) }
    if (scenario === 'changed-request') f.claim.metadata.request.content += 'Changed.'
    expect((await f.read()).inspected.complete).toBe(false)
  })

  it('recovers a fresh known first result locally before claiming or paying for a second request', async () => {
    const f = emptyProposalFixture(), claim = vi.fn(), dispatch = vi.fn(), assertCurrent = vi.fn()
    const result = await runContinuityReassessment({ original: f.original, bodies: f.bodies, system: 'Frozen', content: 'Frozen', reassessmentProtocol: 5,
      billingKnown: true, providerComplete: true, slotUsed: false, signal: new AbortController().signal, assertCurrent, claim, dispatch })
    expect(result.complete).toBe(true)
    expect(assertCurrent).toHaveBeenCalledOnce()
    expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  })

  it.each(['unknown-billing', 'incomplete-provider', 'claimed-second', 'cancelled', 'cancel-during-current-check', 'stale-owner'] as const)('does not recover live after %s', async scenario => {
    const f = emptyProposalFixture(), controller = new AbortController(), claim = vi.fn(), dispatch = vi.fn()
    if (scenario === 'cancelled') controller.abort()
    const result = runContinuityReassessment({ original: f.original, bodies: f.bodies, system: 'Frozen', content: 'Frozen', reassessmentProtocol: 5,
      billingKnown: scenario !== 'unknown-billing', providerComplete: scenario !== 'incomplete-provider', slotUsed: scenario === 'claimed-second', signal: controller.signal,
      assertCurrent: async () => { if (scenario === 'stale-owner') throw Error('Stale owner'); if (scenario === 'cancel-during-current-check') controller.abort() }, claim, dispatch })
    if (scenario === 'cancelled' || scenario === 'cancel-during-current-check' || scenario === 'stale-owner') await expect(result).rejects.toThrow()
    else expect(await result).toBe(f.original)
    expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
  })
})
