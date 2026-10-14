/** Accounting certainty is independent of response/report validity. These
 * zero-reservation terminal states are written only by server request producers;
 * a generic provider error or a partial/unknown token observation is no proof. */
export function isKnownTextRequestBilling(usage: {
  usageSource: string | null; billingStatus: string | null; requestTokens: number | null;
  responseTokens: number | null; reservedCreditMilli: number;
}): boolean {
  if (usage.reservedCreditMilli !== 0) return false
  if (usage.usageSource === 'reported' && ['settled', 'exempt'].includes(usage.billingStatus ?? '')) {
    return usage.requestTokens !== null && usage.responseTokens !== null
      && Number.isSafeInteger(usage.requestTokens) && Number.isSafeInteger(usage.responseTokens)
      && usage.requestTokens >= 0 && usage.responseTokens >= 0
  }
  return usage.requestTokens === null && usage.responseTokens === null
    && (usage.billingStatus === 'provider_rejected' && usage.usageSource === 'prepared'
      || usage.billingStatus === 'not_dispatched' && usage.usageSource === 'unknown')
}

type ZeroBilling = Parameters<typeof isKnownTextRequestBilling>[0] & {
  creditChargeMilli: number; promptCacheHitTokens?: number | null; promptCacheMissTokens?: number | null;
  billingEvidence?: unknown;
}
/** Actual zero accounting only. Empty/partial usage and pending settlement are
 * never a zero-spend attempt, even when their current charge happens to be 0. */
export function isKnownZeroTextRequestBilling(usage: ZeroBilling): boolean {
  return usage.creditChargeMilli === 0 && isKnownTextRequestBilling(usage)
    && (usage.promptCacheHitTokens == null || usage.promptCacheHitTokens === 0)
    && (usage.promptCacheMissTokens == null || usage.promptCacheMissTokens === 0)
    && (usage.billingStatus === 'provider_rejected'
      || usage.usageSource === 'reported' && usage.requestTokens === 0 && usage.responseTokens === 0
        && ['settled', 'exempt'].includes(usage.billingStatus ?? ''))
}

/** A rejected HTTP attempt is not a semantic review stage. Reported 0/0 needs
 * its server HTTP witness; a successful empty 0/0 response remains semantic. */
export function isKnownRejectedTextRequestAttempt(usage: ZeroBilling): boolean {
  if (!isKnownZeroTextRequestBilling(usage)) return false
  const evidence = usage.billingEvidence && typeof usage.billingEvidence === 'object' && !Array.isArray(usage.billingEvidence)
    ? usage.billingEvidence as Record<string, unknown> : {}
  if (evidence.responseObserved === true) return false
  if (usage.billingStatus === 'provider_rejected') return true
  const witness = evidence.providerRejection
  return !!witness && typeof witness === 'object' && !Array.isArray(witness)
    && typeof (witness as Record<string, unknown>).status === 'number'
    && [429, 500, 502, 503, 504].includes((witness as { status: number }).status)
}
