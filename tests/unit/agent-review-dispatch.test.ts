import { describe, expect, it } from 'vitest'
import { nextMergedReviewReminder, nextReviewDispatch, reviewDispatchKey } from '../../api/lib/agent/review-dispatch.js'
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
  it('does not turn a historical three-check count into exhaustion or limited delivery', () => {
    const state = pending({ continuity: 'stale', continuityExhausted: true, requiredTools: [
      { name: 'continuity_validate', args: { compilationId: 'compile' } },
      { name: 'quality_analyze', args: { compilationId: 'compile' } },
    ] })
    expect(nextReviewDispatch(state, available, new Set())).toMatchObject({ kind: 'tool', tool: { name: 'continuity_validate' } })
    expect(nextReviewDispatch({ ...state, quality: 'complete', requiredTools: state.requiredTools.slice(0, 1) }, available, new Set()).kind).toBe('tool')
    expect(state.ready).toBe(false)
  })
  it('admits one authenticated protocol recovery while retaining historical attempts and blocking the new attempt on resume', () => {
    const state = pending({ continuity: 'incomplete', requiredTools: [{ name: 'continuity_validate', args: { compilationId: 'compile' } }] })
    const old = new Set(['compile:chapter:4:continuity_validate'])
    const key = reviewDispatchKey(state, 'continuity_validate')
    expect(nextReviewDispatch(state, available, old).kind).toBe('blocked')
    expect(nextReviewDispatch(state, available, old, new Set([key]))).toMatchObject({ kind: 'tool', key })
    expect(old.has('compile:chapter:4:continuity_validate')).toBe(true)
    expect(nextReviewDispatch(state, available, new Set([...old, key]), new Set([key])).kind).toBe('blocked')
  })
  it('prompts once for an unspent current-version aesthetic decision, without redispatching a paid check', () => {
    const state = pending({ ready: true, quality: 'complete', qualityCandidateCount: 2, requiredTools: [] })
    const writers = new Set(['chapter_edit_range'])
    const key = nextMergedReviewReminder(state, writers, new Set(), true)!
    expect(key).toBe('compile:chapter:4:merged')
    expect(nextMergedReviewReminder(state, writers, new Set([key]), true)).toBeNull()
    expect(nextMergedReviewReminder(state, new Set(['chapter_bridge_commit']), new Set(), true)).toBe(key)
    expect(nextMergedReviewReminder({ ...state, revision: 5 }, writers, new Set([key]), true)).toBe('compile:chapter:5:merged')
    expect(nextReviewDispatch(state, available, new Set()).kind).toBe('ready')
  })
  it('uses a separate authenticated format-recovery identity without erasing the original attempt', () => {
    const state = pending({ quality: 'incomplete' })
    const original = reviewDispatchKey(state, 'quality_analyze')
    const recovery = 'quality-format-recovery:received-report'
    const keys = new Map([[original, recovery]])
    const attempts = new Set([original])
    expect(nextReviewDispatch(state, available, attempts, new Set(), keys)).toMatchObject({ kind: 'tool', key: recovery })
    expect(attempts).toEqual(new Set([original]))
    expect(nextReviewDispatch(state, available, new Set([original, recovery]), new Set(), keys).kind).toBe('blocked')
    expect(nextReviewDispatch(state, new Set(), attempts, new Set(), keys).kind).toBe('blocked')
    expect(nextReviewDispatch({ ...state, chapterId: 'other' }, available, attempts, new Set(), keys).kind).toBe('blocked')
  })
  it('never prompts for a closed channel, absent writer, missing checks or original waiver', () => {
    const state = pending({ ready: true, quality: 'complete', qualityCandidateCount: 2, requiredTools: [] })
    expect(nextMergedReviewReminder(state, new Set(['chapter_edit_range']), new Set(), false)).toBeNull()
    expect(nextMergedReviewReminder(state, available, new Set(), true)).toBeNull()
    expect(nextMergedReviewReminder(pending(), new Set(['chapter_edit_range']), new Set(), true)).toBeNull()
    expect(nextMergedReviewReminder({ ...state, checksRequired: false }, new Set(['chapter_edit_range']), new Set(), true)).toBeNull()
    expect(nextMergedReviewReminder(null, new Set(['chapter_edit_range']), new Set(), true)).toBeNull()
  })
  it('does not schedule an empty decision but admits a true factual candidate under the same key', () => {
    const state = pending({ ready: true, quality: 'complete', requiredTools: [] })
    const writers = new Set(['chapter_write'])
    expect(nextMergedReviewReminder(state, writers, new Set(), true)).toBeNull()
    expect(nextMergedReviewReminder({ ...state, continuityErrorCount: 1 }, writers, new Set(), true)).toBe('compile:chapter:4:merged')
  })
})
