import { describe, expect, it } from 'vitest'
import type { AiUsageLog } from '@prisma/client'
import { isKnownUndispatchedDeletionUsage } from '../../api/lib/agent/runtime-novel-delete-scope.js'
import { FALLBACK_USAGE_POLICY } from '../../api/lib/billing/reservation-policy.js'

const original = () => ({ providerType: 'text' as const, modelTier: 'speed', multiplierBps: 10000, billingStatus: 'not_dispatched', usageSource: 'unknown',
  reservedCreditMilli: 0, reservationExpiresAt: null, creditChargeMilli: 0, requestTokens: null, responseTokens: null, promptCacheHitTokens: null,
  promptCacheMissTokens: null, durationMs: 0, billingSnapshot: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 },
  billingEvidence: { policy: FALLBACK_USAGE_POLICY, inputEstimate: 100, outputEstimate: 0, responseObserved: false } })

describe('known before-HTTP legacy cancellation is distinct from unknown billing', () => {
  it('accepts the actual original frozen-price prepare/cancel shape without requiring a fabricated debit', () => {
    expect(isKnownUndispatchedDeletionUsage(original())).toBe(true)
    expect(isKnownUndispatchedDeletionUsage({ ...original(), modelTier: 'custom', billingSnapshot: { version: 'byok-exempt' } })).toBe(true)
  })
  it.each(['unknown', 'pending_usage', 'pending_authorization', 'prepared', 'provider_rejected', 'observed'])('does not infer no dispatch from %s', billingStatus => {
    expect(isKnownUndispatchedDeletionUsage({ ...original(), billingStatus })).toBe(false)
  })
  it.each(['usageSource', 'reservedCreditMilli', 'reservationExpiresAt', 'creditChargeMilli', 'requestTokens', 'responseTokens', 'promptCacheHitTokens',
    'promptCacheMissTokens', 'durationMs', 'billingSnapshot', 'billingEvidence', 'multiplierBps', 'modelTier', 'providerType'] as const)('rejects inconsistent %s evidence', field => {
      const log = { ...original() } as Parameters<typeof isKnownUndispatchedDeletionUsage>[0]
      const mutations: Partial<AiUsageLog> = { usageSource: 'reported', reservedCreditMilli: 1, reservationExpiresAt: new Date(), creditChargeMilli: 1,
        requestTokens: 1, responseTokens: 1, promptCacheHitTokens: 0, promptCacheMissTokens: 1, durationMs: 1, billingSnapshot: null,
        billingEvidence: { policy: FALLBACK_USAGE_POLICY, inputEstimate: 100, outputEstimate: 1, responseObserved: true }, multiplierBps: 20000, modelTier: 'standard', providerType: 'image' }
      Object.assign(log, { [field]: mutations[field] })
      expect(isKnownUndispatchedDeletionUsage(log)).toBe(false)
    })
})
