import { describe, expect, it, vi } from 'vitest'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { terminalAddressResponseFields, terminalReviewAddressCatalog } from '../../api/lib/agent/terminal-review-addresses.js'
import { inspectContinuityResponse, continuityFailureOutput } from '../../api/lib/agent/continuity-format-recovery.js'
import { continuityResponseContract, continuityResponseInput, continuityResponseSystem, continuityReassessmentDiagnostics } from '../../api/lib/agent/continuity-response-contract.js'
import { runContinuityReassessment, applyContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'

function fixture() {
  const content = 'The clerk records the new request and remains at the desk. Earlier matters have not been restated.'
  const candidate = terminalCandidateSchema.parse({ exitState: { action: 'The clerk records the new request.', knowledge: ['The new request is recorded.'] } })
  const context: TerminalEvidenceContext = { protocol: 2, verdictProtocol: 6, spanAddressProtocol: 2, quoteAddressProtocol: 1,
    current: { id: 'current', revision: 4, orderIndex: 10, contentHash: runtimeJson({ content }).hash }, previous: null,
    factCoverage: { version: 2, taskId: 'task', chapterId: 'current', obligations: Array.from({ length: 18 }, (_, index) => {
      const field = 'knowledge' as const, claim = `Earlier established matter ${index}.`
      return { id: runtimeJson({ field, claim }).hash, field, claim }
    }) } }
  const bodies = { previous: null, current: content, terminalEvidence: context }
  const catalog = terminalReviewAddressCatalog(candidate, context)
  const wire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic full-body check.', findingIndexes: [] })),
    terminalVerdicts: catalog.ordinary.map(row => ({ claimIndex: row.claimIndex, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] })),
    terminalProofVerdicts: [] as Array<{ proofIndex: number; currentState: string; reason: string }>,
    terminalDispositions: context.factCoverage!.obligations.map((_, obligationIndex) => ({ obligationIndex, outcome: 'unknown', reason: 'The whole old fact remains unresolved.', sourceEvidence: [] as Array<{ segmentId: string }> })) }
  const inspect = (value: unknown, responseContract?: 3) => inspectContinuityResponse(JSON.stringify(value), bodies, true, 8, candidate, undefined, responseContract ? { responseContract } : {})
  return { content, candidate, context, bodies, catalog, wire, inspect }
}

