import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { CriticQualityFinding } from '../../shared/contracts/humanity-quality-contracts.js'
import { buildQualityEvidenceSources, coerceCriticFindings, correctQualityEvidence, locateQualityFindingSpans,
  locateQuoteSpans, renderQualityEvidenceSources, unlocatedQualityEvidence, validateQualityEvidenceSources,
  inspectCriticResponse, parseQualityJsonObject } from '../../api/lib/agent/quality-evidence.js'

const finding: CriticQualityFinding = { signal: 'explanation_echo', severity: 'warning', quote: '模型改写的引文', explanation: '重复解释', suggestion: '删除重复解释', confidence: 0.9 }
const content = '她关上了门。走廊里的声音消失了。'
const sourceIdentity = { userId: 'owner', novelId: 'novel', chapterId: 'chapter', chapterRevision: 3 }

describe('complete quality JSON response evidence', () => {
  it('extracts one complete fenced report around unrelated JSON noise and string braces without joining objects', () => {
    const value = { findings: [{ ...finding, quote: '她关上了门。', explanation: '字符串内的 { 与 }，以及 \\"引号\\" 都是数据。' }] }
    const raw = `参考：{"metadata":"untrusted"}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n说明：{"note":"end"}`
    expect(parseQualityJsonObject(raw, 'findings')).toEqual(value)
    expect(inspectCriticResponse(raw)).toMatchObject({ complete: true, findings: value.findings,
      diagnostic: { version: 1, contentHash: createHash('sha256').update(raw).digest('hex'), characterCount: raw.length, classification: 'complete', findingCount: 1 } })
  })
  it.each([
    ['{"findings":[]}\n{"findings":[]}', 'ambiguous_envelope'],
    ['{"findings":[]}\n{"findings":[', 'incomplete_json'],
    ['{"findings":[{"quote":"unfinished}', 'incomplete_json'],
    ['{"findings":[],}', 'json_invalid'],
    ['{"findings":[null],"findings":[]}', 'duplicate_keys'],
    ['{"findings":[],"findings":[null]}', 'duplicate_keys'],
    ['{"findings":[{"signal":"reader_pull","signal":"plot_progress"}]}', 'duplicate_keys'],
    ['{"findings":[],"find\\u0069ngs":[null]}', 'duplicate_keys'],
    ['{"summary":"no findings"}', 'envelope_invalid'],
    ['[{"findings":[]}]', 'envelope_invalid'],
    ['{"findings":null}', 'envelope_invalid'],
    ['No structured response.', 'json_invalid'],
  ])('never invents a completed review for %s', (raw, classification) => {
    expect(inspectCriticResponse(raw)).toMatchObject({ complete: false, findings: [], diagnostic: { classification } })
  })
  it('retains authentic findings while a foreign source keeps the entire report unavailable', () => {
    const sources = buildQualityEvidenceSources(sourceIdentity, content)
    const valid = { ...finding, quote: sources.entries[0].text, sourceId: sources.entries[0].id }
    const raw = JSON.stringify({ findings: [valid, { ...finding, sourceId: 'foreign', quote: content }] })
    expect(inspectCriticResponse(raw, sources)).toMatchObject({ complete: false, findings: [valid], diagnostic: {
      classification: 'source_invalid', findingCount: 2, droppedFindings: 1, invalidSources: 1 } })
  })
  it('distinguishes a successful empty review from incomplete provider output or absent response', () => {
    expect(inspectCriticResponse('{"findings":[]}')).toMatchObject({ complete: true, diagnostic: { classification: 'complete' } })
    expect(inspectCriticResponse('{"findings":[]}', undefined, false)).toMatchObject({ complete: false, diagnostic: { classification: 'provider_incomplete' } })
    expect(inspectCriticResponse(null)).toMatchObject({ complete: false, diagnostic: { classification: 'provider_unavailable', contentHash: null, characterCount: 0 } })
  })
  it('never turns nonempty unusable findings into a passed empty report', () => {
    expect(inspectCriticResponse('{"findings":[null]}')).toMatchObject({ complete: false, diagnostic: { classification: 'findings_invalid', findingCount: 1, droppedFindings: 1 } })
  })
})

