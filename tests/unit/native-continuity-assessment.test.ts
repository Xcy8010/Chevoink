import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import { buildContinuityReviewManifest, inspectContinuityV4 } from '../../api/lib/agent/continuity-review-v4.js'
import { stageTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'
import { continuityReassessmentRequest, failedContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readNativeContinuityAssessments } from '../../api/lib/agent/native-continuity-assessment.js'
import { isContinuityV4Inspection, readAuthenticatedContinuityAssessment } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'

const mocks = vi.hoisted(() => ({ source: vi.fn(async (_db, row) => ({ input: row.inputSnapshot.input })), state: vi.fn() }))
// Cursor/source verification has its own real PG chain. This unit exercises
// immutable native provider/effect authentication, never provider admission.
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(), readToolOperationSource: mocks.source }))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(), readExecutionStateInTransaction: mocks.state }))

function fixture() {
  const content = 'The guard waits. The packet remains sealed.', taskId = 'task'
  const context = { protocol: 2 as const, verdictProtocol: 6 as const, spanAddressProtocol: 2 as const, current: { id: 'chapter', revision: 4, orderIndex: 1, contentHash: runtimeJson({ content }).hash },
    previous: null, factCoverage: { version: 2 as const, taskId, chapterId: 'chapter', obligations: [] } }
  const sourceScope = { currentOrderIndex: 1, previous: [] }, originCandidate = terminalCandidateSchema.parse({ exitState: { openLoops: ['The guard waits.'] } }), candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
  const subject = { userId: 'user', novelId: 'novel', runId: 'run' }, route = { provider: 'fixture', model: 'fixture', baseUrl: 'https://provider.invalid/v1', maxOutputTokens: 16384 }
  const price = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'fixture', rates: { inputNano: 1, cacheNano: 1, outputNano: 1 } }
  const freeze = (terminalCandidate: typeof candidate, evidence: typeof context | (typeof context & { proposalChanges: NonNullable<ReturnType<typeof stageTerminalProposals>>['changes'] })) => {
    const bodies = { previous: null, current: content, terminalEvidence: evidence }
    const manifest = buildContinuityReviewManifest({ subject: { userId: subject.userId, novelId: subject.novelId, taskId, targetType: 'story_compilation', targetId: 'compilation', chapterId: 'chapter', revision: 4 }, bodies, candidate: terminalCandidate, sourceScope,
      sourceHash: null, sourceVersions: context.current, verifiedCoverage: evidence.factCoverage, draftProposals: 'proposalChanges' in evidence ? evidence.proposalChanges : null })
    return { manifest, bodies, candidate: terminalCandidate, sourceScope }
  }
  const wire = (unknown: boolean) => ({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic independent review.', findingIds: [] })), terminalVerdicts: [{ claimIndex: 0, verdict: unknown ? 'unknown' : 'supported', sourceEvidence: unknown ? [] : [{ segmentId: 'c0' }] }], terminalProofVerdicts: [], terminalDispositions: [] })
  const originFrozen = freeze(originCandidate, context), origin = inspectContinuityV4(JSON.stringify(wire(true)), originFrozen)
  const undefinedPaths = (value: unknown, path = ''): string[] => value === undefined ? [path] : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => undefinedPaths(child, `${path}.${key}`)) : []
  expect(undefinedPaths(origin.audit)).toEqual([])
  const staged = stageTerminalProposals({ preparedContext: {}, identity: { taskId, chapterId: 'chapter', bodyHash: context.current.contentHash, sourceHash: runtimeJson({ previous: null }).hash }, auditHash: runtimeJson(origin.audit).hash, base: originCandidate, candidate, verifiedFactIds: [] })!
  const frozen = freeze(candidate, { ...context, proposalChanges: staged.changes! }), currentWire = { ...wire(false), proposalDispositions: [{ proposalIndex: 0, outcome: 'unknown', reason: 'The old draft remains unknown.', sourceEvidence: [] }] }
  const current = inspectContinuityV4(JSON.stringify(currentWire), frozen)
  expect(origin.complete).toBe(true); expect(current.complete).toBe(true)
  const rawResult = (raw: string) => ({ outcome: 'succeeded', result: { content: raw, reasoning: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20, promptCacheHitTokens: null, promptCacheMissTokens: null } } })
  const child = (parentId: string, step: string, raw: string, requestText: { system: string; content: string }) => {
    const id = `${parentId}-${step}`, request = { endpoint: `${route.baseUrl}/chat/completions`, body: { model: route.model, max_tokens: route.maxOutputTokens, messages: [{ role: 'system', content: requestText.system }, { role: 'user', content: requestText.content }] } }
    const snapshot = runtimeJson({ kind: 'provider', input: { request, billing: price } }), result = runtimeJson(rawResult(raw)), requestSnapshot = runtimeJson({ provider: route.provider, model: route.model, request })
    const measurement = { source: 'reported', promptTokens: 12, completionTokens: 8, cacheHitTokens: null, cacheMissTokens: null }
    return { id, kind: 'provider', action: step, parentOperationId: parentId, taskRootId: taskId, operationKey: `aux:${parentId}:${step}`, status: 'succeeded', inputSnapshot: snapshot.value, inputHash: snapshot.hash,
      attempts: [{ id: `${id}-attempt`, attemptKey: '1', status: 'succeeded', runId: 'run', dispatchedAt: new Date(1), completedAt: new Date(2), provider: route.provider, model: route.model, requestSnapshot: requestSnapshot.value, requestHash: requestSnapshot.hash, result: result.value, resultHash: result.hash,
        usageReceipt: { ...measurement, settlementStatus: 'settled', observationHash: runtimeJson(measurement).hash } }],
      events: [{ eventKey: `result:${id}-attempt:${result.hash}`, type: 'provider.result.recorded', taskRootId: taskId, operationId: id, payload: { attemptId: `${id}-attempt`, status: 'succeeded', resultHash: result.hash } }] }
  }
  const operation = (id: string, frozenInput: typeof frozen, inspection: typeof current) => {
    const work = { kind: 'check', version: 22, chapter: { id: 'chapter', revision: 4, content, orderIndex: 1 }, compiler: { id: 'compilation' }, terminalCandidate: frozenInput.candidate,
      sourceBodies: frozenInput.bodies, sourceScope, continuityManifest: frozenInput.manifest, reassessmentProtocol: 6, criticSystem: `system:${id}`, criticInput: `input:${id}`, coverage: { binding: 'unchanged' }, route, price }
    const snapshot = runtimeJson({ kind: 'tool', input: { work, novelId: subject.novelId, callId: id } }), effect = runtimeJson({ toolResult: { ...(!inspection.terminalReview?.supported ? { outcome: 'failed' } : {}), summary: 'Synthetic report.' } })
    return { id, originRunId: 'run', taskRootId: taskId, kind: 'tool', action: 'continuity_validate', status: 'succeeded', parentOperationId: null, operationKey: `exec:${id}`, inputSnapshot: snapshot.value, inputHash: snapshot.hash,
      effectReceipt: { runId: 'run', result: effect.value, resultHash: effect.hash }, events: [{ eventKey: `effect:${id}`, type: 'effect.committed', taskRootId: taskId, operationId: id, payload: { operationId: id, resultHash: effect.hash } }],
      children: [child(id, 'continuity_critic', JSON.parse(inspection.audit.rawResponse.content), { system: work.criticSystem, content: work.criticInput })] }
  }
  const operations = [operation('origin', originFrozen, origin), operation('current', frozen, current)], artifacts: Array<{ metadata: unknown }> = []
  const tx = { agentOperation: { findMany: vi.fn(async ({ where }) => operations.filter(row => row.taskRootId === where.taskRootId && where.originRunId.in.includes(row.originRunId))) }, agentRun: { findFirst: vi.fn(async () => ({ id: 'run' })) } }
  mocks.state.mockResolvedValue({ frame: { state: { phase: 'awaiting_operation', pendingOperationId: 'current' } } })
  const read = () => readNativeContinuityAssessments(tx as unknown as Prisma.TransactionClient, subject, taskId, ['run'], { compilationId: 'compilation', chapterId: 'chapter', currentAudit: current.audit, related: () => true }, artifacts)
  const cache = (id: string, from: typeof operations[number]) => {
    const cloned = structuredClone(from), input = cloned.inputSnapshot as { input: { work: Record<string, unknown> } }, old = input.input.work
    const { continuityManifest: _manifest, ...rest } = old
    const snapshot = runtimeJson({ ...cloned.inputSnapshot as object, input: { novelId: subject.novelId, callId: id, work: { ...rest, version: 18, reassessmentProtocol: 2, repair: false, cached: [] } } })
    cloned.id = id; cloned.inputSnapshot = snapshot.value; cloned.inputHash = snapshot.hash; cloned.children = []
    cloned.events = [{ eventKey: `effect:${id}`, type: 'effect.committed', taskRootId: taskId, operationId: id, payload: { operationId: id, resultHash: cloned.effectReceipt.resultHash } }]
    return cloned
  }
  return { operations, origin, current, frozen, currentWire, artifacts, read, cache, child, operation, tx }
}