describe('coherent frozen continuity response contract', () => {
  it('keeps 18 obligations and zero requested proofs distinct; unresolved facts remain unresolved', () => {
    const f = fixture(), report = f.inspect(f.wire, 3)
    expect(continuityResponseContract(f.bodies, f.candidate).safeParse(f.wire).success).toBe(true)
    expect(report).toMatchObject({ complete: true, audit: { responseContract: 3, classification: 'complete' } })
    const saved = { independentCheck: 'complete', terminalCandidate: f.candidate, continuityCriticResponse: report.audit }
    expect(currentTerminalReview(saved, f.content, f.context)).toMatchObject({ supported: false, factCoverage: { complete: false, dispositions: expect.any(Array) } })
    expect(currentTerminalReview(saved, f.content, f.context)?.factCoverage?.dispositions).toHaveLength(18)
    expect(continuityResponseInput('Complete source input.', f.bodies, f.candidate)).toContain('"terminalProofVerdicts":0')
    expect(continuityResponseInput('Complete source input.', f.bodies, f.candidate)).toContain('"terminalDispositions":18')
  })
  it.each(['unknown-target', 'replacement-without-target', 'replacement-to-action', 'ended-with-target', 'ended-without-evidence'])('does not advertise a disposition the semantic guard must reject: %s', kind => {
    const f = fixture(), persistentIndex = f.catalog.claims.find(row => row.field === 'knowledge')!.claimIndex
    const first = f.wire.terminalDispositions[0]
    const row = kind === 'unknown-target' ? { ...first, candidateIndex: persistentIndex }
      : kind === 'replacement-without-target' ? { ...first, outcome: 'replaced' }
        : kind === 'replacement-to-action' ? { ...first, outcome: 'replaced', candidateIndex: f.catalog.claims.find(row => row.field === 'action')!.claimIndex }
          : kind === 'ended-with-target' ? { ...first, outcome: 'ended', candidateIndex: persistentIndex, sourceEvidence: [{ segmentId: 'c0' }] }
            : { ...first, outcome: 'ended' }
    const wire = { ...f.wire, terminalDispositions: [row, ...f.wire.terminalDispositions.slice(1)] }
    // Historical schema remains frozen; new requests close its known gap.
    expect(terminalAddressResponseFields(f.candidate, f.context).terminalDispositions.safeParse(wire.terminalDispositions).success).toBe(true)
    expect(continuityResponseContract(f.bodies, f.candidate).safeParse(wire).success).toBe(false)
    expect(f.inspect(wire, 3).complete).toBe(false)
  })
  it('puts only the single full contract in the system role and removes the contradictory findings-only example', () => {
    const f = fixture(), text = continuityResponseSystem('Independent review. 无问题返回 {"findings":[]}。\n只输出 JSON。合法结构示例：{"findings":[]}。', continuityResponseContract(f.bodies, f.candidate))
    expect(text).not.toContain('合法结构示例')
    expect(text).not.toContain('无问题返回 {"findings":[]}')
    expect(text).toContain('terminalDispositions')
    expect(text).toContain('"const":"replaced"')
    expect(continuityResponseSystem(text, continuityResponseContract(f.bodies, f.candidate)).split('"$schema"')).toHaveLength(2)
    const input = continuityResponseInput('Source.', f.bodies, f.candidate)
    expect(continuityResponseInput(input, f.bodies, f.candidate)).toBe(input)
  })
  it('projects only identical repeated rows under protocol3, preserves raw hashes, and replays the same audit at commit', () => {
    const f = fixture(), wire = { ...f.wire, terminalDispositions: [...f.wire.terminalDispositions, structuredClone(f.wire.terminalDispositions[15])] }
    const before = JSON.stringify(wire), old = f.inspect(wire), report = f.inspect(wire, 3)
    expect(old.complete).toBe(false)
    expect(old.audit).not.toHaveProperty('responseContract')
    expect(old.audit).not.toHaveProperty('responseNormalization')
    expect(report.complete).toBe(true)
    expect(report.audit.rawResponse).toEqual(old.audit.rawResponse)
    expect(report.audit.contentHash).toBe(old.audit.contentHash)
    expect(report.audit.characterCount).toBe(old.audit.characterCount)
    expect(report.audit.responseNormalization?.repeated).toEqual([{ field: 'terminalDispositions', index: 18, originalIndex: 15, address: 15 }])
    expect(f.inspect(wire, 3).audit).toEqual(report.audit)
    const saved = { independentCheck: 'complete', terminalCandidate: f.candidate, continuityCriticResponse: report.audit }
    expect(currentTerminalReview(saved, f.content, f.context)).toMatchObject({ supported: false })
    const { responseContract: _contract, ...withoutMarker } = report.audit
    expect(currentTerminalReview({ ...saved, continuityCriticResponse: withoutMarker }, f.content, f.context)).toBeNull()
    expect(JSON.stringify(wire)).toBe(before)
  })
  it('retains a deep malformed model response as an invalid raw audit instead of throwing out of the tool', () => {
    const f = fixture()
    let nested: unknown = 'synthetic malformed extra field'
    for (let index = 0; index < 35; index++) nested = { nested }
    const wire = { ...f.wire, malformed: nested }, raw = JSON.stringify(wire)
    const report = f.inspect(wire, 3)
    expect(report).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid', responseContract: 3,
      terminalReviewDiagnostics: [{ code: 'response_projection_invalid' }] } })
    expect(JSON.parse(report.audit.rawResponse.content)).toBe(raw)
    const invalidSemantic = f.inspect({ ...wire, semanticChecks: [] }, 3)
    expect(invalidSemantic.audit.classification).toBe('semantic_invalid')
    expect(applyContinuityReassessment(invalidSemantic, JSON.stringify(f.wire), f.bodies, 3))
      .toMatchObject({ complete: true, audit: { reassessment: { fixedFields: ['findings'] } } })
  })
  it.each(['conflicting-duplicate', 'missing-row', 'unknown-address', 'unknown-key'])('never repairs away a real response ambiguity: %s', kind => {
    const f = fixture(), rows = [...f.wire.terminalDispositions]
    if (kind === 'conflicting-duplicate') rows.push({ ...rows[15], reason: 'A different independent judgment.' })
    else if (kind === 'missing-row') rows.pop()
    else if (kind === 'unknown-address') rows[17] = { ...rows[17], obligationIndex: 99 }
    else Object.assign(rows[17], { invented: true })
    expect(f.inspect({ ...f.wire, terminalDispositions: rows }, 3).complete).toBe(false)
  })
})

