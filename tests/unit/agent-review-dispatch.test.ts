import { describe, expect, it } from 'vitest'
import { nextReviewDispatch, reviewDispatchKey } from '../../api/lib/agent/review-dispatch.js'
import type { ChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'

function pending(overrides: Partial<ChapterReviewReadiness> = {}): ChapterReviewReadiness {
  return { ready: false, checksRequired: true, compilationId: 'compile', chapterId: 'chapter', revision: 4,
    continuity: 'complete', quality: 'missing', continuityErrorCount: 0, qualityErrorCount: 0, qualityReportId: null,
    requiredTools: [{ name: 'quality_analyze', args: { compilationId: 'compile' } }], ...overrides }
}
describe('server review fallback', () => {
  const available = new Set(['quality_analyze', 'continuity_validate'])
  it('runs a missing current assessment through its original compiler', () => {
    expect(nextReviewDispatch(pending(), available, new Set())).toMatchObject({ kind: 'tool',
      tool: { name: 'quality_analyze', args: { compilationId: 'compile' } } })
  })
  it('never repeats an incomplete or unconfirmed assessment', () => {
    expect(nextReviewDispatch(pending({ quality: 'incomplete' }), available, new Set()).kind).toBe('blocked')
    expect(nextReviewDispatch(pending(), available, new Set([reviewDispatchKey(pending(), 'quality_analyze')])).kind).toBe('blocked')
  })
  it('allows a new version to receive its own assessment without resetting the compiler', () => {
    const old = pending({ revision: 3 })
    expect(nextReviewDispatch(pending(), available, new Set([reviewDispatchKey(old, 'quality_analyze')])).kind).toBe('tool')
  })
  it('cannot add a tool omitted from the original ceiling', () => {
    expect(nextReviewDispatch(pending(), new Set(['continuity_validate']), new Set()).kind).toBe('blocked')
  })
  it('schedules continuity before quality, one assessment per persisted-state read', () => {
    const state = pending({ continuity: 'stale', requiredTools: [
      { name: 'continuity_validate', args: { compilationId: 'compile' } },
      { name: 'quality_analyze', args: { compilationId: 'compile' } },
    ] })
    expect(nextReviewDispatch(state, available, new Set())).toMatchObject({ kind: 'tool', tool: { name: 'continuity_validate' } })
  })
  it('does nothing when no applicable compiler exists or the required checks are ready', () => {
    expect(nextReviewDispatch(null, available, new Set()).kind).toBe('ready')
    expect(nextReviewDispatch(pending({ ready: true, requiredTools: [] }), available, new Set()).kind).toBe('ready')
  })
})
