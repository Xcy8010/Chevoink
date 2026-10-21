import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { continuitySourceSegments, locateUniqueContinuityQuote, resolveContinuitySources,
  type ContinuitySourceRelocation } from '../../api/lib/agent/continuity-review-context.js'

const segments = (current: string) => continuitySourceSegments({ previous: null, current })
const quote = '唯一逐字引文'

describe('exact continuity quote address', () => {
  it('locates an exact quote ending at UTF16 offset 300 without changing its bytes', () => {
    const body = '甲'.repeat(294) + quote + '乙'.repeat(300)
    expect(body.slice(294, 300)).toBe(quote)
    expect(locateUniqueContinuityQuote(quote, [body], segments(body))).toEqual({ valid: true, segmentId: 'c0',
      quoteHash: createHash('sha256').update(quote).digest('hex') })
  })

  it.each(['🔒原句', '原文\n含"引号"和\\斜线', '甲乙\r\n丙丁'])('keeps exact UTF16, escapes and line endings: %j', exact => {
    const body = '甲'.repeat(300) + exact
    expect(locateUniqueContinuityQuote(exact, [body], segments(body))).toMatchObject({ valid: true, segmentId: 'c1' })
    expect(locateUniqueContinuityQuote(exact + '不存在', [body], segments(body))).toEqual({ valid: false, reason: 'quote_missing' })
  })

  it('rejects a unique exact quote spanning two legal chunks', () => {
    const body = '甲'.repeat(294) + 'ABCDEFGHIJKL' + '乙'.repeat(300)
    expect(body.slice(294, 306)).toBe('ABCDEFGHIJKL')
    expect(locateUniqueContinuityQuote('ABCDEFGHIJKL', [body], segments(body)))
      .toEqual({ valid: false, reason: 'quote_not_in_single_segment' })
  })

  it.each([
    { body: quote + quote, target: quote },
    { body: quote.padEnd(300, '甲') + quote, target: quote },
    { body: 'aaaa', target: 'aaa' },
    { body: quote.padEnd(294, '甲') + quote, target: quote },
    { body: quote.padEnd(298, '甲') + quote, target: quote },
  ])('counts all whole-source occurrences, including overlaps and boundary crossings: $body.length', ({ body, target }) => {
    expect(locateUniqueContinuityQuote(target, [body], segments(body))).toEqual({ valid: false, reason: 'quote_ambiguous' })
  })

  it('does not join unavailable gaps or disregard a duplicate in a separate legal source block', () => {
    expect(locateUniqueContinuityQuote('左右', ['左', '右'], [{ segmentId: 'p1', quote: '左' }, { segmentId: 'p3', quote: '右' }]))
      .toEqual({ valid: false, reason: 'quote_missing' })
    expect(locateUniqueContinuityQuote(quote, [quote, quote], [{ segmentId: 'p1', quote }, { segmentId: 'p3', quote }]))
      .toEqual({ valid: false, reason: 'quote_ambiguous' })
  })
})

describe('frozen continuity parser3/4 source contract', () => {
  const bodies = { previous: '仅前章存在的引文', current: '甲'.repeat(300) + quote }
  it.each(['c0', 'c999'])('preserves parser4 relocation and stripped refs for original address %s', segmentId => {
    const item = { sourceEvidence: [{ source: 'current', segmentId, quote }] }
    const relocations: ContinuitySourceRelocation[] = []
    expect(resolveContinuitySources(item, bodies, 4, relocations, 7))
      .toEqual({ sourceEvidence: [{ source: 'current', quote }] })
    expect(relocations).toEqual([{ findingIndex: 7, referenceIndex: 0, source: 'current', originalSegmentId: segmentId,
      actualSegmentId: 'c1', quoteHash: createHash('sha256').update(quote).digest('hex') }])
    expect(resolveContinuitySources(item, bodies, 3)).toEqual({ sourceEvidence: [{ source: 'current', quote: '' }] })
  })

  it('preserves valid quote omission and rejects wrong source prefixes without relocation', () => {
    expect(resolveContinuitySources({ sourceEvidence: [{ source: 'current', segmentId: 'c1' }] }, bodies, 4))
      .toEqual({ sourceEvidence: [{ source: 'current', quote }] })
    const relocations: ContinuitySourceRelocation[] = []
    expect(resolveContinuitySources({ sourceEvidence: [{ source: 'current', segmentId: 'p0', quote }] }, bodies, 4, relocations))
      .toEqual({ sourceEvidence: [{ source: 'current', quote: '' }] })
    expect(relocations).toEqual([])
  })
})
