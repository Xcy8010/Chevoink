import { describe, expect, it } from 'vitest'
import { recoverLegacyRunUsage, recoverRunElapsedMs, savedRunUsageSchema } from '../../api/lib/agent/checkpoint.js'
import { continuityRepairRounds } from '../../api/lib/agent/story-compiler.js'

describe('legacy resume budget receipts', () => {
  it('excludes paused gaps but never resets a missing-terminal execution interval', () => {
    expect(recoverRunElapsedMs(0, 10000, [
      { type: 'run.started', at: 0 }, { type: 'run.started', at: 1000 },
      { type: 'run.paused', at: 2000 }, { type: 'run.started', at: 9000 },
      { type: 'run.finished', at: 9500 },
    ])).toBe(2500)
    expect(recoverRunElapsedMs(0, 10000, [])).toBe(10000)
    expect(recoverRunElapsedMs(0, 10000, [{ type: 'run.paused', at: 2000 }])).toBe(2000)
    expect(recoverRunElapsedMs(0, 10000, [{ type: 'run.started', at: 11000 }])).toBeNull()
    expect(recoverRunElapsedMs(0, 10000, [{ type: 'run.paused', at: 2000 }, { type: 'run.started', at: 1000 }])).toBeNull()
    // A checkpoint cannot move the original clock forward after slow paid
    // review/application while retaining its earlier start event.
    const originalTiming = [{ type: 'run.started', at: 1000 }, { type: 'run.paused', at: 4000 }]
    expect(recoverRunElapsedMs(3000, 4000, originalTiming)).toBeNull()
    expect(recoverRunElapsedMs(500, 4000, originalTiming)).toBe(3500)
  })
  it('recovers all known consumption instead of granting a fresh budget', () => {
    expect(recoverLegacyRunUsage(2, [
      { turn: 1, requestTokens: 100, responseTokens: 20 },
      { turn: 2, requestTokens: 200, responseTokens: 30 },
      { turn: null, requestTokens: 10, responseTokens: 5 },
    ])).toEqual({ promptTokens: 310, completionTokens: 55, totalTokens: 365 })
  })
  it('refuses missing turns, unknown receipts and malformed saved budgets', () => {
    expect(recoverLegacyRunUsage(2, [{ turn: 2, requestTokens: 10, responseTokens: 2 }])).toBeNull()
    expect(recoverLegacyRunUsage(1, [{ turn: 1, requestTokens: null, responseTokens: 2 }])).toBeNull()
    expect(savedRunUsageSchema.safeParse({ promptTokens: 10, completionTokens: 2, totalTokens: 0 }).success).toBe(false)
  })
  it('counts retries as consumption without requiring unique turn receipts', () => {
    expect(recoverLegacyRunUsage(1, [
      { turn: 1, requestTokens: 10, responseTokens: 2 },
      { turn: 1, requestTokens: 10, responseTokens: 3 },
    ])?.totalTokens).toBe(25)
  })
})

describe('continuity repair budget survives revision changes', () => {
  it('does not reset the cap when a new revision is checked', () => {
    expect(continuityRepairRounds({ autoRepairRounds: 2, checkedRevision: 7 })).toBe(2)
    expect(continuityRepairRounds({ autoRepairRounds: 2, checkedRevision: 8 })).toBe(2)
    expect(continuityRepairRounds(null)).toBe(0)
  })
})
