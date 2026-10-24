/** Review control is independent of provider/storage adapters. These states
 * describe evidence; none grants a write, a new budget or semantic progress. */
export type ReviewOutcome = 'complete' | 'decision_required' | 'evidence_repair_required' | 'provider_unresolved' | 'provider_failed' | 'stale'
export const REVIEW_OUTCOMES = ['complete', 'decision_required', 'evidence_repair_required', 'provider_unresolved', 'provider_failed', 'stale'] as const
export type ReviewAction = 'reuse' | 'decision' | 'repair' | 'dispatch' | 'pause'
export type ReviewTransition = {
  ownerCurrent: boolean; cancelled: boolean; contextCurrent: boolean;
  reserved: boolean; rawPresent: boolean; providerComplete: boolean; billingKnown: boolean;
  providerFailed: boolean; complete: boolean; sameFailedSubject: boolean;
  repairAvailable: boolean; repairConsumed: boolean; newRequestAllowed: boolean;
}

export function reviewLifecycleOutcome(state: ReviewTransition): ReviewOutcome | null {
  if (!state.ownerCurrent || state.cancelled || !state.contextCurrent) return 'stale'
  if (state.reserved && (!state.billingKnown || !state.providerComplete)) return 'provider_unresolved'
  if (state.providerFailed) return 'provider_failed'
  if (state.reserved && !state.rawPresent) return 'provider_unresolved'
  if (state.sameFailedSubject) return 'decision_required'
  if (state.complete && state.rawPresent && state.billingKnown && state.providerComplete) return 'complete'
  if (state.repairAvailable && !state.repairConsumed && state.rawPresent && state.billingKnown && state.providerComplete) return 'evidence_repair_required'
  return state.reserved ? 'evidence_repair_required' : null
}

/** A projected outcome grants no new repair slot or request admission. */
export function projectedReviewAction(outcome: ReviewOutcome): ReviewAction {
  return outcome === 'complete' ? 'reuse' : outcome === 'decision_required' ? 'decision' : 'pause'
}

export function nextReviewAction(state: ReviewTransition): { outcome: ReviewOutcome | null; action: ReviewAction } {
  const outcome = reviewLifecycleOutcome(state)
  if (outcome === 'stale' || outcome === 'provider_unresolved' || outcome === 'provider_failed') return { outcome, action: 'pause' }
  if (outcome === 'decision_required') return { outcome, action: 'decision' }
  if (outcome === 'complete') return { outcome, action: 'reuse' }
  if (state.repairAvailable && !state.repairConsumed && state.reserved) return { outcome, action: 'repair' }
  return { outcome, action: !state.reserved && state.newRequestAllowed ? 'dispatch' : 'pause' }
}

/** Storage adapters call this only after their existing receipt/owner checks.
 * A saved failed report remains a protocol failure, never a passed advisory. */
export function observedReviewOutcome(input: { complete: boolean; rawPresent: boolean; providerComplete: boolean; billingKnown: boolean;
  cancelled?: boolean; stale?: boolean; providerFailed?: boolean; decisionRequired?: boolean; repairAvailable?: boolean; repairConsumed?: boolean }) {
  return nextReviewAction({ ownerCurrent: true, cancelled: input.cancelled === true, contextCurrent: !input.stale,
    reserved: true, rawPresent: input.rawPresent, providerComplete: input.providerComplete, billingKnown: input.billingKnown,
    providerFailed: input.providerFailed === true, complete: input.complete, sameFailedSubject: input.decisionRequired === true,
    repairAvailable: input.repairAvailable === true, repairConsumed: input.repairConsumed === true, newRequestAllowed: false })
}
