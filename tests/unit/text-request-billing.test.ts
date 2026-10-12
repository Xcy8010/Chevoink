import { describe, expect, it } from 'vitest'
import { isKnownTextRequestBilling } from '../../api/lib/agent/text-request-billing.js'

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
