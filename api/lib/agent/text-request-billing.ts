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
