import { expect, it } from 'vitest'
import { goalResumeBudget } from '../../api/lib/agent/goal-resume-budget.js'

const budget = { tokenLimit: 1000n, platformTokenCap: 1000n, tokensUsed: 1000n, tokensReserved: 0n,
  activeTimeMs: 60_000n, activeTimeLimitMs: 60_000n, platformTimeCapMs: 60_000n }
const allowance = { tokens: 1000n, timeMs: 60_000n }

it('continues with one bounded allowance without resetting cumulative usage', () => {
  expect(goalResumeBudget(budget, true, allowance)).toEqual({
    tokenLimit: 2000n, platformTokenCap: 2000n, activeTimeLimitMs: 120_000n, platformTimeCapMs: 120_000n,
  })
  expect(budget.tokensUsed).toBe(1000n)
  expect(budget.activeTimeMs).toBe(60_000n)
})

it('renews after reservation pressure even when usage is below the old ceiling', () => {
  expect(goalResumeBudget({ ...budget, tokensUsed: 950n }, true, allowance).tokenLimit).toBe(1950n)
})

it('does not enlarge a paused or credits-limited goal that still has budget', () => {
  expect(goalResumeBudget({ ...budget, tokensUsed: 100n, activeTimeMs: 1000n }, false, allowance)).toEqual({
    tokenLimit: 1000n, platformTokenCap: 1000n, activeTimeLimitMs: 60_000n, platformTimeCapMs: 60_000n,
  })
})

it('leaves explicit limits subject to validation instead of granting a new cap', () => {
  const next = goalResumeBudget(budget, true, allowance, { tokenLimit: 9999 })
  expect(next.tokenLimit).toBe(9999n)
  expect(next.platformTokenCap).toBe(1000n)
})
