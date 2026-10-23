import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { applyContinuityReassessment, bindLegacyContinuityRequest, continuityReassessmentCandidates, continuityReassessmentRequest, readLegacyContinuityAssessment, runContinuityReassessment, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import type { AiUsageLog, Prisma } from '@prisma/client'
import { readOwnedContinuityReassessment } from '../../api/lib/agent/continuity-reassessment-witness.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { isKnownRejectedTextRequestAttempt } from '../../api/lib/agent/text-request-billing.js'

const bodies = { previous: '前章门锁着，之后门打开。', current: '本章人物走进已打开的门。' }
const proof = [{ source: 'previous', segmentId: 'p0' }, { source: 'current', segmentId: 'c0' }]
const finding = { signal: 'object', severity: 'error', evidence: '前章“错误引文”与本章门状态互斥。', suggestion: '统一门状态。', sourceEvidence: proof }
const raw = JSON.stringify({ findings: [finding] })
const original = (content = raw) => inspectContinuityResponse(content, bodies, true, 6)
const retract = () => ({ decisions: [{ index: 0, action: 'retract', reason: '原判断忽略前章后续已开门的事件，核对两章原文后撤回。', sourceEvidence: proof }], findings: [] })

describe('legacy continuity request attempts retain their semantic stage', () => {
  const ctx = { userId: 'owner', novelId: 'novel', runId: 'run', callId: 'call' } as ToolContext
  const input: LegacyAssessmentInput = { chapterId: 'chapter', revision: 1, bodies, system: 'selected reviewer', content: 'frozen full input', targetType: 'chapter', targetId: 'chapter' }
  const rejected = { id: 'rejected', action: 'agent3ContinuityCritic', usageSource: 'prepared', billingStatus: 'provider_rejected',
    requestTokens: null, responseTokens: null, reservedCreditMilli: 0, creditChargeMilli: 0 }
  const settled = { id: 'success', action: 'agent3ContinuityCritic', usageSource: 'reported', billingStatus: 'settled',
    requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0, creditChargeMilli: 1 }
  it('binds the actual same-action retry to first rather than output recovery', async () => {
    const create = vi.fn(async ({ data }: { data: { metadata: unknown } }) => ({ id: 'binding', ...data }))
    const tx = { $queryRaw: vi.fn(async () => [{ id: ctx.novelId }]), aiUsageLog: { findFirst: vi.fn(async () => settled), findMany: vi.fn(async () => [rejected]) },
      agentArtifact: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => [{ metadata: { stage: 'first', usageIds: [rejected.id] } }]), create } } as unknown as Prisma.TransactionClient
    await bindLegacyContinuityRequest(tx, ctx, input, settled.id, 'primary', async () => {})
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0].data.metadata).toMatchObject({ stage: 'first', usageIds: [settled.id] })
  })
  it.each(['agent3ContinuityCriticOutputRecovery', 'agent3ContinuityCriticEmptyRecovery'])('preserves the real recovery action %s', async action => {
    const create = vi.fn(async ({ data }: { data: { metadata: unknown } }) => ({ id: 'binding', ...data }))
    const tx = { $queryRaw: vi.fn(async () => [{ id: ctx.novelId }]), aiUsageLog: { findFirst: vi.fn(async () => ({ ...settled, action })) }, agentArtifact: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create } } as unknown as Prisma.TransactionClient
    await bindLegacyContinuityRequest(tx, ctx, input, settled.id, 'primary', async () => {})
    expect(create.mock.calls[0][0].data.metadata).toMatchObject({ stage: 'output_recovery' })
  })
  it('rejects reassessment usage bound to a primary stage before saving ownership', async () => {
    const create = vi.fn()
    const tx = { $queryRaw: vi.fn(async () => [{ id: ctx.novelId }]), aiUsageLog: { findFirst: vi.fn(async () => ({ ...settled, action: 'agent3ContinuityCriticSecondPass' })) }, agentArtifact: { findFirst: vi.fn(), create } } as unknown as Prisma.TransactionClient
    await expect(bindLegacyContinuityRequest(tx, ctx, input, settled.id, 'primary', async () => {})).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(create).not.toHaveBeenCalled()
  })
  it.each(['unknown', 'pending-settlement', 'successful-zero', 'third-attempt'] as const)('does not bind another request after %s', async kind => {
    const create = vi.fn()
    const prior = kind === 'unknown' ? { ...rejected, usageSource: 'unknown', billingStatus: 'pending_usage' }
      : kind === 'pending-settlement' ? { ...settled, id: rejected.id, billingStatus: 'pending_settlement', requestTokens: 0, responseTokens: 0, creditChargeMilli: 0 }
        : kind === 'successful-zero' ? { ...settled, id: rejected.id, requestTokens: 0, responseTokens: 0, creditChargeMilli: 0 }
          : rejected
    const priors = kind === 'third-attempt' ? [prior, { ...rejected, id: 'another-rejection' }] : [prior]
    const tx = { $queryRaw: vi.fn(async () => [{ id: ctx.novelId }]), aiUsageLog: { findFirst: vi.fn(async () => settled), findMany: vi.fn(async () => priors) },
      agentArtifact: { findMany: vi.fn(async () => priors.map(row => ({ metadata: { usageIds: [row.id] } }))), findFirst: vi.fn(), create } } as unknown as Prisma.TransactionClient
    await expect(bindLegacyContinuityRequest(tx, ctx, input, settled.id, 'primary', async () => {})).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(create).not.toHaveBeenCalled()
  })
  it.each(['first', 'output_recovery'] as const)('existing usage binding preserves its frozen stage %s', async stage => {
    const create = vi.fn(), findMany = vi.fn()
    const tx = { $queryRaw: vi.fn(async () => [{ id: ctx.novelId }]), aiUsageLog: { findFirst: vi.fn(async () => settled) },
      agentArtifact: { findFirst: vi.fn(async () => ({ metadata: { stage } })), findMany, create } } as unknown as Prisma.TransactionClient
    const result = bindLegacyContinuityRequest(tx, ctx, input, settled.id, 'primary', async () => {})
    if (stage === 'first') await expect(result).resolves.toBe('first')
    else await expect(result).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(findMany).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })
  it('requires a fresh HTTP rejection witness to classify settled 0/0 as a rejected attempt', () => {
    const zero = { ...settled, requestTokens: 0, responseTokens: 0, creditChargeMilli: 0 }
    expect(isKnownRejectedTextRequestAttempt(zero)).toBe(false)
    expect(isKnownRejectedTextRequestAttempt({ ...zero, billingEvidence: { responseObserved: true } })).toBe(false)
    expect(isKnownRejectedTextRequestAttempt({ ...zero, billingEvidence: { providerRejection: { status: 429 } } })).toBe(true)
    expect(isKnownRejectedTextRequestAttempt({ ...zero, billingEvidence: { providerRejection: { status: 200 } } })).toBe(false)
    expect(isKnownRejectedTextRequestAttempt({ ...zero, billingEvidence: { responseObserved: true, providerRejection: { status: 429 } } })).toBe(false)
    expect(isKnownRejectedTextRequestAttempt({ ...zero, billingStatus: 'pending_settlement', billingEvidence: { providerRejection: { status: 429 } } })).toBe(false)
    expect(isKnownRejectedTextRequestAttempt({ ...zero, promptCacheHitTokens: 1, billingEvidence: { providerRejection: { status: 429 } } })).toBe(false)
  })
  const response = (content: string | null) => ({ content: content === null ? null : JSON.stringify(content), finishReason: content === null ? null : 'stop',
    toolCalls: [], transportComplete: content !== null })
  function reader(rows: Array<Record<string, unknown>>, frames: Array<Record<string, unknown>>) {
    return { aiUsageLog: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter(row => typeof row.id === 'string' && where.id.in.includes(row.id))) },
      agentArtifact: { findMany: vi.fn(async () => frames.map((metadata, index) => ({ id: `observation-${index}`, metadata }))),
        findFirst: vi.fn(async () => null) } } as unknown as Prisma.TransactionClient
  }
  it('reads the successful same-action response after a null rejected attempt without consuming the format slot', async () => {
    const frames = [{ stage: 'first', usageIds: [rejected.id], response: response(null) },
      { stage: 'first', usageIds: [settled.id], response: response('{"findings":[]}') }]
    const result = await readLegacyContinuityAssessment(reader([rejected, settled], frames), ctx, input)
    expect(result).toMatchObject({ billingKnown: true, providerComplete: true, slotUsed: false, inspected: { complete: true, findings: [] } })
    expect(result.usageIds).toEqual([rejected.id, settled.id])
  })
  it('reuses a complete second pass after its own zero-fee rejection and retains all four request IDs', async () => {
    const secondRejected = { ...rejected, id: 'second-rejected', action: 'agent3ContinuityCriticSecondPass' }
    const secondSettled = { ...settled, id: 'second-success', action: 'agent3ContinuityCriticSecondPass' }
    const frames = [{ stage: 'first', usageIds: [rejected.id], response: response(null) },
      { stage: 'first', usageIds: [settled.id], response: response(raw) },
      { stage: 'reassessment', usageIds: [secondRejected.id], response: response(null) },
      { stage: 'reassessment', usageIds: [secondSettled.id], response: response(JSON.stringify(retract())) }]
    const tx = reader([rejected, settled, secondRejected, secondSettled], frames)
    vi.mocked(tx.agentArtifact.findFirst).mockResolvedValue({ id: 'claimed' } as never)
    const result = await readLegacyContinuityAssessment(tx, ctx, input)
    expect(result).toMatchObject({ billingKnown: true, providerComplete: true, slotUsed: true, inspected: { complete: true, findings: [] } })
    expect(result.usageIds).toEqual([rejected.id, settled.id, secondRejected.id, secondSettled.id])
  })
  it.each(['unknown-bound', 'settled-bound', 'truncated', 'invalid'] as const)('does not replace an unresolved final report with a newly interpretable primary: %s', async kind => {
    const second = { ...settled, id: 'second-request', action: 'agent3ContinuityCriticSecondPass',
      ...(kind === 'unknown-bound' ? { usageSource: 'unknown', billingStatus: 'pending_usage' } : {}) }
    const frames = [{ stage: 'first', usageIds: [settled.id], response: response('{"findings":[]}') },
      ...(kind === 'truncated' ? [{ stage: 'reassessment', usageIds: [second.id], response: { ...response('{"findings":[]}'), finishReason: 'length', transportComplete: false } }]
        : kind === 'invalid' ? [{ stage: 'reassessment', usageIds: [second.id], response: response('{"invalid":true}') }] : [])]
    const tx = reader([settled, second], frames), findMany = vi.mocked(tx.agentArtifact.findMany)
    findMany.mockResolvedValueOnce(frames.map((metadata, index) => ({ id: `frame-${index}`, metadata })) as never)
      .mockResolvedValueOnce([{ metadata: { stage: 'first', usageIds: [settled.id] } }, { metadata: { stage: 'reassessment', usageIds: [second.id] } }] as never)
    vi.mocked(tx.agentArtifact.findFirst).mockResolvedValue({ id: 'second-claimed' } as never)
    await expect(readLegacyContinuityAssessment(tx, ctx, input)).rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(vi.mocked(tx.aiUsageLog.findMany).mock.calls[0][0]?.where?.id).toEqual({ in: [settled.id, second.id] })
  })
  it('does not erase a successful unmarked 0/0 output recovery stage', async () => {
    const zero = { ...settled, id: 'zero-response', action: 'agent3ContinuityCriticEmptyRecovery', requestTokens: 0, responseTokens: 0, creditChargeMilli: 0 }
    const frames = [{ stage: 'first', usageIds: [settled.id], response: response(raw) },
      { stage: 'output_recovery', usageIds: [zero.id], response: response('{"findings":[]}') }]
    const result = await readLegacyContinuityAssessment(reader([settled, zero], frames), ctx, input)
    expect(result).toMatchObject({ billingKnown: true, providerComplete: true, slotUsed: true, inspected: { complete: true, findings: [] } })
  })
  it.each([undefined, 2] as const)('interprets stored missing-decisions responses only under their frozen protocol: %s', async reassessmentProtocol => {
    const second = { ...settled, id: 'second', action: 'agent3ContinuityCriticSecondPass' }
    const firstRaw = '{"findings":[]}'
    const secondRaw = JSON.stringify({ findings: [], terminalVerdicts: [{ path: 'exitState.body.0', verdict: 'unknown', segmentIds: ['c0'] }] })
    const frames = [{ stage: 'first', usageIds: [settled.id], response: response(firstRaw) },
      { stage: 'reassessment', usageIds: [second.id], response: response(secondRaw) }]
    const before = JSON.stringify(frames)
    const result = await readLegacyContinuityAssessment(reader([settled, second], frames), ctx, { ...input,
      terminalCandidate: terminalCandidateSchema.parse({ exitState: { body: ['An injury is confirmed.'] } }),
      ...(reassessmentProtocol ? { reassessmentProtocol } : {}),
    })
    expect(result.billingKnown).toBe(true)
    expect(result.inspected.complete).toBe(reassessmentProtocol === 2)
    expect(JSON.stringify(frames)).toBe(before)
    expect(result.inspected.audit.rawResponse.content).toBe(JSON.stringify(reassessmentProtocol === 2 ? secondRaw : firstRaw))
  })
  it.each(['unknown', 'partial', 'pending-settlement', 'charged-rejection'] as const)('does not certify %s prior attempts', async kind => {
    const unsafe = { ...rejected, ...(kind === 'unknown' ? { usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 3 }
      : kind === 'partial' ? { usageSource: 'partial', billingStatus: 'pending_usage', requestTokens: 1 }
        : kind === 'pending-settlement' ? { usageSource: 'reported', billingStatus: 'pending_settlement', requestTokens: 0, responseTokens: 0 }
          : { creditChargeMilli: 1 }) }
    const frames = [{ stage: 'first', usageIds: [unsafe.id], response: response(null) }, { stage: 'first', usageIds: [settled.id], response: response('{"findings":[]}') }]
    const tx = reader([unsafe, settled], frames)
    await expect(readLegacyContinuityAssessment(tx, ctx, input)).rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(vi.mocked(tx.aiUsageLog.findMany).mock.calls[0][0]?.where?.id).toEqual({ in: [unsafe.id, settled.id] })
  })
})