describe('one bounded field recovery under the original request budget', () => {
  function work() {
    const f = fixture(), bad = { ...f.wire, terminalProofVerdicts: Array.from({ length: 18 }, (_, proofIndex) => ({ proofIndex, currentState: 'unchanged', reason: 'Wrong response table.' })) }
    const original = f.inspect(bad, 3), claim = vi.fn(async (_request: { system: string; content: string }) => true), dispatch = vi.fn(async (_request: { system: string; content: string }) => ({ content: JSON.stringify(f.wire), complete: true }))
    const args = { original, bodies: f.bodies, system: 'Independent editor.', content: 'Frozen complete source input.', reassessmentProtocol: 3 as const,
      billingKnown: true, providerComplete: true, slotUsed: false, signal: new AbortController().signal, assertCurrent: vi.fn(async () => {}), claim, dispatch }
    return { ...f, bad, original, args, claim, dispatch }
  }
  it('repairs the requested tables once without changing valid opinions/semantic checks or inventing a model response', async () => {
    const f = work(), raw = JSON.stringify(f.wire), result = await runContinuityReassessment(f.args)
    expect(f.original.complete).toBe(false)
    expect(result).toMatchObject({ complete: true, audit: { responseContract: 3, reassessment: { kind: 'field_repair', fixedFields: ['findings', 'semanticChecks'] } } })
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(raw)
    expect(f.claim).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce()
    expect(f.dispatch.mock.calls[0]?.[0]).toEqual(f.claim.mock.calls[0]?.[0])
    expect(f.claim.mock.calls[0]).toHaveLength(1)
    expect(JSON.stringify(f.claim.mock.calls)).toContain('本次待回复表精确行数')
  })
  it.each(['unknown-billing', 'incomplete-provider', 'slot-used'])('does not buy another response for %s', async kind => {
    const f = work()
    const result = await runContinuityReassessment({ ...f.args, ...(kind === 'unknown-billing' ? { billingKnown: false } : kind === 'incomplete-provider' ? { providerComplete: false } : { slotUsed: true }) })
    expect(result).toBe(f.original); expect(f.claim).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('rejects audit/request marker mismatches before claiming or dispatching', async () => {
    const f = work(), old = f.inspect(f.bad)
    await expect(runContinuityReassessment({ ...f.args, original: old })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    await expect(runContinuityReassessment({ ...f.args, reassessmentProtocol: 2 })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(f.claim).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('retains the latest second-response diagnosis instead of repeatedly showing the old proof-table error', async () => {
    const f = work(), bad = { ...f.wire, terminalDispositions: f.wire.terminalDispositions.map((row, index) => index ? row : { ...row, candidateIndex: 1 }) }
    f.dispatch.mockResolvedValueOnce({ content: JSON.stringify(bad), complete: true })
    const result = await runContinuityReassessment(f.args), visible = continuityFailureOutput(result.audit, 'Unconfirmed.', f.bodies)
    expect(result.complete).toBe(false)
    expect(visible).toContain('最新一次复评')
    expect(visible).toContain('terminalDispositions')
    expect(visible).not.toContain('terminalProofVerdicts')
    expect(f.dispatch).toHaveBeenCalledOnce()
  })
  it('uses the same full decision validator for source-invalid recovery, exact duplicates and latest failure diagnostics', () => {
    const f = work(), original = f.inspect({ ...f.wire, findings: [{ signal: 'object', severity: 'error',
      evidence: 'The source contains “a sentence that is not present”.', suggestion: 'Check the real passage.',
      sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: 'a sentence that is not present' }] }] }, 3)
    expect(original.audit.classification).toBe('source_invalid')
    const missing = continuityReassessmentDiagnostics(original, JSON.stringify(f.wire), f.bodies)
    expect(missing).toMatchObject({ classification: 'terminal_invalid', terminalReviewDiagnostics: [{ path: 'decisions' }] })
    const decision = { index: 0, action: 'retract', reason: 'The original quotation is absent; the current source records the request.',
      sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: f.content }] }
    const raw = JSON.stringify({ ...f.wire, decisions: [decision], terminalDispositions: [...f.wire.terminalDispositions, f.wire.terminalDispositions[15]] })
    const repaired = applyContinuityReassessment(original, raw, f.bodies, 3)
    expect(repaired).toMatchObject({ complete: true, audit: { responseContract: 3, reassessment: { decisions: [decision] } } })
    expect(JSON.parse(repaired.audit.rawResponse.content)).toBe(raw)
    expect(repaired.audit.responseNormalization?.repeated).toHaveLength(1)
  })
  it('does not silently delete or change previously valid reviewer findings during field repair', async () => {
    const f = work(), changed = { ...f.wire, findings: [{ invented: true }] }
    expect(() => applyContinuityReassessment(f.original, JSON.stringify(changed), f.bodies, 3)).toThrow('changed frozen findings')
    f.dispatch.mockResolvedValueOnce({ content: JSON.stringify(changed), complete: true })
    const result = await runContinuityReassessment(f.args)
    expect(result.complete).toBe(false)
    expect(continuityFailureOutput(result.audit, 'Unconfirmed.', f.bodies)).toContain('改变了已冻结')
  })
})