describe('frozen quality evidence sources', () => {
  it('binds repeated original sentences by distinct source IDs without inventing offsets', () => {
    const chapter = '门开了。门开了。'
    const sources = buildQualityEvidenceSources(sourceIdentity, chapter)
    expect(sources.entries).toHaveLength(2)
    expect(sources.entries[0].id).not.toBe(sources.entries[1].id)
    const result = coerceCriticFindings({ findings: [{ ...finding, quote: undefined, sourceId: sources.entries[1].id }] }, sources)!
    expect(result).toMatchObject({ dropped: 0, invalidSources: 0 })
    expect(result.findings[0].quote).toBe('门开了。')
    expect(locateQualityFindingSpans(chapter, result.findings[0], sources)).toEqual([{ start: 4, end: 8 }])
    expect(unlocatedQualityEvidence(chapter, result.findings, sources)).toEqual([])
    expect(locateQuoteSpans(chapter, result.findings[0].quote)).toHaveLength(2)
    expect(locateQualityFindingSpans(chapter, result.findings[0])).toEqual([])
  })
  it.each(['userId', 'novelId', 'chapterId', 'chapterRevision'] as const)('rejects an identical body with changed %s identity', key => {
    const sources = buildQualityEvidenceSources(sourceIdentity, content)
    const changed = { ...sourceIdentity, [key]: key === 'chapterRevision' ? 4 : 'other' }
    expect(validateQualityEvidenceSources(sources, changed, content)).toBe(false)
    expect(buildQualityEvidenceSources(changed, content).entries[0].id).not.toBe(sources.entries[0].id)
  })
  it('covers exact paragraph boundaries and long Unicode text without cutting surrogate pairs', () => {
    const chapter = '她关上了门。\r\n\r\n' + '😀'.repeat(241) + '\n' + '长'.repeat(721)
    const sources = buildQualityEvidenceSources(sourceIdentity, chapter)
    expect(sources.entries.map(entry => entry.text).join('')).toBe(chapter)
    expect(validateQualityEvidenceSources(sources, sourceIdentity, chapter)).toBe(true)
    for (const entry of sources.entries) {
      expect(chapter.slice(entry.start, entry.end)).toBe(entry.text)
      expect(entry.text.length).toBeLessThanOrEqual(360)
      expect(entry.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
    }
    expect(renderQualityEvidenceSources(sources)).toContain(sources.entries[0].id)
    expect(renderQualityEvidenceSources(sources)).toContain(JSON.stringify(sources.entries[0].text))
  })
  it('rejects unknown, stale, inconsistent or non-string IDs even with a locatable quote', () => {
    const sources = buildQualityEvidenceSources(sourceIdentity, content)
    const foreign = buildQualityEvidenceSources({ ...sourceIdentity, chapterId: 'other' }, content)
    for (const sourceId of ['unknown', foreign.entries[0].id, 3, null]) {
      expect(coerceCriticFindings({ findings: [{ ...finding, sourceId, quote: '她关上了门。' }] }, sources)).toMatchObject({ findings: [], dropped: 1, invalidSources: 1 })
    }
    expect(coerceCriticFindings({ findings: [{ ...finding, sourceId: sources.entries[0].id, quote: '走廊里的声音消失了。' }] }, sources)).toMatchObject({ findings: [], invalidSources: 1 })
    const bound = { ...finding, sourceId: sources.entries[0].id, quote: sources.entries[0].text }
    expect(locateQualityFindingSpans(content + '新正文。', bound, sources)).toEqual([])
    expect(coerceCriticFindings({ findings: [bound] })).toMatchObject({ findings: [], invalidSources: 1 })
  })
  it('preserves invalid-source accounting alongside valid findings rather than claiming an empty review', () => {
    const sources = buildQualityEvidenceSources(sourceIdentity, content)
    const valid = { ...finding, quote: undefined, sourceId: sources.entries[0].id }
    const result = coerceCriticFindings({ findings: [valid, { ...finding, sourceId: 'invented' }] }, sources)!
    expect(result.findings).toHaveLength(1)
    expect(result).toMatchObject({ dropped: 1, invalidSources: 1 })
    expect(coerceCriticFindings({ findings: [] }, sources)).toEqual({ findings: [], dropped: 0, invalidSources: 0 })
  })
  it('corrects an unbound old quote using the same frozen source table without changing its judgment', () => {
    const sources = buildQualityEvidenceSources(sourceIdentity, content)
    const source = sources.entries[1]
    const corrected = correctQualityEvidence(content, [finding], { corrections: [{ index: 0, sourceId: source.id }] }, sources)
    expect(corrected).toEqual([{ ...finding, sourceId: source.id, quote: source.text }])
    expect(unlocatedQualityEvidence(content, corrected, sources)).toEqual([])
    expect(correctQualityEvidence(content, [finding], { corrections: [{ index: 0, sourceId: source.id, quote: '她关上了门。' }] }, sources)).toEqual([finding])
    const badId = { ...finding, sourceId: 'unknown' }
    expect(correctQualityEvidence(content, [badId], { corrections: [{ index: 0, quote: '她关上了门。' }] }, sources)).toEqual([badId])
  })
  it('rejects a tampered table and blank evidence while retaining old exact-quote behavior', () => {
    const sources = buildQualityEvidenceSources(sourceIdentity, content)
    const tampered = structuredClone(sources)
    tampered.entries[0].end += 1
    expect(validateQualityEvidenceSources(tampered, sourceIdentity, content)).toBe(false)
    const whitespace = buildQualityEvidenceSources(sourceIdentity, '\n\n')
    expect(coerceCriticFindings({ findings: [{ ...finding, quote: undefined, sourceId: whitespace.entries[0].id }] }, whitespace)).toMatchObject({ invalidSources: 1, findings: [] })
    const old = { ...finding, quote: '她关上了门。' }
    expect(coerceCriticFindings({ findings: [old] }, sources)!.findings).toEqual([old])
    expect(unlocatedQualityEvidence(content, [old], sources)).toEqual([])
  })
})

describe('quality evidence correction', () => {
  it('corrects only an unbound quote while preserving the original judgment', () => {
    const result = correctQualityEvidence(content, [finding], { corrections: [{ index: 0, quote: '走廊里的声音消失了。' }] })
    expect(result).toEqual([{ ...finding, quote: '走廊里的声音消失了。' }])
    expect(unlocatedQualityEvidence(content, result)).toEqual([])
    expect(finding.quote).toBe('模型改写的引文')
  })
  it.each([
    { corrections: [] },
    { corrections: [{ index: 0, quote: '不存在的文本' }] },
    { corrections: [{ index: 0, quote: '她关上……声音消失了。' }] },
    { corrections: [{ index: 0, quote: '她关上了门。' }, { index: 0, quote: '走廊里的声音消失了。' }] },
    { corrections: [{ index: 99, quote: '她关上了门。' }] },
    { findings: [] },
  ])('retains every unresolved judgment for malformed or ambiguous correction %#', raw => {
    expect(correctQualityEvidence(content, [finding], raw)).toEqual([finding])
    expect(unlocatedQualityEvidence(content, [finding])).toHaveLength(1)
  })
  it('does not accept ambiguous evidence or replace already valid evidence', () => {
    expect(correctQualityEvidence('重复。重复。', [finding], { corrections: [{ index: 0, quote: '重复。' }] })).toEqual([finding])
    const bound = { ...finding, quote: '她关上了门。' }
    expect(correctQualityEvidence(content, [bound], { corrections: [{ index: 0, quote: '走廊里的声音消失了。' }] })).toEqual([bound])
  })
})

describe('quality evidence normalized binding', () => {
  it('binds a quote copied across a paragraph break without the blank line', () => {
    const chapter = '废窑的灰还在落。\n\n他停住脚，听了很久。'
    expect(locateQuoteSpans(chapter, '废窑的灰还在落。他停住脚，听了很久。')).toEqual([{ start: 0, end: chapter.length }])
    expect(unlocatedQualityEvidence(chapter, [{ ...finding, quote: '废窑的灰还在落。他停住脚，听了很久。' }])).toEqual([])
  })
  it.each([
    { chapter: '他说：「废窑里还有存货。」', quote: '“废窑里还有存货。”', expected: '「废窑里还有存货。」', label: 'quote-mark style' },
    { chapter: '他愣住了……半晌才开口。', quote: '他愣住了...', expected: '他愣住了……', label: 'ellipsis as periods' },
    { chapter: '他愣住了……半晌才开口。', quote: '他愣住了。半晌', expected: '他愣住了……半晌', label: 'period for ellipsis' },
    { chapter: '他说——好。', quote: '他说—好', expected: '他说——好', label: 'dash run written shorter' },
    { chapter: '“三文，”他说。', quote: '“三文,”他说。', expected: '“三文，”他说。', label: 'fullwidth comma' },
    { chapter: '门开了．风没进来。', quote: '门开了.风没进来。', expected: '门开了．风没进来。', label: 'fullwidth period' },
  ])('binds an equivalent quote variant: $label', ({ chapter, quote, expected }) => {
    const spans = locateQuoteSpans(chapter, quote)
    expect(spans).toHaveLength(1)
    expect(chapter.slice(spans[0].start, spans[0].end)).toBe(expected)
  })
  it('does not bind evidence that stays ambiguous after normalization', () => {
    expect(locateQuoteSpans('他看到门。他看到门。', '他看到门。')).toHaveLength(2)
    expect(locateQuoteSpans('他认为 "废窑" 还亮着，牌子上写着「废窑」。', '“废窑”')).toHaveLength(2)
  })
})

describe('critic finding coercion', () => {
  it('rescues findings with out-of-range fields instead of failing the whole report', () => {
    const result = coerceCriticFindings({ findings: [
      { signal: 'emotion_grounding', severity: 'error', quote: '长'.repeat(400), explanation: '缺少动作', suggestion: '局部调整', confidence: 85 },
      { signal: 'reader_pull', severity: 'warning', quote: '原文', explanation: '缺少张力', suggestion: '补充动作' },
    ] })
    expect(result).toMatchObject({ dropped: 0 })
    expect(result!.findings).toHaveLength(2)
    expect(result!.findings[0]).toMatchObject({ signal: 'emotion_grounding', severity: 'warning', confidence: 1 })
    expect(result!.findings[0].quote).toHaveLength(360)
    expect(result!.findings[1].confidence).toBe(0.7)
  })
  it('drops only unusable items and truncates beyond the cap', () => {
    const valid = { signal: 'emotion_grounding' as const, severity: 'advisory' as const, quote: '原文', explanation: '说明', suggestion: '建议' }
    const result = coerceCriticFindings({ findings: [null, { ...valid, quote: '' },
      ...Array.from({ length: 26 }, (_, index) => ({ ...valid, quote: `原文${index}`, explanation: `说明${index}` }))] })
    expect(result).toMatchObject({ dropped: 4 })
    expect(result!.findings).toHaveLength(24)
  })
  it('returns null only when the envelope itself is unrecognizable', () => {
    expect(coerceCriticFindings(null)).toBeNull()
    expect(coerceCriticFindings([])).toBeNull()
    expect(coerceCriticFindings({})).toBeNull()
    expect(coerceCriticFindings({ findings: [] })).toEqual({ findings: [], dropped: 0 })
  })
})
