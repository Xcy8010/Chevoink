import { z } from 'zod'
import { calculateV1ChargeMilli, calculateV2UserChargeMilli } from './pricing.js'
import type { TokenPrice } from './token-price.js'

export const RESERVATION_TTL_MS = 30 * 60_000
export const FALLBACK_USAGE_POLICY = 'observed-output-estimate-2026-09-09'
export const fallbackUsageEvidenceSchema = z.object({
  policy: z.literal(FALLBACK_USAGE_POLICY),
  inputEstimate: z.number().int().min(0).max(2147483647),
  outputEstimate: z.number().int().min(0).max(2147483647),
  responseObserved: z.boolean(),
})

export function priceTokenEvidence(price: TokenPrice, input: number, output: number, hits: number | null = null) {
  return price.version === 'credits-v2-itemized'
    ? calculateV2UserChargeMilli(input, output, hits, price.rates, price.v1CeilingBps, price.activity)
    : calculateV1ChargeMilli(input, output, price.multiplierBps)
}

/** A limited deposit, not an invoice or a promise that output costs no more.
 * Existing completed-output partial-charge protection remains in effect. */
export function tokenReservationMilli(price: TokenPrice, input: number, maxOutput: number, balance: number, available: number) {
  const quote = priceTokenEvidence(price, input, maxOutput, 0)
  return Math.max(0, Math.min(quote, 25000, Math.ceil(balance / 4), available))
}
