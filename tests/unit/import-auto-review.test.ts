import { describe, expect, it } from 'vitest'
import type { NovelImportReportDto } from '../../shared/contracts/novel-import-preview'
import { canHumanReviewImportItem, planImportAutoReview } from '../../src/features/studio/lib/import-auto-review'

const item: NovelImportReportDto['items'][number] = { id: 'p1', kind: 'page', source: 'book.pdf#page=1', status: 'native', excludable: true }
const issue: NovelImportReportDto['issues'][number] = { id: 'i1', code: 'MISSING', message: '缺失正文', itemIds: ['p1'], blocking: true, resolved: false, resolution: 'exclude' }
const report = (over: Partial<NovelImportReportDto> = {}): NovelImportReportDto => ({ manifestRevision: 1, manifestHash: 'a', sourceHash: 'b', reportHash: 'c', partialImport: false, items: [item], issues: [issue], decisions: [], artifacts: [], ...over })

describe('automatic exclusion planning', () => {
  it('uses resolution=exclude even if missing content is labelled native, without mutating input', () => {
    const input = report()
    const before = JSON.stringify(input)
    expect(planImportAutoReview(input).decisions).toEqual([expect.objectContaining({ itemId: 'p1', action: 'exclude' })])
    expect(JSON.stringify(input)).toBe(before)
  })
  it('never turns a review requirement into machine review', () => {
    const result = planImportAutoReview(report({ issues: [{ ...issue, resolution: 'review' }] }))
    expect(result.decisions).toEqual([])
    expect(result.reason).toContain('人工')
  })
  it.each(['IMPORT_NATIVE_COVERAGE', 'IMPORT_NATIVE_INCOMPLETE_CONTENT'])('does not exclude healthy pages in aggregate %s', code => {
    const result = planImportAutoReview(report({
      items: [{ ...item, status: 'failed' }, { ...item, id: 'healthy', source: 'book.pdf#page=2' }],
      issues: [issue, { ...issue, id: 'coverage', code, itemIds: ['p1', 'healthy'] }],
    }))
    expect(result.decisions.map(decision => decision.itemId)).toEqual(['p1'])
  })
  it.each([
    { issues: [{ ...issue, itemIds: [] }] },
    { issues: [{ ...issue, itemIds: ['unknown'] }] },
    { issues: [{ ...issue, resolution: 'none' as const }] },
    { items: [{ ...item, excludable: false }] },
    { items: [{ ...item, source: '' }] },
    { items: [item, { ...item, id: 'healthy' }] },
    { items: [{ ...item, kind: 'block' as const, characters: 200 }] },
  ])('falls back without widening exclusions when unsafe: %j', over => {
    const result = planImportAutoReview(report(over))
    expect(result.decisions).toEqual([])
    expect(result.reason).toBeTruthy()
  })
  it('deduplicates failed items and multiple exclude issues', () => {
    const result = planImportAutoReview(report({ items: [{ ...item, status: 'failed' }], issues: [issue, { ...issue, id: 'i2' }] }))
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0].action).toBe('exclude')
  })
  it('does not repeat saved exclusions or invent decisions for clean reports', () => {
    expect(planImportAutoReview(report({ issues: [] })).decisions).toEqual([])
    const input = report({
      items: [{ ...item, status: 'failed' }], issues: [{ ...issue, resolved: true }],
      decisions: [{ itemId: 'p1', action: 'exclude', reason: '失败', reviewedAt: '', sourceHash: 'b', reportHash: 'c', contentHash: 'd' }],
    })
    expect(planImportAutoReview(input).decisions).toEqual([])
  })
  it('unexplained needs_review stays manual, including coverage-only reports', () => {
    const result = planImportAutoReview(report({ items: [{ ...item, status: 'needs_review' }], issues: [{ ...issue, code: 'IMPORT_NATIVE_COVERAGE' }] }))
    expect(result.decisions).toEqual([])
    expect(result.reason).toContain('人工')
  })
})

describe('human review matches all blocking non-coverage issues', () => {
  const review = { ...issue, resolution: 'review' as const }
  it('permits review with a coverage summary but no physical exclusion requirement', () => {
    expect(canHumanReviewImportItem(item, [review, { ...issue, code: 'IMPORT_NATIVE_COVERAGE' }])).toBe(true)
  })
  it('rejects failed items even if the issue says review', () => {
    expect(canHumanReviewImportItem({ ...item, status: 'failed' }, [review])).toBe(false)
  })
  it('checks every issue including resolved blockers, not just some unresolved review issue', () => {
    expect(canHumanReviewImportItem(item, [review, { ...issue, resolved: true }])).toBe(false)
    expect(canHumanReviewImportItem(item, [review, { ...issue, resolution: 'none' }])).toBe(false)
  })
  it('requires an actual non-coverage blocking review issue', () => {
    expect(canHumanReviewImportItem(item, [])).toBe(false)
    expect(canHumanReviewImportItem(item, [{ ...review, blocking: false }])).toBe(false)
    expect(canHumanReviewImportItem(item, [{ ...review, code: 'IMPORT_NATIVE_INCOMPLETE_CONTENT' }])).toBe(false)
  })
})
