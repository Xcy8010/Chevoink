import { describe, expect, it, vi } from 'vitest'
import { readReviewTransitionReport } from '../../api/lib/agent/activity-report.js'
import type { RuntimeTx } from '../../api/lib/agent/runtime-common.js'

const call = (name: string, args: object) => ({ name, id: name + JSON.stringify(args), arguments: JSON.stringify(args) })
const batch = call('chapter_review_batch', { chapterIds: ['a', 'b'], reviewType: 'quality' })
const solo = (chapterId: string) => call('quality_analyze', { chapterId })
const turn = (...toolCalls: ReturnType<typeof call>[]) => ({ role: 'assistant', toolCalls })

describe('review method changes', () => {
  const setup = (receipt: object) => {
    const findFirst = vi.fn(async () => ({ payload: receipt }))
    const db = { agentRunEvent: { findFirst } } as unknown as RuntimeTx
    return { findFirst, db }
  }
  it('announces only the uncovered chapter and only once for its batch', async () => {
    const { db, findFirst } = setup({ ok: true, display: { kind: 'reviewBatch', chapters: [
      { chapterId: 'a', status: 'complete' }, { chapterId: 'b', status: 'incomplete' },
    ] } })
    const history = [turn(batch), turn(solo('unrelated'))]
    expect(await readReviewTransitionReport(db, 'run', history, [solo('a')])).toBe('')
    expect(await readReviewTransitionReport(db, 'run', history, [solo('b')])).toContain('按章核对')
    expect(await readReviewTransitionReport(db, 'run', [...history, turn(solo('b'))], [solo('b')])).toBe('')
    expect(findFirst).toHaveBeenCalledTimes(2)
  })
  it('does not announce a success, an unrelated type or a new paid check for an unresolved request', async () => {
    const { db, findFirst } = setup({ ok: false, failureCode: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(await readReviewTransitionReport(db, 'run', [turn(batch)], [call('chapter_read', { chapterId: 'a' })])).toBe('')
    expect(await readReviewTransitionReport(db, 'run', [turn(batch)], [call('continuity_validate', { chapterId: 'a' })])).toBe('')
    expect(findFirst).not.toHaveBeenCalled()
    expect(await readReviewTransitionReport(db, 'run', [turn(batch)], [solo('a')])).toBe('批量复查的原请求仍待核对。')
    expect(await readReviewTransitionReport(setup({ ok: true }).db, 'run', [turn(batch)], [solo('a')])).toBe('')
  })
})
