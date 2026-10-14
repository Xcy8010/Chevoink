import { describe, expect, it } from 'vitest'
import { isKnownRejectedTextRequestAttempt, isKnownTextRequestBilling, isKnownZeroTextRequestBilling } from '../../api/lib/agent/text-request-billing.js'

const unobserved = { usageSource: 'prepared', billingStatus: 'provider_rejected', requestTokens: null, responseTokens: null, reservedCreditMilli: 0 }
describe('request terminal accounting evidence', () => {
  it.each([
    unobserved,
    { ...unobserved, usageSource: 'unknown', billingStatus: 'not_dispatched' },
    { ...unobserved, usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 3 },
    { ...unobserved, usageSource: 'reported', billingStatus: 'exempt', requestTokens: 12, responseTokens: 0 },
  ])('accepts only exact server terminal accounting %#', usage => expect(isKnownTextRequestBilling(usage)).toBe(true))
  it.each([
    { reservedCreditMilli: 1 }, { requestTokens: 12 }, { responseTokens: 0 }, { usageSource: 'unknown' },
    { usageSource: 'estimated' }, { billingStatus: 'pending_usage' }, { billingStatus: 'prepared' }, { billingStatus: null },
    { usageSource: 'prepared', billingStatus: 'not_dispatched' },
    { usageSource: 'reported', billingStatus: 'pending_settlement', requestTokens: 12, responseTokens: 3 },
    { usageSource: 'reported', billingStatus: 'settled', requestTokens: 12 },
    { usageSource: 'reported', billingStatus: 'settled', requestTokens: -1, responseTokens: 3 },
    { usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 0.5 },
  ])('keeps partial/unknown/reserved or inconsistent terminal accounting unknown %#', mismatch => {
    expect(isKnownTextRequestBilling({ ...unobserved, ...mismatch })).toBe(false)
  })
})

describe('zero-fee rejected attempts versus semantic responses', () => {
  const rejected = { ...unobserved, creditChargeMilli: 0, billingEvidence: { responseObserved: false },
    promptCacheHitTokens: null, promptCacheMissTokens: null }
  const reportedZero = { ...rejected, usageSource: 'reported', billingStatus: 'settled', requestTokens: 0, responseTokens: 0 }
  it('keeps an old or successful zero-token response as a semantic request without an HTTP rejection witness', () => {
    expect(isKnownZeroTextRequestBilling(reportedZero)).toBe(true)
    expect(isKnownRejectedTextRequestAttempt(reportedZero)).toBe(false)
    expect(isKnownRejectedTextRequestAttempt({ ...reportedZero, billingEvidence: { responseObserved: true } })).toBe(false)
  })
  it.each([429, 500, 502, 503, 504])('accepts a fresh zero-token HTTP%s rejection without inventing token observations', status => {
    expect(isKnownRejectedTextRequestAttempt({ ...reportedZero, billingEvidence: { responseObserved: false, providerRejection: { status } } })).toBe(true)
    expect(isKnownRejectedTextRequestAttempt(rejected)).toBe(true)
    expect(rejected.requestTokens).toBeNull()
    expect(rejected.responseTokens).toBeNull()
  })
  it.each([
    { reservedCreditMilli: 1 }, { creditChargeMilli: 1 }, { requestTokens: 1 }, { responseTokens: 0 },
    { promptCacheHitTokens: 1 }, { promptCacheMissTokens: 1 }, { usageSource: 'unknown' }, { billingStatus: 'pending_usage' },
    { billingStatus: 'pending_settlement' }, { billingStatus: 'not_dispatched', usageSource: 'unknown' },
    { billingEvidence: { responseObserved: true } },
  ])('does not discard an unknown/charged/reserved/output-bearing request as a rejected attempt %#', mismatch => {
    expect(isKnownRejectedTextRequestAttempt({ ...rejected, ...mismatch })).toBe(false)
  })
  it.each([{}, { status: '429' }, { status: 200 }, { status: null }, { status: 429, extra: 'irrelevant' }])('requires an actual numeric failed HTTP witness %j', witness => {
    expect(isKnownRejectedTextRequestAttempt({ ...reportedZero, billingEvidence: { providerRejection: witness } })).toBe('status' in witness && witness.status === 429)
  })
})
