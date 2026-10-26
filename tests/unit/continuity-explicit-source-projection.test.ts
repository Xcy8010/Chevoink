import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { readKnownContinuityReplay } from '../../api/lib/agent/continuity-coordinator.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey, readReusableLegacyContinuityAssessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import * as writingScope from '../../api/lib/agent/writing-scope.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { recoverExplicitSourceEvidence, sameExplicitSourceInput, validateStoredExplicitSourceProjection } from '../../api/lib/agent/continuity-explicit-source-projection.js'
import { continuityReassessmentEnvelope } from '../../api/lib/agent/continuity-response-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ContinuityBodies } from '../../api/lib/agent/continuity-review-context.js'
import type { LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'

function fixture() {
  const current = 'The guard hands over forty coins. The clerk records sixty coins.'
  const chapter = { id: 'current', revision: 4, orderIndex: 3, content: current }
  const context = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: 'task', chapterId: chapter.id, obligations: [] }, 5, 2)
  const bodies: ContinuityBodies = { current, previous: null, terminalEvidence: context }
  const scope = { currentOrderIndex: 3, previous: [] }
  const finding = { signal: 'object' as const, severity: 'error' as const, evidence: 'The paid amount and the recorded amount disagree.',
    suggestion: 'Reconcile the paid and recorded amounts.', sourceEvidence: [{ source: 'current' as const, segmentId: 'c0', quote: 'forty coins' },
      { source: 'current' as const, segmentId: 'c0', quote: 'sixty coins' }] }
  const wire = { findings: [finding], semanticChecks: [{ kind: 'action_direction', result: 'not_applicable', reason: 'No directional operation is claimed.', findingIndexes: [] as number[] },
    { kind: 'state_progression', result: 'conflict', reason: 'The paid and recorded amounts disagree.', findingIndexes: [0] }], terminalVerdicts: [], terminalProofVerdicts: [], terminalDispositions: [] }
  const inspect = (raw: string, frozen = bodies) => inspectContinuityResponse(raw, frozen, true, 8, undefined, scope)
  const raw = JSON.stringify(wire)
  const input: LegacyAssessmentInput = { parserVersion: 8, reassessmentProtocol: 2, chapterId: chapter.id, revision: chapter.revision,
    bodies, sourceScope: scope, bindingHash: 'b'.repeat(64), targetType: 'story_compilation', targetId: 'compilation', system: 'Frozen reviewer.', content: 'Original rendered guidance.' }
  return { chapter, context, bodies, scope, finding, wire, raw, inspect, original: inspect(raw), input }
}

function pair() {
  const f = fixture()
  const primaryWire = { ...f.wire, findings: [...f.wire.findings, { ...f.finding, severity: 'warning' as const,
    evidence: 'The guard departure needs review.', suggestion: 'Check whether a departure occurs.' }] }
  const original = f.inspect(JSON.stringify(primaryWire))
  const decisions = [{ index: 0, action: 'confirm' as const, reason: 'The amount comparison remains an active finding.', sourceEvidence: [f.finding.sourceEvidence[0]], findingIndex: 0 },
    { index: 1, action: 'retract' as const, reason: 'Current text "The guard already left." resolves the earlier concern.',
      sourceEvidence: [{ source: 'current' as const, segmentId: 'c0', quote: 'The guard already left.' }] }]
  const wire = { ...f.wire, decisions }, raw = JSON.stringify(wire)
  const second = { audit: f.inspect(raw).audit, protocol: 2 as const }
  return { ...f, original, primaryWire, decisions, finalWire: wire, finalRaw: raw, second }
}
const record = (value: unknown) => value as Record<string, unknown>

