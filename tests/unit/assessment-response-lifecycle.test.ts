import { describe, expect, it, vi } from 'vitest'
import { applyContinuityReassessment, continuityReassessmentCandidates, runContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import type { AiUsageLog, Prisma } from '@prisma/client'
import { readOwnedContinuityReassessment } from '../../api/lib/agent/continuity-reassessment-witness.js'

const bodies = { previous: '前章门锁着，之后门打开。', current: '本章人物走进已打开的门。' }
const proof = [{ source: 'previous', segmentId: 'p0' }, { source: 'current', segmentId: 'c0' }]
const finding = { signal: 'object', severity: 'error', evidence: '前章“错误引文”与本章门状态互斥。', suggestion: '统一门状态。', sourceEvidence: proof }
const raw = JSON.stringify({ findings: [finding] })
const original = (content = raw) => inspectContinuityResponse(content, bodies, true, 6)
const retract = () => ({ decisions: [{ index: 0, action: 'retract', reason: '原判断忽略前章后续已开门的事件，核对两章原文后撤回。', sourceEvidence: proof }], findings: [] })

describe('one complete continuity reassessment', () => {
  it('limits the Prisma run filter to the owner even when the caller has a full tool context', async () => {
    const findMany = vi.fn(async () => [])
    const tx = { agentArtifact: { findMany } } as unknown as Prisma.TransactionClient
    const subject = { userId: 'owner', novelId: 'novel', runId: 'run', sessionId: 'session', chapterId: 'chapter', spec: { intent: 'revise' } }
    const usage = { usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, requestTokens: 12, responseTokens: 0,
      billingEvidence: { responseObserved: true } }
    await expect(readOwnedContinuityReassessment(tx, subject, { runId: 'run', callId: 'call', chapterId: 'chapter', revision: 1,
      callAt: new Date(1), resultAt: new Date(2), payments: [{ ...usage, action: 'agent3ContinuityCritic' },
        { ...usage, action: 'agent3ContinuityCriticSecondPass' }] as AiUsageLog[] })).resolves.toBeNull()
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
