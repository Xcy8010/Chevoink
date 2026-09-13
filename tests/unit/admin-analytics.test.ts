import { describe, expect, it } from 'vitest'
import { analyticsWindow } from '../../api/lib/data/admin-analytics.js'

describe('admin analytics UTC+8 calendar', () => {
  it('uses local midnight rather than UTC midnight', () => {
    const result = analyticsWindow('day', new Date('2026-09-12T17:00:00Z'))
    expect(result.labels).toHaveLength(14)
    expect(result.labels.at(-1)).toBe('2026-09-13')
    expect(result.from.toISOString()).toBe('2026-08-30T16:00:00.000Z')
  })
  it('starts each week on Monday across year boundary', () => {
    const result = analyticsWindow('week', new Date('2026-01-01T00:00:00Z'))
    expect(result.labels).toHaveLength(12)
    expect(result.labels.at(-1)).toBe('2025-12-29')
    expect(result.labels.every(label => new Date(label).getUTCDay() === 1)).toBe(true)
  })
  it('does not overflow short months', () => {
    const result = analyticsWindow('month', new Date('2026-03-31T00:00:00Z'))
    expect(result.labels).toHaveLength(12)
    expect(result.labels.at(-2)).toBe('2026-02-01')
    expect(result.labels.at(-1)).toBe('2026-03-01')
  })
})
