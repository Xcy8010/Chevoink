import { describe, expect, it } from 'vitest'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from '../../api/lib/agent/compiler-continuity-contract.js'
import { currentTerminalReview, inspectTerminalReview, terminalCandidateSchema, terminalClaims, terminalReviewInput, terminalReviewFailure } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityReassessment, continuityReassessmentRequest } from '../../api/lib/agent/assessment-response-lifecycle.js'

const candidate = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌骨裂'] } })
const raw = (verdict = 'supported', segmentIds = ['c0']) => JSON.stringify({ findings: [], terminalVerdicts: [{ path: 'exitState.body.0', verdict, segmentIds }] })
describe('independent terminal fact evidence', () => {
  it('keeps a completed check and unsupported candidate distinct without changing visible presentation', () => {
    const body = '他右掌疼痛，伤情未明。', response = raw('unknown')
    const inspected = inspectContinuityResponse(response, { previous: null, current: body }, true, 6, candidate)
    expect(inspected.complete).toBe(true)
    const validation = { terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspected.audit }
    const before = structuredClone(validation)
    const result = terminalReviewFailure(validation, body)
    expect(result).toMatchObject({ reviewOutcome: 'decision_required', reviewCompleted: true,
      summary: '连续性检查完成 · 章节尚未提交' })
    expect(result).not.toHaveProperty('failureCode')
    expect(result).not.toHaveProperty('display')
    expect(result?.output).toContain('exitState.body.0')
    expect(result?.output).toContain('unknown')
    expect(validation).toEqual(before)
    expect(currentTerminalReview(validation, body)?.supported).toBe(false)
  })
  it('preserves the old frozen request prefix byte for byte when no terminal candidate exists', () => {
    const bodies = { previous: null, current: '正文' }
    const old = inspectContinuityResponse('{"findings":[]}', bodies, true, 6)
    expect(continuityReassessmentRequest('原系统', '冻结输入', old, bodies).content.startsWith('冻结输入\n本次原文定位表：\n')).toBe(true)
    expect(continuityReassessmentRequest('原系统', '冻结输入', old, bodies).content).not.toContain('terminalVerdicts')
  })
  it('uses the existing full reassessment for missing verdicts and preserves the exact second response', () => {
    const bodies = { previous: null, current: '医师确认林舟右掌骨裂。' }
    const first = inspectContinuityResponse('{"findings":[]}', bodies, true, 6, candidate)
    expect(first).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid' } })
    const second = JSON.stringify({ decisions: [], ...JSON.parse(raw()) })
    const final = applyContinuityReassessment(first, second, bodies)
    expect(final.complete).toBe(true)
    expect(JSON.parse(final.audit.rawResponse.content)).toBe(second)
    expect(currentTerminalReview({ independentCheck: 'complete', terminalCandidate: candidate, continuityCriticResponse: final.audit }, bodies.current)?.supported).toBe(true)
    expect(() => applyContinuityReassessment(first, '{"decisions":[],"findings":[]}', bodies)).toThrow()
    expect(inspectContinuityResponse(raw('unknown'), bodies, true, 6, candidate).complete).toBe(true)
    expect(inspectContinuityResponse('{"findings":[]}', bodies, true, 6).complete).toBe(true)
  })
  it('binds every claim to a server-owned complete span without accepting critic-authored quotes', () => {
    const body = '医师验明林舟右掌骨裂，尚未愈合。他握不住刀。'
    const result = inspectTerminalReview(candidate, body, raw(), true)!
    expect(result).toMatchObject({ supported: true, candidate, verdicts: [{ evidence: [{ segmentId: 'c0', start: 0, end: body.length }] }] })
    expect(result.verdicts[0].evidence[0]).not.toHaveProperty('quote')
    const forged = JSON.stringify({ findings: [], terminalVerdicts: [{ path: 'exitState.body.0', verdict: 'supported', segmentIds: ['c0'], quote: '正文从未说过的话' }] })
    expect(inspectTerminalReview(candidate, body, forged, true)).toBeNull()
  })
  it.each([
    ['他计划明日假装右掌骨裂。', 'planned'],
    ['他右掌隐隐作痛，伤情不明。', 'unknown'],
    ['医师确认他右掌没有骨裂。', 'negated'],
    ['“林舟右掌骨裂。”敌人散布着这条未经证实的传言。', 'attributed'],
    ['此前他右掌骨裂，现已完全愈合。', 'unknown'],
  ])('does not promote %s to present fact from a located substring (%s)', (body, verdict) => {
    const result = inspectTerminalReview(candidate, body, raw(verdict), true)!
    expect(result.supported).toBe(false)
    expect(result.candidate).toEqual(candidate)
    expect(result.verdicts[0].verdict).toBe(verdict)
    expect(terminalReviewInput(candidate)).toContain(verdict === 'unknown' ? 'unknown' : verdict)
  })
  it.each(['missing', 'duplicate', 'extra', 'invented', 'empty', 'incomplete'] as const)('rejects %s independent evidence instead of interpreting no findings as support', kind => {
    let response = raw()
    const record = JSON.parse(response)
    if (kind === 'missing') delete record.terminalVerdicts
    if (kind === 'duplicate') record.terminalVerdicts.push(record.terminalVerdicts[0])
    if (kind === 'extra') record.terminalVerdicts[0].path = 'exitState.body.1'
    if (kind === 'invented') record.terminalVerdicts[0].segmentIds = ['c999']
    if (kind === 'empty') record.terminalVerdicts[0].segmentIds = []
    response = JSON.stringify(record)
    expect(inspectTerminalReview(candidate, '正文', response, kind !== 'incomplete')).toBeNull()
  })
  it('accepts an explicit supported negative claim and keeps genuinely missing fields unknown', () => {
    const negative = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌没有骨裂'] } })
    expect(inspectTerminalReview(negative, '医师确认林舟右掌没有骨裂。', raw(), true)?.supported).toBe(true)
    expect(terminalClaims(terminalCandidateSchema.parse({ exitState: {} }))).toEqual([])
    expect(inspectTerminalReview(terminalCandidateSchema.parse({ exitState: {} }), '正文', '{"findings":[],"terminalVerdicts":[]}', true)?.supported).toBe(true)
  })
  it('changes coverage for different candidates at the same revision, and after edits to evidence', () => {
    const source = { chapter: { id: 'c', revision: 1, content: '医师确认林舟右掌骨裂。', orderIndex: 1 }, bridge: {}, sceneTasks: [], source: null, terminalCandidate: candidate }
    const checked = compilerContinuityCoverage(source)
    expect(compilerContinuityCoverageMatches(checked, compilerContinuityCoverage(source))).toBe(true)
    expect(compilerContinuityCoverageMatches(checked, compilerContinuityCoverage({ ...source, terminalCandidate: terminalCandidateSchema.parse({ exitState: {} }) }))).toBe(false)
    expect(compilerContinuityCoverageMatches(checked, compilerContinuityCoverage({ ...source, chapter: { ...source.chapter, content: '医师确认林舟右掌没有骨裂。' } }))).toBe(false)
  })
  it('requires saved complete independent response and preserves unsupported claims', () => {
    expect(currentTerminalReview({ terminalCandidate: candidate, independentCheck: 'complete' }, '正文')).toBeNull()
    const validation = { terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspectContinuityResponse(raw('unknown'), { previous: null, current: '正文' }, true, 6, candidate).audit }
    expect(currentTerminalReview(validation, '正文')).toMatchObject({ supported: false, candidate })
    expect(currentTerminalReview(validation, '修改后的正文')).toBeNull()
    expect(currentTerminalReview({ ...validation, terminalCandidate: terminalCandidateSchema.parse({ exitState: { body: ['不同主张'] } }) }, '正文')).toBeNull()
  })
})