describe('versioned free explicit-source report projection', () => {
  it('preserves byte-exact default parser8 behavior captured before this policy existed', () => {
    const f = fixture()
    expect(runtimeJson(f.original).hash).toBe('c23a1b3c67409b651b0e84f76fc59af2de78304891cd21b7957c0fcc84f43d4c')
    expect(runtimeJson(f.original.audit).hash).toBe('62c56a3a3f3694c349bd1e40c69303e05b7f1282a4e43df6ee5862b3a4d8b5a9')
    expect(f.original).toMatchObject({ complete: false, findings: [], audit: { parserVersion: 8, classification: 'source_invalid' } })
    expect(f.original.audit).not.toHaveProperty('sourceCheckPolicy')
  })
  it.each([3, 4, 5, 6] as const)('does not enable the policy for parser %s', version => {
    const f = fixture()
    expect(inspectContinuityResponse(f.raw, f.bodies, true, version, undefined, f.scope, { sourceCheckPolicy: 'explicit_source_evidence_v1' }))
      .toEqual(inspectContinuityResponse(f.raw, f.bodies, true, version, undefined, f.scope))
  })
  it('keeps every finding, quote and physical raw response while separately replaying the strict failure', () => {
    const f = fixture(), before = JSON.stringify(f.original), projected = recoverExplicitSourceEvidence(f.original, f.bodies)!
    expect(projected).toMatchObject({ complete: true, findings: [{ signal: f.finding.signal, severity: 'error', evidence: f.finding.evidence, suggestion: f.finding.suggestion,
      sourceEvidence: f.finding.sourceEvidence.map(({ source, quote }) => ({ source, quote })) }], audit: { sourceCheckPolicy: 'explicit_source_evidence_v1',
      sourceProjection: { kind: 'explicit_source_evidence', version: 1, scope: 'single_report', originalAudit: f.original.audit } } })
    expect(projected.audit.rawResponse).toEqual(f.original.audit.rawResponse)
    expect(projected.audit).not.toHaveProperty('reassessment')
    expect(projected.audit).not.toHaveProperty('terminalCandidate')
    expect(JSON.stringify(f.original)).toBe(before)
    expect(f.inspect(f.raw)).toEqual(f.original)
    expect(validateStoredExplicitSourceProjection(projected.audit, f.chapter.content, f.context)).toEqual(projected)
  })
  it.each(['fake-summary-quote', 'wrong-attribution', 'wrong-source', 'only-previous', 'duplicate-pair', 'missing-quote', 'wrong-segment', 'missing-evidence'] as const)(
    'does not relax actual source proof: %s', fault => {
      const f = fixture(), wire = structuredClone(f.wire), bodies = structuredClone(f.bodies)
      if (fault === 'fake-summary-quote') wire.findings[0].evidence = 'Current text "The safe is empty." contradicts the recorded amount.'
      if (fault === 'wrong-attribution') wire.findings[0].evidence = '前文“forty coins”与当前“sixty coins”冲突。'
      if (fault === 'wrong-source') Object.assign(wire.findings[0].sourceEvidence[0], { source: 'previous' })
      if (fault === 'only-previous') { bodies.previous = bodies.current; for (const ref of wire.findings[0].sourceEvidence) Object.assign(ref, { source: 'previous' }) }
      if (fault === 'duplicate-pair') wire.findings[0].sourceEvidence[1] = { ...wire.findings[0].sourceEvidence[0] }
      if (fault === 'missing-quote') for (const ref of wire.findings[0].sourceEvidence) delete record(ref).quote
      if (fault === 'wrong-segment') wire.findings[0].sourceEvidence[0].segmentId = 'p0'
      if (fault === 'missing-evidence') delete record(wire.findings[0]).sourceEvidence
      expect(recoverExplicitSourceEvidence(f.inspect(JSON.stringify(wire), bodies), bodies)).toBeNull()
    })
  it.each(['semantic', 'terminal', 'duplicate-key', 'truncated', 'incomplete-transport'] as const)('retains every other parser rejection: %s', fault => {
    const f = fixture(), wire = structuredClone(f.wire)
    if (fault === 'semantic') wire.semanticChecks[1].findingIndexes = []
    if (fault === 'terminal') Object.assign(wire, { terminalVerdicts: [{ path: 'exitState.objects.0', verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }] })
    const raw = fault === 'duplicate-key' ? f.raw.replace('"findings":', '"findings":[],"findings":') : fault === 'truncated' ? f.raw.slice(0, -1) : JSON.stringify(wire)
    const original = fault === 'incomplete-transport' ? inspectContinuityResponse(raw, f.bodies, false, 8, undefined, f.scope) : f.inspect(raw)
    expect(recoverExplicitSourceEvidence(original, f.bodies)).toBeNull()
  })
  it.each(['original-audit', 'original-findings', 'raw', 'body-hash', 'body', 'context', 'scope', 'kind', 'version', 'projected-hash', 'policy', 'extra-field'] as const)(
    'rebuilds and rejects saved tampering: %s', fault => {
      const f = fixture(), projected = recoverExplicitSourceEvidence(f.original, f.bodies)!, audit = record(structuredClone(projected.audit))
      const marker = record(audit.sourceProjection)
      if (fault === 'original-audit') record(marker.originalAudit).classification = 'complete'
      if (fault === 'original-findings') record(marker.originalAudit).candidateFindings = []
      if (fault === 'raw') record(audit.rawResponse).content = JSON.stringify('{}')
      if (fault === 'body-hash') marker.frozenBodiesHash = 'f'.repeat(64)
      if (fault === 'body') record(marker.frozenBodies).current = f.chapter.content + ' A new event.'
      if (fault === 'scope') marker.scope = 'unapplied_body_only_final_report'
      if (fault === 'kind') marker.kind = 'unknown'
      if (fault === 'version') marker.version = 2
      if (fault === 'projected-hash') marker.projectedAuditHash = 'f'.repeat(64)
      if (fault === 'policy') delete audit.sourceCheckPolicy
      if (fault === 'extra-field') audit.ignored = true
      const context = fault === 'context' ? { ...f.context, current: { ...f.context.current, revision: 5 } } : f.context
      expect(validateStoredExplicitSourceProjection(audit, f.chapter.content, context)).toBeNull()
    })
  it('rejects stale current content and only permits the exact separately authenticated binding shape', () => {
    const f = fixture(), projected = recoverExplicitSourceEvidence(f.original, f.bodies)!
    expect(validateStoredExplicitSourceProjection(projected.audit, f.chapter.content + ' Changed.', f.context)).toBeNull()
    const binding = { version: 1, key: 'a'.repeat(64), inputHash: 'b'.repeat(64) }
    const bound = { ...projected.audit, assessmentRequest: binding }
    expect(validateStoredExplicitSourceProjection(bound, f.chapter.content, f.context)?.audit).toEqual(bound)
    for (const invalid of [{ ...binding, extra: true }, { ...binding, key: 'invalid' }, { ...binding, version: 2 }])
      expect(validateStoredExplicitSourceProjection({ ...projected.audit, assessmentRequest: invalid }, f.chapter.content, f.context)).toBeNull()
  })
  it('retains an unsupported withdrawal as a diagnostic without certifying it or changing either response', () => {
    const f = pair(), before = JSON.stringify(f), projected = recoverExplicitSourceEvidence(f.original, f.bodies, f.second)!
    expect(() => continuityReassessmentEnvelope(f.original, f.finalRaw, f.bodies, 2)).toThrow()
    expect(projected).toMatchObject({ complete: true, findings: [{ severity: 'error', evidence: f.finding.evidence }], audit: {
      sourceProjection: { scope: 'unapplied_body_only_final_report', originalAudit: f.original.audit, second: f.second,
        dispositionDiagnostics: [{ index: 1, code: 'retract_source_proof_invalid' }] } } })
    expect(JSON.parse(projected.audit.rawResponse.content)).toBe(f.finalRaw)
    expect(JSON.parse(JSON.parse(projected.audit.rawResponse.content)).decisions).toEqual(f.decisions)
    expect(projected.audit).not.toHaveProperty('reassessment')
    expect(projected.audit).not.toHaveProperty('terminalCandidate')
    expect(validateStoredExplicitSourceProjection(projected.audit, f.chapter.content, f.context)).toEqual(projected)
    expect(JSON.stringify(f)).toBe(before)
  })
  it.each(['confirm-proof', 'replace-proof', 'confirm-identity', 'missing-index', 'duplicate-index', 'retract-finding', 'bad-schema', 'wrong-protocol', 'old-revision', 'invented-final-quote'] as const)(
    'never diagnoses away a substantive final-response failure: %s', fault => {
      const f = pair(), wire = structuredClone(f.finalWire)
      if (fault === 'confirm-proof' || fault === 'replace-proof') {
        wire.decisions[0].sourceEvidence[0].quote = 'The safe is empty.'
        if (fault === 'replace-proof') Object.assign(wire.decisions[0], { action: 'replace' })
      }
      if (fault === 'confirm-identity') wire.findings[0].suggestion = 'A different judgment.'
      if (fault === 'missing-index') wire.decisions.pop()
      if (fault === 'duplicate-index') wire.decisions[1].index = 0
      if (fault === 'retract-finding') Object.assign(wire.decisions[1], { findingIndex: 0 })
      if (fault === 'bad-schema') Object.assign(wire.decisions[1], { action: 'ignore' })
      if (fault === 'invented-final-quote') wire.findings[0].evidence = 'Current text "The guard already left." resolves this.'
      const second = { audit: f.inspect(JSON.stringify(wire)).audit, protocol: 2 as const }
      if (fault === 'wrong-protocol') Object.assign(second, { protocol: 3 })
      if (fault === 'old-revision') second.audit.terminalEvidence = { ...f.context, current: { ...f.context.current, revision: 3 } }
      expect(recoverExplicitSourceEvidence(f.original, f.bodies, second)).toBeNull()
    })
  it.each(['diagnostics', 'second-raw', 'second-audit', 'original-raw', 'second-missing'] as const)('authenticates the entire two-response lineage: %s', fault => {
    const f = pair(), projected = recoverExplicitSourceEvidence(f.original, f.bodies, f.second)!, audit = record(structuredClone(projected.audit)), marker = record(audit.sourceProjection)
    if (fault === 'diagnostics') marker.dispositionDiagnostics = []
    if (fault === 'second-raw') record(record(marker.second).audit).rawResponse = f.original.audit.rawResponse
    if (fault === 'second-audit') record(record(marker.second).audit).candidateFindings = []
    if (fault === 'original-raw') record(marker.originalAudit).rawResponse = f.second.audit.rawResponse
    if (fault === 'second-missing') delete marker.second
    expect(validateStoredExplicitSourceProjection(audit, f.chapter.content, f.context)).toBeNull()
  })
  it('does not reinterpret an already valid primary, a terminal candidate or a different parser/contract', () => {
    const f = pair(), wire = { ...f.primaryWire, findings: f.primaryWire.findings.map(item => ({ ...item, evidence: '当前“forty coins”与“sixty coins”需要核对。' })) }
    const valid = f.inspect(JSON.stringify(wire))
    expect(valid.complete).toBe(true)
    expect(recoverExplicitSourceEvidence(valid, f.bodies)).toBeNull()
    expect(recoverExplicitSourceEvidence(valid, f.bodies, f.second)).toBeNull()
    for (const extra of [{ terminalCandidate: { exitState: {} } }, { terminalContentHash: 'a'.repeat(64) }, { parserVersion: 7 }, { responseContract: 3 }])
      expect(recoverExplicitSourceEvidence({ ...f.original, audit: { ...f.original.audit, ...extra } } as typeof f.original, f.bodies, f.second)).toBeNull()
  })
  it.each(['chapter', 'story_compilation'] as const)('matches only content drift under the complete frozen %s input', targetType => {
    const f = fixture(), input = { ...f.input, targetType }, proposed = { ...input, content: 'New rendered guidance.' }
    expect(sameExplicitSourceInput(input, proposed)).toBe(true)
    for (const patch of [{ system: 'Different reviewer.' }, { revision: 5 }, { chapterId: 'other' }, { bindingHash: 'f'.repeat(64) },
      { targetId: 'other' }, { sourceScope: { ...f.scope, currentOrderIndex: 2 } }, { reassessmentProtocol: 3 }, { parserVersion: 7 },
      { bodies: { ...f.bodies, current: f.bodies.current + ' Changed.' } }, { extra: 'Unknown field cannot drift.' }])
      expect(sameExplicitSourceInput({ ...input, ...patch }, proposed)).toBe(false)
    expect(sameExplicitSourceInput({ ...input, bindingHash: 'invalid' }, { ...proposed, bindingHash: 'invalid' })).toBe(false)
  })
})


