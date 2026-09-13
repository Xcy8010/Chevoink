import { describe, expect, it } from 'vitest'
import { analyticsWindow } from '../../api/lib/data/admin-analytics.js'

describe('admin analytics UTC+8 calendar', () => {
  it('uses local midnight rather than UTC midnight', () => {
    const result = analyticsWindow('day', new Date('2026-09-12T17:00:00Z'))
    expect(result.labels).toEqual(['2026-09-13 00:00', '2026-09-13 01:00'])
    expect(result.from.toISOString()).toBe('2026-09-12T16:00:00.000Z')
  })
  it('starts each week on Monday across year boundary', () => {
    const result = analyticsWindow('week', new Date('2026-01-01T00:00:00Z'))
    expect(result.labels).toEqual(['2025-12-29','2025-12-30','2025-12-31','2026-01-01'])
  })
  it('does not overflow short months', () => {
    const result = analyticsWindow('month', new Date('2026-03-31T00:00:00Z'))
    expect(result.labels).toHaveLength(31)
    expect(result.labels[0]).toBe('2026-03-01')
    expect(result.labels.at(-1)).toBe('2026-03-31')
  })
})
