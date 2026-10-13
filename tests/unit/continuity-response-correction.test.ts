import { describe, expect, it, vi } from 'vitest'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityEvidenceCorrection, runContinuityEvidenceCorrection, continuityCorrectionRecoveryDecision } from '../../api/lib/agent/continuity-response-correction.js'

const bodies = { previous: '上一章门打开。', current: '这一章门锁住。' }
const finding = { signal: 'object', severity: 'error', evidence: '同一门状态互斥。', suggestion: '统一实际状态。', sourceEvidence: [
  { source: 'previous', segmentId: 'p0', quote: '门打开' }, { source: 'current', segmentId: 'c0', quote: '杜撰引文' },
] }
const raw = JSON.stringify({ findings: [finding, { ...finding, evidence: '另一原意见。', severity: 'warning' }] })
const original = () => inspectContinuityResponse(raw, bodies, true, 5)
const corrections = () => ({ corrections: [0, 1].map(index => ({ index, sourceEvidence: [
  { source: 'previous', segmentId: 'p0', quote: '门打开' }, { source: 'current', segmentId: 'c0', quote: '门锁住' },
] })) })

describe('continuity typed response and evidence correction', () => {
  it('models accounting, output, assessment, application, admission and binding independently', () => {
    for (const billingKnown of [false, true]) for (const providerComplete of [false, true]) for (const assessmentValid of [false, true])
      for (const applied of [false, true]) for (const newAdmission of [false, true]) for (const bindingMatches of [false, true]) {
        const decision = continuityCorrectionRecoveryDecision({ billingKnown, providerComplete, assessmentValid, applied, newAdmission, bindingMatches })
        if (!billingKnown) expect(decision).toBe('unknown')
        else if (applied) expect(decision).toBe('applied')
        else if (providerComplete && assessmentValid && bindingMatches) expect(decision).toBe('reuse')
        else expect(decision).toBe(newAdmission ? 'fresh' : 'wait')
      }
  })
  it('separates valid fields from invalid sources without losing a judgment or raw response', () => {
    expect(inspectContinuityResponse(raw, bodies, true, 4).audit.classification).toBe('findings_invalid')
    const inspected = original()
    expect(inspected).toMatchObject({ structured: true, complete: false, findings: [], candidateFindings: JSON.parse(raw).findings,
      audit: { parserVersion: 5, classification: 'source_invalid' } })
    expect(JSON.parse(inspected.audit.rawResponse.content)).toBe(raw)
    expect(inspected.audit.candidateFindings).toEqual(JSON.parse(raw).findings)
  })
  it('binds all exact original signals, severity, evidence and suggestions', () => {
    const result = applyContinuityEvidenceCorrection(original(), JSON.stringify(corrections()), bodies)
    expect(result.complete).toBe(true)
    expect(result.findings).toEqual(JSON.parse(raw).findings.map((item: object) => ({ ...item, sourceEvidence: [
      { source: 'previous', quote: '门打开' }, { source: 'current', quote: '门锁住' },
    ] })))
    expect(result.candidateFindings).toEqual(JSON.parse(raw).findings)
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(raw)
  })
  it.each(['dropped', 'duplicate', 'changed-judgment', 'extra-finding', 'swapped-source', 'fewer-refs', 'invented'] as const)('rejects %s corrections', scenario => {
    const value = corrections()
    if (scenario === 'dropped') value.corrections.pop()
    if (scenario === 'duplicate') value.corrections[1].index = 0
    if (scenario === 'changed-judgment') Object.assign(value.corrections[0], { severity: 'warning' })
    if (scenario === 'extra-finding') value.corrections.push({ ...value.corrections[0], index: 2 })
    if (scenario === 'swapped-source') value.corrections[0].sourceEvidence[0].source = 'current'
    if (scenario === 'fewer-refs') value.corrections[0].sourceEvidence.pop()
    if (scenario === 'invented') value.corrections[0].sourceEvidence[1].quote = '不存在的引用'
    if (scenario === 'invented') expect(applyContinuityEvidenceCorrection(original(), JSON.stringify(value), bodies).complete).toBe(false)
    else expect(() => applyContinuityEvidenceCorrection(original(), JSON.stringify(value), bodies)).toThrow()
  })
  it.each(['legacy', 'durable'] as const)('%s uses one claimed source-only dispatch and denies restart dispatch', async () => {
    let claimed = false
    const journal: unknown[] = []
    const dispatch = vi.fn(async () => { expect(journal).toEqual([original().audit]); return { content: JSON.stringify(corrections()), complete: true } })
    const input = { original: original(), bodies, billingKnown: true, signal: new AbortController().signal, assertCurrent: vi.fn(async () => {}),
      claim: async (inspection: ReturnType<typeof original>) => { if (claimed) return false; claimed = true; journal.push(inspection.audit); return true }, dispatch }
    expect((await runContinuityEvidenceCorrection(input)).complete).toBe(true)
    expect((await runContinuityEvidenceCorrection(input)).complete).toBe(false)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it.each(['usage-unknown', 'incomplete', 'aborted', 'current-changed', 'previous-changed'] as const)('denies dispatch for %s', async scenario => {
    const controller = new AbortController()
    if (scenario === 'aborted') controller.abort()
    const dispatch = vi.fn(async () => ({ content: '', complete: false }))
    const input = { original: scenario === 'incomplete' ? inspectContinuityResponse(raw, bodies, false, 5) : original(), bodies,
      billingKnown: scenario !== 'usage-unknown', signal: controller.signal,
      assertCurrent: async () => { if (scenario.endsWith('changed')) throw new Error('Frozen source changed') }, claim: vi.fn(async () => true), dispatch }
    if (['aborted', 'current-changed', 'previous-changed'].includes(scenario)) await expect(runContinuityEvidenceCorrection(input)).rejects.toThrow()
    else expect((await runContinuityEvidenceCorrection(input)).complete).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(input.claim).not.toHaveBeenCalled()
  })
  it('keeps invalid/unfinished followup honestly incomplete and never retries', async () => {
    for (const complete of [true, false]) {
      const dispatch = vi.fn(async () => ({ content: '{"corrections":[]}', complete }))
      const result = await runContinuityEvidenceCorrection({ original: original(), bodies, billingKnown: true, signal: new AbortController().signal,
        assertCurrent: async () => {}, claim: async () => true, dispatch })
      expect(result.complete).toBe(false)
      expect(result.candidateFindings).toEqual(JSON.parse(raw).findings)
      expect(dispatch).toHaveBeenCalledTimes(1)
    }
  })
  it.each(['aborted', 'body-changed', 'apply-failed'] as const)('journals received correction before %s guards', async scenario => {
    const controller = new AbortController()
    const observation: unknown[] = []
    let assertions = 0
    const input = { original: original(), bodies, billingKnown: true, signal: controller.signal,
      assertCurrent: async () => { assertions++; if (assertions === 3 && scenario !== 'aborted') throw new Error('application cannot proceed') },
      claim: async () => true, dispatch: async () => { if (scenario === 'aborted') controller.abort(); return { content: JSON.stringify(corrections()), complete: true } },
      observe: async (response: { content: string; complete: boolean }) => { observation.push(response) } }
    await expect(runContinuityEvidenceCorrection(input)).rejects.toThrow()
    expect(observation).toEqual([{ content: JSON.stringify(corrections()), complete: true }])
  })
})
