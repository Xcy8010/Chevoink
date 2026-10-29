import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
import { reviewContinuity } from '../../api/lib/agent/continuity-review.js'
import { currentContinuityRunnerFixture } from '../helpers/current-continuity-runner-fixture.js'

afterEach(() => vi.restoreAllMocks())

describe('current continuity request admission without a historical phase counter', () => {
  it('returns the real format failure and preserves the historical counter and paid replies', async () => {
    const f = currentContinuityRunnerFixture(), original = { checkRounds: 9, autoRepairRounds: 1 }
    f.compilation.validation = structuredClone(original)
    const result = await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(() => 'not JSON') })
    expect(result).toMatchObject({ outcome: 'failed', reviewCompleted: false, failureCode: 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(f.requests.map(row => row.action)).toEqual(['agent3ContinuityCritic', 'agent3ContinuityFormatRecovery'])
    expect(f.compilation.validation).toMatchObject(original)
    expect(f.report().rawResponses).toEqual(['not JSON', 'not JSON'])
    expect(f.fees).toHaveLength(2)
  })
  it.each(['denied', 'blocked', 'cached'] as const)('%s leaves original counters and provider history untouched', async kind => {
    const f = currentContinuityRunnerFixture(), original = { checkRounds: 3, autoRepairRounds: 1 }
    f.compilation.validation = structuredClone(original)
    if (kind === 'cached') await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(() => '{"findings":[]}') })
    if (kind === 'blocked') f.fees.push({ id: 'unknown', usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 7 })
    const beforeFees = structuredClone(f.fees), beforeRequests = f.requests.length
    const input = reviewContinuity(kind === 'denied' ? { ...f.ctx, runId: 'another-task' } : f.ctx,
      { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(() => '{"findings":[]}') })
    if (kind === 'cached') expect(await input).toMatchObject({ reviewCompleted: true })
    else await expect(input).rejects.toMatchObject({ code: kind === 'denied' ? 'COMPILATION_NOT_FOUND' : 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(f.requests).toHaveLength(beforeRequests)
    expect(f.fees).toEqual(beforeFees)
    expect(f.compilation.validation).toMatchObject(original)
  })
  it('keeps a known failed physical attempt and can check the same body after it ends', async () => {
    const f = currentContinuityRunnerFixture()
    f.compilation.validation = { checkRounds: 3, autoRepairRounds: 1 }
    await expect(reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false,
      dispatch: f.dispatch(() => { throw new DataAccessError(502, 'AI_PROVIDER_ERROR', '供应商明确拒绝该请求') }) })).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' })
    const originalFees = structuredClone(f.fees)
    expect(f.report()).toMatchObject({ complete: false, billingKnown: true })
    expect(await reviewContinuity({ ...f.ctx, callId: 'next-call' }, { compilationId: 'compilation' }, { allowRepair: false,
      dispatch: f.dispatch(() => '{"findings":[]}') })).toMatchObject({ reviewCompleted: true })
    expect(f.fees.slice(0, originalFees.length)).toEqual(originalFees)
    expect(f.requests).toHaveLength(2)
    expect(f.compilation.validation).toMatchObject({ checkRounds: 3, autoRepairRounds: 1 })
  })
  it('does not register a request when the actual compilation is missing', async () => {
    const f = currentContinuityRunnerFixture()
    await expect(reviewContinuity(f.ctx, { compilationId: 'missing' }, { allowRepair: false,
      dispatch: f.dispatch(() => '{"findings":[]}') })).rejects.toMatchObject({ code: 'COMPILATION_NOT_FOUND' })
    expect(f.artifacts.size).toBe(0); expect(f.requests).toEqual([]); expect(f.fees).toEqual([])
  })
})