describe('one complete continuity reassessment', () => {
  it('new independent reassessment retains original findings and full sources without feeding back failed terminal judgments', () => {
    const first = original(JSON.stringify({ findings: [finding], terminalVerdicts: ['failed-terminal-answer'], semanticChecks: 'failed-semantic-summary' }))
    const before = JSON.stringify(first)
    const request = continuityReassessmentRequest('frozen system', 'full candidate and source context', first, bodies, false, 2)
    expect(request.content).toContain('full candidate and source context')
    expect(request.content).toContain(bodies.current)
    expect(request.content).toContain(JSON.stringify({ index: 0, finding }))
    expect(request.content).not.toContain('failed-terminal-answer')
    expect(request.content).not.toContain('failed-semantic-summary')
    expect(JSON.stringify(first)).toBe(before)
    expect(continuityReassessmentRequest('frozen system', 'input', first, bodies).content).toContain('failed-terminal-answer')
  })
  it('derives empty dispositions only from a known empty original, preserving the raw audit', () => {
    const first = original('{"findings":[]}'), raw = '{\n  "findings": []\n}'
    const before = JSON.stringify(first)
    expect(() => applyContinuityReassessment(first, raw, bodies)).toThrow()
    const result = applyContinuityReassessment(first, raw, bodies, 2)
    expect(result.complete).toBe(true)
    expect(JSON.stringify(first)).toBe(before)
    expect((result.audit as unknown as { reassessment: { decisions: unknown[]; rawResponse: { content: string } } }).reassessment)
      .toMatchObject({ decisions: [], rawResponse: { content: JSON.stringify(raw) }, mechanicalRecovery: {
        version: 1, kind: 'empty_original_dispositions', originalResponseHash: first.audit.contentHash,
        responseHash: createHash('sha256').update(raw).digest('hex'), derived: { decisions: [] },
      } })
    for (const content of ['{broken', JSON.stringify({ findings: [finding] }), '{"findings":[],"issues":[]}']) {
      expect(() => applyContinuityReassessment(original(content), raw, bodies, 2)).toThrow()
    }
    for (const decisions of [null, {}, '[]', [{ index: 0 }]]) {
      expect(() => applyContinuityReassessment(first, JSON.stringify({ findings: [], decisions }), bodies, 2)).toThrow()
    }
    expect(() => applyContinuityReassessment(first, '{"findings":null}', bodies, 2)).toThrow()
  })
  it('limits the Prisma run filter to the owner even when the caller has a full tool context', async () => {
    const findMany = vi.fn(async () => [])
    const tx = { agentArtifact: { findMany } } as unknown as Prisma.TransactionClient
    const subject = { userId: 'owner', novelId: 'novel', runId: 'run', sessionId: 'session', chapterId: 'chapter', spec: { intent: 'revise' } }
    const usage = { usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, requestTokens: 12, responseTokens: 0,
      billingEvidence: { responseObserved: true } }
    await expect(readOwnedContinuityReassessment(tx, subject, { runId: 'run', callId: 'call', chapterId: 'chapter', revision: 1,
      callAt: new Date(1), resultAt: new Date(2), payments: [{ ...usage, action: 'agent3ContinuityCritic' },
        { ...usage, action: 'agent3ContinuityCriticSecondPass' }] as unknown as AiUsageLog[] })).resolves.toBeNull()
    expect(findMany.mock.calls[0]).toEqual([expect.objectContaining({ where: expect.objectContaining({ run: { userId: 'owner', novelId: 'novel' } }) })])
  })
  it('preserves parseable invalid fields as original indices and invents none for unparseable syntax', () => {
    expect(continuityReassessmentCandidates(JSON.stringify({ findings: [{ ...finding, severity: 'unsupported' }] }))).toEqual([{ ...finding, severity: 'unsupported' }])
    expect(continuityReassessmentCandidates('{broken')).toBeNull()
    expect(applyContinuityReassessment(original('{broken'), '{"decisions":[],"findings":[]}', bodies).complete).toBe(true)
  })
  it.each(['judgment', 'pair', 'fields'] as const)('a complete %s failure can explicitly retract with real source proof and a valid full report', kind => {
    const item = kind === 'judgment' ? finding : kind === 'pair' ? { ...finding, evidence: '原判断混淆门的先后状态。', sourceEvidence: [proof[0]] }
      : { ...finding, severity: 'unsupported' }
    const first = original(JSON.stringify({ findings: [item] }))
    expect(first.complete).toBe(false)
    const result = applyContinuityReassessment(first, JSON.stringify(retract()), bodies)
    expect(result.complete).toBe(true)
    expect(result.findings).toEqual([])
    expect((result.audit as unknown as { reassessment: { original: unknown } }).reassessment.original).toEqual(first.audit)
  })
  it.each(['omitted', 'duplicate', 'invented-index', 'no-reason', 'invalid-source', 'confirmed-changed', 'invalid-final'] as const)('rejects %s reassessment without silent dropping', kind => {
    const envelope: { decisions: Array<Record<string, unknown>>; findings: unknown[] } = retract()
    if (kind === 'omitted') envelope.decisions = []
    if (kind === 'duplicate') envelope.decisions.push(envelope.decisions[0])
    if (kind === 'invented-index') envelope.decisions[0].index = 1
    if (kind === 'no-reason') envelope.decisions[0].reason = ''
    if (kind === 'invalid-source') envelope.decisions[0].sourceEvidence = [{ source: 'current', segmentId: 'c99' }]
    if (kind === 'confirmed-changed') { envelope.decisions[0].action = 'confirm'; envelope.decisions[0].findingIndex = 0; envelope.findings = [{ ...finding, evidence: '不同判断' }] }
    if (kind === 'invalid-final') envelope.findings = [{ ...finding, sourceEvidence: [{ source: 'current', quote: '不存在的原文' }] }]
    expect(() => applyContinuityReassessment(original(), JSON.stringify(envelope), bodies)).toThrow()
  })
  it('replacement explicitly links a corrected judgment and retains the original audit', () => {
    const replacement = { ...finding, severity: 'warning', evidence: '两章门的开启过程虽成立，读者可能误读省略的过渡。', sourceEvidence: proof }
    const result = applyContinuityReassessment(original(), JSON.stringify({ decisions: [{ index: 0, action: 'replace', reason: '原互斥判断不成立，更正为可选衔接意见。', sourceEvidence: proof, findingIndex: 0 }], findings: [replacement] }), bodies)
    expect(result.complete).toBe(true)
    expect(result.findings).toMatchObject([{ severity: 'warning', evidence: replacement.evidence }])
  })
  it.each(['unknown', 'partial', 'slot-used', 'cancelled', 'stale'] as const)('does not send a reassessment for %s', async kind => {
    const signal = new AbortController()
    if (kind === 'cancelled') signal.abort()
    const claim = vi.fn(async () => true), dispatch = vi.fn(async () => ({ content: JSON.stringify(retract()), complete: true }))
    const result = runContinuityReassessment({ original: original(), bodies, system: 'original selected reviewer', content: 'full immutable input',
      billingKnown: kind !== 'unknown', providerComplete: kind !== 'partial', slotUsed: kind === 'slot-used', signal: signal.signal,
      assertCurrent: async () => { if (kind === 'stale') throw new Error('input changed') }, claim, dispatch })
    if (['cancelled', 'stale'].includes(kind)) await expect(result).rejects.toBeDefined()
    else expect((await result).complete).toBe(false)
    expect(dispatch).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled()
  })
  it('a failed second result consumes the single claimed slot across restart', async () => {
    let claimed = false
    const claim = vi.fn(async () => { if (claimed) return false; claimed = true; return true })
    const dispatch = vi.fn(async () => ({ content: '{"decisions":[],"findings":[]}', complete: true }))
    const input = { original: original(), bodies, system: 'selected reviewer', content: 'full immutable input', billingKnown: true, providerComplete: true,
      slotUsed: false, signal: new AbortController().signal, assertCurrent: async () => {}, claim, dispatch }
    expect((await runContinuityReassessment(input)).complete).toBe(false)
    expect((await runContinuityReassessment(input)).complete).toBe(false)
    expect(dispatch).toHaveBeenCalledOnce()
  })
  it.each(['abort', 'stale'] as const)('positively observes %s after claim before entering dispatch', async kind => {
    const controller = new AbortController(), notDispatched = vi.fn(async () => {}), dispatch = vi.fn()
    let claimed = false
    const assertCurrent = vi.fn(async () => { if (claimed && kind === 'stale') throw new Error('current input changed') })
    await expect(runContinuityReassessment({ original: original(), bodies, system: 'selected reviewer', content: 'full input', billingKnown: true,
      providerComplete: true, slotUsed: false, signal: controller.signal, assertCurrent,
      claim: async () => { claimed = true; if (kind === 'abort') controller.abort(); return true }, dispatch, notDispatched,
    })).rejects.toBeDefined()
    expect(dispatch).not.toHaveBeenCalled(); expect(notDispatched).toHaveBeenCalledOnce()
  })
})