describe('readonly native continuity provenance', () => {
  it('authenticates an original work21 UNKNOWN from the same real billing snapshot shape', async () => {
    const f = fixture(), origin = f.operations[0], input = origin.inputSnapshot as { input: { work: Record<string, unknown> } }, work = input.input.work
    const context = (work.sourceBodies as typeof f.frozen.bodies).terminalEvidence
    const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic frozen parser8 review.', findingIndexes: [] })),
      terminalVerdicts: [{ claimIndex: 0, verdict: 'unknown', sourceEvidence: [] }], terminalProofVerdicts: [], terminalDispositions: [] })
    work.version = 21; work.reassessmentProtocol = 5; delete work.continuityManifest
    origin.inputHash = runtimeJson(origin.inputSnapshot).hash
    origin.children = [f.child(origin.id, 'continuity_critic', raw, { system: String(work.criticSystem), content: String(work.criticInput) })]
    const expected = inspectContinuityResponse(raw, work.sourceBodies as typeof f.frozen.bodies, true, 8,
      work.terminalCandidate as typeof f.frozen.candidate, f.frozen.sourceScope, { responseContract: 3 })
    expect(expected.complete).toBe(true)
    expect(context.verdictProtocol).toBe(6)
    const entries = await f.read()
    expect(entries).toHaveLength(2)
    expect(entries?.find(entry => entry.operationId === origin.id)?.inspected.audit).toEqual(expected.audit)
    const authenticated = entries?.find(entry => entry.operationId === origin.id)!.inspected
    expect(readAuthenticatedContinuityAssessment(authenticated!.audit, f.frozen.bodies.current, context, true)?.supported).toBe(false)
  })
  it('authenticates only the exact current prepared report before its own business effect exists', async () => {
    const f = fixture()
    Object.assign(f.operations[1], { status: 'prepared', effectReceipt: null, events: [] })
    expect(await f.read()).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: 'current', current: true, committed: false })]))
    mocks.state.mockResolvedValueOnce({ frame: { state: { phase: 'awaiting_operation', pendingOperationId: 'unrelated' } } })
    expect(await f.read()).toBeNull()
  })
  it('authenticates original unknown, current report, and both historical/current no-provider cache forwarding', async () => {
    const f = fixture(); f.operations.push(f.cache('old-cache', f.operations[0]), f.cache('current-cache', f.operations[1]))
    const before = runtimeJson(f.operations.map(row => ({ ...row, children: row.children.map(child => ({ ...child, attempts: child.attempts.map(attempt => ({ ...attempt, dispatchedAt: 'frozen', completedAt: 'frozen' })) })) }))).hash
    expect(await f.read()).toHaveLength(2)
    expect(f.tx.agentOperation.findMany).toHaveBeenCalledOnce()
    expect(runtimeJson(f.operations.map(row => ({ ...row, children: row.children.map(child => ({ ...child, attempts: child.attempts.map(attempt => ({ ...attempt, dispatchedAt: 'frozen', completedAt: 'frozen' })) })) }))).hash).toBe(before)
  })
  it.each(['missing-effect', 'wrong-root', 'unknown-usage', 'missing-result-event', 'bad-request', 'price-only', 'different-billing', 'bad-cache', 'paid-cache'] as const)('rejects %s without provider or state writes', async fault => {
    const f = fixture(), origin = f.operations[0], provider = origin.children[0]
    if (fault === 'missing-effect') Object.assign(origin, { effectReceipt: null })
    if (fault === 'wrong-root') provider.taskRootId = 'other'
    if (fault === 'unknown-usage') provider.attempts[0].usageReceipt.source = 'unknown'
    if (fault === 'missing-result-event') provider.events = []
    if (fault === 'bad-request') provider.attempts[0].requestHash = '0'.repeat(64)
    if (fault === 'price-only' || fault === 'different-billing') {
      const input = provider.inputSnapshot as { input: { billing?: unknown; price?: unknown } }
      if (fault === 'price-only') { input.input.price = input.input.billing; delete input.input.billing }
      else input.input.billing = { ...input.input.billing as object, rateCardId: 'another-frozen-card' }
      provider.inputHash = runtimeJson(provider.inputSnapshot).hash
    }
    if (fault === 'bad-cache' || fault === 'paid-cache') {
      const cache = f.cache('cache', f.operations[1]); if (fault === 'paid-cache') cache.children.push(provider)
      else { const input = cache.inputSnapshot as { input: { work: Record<string, unknown> } }; input.input.work.cached = [{ signal: 'object', severity: 'warning', evidence: 'invented', suggestion: 'invented' }]; cache.inputHash = runtimeJson(cache.inputSnapshot).hash }
      f.operations.push(cache)
    }
    expect(await f.read()).toBeNull()
  })
  it('authenticates a final failed pending-only pair without treating its projection as a passing report', async () => {
    const f = fixture(), first = inspectContinuityV4(JSON.stringify({ ...f.currentWire, findings: [{ findingId: 'f0', signal: 'object', severity: 'warning', reason: 'Synthetic local evidence error.', suggestion: 'Review the exact source.', sourceEvidence: [{ segmentId: 'c999' }] }] }), f.frozen)
    const request = continuityReassessmentRequest('system:pending', 'input:pending', first, f.frozen.bodies, false, 6), response = JSON.stringify({ corrections: [{ table: 'findings', index: 0, value: { findingId: 'f0', signal: 'object', severity: 'warning', reason: 'Still not bound.', suggestion: 'Keep the error.', sourceEvidence: [{ segmentId: 'c999' }] } }] })
    const failed = failedContinuityReassessment(first, response, true, f.frozen.bodies, 6)
    if (!isContinuityV4Inspection(failed)) throw Error('Expected the frozen v4 failure')
    const pending = f.operation('pending', f.frozen, failed)
    pending.children.push(f.child(pending.id, 'continuity_reassessment', response, request))
    f.artifacts.push({ metadata: { fullReassessmentKey: 'durable:pending:continuity_reassessment', original: first.audit, request,
      frozenInput: { system: 'system:pending', content: 'input:pending', bodies: f.frozen.bodies, coverage: { binding: 'unchanged' } } } })
    f.operations.push(pending)
    const entries = await f.read()
    expect(entries).toHaveLength(3)
    expect(entries?.find(entry => entry.operationId === 'pending')).toMatchObject({ committed: true, current: false, inspected: { complete: false, audit: { classification: 'projection_invalid' } } })
  })
})