describe('actual body-only bootstrap replay with authenticated source projection', () => {
  it.each(['valid', 'source-mismatch', 'candidate-mismatch', 'scope-mismatch', 'coverage-mismatch', 'context-mismatch', 'physical-first-raw', 'original-audit', 'unknown-second', 'applied-primary', 'cross-continuation-application', 'same-projection-multiple-runs', 'wrong-application-reservation'] as const)(
    'reads original frames and current provenance without a provider call: %s', async fault => {
      const f = pair(), bridge = { fromChapterId: null }, sceneTasks: unknown[] = []
      const coverage = compilerContinuityCoverage({ chapter: f.chapter, bridge, sceneTasks, source: null }, 11)
      const ctx = { userId: 'owner', novelId: 'novel', runId: 'run', callId: 'original-call' } as ToolContext
      const input = { ...f.input, bindingHash: runtimeJson(coverage).hash }
      const key = legacyContinuityAssessmentKey(ctx, input)
      const usage = ['first', 'second'].map((id, index) => ({ id, action: index ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic',
        usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0, creditChargeMilli: 23 }))
      const frames = [{ id: 'first', metadata: { input, stage: 'first', usageIds: ['first'], audit: f.original.audit,
        response: { content: f.original.audit.rawResponse.content, encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] } } },
      { id: 'second', metadata: { input, stage: 'reassessment', usageIds: ['second'], audit: f.second.audit,
        response: { content: f.second.audit.rawResponse.content, encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] } } }]
      const owners = ['first', 'reassessment'].map((stage, index) => ({ metadata: { stage, usageIds: [usage[index].id] } }))
      const claim = { metadata: { input, original: f.original.audit,
        request: continuityReassessmentRequest(input.system, input.content, f.original, f.bodies, false, 2) } }
      const reservations = [{ id: 'reservation', runId: ctx.runId, metadata: { input, callId: ctx.callId, continuityAssessmentRequestKey: key } }]
      const projection = recoverExplicitSourceEvidence(f.original, f.bodies, f.second)!
      const projectionHash = runtimeJson(record(projection.audit).sourceProjection).hash
      const applications = fault === 'same-projection-multiple-runs' ? ['run', 'continuation'].map(runId => ({ id: 'application-' + runId, runId,
        metadata: { assessmentApplicationKey: key, reservationId: 'reservation', sourceProjectionHash: projectionHash } }))
        : ['applied-primary', 'cross-continuation-application', 'wrong-application-reservation'].includes(fault) ? [{ id: 'old-application',
          runId: fault === 'cross-continuation-application' ? 'continuation' : 'run', metadata: { assessmentApplicationKey: key,
            reservationId: fault === 'wrong-application-reservation' ? 'other-reservation' : 'reservation',
            ...(fault === 'wrong-application-reservation' ? { sourceProjectionHash: projectionHash } : {}) } }] : []
      const saved = { id: 'compilation', runId: ctx.runId, chapter: f.chapter, bridge, sceneTasks, preparedContext: {},
        validation: { independentCheck: 'unavailable', checkedRevision: 4, continuityCriticResponse: structuredClone(f.original.audit), coverage } }
      if (fault === 'candidate-mismatch') Object.assign(saved.validation, { terminalCandidate: { exitState: { objects: ['A proposed state.'] } } })
      if (fault === 'scope-mismatch') input.sourceScope = { ...f.scope, currentOrderIndex: 2 }
      if (fault === 'coverage-mismatch') input.bindingHash = 'f'.repeat(64)
      if (fault === 'context-mismatch') input.bodies = { ...f.bodies, terminalEvidence: { ...f.context, current: { ...f.context.current, revision: 5 } } }
      if (fault === 'physical-first-raw') saved.validation.continuityCriticResponse.rawResponse.content += ' '
      if (fault === 'original-audit') frames[0].metadata.audit = { ...f.original.audit, classification: 'complete' }
      if (fault === 'unknown-second') usage[1].billingStatus = 'pending_settlement'
      const db = {
        storyCompilation: { findFirst: vi.fn(async () => saved) },
        chapter: { findMany: vi.fn(async () => fault === 'source-mismatch' ? [{ id: 'previous', revision: 1, orderIndex: 2, title: 'New source', content: 'A new predecessor is now present.' }] : []) },
        agentArtifact: { findMany: vi.fn(async ({ where }: { where: { metadata: { path: string[] }; runId?: string | { in: string[] } } }) => {
          const path = where.metadata.path[0]
          if (path === 'assessmentApplicationKey') { expect(where.runId).toEqual({ in: ['run', 'continuation'] }); return applications }
          if (path === 'continuityAssessmentRequestKey') { expect(where.runId).toBe('run'); return reservations }
          return path === 'assessmentChapterId' ? reservations : path === 'assessmentKey' ? frames : path === 'assessmentRequestOwnerKey' ? owners : []
        }), findFirst: vi.fn(async ({ where }: { where: { metadata: { path: string[] } } }) => where.metadata.path[0] === 'fullReassessmentKey' ? claim : null) },
        aiUsageLog: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => usage.filter(row => where.id.in.includes(row.id))) },
      }
      const spec = buildTaskSpec({ runId: 'task', novelId: 'novel', prompt: '修改第三章', terminalEvidenceProtocol: 2,
        terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 })
      spec.id = 'task'
      const original = vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', spec } as Awaited<ReturnType<typeof originalRequest.readOriginalTaskRequest>>)
      const runs = vi.spyOn(originalRequest, 'originalTaskRunIds').mockResolvedValue(['run', 'continuation'])
      const target = vi.spyOn(writingScope, 'assertWritingTarget').mockResolvedValue({ taskId: 'task', spec } as Awaited<ReturnType<typeof writingScope.assertWritingTarget>>)
      const provider = vi.fn(async () => { throw Error('A free bootstrap read cannot dispatch a provider request') })
      vi.stubGlobal('fetch', provider)
      const before = JSON.stringify({ saved, frames, owners, usage, claim, reservations, applications })
      try {
        const result = await readKnownContinuityReplay(db as unknown as Prisma.TransactionClient, ctx, 'compilation')
        if (fault === 'valid' || fault === 'same-projection-multiple-runs') {
          expect(result).toEqual({ assessmentKey: key, inputHash: runtimeJson(input).hash })
          const reused = await readReusableLegacyContinuityAssessment(db as unknown as Prisma.TransactionClient, { ...ctx, callId: 'new-probe' },
            { ...input, content: 'New rendering; the actual frozen input remains original.' })
          expect(reused).toMatchObject({ complete: true, findings: [{ severity: 'error', evidence: f.finding.evidence }], audit: {
            assessmentRequest: { key, inputHash: runtimeJson(input).hash }, sourceProjection: { scope: 'unapplied_body_only_final_report',
              dispositionDiagnostics: [{ index: 1, code: 'retract_source_proof_invalid' }], originalAudit: f.original.audit } } })
          expect(reused?.audit).not.toHaveProperty('terminalCandidate')
        } else expect(result).toBeNull()
        expect(provider).not.toHaveBeenCalled()
        expect(JSON.stringify({ saved, frames, owners, usage, claim, reservations, applications })).toBe(before)
      } finally { original.mockRestore(); runs.mockRestore(); target.mockRestore(); vi.unstubAllGlobals() }
    })
})


