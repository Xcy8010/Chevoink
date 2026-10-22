import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiUsageLog, Prisma } from '@prisma/client'
import { readOwnedContinuityReassessment } from '../../api/lib/agent/continuity-reassessment-witness.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'

afterEach(() => { vi.unstubAllGlobals() })
function fixture(legacy: boolean, rootError = false, verdictProtocol?: 2 | 3 | 4 | 5) {
  const current = { id: 'chapter', content: 'The sensor is offline.', revision: 1, orderIndex: 1 }
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The sensor is offline.'] } })
  const evidence = terminalEvidenceContext(current, null, 2, 1, terminalCoverageInput({ id: 'task', scope: { terminalCoverageProtocol: 2 } }, {}, current, candidate), verdictProtocol)
  const input = { chapterId: 'chapter', revision: 1, parserVersion: 8 as const, bodies: { previous: null, current: current.content, terminalEvidence: evidence },
    terminalCandidate: candidate, sourceScope: { previous: [], currentOrderIndex: 1 }, system: 'frozen system', content: 'frozen original request', targetType: 'chapter' as const, targetId: 'chapter' }
  const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Checked.', findingIndexes: [] })),
    terminalVerdicts: rootError ? {} : [{ path: 'exitState.knowledge.0', verdict: 'unknown', basis: 'The source was considered.', sourceEvidence: [{ segmentId: 'c0', quote: current.content }] }] })
  const inspected = inspectContinuityResponse(raw, input.bodies, true, 8, candidate, input.sourceScope)
  expect(inspected.audit.classification).toBe('terminal_invalid')
  const frozen = structuredClone(inspected)
  if (legacy) frozen.audit.terminalReviewDiagnostics!.forEach(item => { delete item.path })
  const key = legacyContinuityAssessmentKey({ runId: 'run', callId: 'call' }, input)
  const request = continuityReassessmentRequest(input.system, input.content, frozen, input.bodies, legacy)
  const claim = { id: 'claim', createdAt: new Date(5), metadata: { callId: 'call', fullReassessmentKey: key, input,
    original: frozen.audit, request, usageIds: ['primary'] } }
  const claims = [claim,
    { id: 'first-owner', createdAt: new Date(3), metadata: { assessmentRequestOwnerKey: key, stage: 'first', usageIds: ['primary'] } },
    { id: 'first-frame', createdAt: new Date(4), metadata: { assessmentKey: key, stage: 'first', usageIds: ['primary'], response: { content: JSON.stringify(raw) }, audit: frozen.audit } },
    { id: 'second-owner', createdAt: new Date(7), metadata: { assessmentRequestOwnerKey: key, stage: 'reassessment', usageIds: ['second'] } },
    { id: 'second-frame', createdAt: new Date(8), metadata: { assessmentKey: key, stage: 'reassessment', usageIds: ['second'], response: { content: JSON.stringify(raw) } } }]
  const payments = ['primary', 'second'].map((id, index) => ({ id, userId: 'owner', novelId: 'novel', agentRunId: 'run', targetType: 'chapter', targetId: 'chapter',
    action: index === 0 ? 'agent3ContinuityCritic' : 'agent3ContinuityCriticSecondPass', createdAt: new Date(index === 0 ? 2 : 6),
    usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, requestTokens: 10, responseTokens: 10, creditChargeMilli: 1, billingEvidence: { responseObserved: true } })) as unknown as AiUsageLog[]
  const findMany = vi.fn().mockResolvedValue(claims), write = vi.fn(() => { throw Error('Unexpected write') })
  const tx = { agentArtifact: { findMany, create: write }, aiUsageLog: { create: write, update: write } } as unknown as Prisma.TransactionClient
  const args = { runId: 'run', callId: 'call', chapterId: 'chapter', revision: 1, callAt: new Date(1), resultAt: new Date(10), payments }
  return { input, inspected, claim, claims, tx, findMany, write, args }
}
describe('exact frozen diagnostic witness compatibility', () => {
  it.each([2, 3, 4, 5] as const)('authenticates the exact frozen request marker %s without changing the raw response or dispatching', async version => {
    const f=fixture(false,true,version),fetcher=vi.fn(()=>{throw Error('Unexpected request')})
    vi.stubGlobal('fetch',fetcher)
    const before=JSON.stringify(f.claims)
    expect(await readOwnedContinuityReassessment(f.tx,{userId:'owner',novelId:'novel'},f.args)).toMatchObject({claim:{id:'claim'},input:f.input})
    expect(JSON.stringify(f.claims)).toBe(before)
    expect(fetcher).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled()
  })
  it.each([[true, false], [false, false], [true, true], [false, true]])('authenticates legacy=%s rootError=%s without a provider call or write', async (legacy, rootError) => {
    const f = fixture(legacy, rootError), fetcher = vi.fn(() => { throw Error('Unexpected request') })
    vi.stubGlobal('fetch', fetcher)
    const saved = JSON.stringify(f.claims)
    expect(await readOwnedContinuityReassessment(f.tx, { userId: 'owner', novelId: 'novel' }, f.args)).toMatchObject({ claim: { id: 'claim' }, input: f.input })
    expect(JSON.stringify(f.claims)).toBe(saved)
    expect(fetcher).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled()
  })
  it.each([true, false])('rejects a mixed root-schema diagnostic pair (legacy=%s)', async legacy => {
    const f = fixture(legacy, true)
    f.claim.metadata.request = continuityReassessmentRequest(f.input.system, f.input.content, f.inspected, f.input.bodies, !legacy)
    expect(await readOwnedContinuityReassessment(f.tx, { userId: 'owner', novelId: 'novel' }, f.args)).toBeNull()
  })
  it.each(['mixed-current', 'mixed-legacy', 'request', 'raw', 'body', 'owner', 'usage-id', 'slot'] as const)('rejects %s mismatch without relaxing the witness', async kind => {
    const legacy = kind !== 'mixed-legacy', f = fixture(legacy)
    if (kind === 'mixed-current' || kind === 'mixed-legacy') f.claim.metadata.request = continuityReassessmentRequest(f.input.system, f.input.content, f.inspected, f.input.bodies, !legacy)
    if (kind === 'request') f.claim.metadata.request.content += 'altered'
    if (kind === 'raw') f.claim.metadata.original.rawResponse.content = JSON.stringify('{"findings":[]}')
    if (kind === 'body') f.input.bodies.current += 'altered'
    if (kind === 'owner') f.args.payments[1].userId = 'other'
    if (kind === 'usage-id') f.claim.metadata.usageIds = ['other']
    if (kind === 'slot') f.claims.push(structuredClone(f.claim))
    expect(await readOwnedContinuityReassessment(f.tx, { userId: 'owner', novelId: 'novel' }, f.args)).toBeNull()
    expect(f.write).not.toHaveBeenCalled()
  })
})
