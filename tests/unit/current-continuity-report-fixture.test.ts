import { describe, expect, it } from 'vitest'
import { continuityOpinionsFromSourceQuotes } from '../support/current-continuity-report.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import type { ContinuitySnapshot } from '../../api/lib/agent/continuity-review.js'

const source = (id: string, kind: 'current' | 'previous', content: string) => ({ source: kind, content,
  table: buildQualityEvidenceSources({ userId: 'u', novelId: 'n', chapterId: id, chapterRevision: 1 }, content) })
const opinion = { signal: 'object' as const, severity: 'error' as const, evidence: '随身与家中现金有矛盾。', suggestion: '核对随身金额。',
  sourceEvidence: [{ source: 'current' as const, quote: '随身390元。' }] }
const snapshot = (sources: ReturnType<typeof source>[]) => ({ sources }) as unknown as ContinuitySnapshot

describe('current continuity report fixture source conversion', () => {
  it('uses only the actual visible current source prefix and preserves the original opinion', () => {
    const current = source('c', 'current', '随身390元。'), previous = source('p', 'previous', '家中97元。')
    const result = continuityOpinionsFromSourceQuotes([opinion], snapshot([current, previous]))
    expect(result).toEqual([{ signal: opinion.signal, severity: opinion.severity, explanation: opinion.evidence, suggestion: opinion.suggestion,
      evidence: [{ sourceId: current.table.entries[0].id.slice(0, 13) }] }])
    expect(opinion.sourceEvidence[0].quote).toBe('随身390元。')
  })
  it.each(['missing', 'ambiguous', 'foreign-source', 'cross-entry'] as const)('rejects %s evidence instead of fabricating a located finding', scenario => {
    const current = source('c', 'current', scenario === 'ambiguous' ? '随身390元。随身390元。' : '随身390元。家中97元。')
    const sources = scenario === 'foreign-source' ? [source('p', 'previous', '随身390元。')] : [current]
    const finding = scenario === 'missing' ? { ...opinion, sourceEvidence: [{ source: 'current' as const, quote: '不存在的现金。' }] }
      : scenario === 'cross-entry' ? { ...opinion, sourceEvidence: [{ source: 'current' as const, quote: '随身390元。家中97元。' }] } : opinion
    expect(() => continuityOpinionsFromSourceQuotes([finding], snapshot(sources))).toThrow('exactly one owned source entry')
  })
})