function standaloneFixture() {
  const f = fixture(), bodies = { current: f.chapter.content, previous: null }
  const raw = JSON.stringify({ findings: [f.finding] })
  const inspect = (value: string, frozen: ContinuityBodies = bodies) => inspectContinuityResponse(value, frozen, true, 7, undefined, f.scope)
  const { reassessmentProtocol: omitted, ...base } = f.input
  expect(omitted).toBe(2)
  const input: LegacyAssessmentInput = { ...base, parserVersion: 7, targetType: 'chapter', targetId: f.chapter.id, bodies }
  return { ...f, bodies, raw, inspect, input, original: inspect(raw) }
}

describe('standalone parser7 single-report explicit source projection', () => {
  it('retains the exact default strict parser7 result captured before this opt-in extension', () => {
    const f = standaloneFixture()
    expect(runtimeJson(f.original).hash).toBe('d9c960fbf10b07561e5df768895b69829ecc18eeff1bd28d97827b69250dc8c0')
    expect(runtimeJson(f.original.audit).hash).toBe('09165983499e85ccf709f1e1f31eda2c695c883e6cda55b72a4413a337b1ec9e')
    expect(f.original).toMatchObject({ complete: false, audit: { parserVersion: 7, classification: 'source_invalid' } })
    expect(f.original.audit).not.toHaveProperty('sourceCheckPolicy')
  })
  it('projects the actual no-context standalone shape without adding metadata or a second response', () => {
    const f = standaloneFixture(), before = JSON.stringify(f.original), projected = recoverExplicitSourceEvidence(f.original, f.bodies)!
    expect(projected).toMatchObject({ complete: true, findings: [{ severity: 'error', evidence: f.finding.evidence, suggestion: f.finding.suggestion }],
      audit: { parserVersion: 7, sourceProjection: { scope: 'single_report', originalAudit: f.original.audit } } })
    expect(projected.audit.rawResponse).toEqual(f.original.audit.rawResponse)
    expect(projected.audit).not.toHaveProperty('terminalEvidence')
    expect(projected.audit).not.toHaveProperty('terminalCandidate')
    expect(record(record(projected.audit).sourceProjection)).not.toHaveProperty('second')
    expect(validateStoredExplicitSourceProjection(projected.audit, f.chapter.content)).toEqual(projected)
    expect(JSON.stringify(f.original)).toBe(before)
    const bound = { ...projected.audit, assessmentRequest: { version: 1, key: 'a'.repeat(64), inputHash: 'b'.repeat(64) } }
    expect(validateStoredExplicitSourceProjection(bound, f.chapter.content)?.audit).toEqual(bound)
  })
  it.each(['fake-quote', 'wrong-source', 'only-previous', 'not-pair'] as const)('keeps strict standalone source proof for %s', fault => {
    const f = standaloneFixture(), finding = structuredClone(f.finding), bodies: ContinuityBodies = { ...f.bodies }
    if (fault === 'fake-quote') finding.evidence = '当前“An invented sentence”证明数额冲突。'
    if (fault === 'wrong-source') Object.assign(finding.sourceEvidence[0], { source: 'previous' })
    if (fault === 'only-previous') { bodies.previous = bodies.current; for (const ref of finding.sourceEvidence) Object.assign(ref, { source: 'previous' }) }
    if (fault === 'not-pair') finding.sourceEvidence[1] = { ...finding.sourceEvidence[0] }
    expect(recoverExplicitSourceEvidence(f.inspect(JSON.stringify({ findings: [finding] }), bodies), bodies)).toBeNull()
  })
  it('requires frozen context absence, exact content and untampered original metadata', () => {
    const f = standaloneFixture(), projected = recoverExplicitSourceEvidence(f.original, f.bodies)!
    expect(recoverExplicitSourceEvidence(f.original, { ...f.bodies, terminalEvidence: f.context })).toBeNull()
    expect(validateStoredExplicitSourceProjection(projected.audit, f.chapter.content, f.context)).toBeNull()
    expect(validateStoredExplicitSourceProjection(projected.audit, f.chapter.content + ' New revision.')).toBeNull()
    const tampered = structuredClone(projected.audit)
    record(record(tampered).sourceProjection).projectedAuditHash = 'f'.repeat(64)
    expect(validateStoredExplicitSourceProjection(tampered, f.chapter.content)).toBeNull()
    expect(recoverExplicitSourceEvidence({ ...f.original, audit: { ...f.original.audit, terminalCandidate: fixture().original.audit.terminalCandidate } }, f.bodies)).toBeNull()
    const body = fixture(), bodyProjection = recoverExplicitSourceEvidence(body.original, body.bodies)!
    expect(validateStoredExplicitSourceProjection(bodyProjection.audit, body.chapter.content)).toBeNull()
  })
  it('never admits a parser7 second response into the parser8 diagnostic exception', () => {
    const f = standaloneFixture()
    expect(recoverExplicitSourceEvidence(f.original, f.bodies, { audit: f.original.audit, protocol: 2 })).toBeNull()
    const eight = pair()
    expect(recoverExplicitSourceEvidence(eight.original, eight.bodies, { audit: f.original.audit, protocol: 2 })).toBeNull()
  })
  it('permits only rendered content to change in an original no-reassessment/no-context standalone input', () => {
    const f = standaloneFixture(), proposed = { ...f.input, content: 'New rendered standalone guidance.' }
    expect(sameExplicitSourceInput(f.input, proposed)).toBe(true)
    for (const patch of [{ reassessmentProtocol: 2 }, { bodies: { ...f.bodies, terminalEvidence: f.context } }, { parserVersion: 8 },
      { system: 'A new reviewer.' }, { revision: 5 }, { chapterId: 'other' }, { targetId: 'other' },
      { sourceScope: { ...f.scope, currentOrderIndex: 2 } }, { bindingHash: 'f'.repeat(64) }])
      expect(sameExplicitSourceInput({ ...f.input, ...patch }, proposed)).toBe(false)
    expect(sameExplicitSourceInput({ ...f.input, reassessmentProtocol: 2 }, { ...proposed, reassessmentProtocol: 2 })).toBe(false)
    expect(sameExplicitSourceInput({ ...f.input, bodies: { ...f.bodies, terminalEvidence: f.context } }, { ...proposed, bodies: { ...f.bodies, terminalEvidence: f.context } })).toBe(false)
  })
})
