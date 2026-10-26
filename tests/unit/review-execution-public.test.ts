import { describe, expect, it } from 'vitest'
import { publicReviewExecution } from '../../shared/review-lifecycle.js'

describe('public review execution receipts', () => {
  it.each(['quality_analyze', 'continuity_validate', 'chapter_bridge_commit'])('preserves real execution, report and failure data for %s', toolName => {
    for (const status of ['success', 'failed'] as const) {
      const stored = { type: 'tool-call', toolName, callId: 'owned', status, reviewOutcome: 'decision_required' as const,
        summary: 'Original report', display: { reportId: 'r4', findings: 4 } }
      const original = structuredClone(stored), visible = publicReviewExecution(stored)
      expect(visible).toEqual({ type: 'tool-call', toolName, callId: 'owned', status,
        summary: 'Original report', display: { reportId: 'r4', findings: 4 } })
      expect(stored).toEqual(original)
      const event = { type: 'tool.result', seq: 12, toolName, callId: 'owned', ok: status === 'success',
        reviewOutcome: 'provider_unresolved' as const, failureCode: 'AI_PROVIDER_TRANSPORT' }
      expect(publicReviewExecution(event)).toEqual({ type: 'tool.result', seq: 12, toolName, callId: 'owned',
        ok: status === 'success', failureCode: 'AI_PROVIDER_TRANSPORT' })
      expect(event.reviewOutcome).toBe('provider_unresolved')
    }
  })
  it('keeps internal report judgments and unrelated event metadata intact', () => {
    const internal = { type: 'review.record', toolName: 'quality_analyze', reviewOutcome: 'decision_required' as const }
    expect(publicReviewExecution(internal)).toBe(internal)
    const other = { type: 'tool.result', toolName: 'unrelated', reviewOutcome: 'stale' as const }
    expect(publicReviewExecution(other)).toBe(other)
  })
})
