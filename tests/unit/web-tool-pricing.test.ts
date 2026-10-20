import { describe, expect, it } from 'vitest'
import { webToolChargeMilli } from '../../shared/web-tool-pricing.js'

describe('fixed Search / Fetch milli-Credit price', () => {
  it.each([[0, 0], [1, 1], [5, 1], [6, 2], [10000, 2000], [12500, 2500], [20000, 4000], [1000000, 200000]])(
    'freezes %i basis points as %i milli, rounding once', (bps, expected) => expect(webToolChargeMilli(bps)).toBe(expected))
  it.each([-1, 0.1, NaN, Infinity, 1000001, Number.MAX_SAFE_INTEGER])('rejects invalid multiplier %s', value => {
    expect(() => webToolChargeMilli(value)).toThrow('Invalid web tool multiplier')
  })
})
