import { describe, expect, it } from 'vitest'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { continuityAuthorRequirements, hasContinuitySourceAuthority } from '../../api/lib/agent/continuity-source-authority.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from '../../api/lib/agent/compiler-continuity-contract.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

const bodies = { previous: '钥匙已经熔毁。库门只能用这把钥匙开启。', current: '她在库门外等候。库门仍然关闭。' }
const sourceScope = { currentOrderIndex: 3, previous: [{ orderIndex: 2, startOffset: 0, endOffset: bodies.previous.length }] }
const references = [{ source: 'previous', segmentId: 'p0', quote: '钥匙已经熔毁' },
  { source: 'current', segmentId: 'c0', quote: '库门仍然关闭' }]
const finding = { signal: 'object', severity: 'error', evidence: '第3章却写“她用旧钥匙开门”，违反既定条件。', suggestion: '核对同一把钥匙的状态。', sourceEvidence: references }
const inspect = (value: unknown, source = bodies, version: 6 | 7 = 7) => inspectContinuityResponse(JSON.stringify({ findings: [value] }), source, true, version, undefined, version === 7 ? sourceScope : undefined)

describe('current manuscript factual source authority', () => {
  it.each([
    '第3章却写“她用旧钥匙开门”，违反既定条件。',
    '第三章表示「她用旧钥匙开门」，前后矛盾。',
    '本章仍然写道『她用旧钥匙开门』。',
    '在章节结尾，作者写了"她用旧钥匙开门"。',
    "Chapter 3 says '她用旧钥匙开门'.",
    '当前r4的句子“她用旧钥匙开门”与前文互斥。',
    '原请求明确指出“她用旧钥匙开门”，所以当前章仍有错误。',
  ])('does not let valid addresses launder old or historical prose: %s', evidence => {
    const result = inspect({ ...finding, evidence })
    expect(result).toMatchObject({ complete: false, findings: [], audit: { classification: 'source_invalid', candidateFindings: [{ evidence }] } })
    expect(JSON.parse(result.audit.rawResponse.content)).toContain(evidence.replaceAll('"', '\\"'))
  })
  it('preserves frozen parser6 behavior while invalidating the new protocol cache identity', () => {
    expect(inspect(finding, bodies, 6).complete).toBe(true)
    expect(inspect(finding).complete).toBe(false)
    const input = { chapter: { id: 'chapter', revision: 4, content: bodies.current, orderIndex: 3 }, bridge: {}, sceneTasks: [], source: bodies.previous }
    expect(compilerContinuityCoverageMatches(compilerContinuityCoverage(input, 8), compilerContinuityCoverage(input, 9))).toBe(false)
  })
  it.each(['第3章仍写', '第三章却写', 'Chapter 3 says', '本章仍然写道', '当前正文表明', '这一章写了', '本回写着', '这一版强调'])('rejects a previous quotation misattributed to %s', attribution => {
    const evidence = `${attribution}“钥匙已经熔毁”，同时又写“库门仍然关闭”，同一时刻互斥。`
    expect(inspect({ ...finding, evidence }).audit.classification).toBe('source_invalid')
  })
  it.each(['“开”', '‘开’', '「开」', '"开"', "'开'", `“${'未提供'.repeat(130)}”`, '“未提供\n新句”'])('does not silently ignore an unsupported quoted span: %s', quote => {
    expect(inspect({ ...finding, evidence: `当前正文“库门仍然关闭”，却另写${quote}，同一时刻互斥。` }).complete).toBe(false)
  })
  it.each(['第3章原句如下：\n', '第2、3章均写', '第2至3章都写'])('does not broaden attribution through newlines or a compound chapter label: %s', label => {
    expect(inspect({ ...finding, evidence: `${label}“钥匙已经熔毁”，而当前“库门仍然关闭”。` }).complete).toBe(false)
  })
  it('preserves an explicitly introduced previous quotation across a newline', () => {
    expect(inspect({ ...finding, evidence: '前文原句如下：\n“钥匙已经熔毁”，本章“库门仍然关闭”。' }).complete).toBe(true)
  })
  it('resolves an explicit earlier chapter ordinal against its frozen range', () => {
    const value = { ...finding, evidence: '第2章“钥匙已经熔毁”与第3章“库门仍然关闭”冲突。' }
    expect(inspect(value).complete).toBe(true)
    expect(inspect({ ...value, evidence: value.evidence.replace('第2章', '第1章') }).complete).toBe(false)
    const split = { currentOrderIndex: 3, previous: [{ orderIndex: 1, startOffset: 0, endOffset: 7 }, { orderIndex: 2, startOffset: 7, endOffset: bodies.previous.length }] }
    expect(inspectContinuityResponse(JSON.stringify({ findings: [value] }), bodies, true, 7, undefined, split).complete).toBe(false)
  })
  it.each([
    references.map(({ source, segmentId }) => ({ source, segmentId })),
    [{ source: 'previous', quote: '钥匙已经熔毁' }, { source: 'previous', quote: '库门只能用这把钥匙开启' }],
    [{ source: 'previous', quote: '钥匙已经熔毁' }, { source: 'current', quote: '钥匙已经熔毁' }],
    [{ source: 'current', quote: '库门仍然关闭' }, { source: 'current', quote: '库门仍然关闭' }],
  ])('requires specific distinct evidence including the actual current source', sourceEvidence => {
    expect(inspect({ ...finding, evidence: '本章“库门仍然关闭”与前文“钥匙已经熔毁”冲突。', sourceEvidence }).complete).toBe(false)
  })
  it('retains a real cross-chapter irreversible-resource contradiction and all anchored findings', () => {
    const actual = { ...bodies, current: '她用旧钥匙开门。门闩依然落下，却同时完全抬起。' }
    const cross = { ...finding, sourceEvidence: [{ ...references[0] }, { source: 'current', segmentId: 'c0', quote: '她用旧钥匙开门' }] }
    const same = { ...finding, evidence: '同一时刻门闩“依然落下”却“同时完全抬起”。',
      sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '依然落下' }, { source: 'current', segmentId: 'c0', quote: '同时完全抬起' }] }
    const result = inspectContinuityResponse(JSON.stringify({ findings: [cross, same] }), actual, true, 7, undefined, sourceScope)
    expect(result.complete).toBe(true)
    expect(result.findings).toHaveLength(2)
    expect(result.findings.map(f => f.severity)).toEqual(['error', 'error'])
  })
  it('does not certify a quote-free accusation based only on valid unrelated spans', () => {
    expect(inspect({ ...finding, evidence: '当前章还是存在旧钥匙开门的问题。' }).complete).toBe(false)
  })
  it('requires an explicit anchored disposition for every invalid candidate without clearing valid errors', () => {
    const original = inspect(finding)
    const decision = { index: 0, action: 'retract', reason: '旧句仅出现在历史问题描述中；当前库门关闭，不能指控开门。',
      sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '库门仍然关闭' }] }
    const corrected = applyContinuityReassessment(original, JSON.stringify({ decisions: [decision], findings: [] }), bodies)
    expect(corrected).toMatchObject({ complete: true, findings: [], audit: { parserVersion: 7, reassessment: { decisions: [decision] } } })
    expect(() => applyContinuityReassessment(original, '{"decisions":[],"findings":[]}', bodies)).toThrow()
    expect(() => applyContinuityReassessment(original, JSON.stringify({ decisions: [{ ...decision, action: 'confirm', findingIndex: 0 }], findings: [finding] }), bodies)).toThrow()
    expect(() => applyContinuityReassessment(original, JSON.stringify({ decisions: [{ ...decision, sourceEvidence: [{ source: 'current', segmentId: 'c0' }] }], findings: [] }), bodies)).toThrow()
  })
  it.each(['retract', 'replace'] as const)('does not clear a real error with an invented quotation in a %s reason', action => {
    const actual = { ...bodies, current: '她用旧钥匙开门。库门仍然关闭。' }
    const valid = { ...finding, sourceEvidence: [references[0], { source: 'current', quote: '她用旧钥匙开门' }] }
    const invalid = { ...finding, evidence: '本章写“她造出了新钥匙”。' }
    const original = inspectContinuityResponse(JSON.stringify({ findings: [valid, invalid] }), actual, true, 7, undefined, sourceScope)
    expect(original.complete).toBe(false)
    const sourceEvidence = [{ source: 'current', quote: '她用旧钥匙开门' }]
    const decisions = [0, 1].map(index => ({ index, action, reason: '当前正文明确“这是另一把全新钥匙”，因此旧问题不成立。',
      sourceEvidence, ...(action === 'replace' ? { findingIndex: 0 } : {}) }))
    const replacement = { ...valid, severity: 'warning', evidence: '当前正文“她用旧钥匙开门”值得核对。', sourceEvidence }
    expect(() => applyContinuityReassessment(original, JSON.stringify({ decisions, findings: action === 'replace' ? [replacement] : [] }), actual))
      .toThrow('unsupported manuscript evidence')
  })
  it('freezes opt-in only at new human admission and marks requirements as non-manuscript evidence', () => {
    const input = { runId: 'run', novelId: 'novel', prompt: '只修改第3章。旧稿“她用旧钥匙开门”有问题，检查必须通过。' }
    expect(hasContinuitySourceAuthority(buildTaskSpec(input))).toBe(false)
    expect(hasContinuitySourceAuthority(buildTaskSpec({ ...input, continuityEvidenceProtocol: 1 }))).toBe(true)
    expect(continuityAuthorRequirements(input.prompt)).toContain(input.prompt)
    expect(continuityAuthorRequirements(input.prompt)).toContain('"manuscriptEvidence":false')
    expect(continuityAuthorRequirements(input.prompt)).toContain('硬性检查门槛仍有效')
  })
})
