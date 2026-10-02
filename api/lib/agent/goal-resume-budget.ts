/** A click on Continue grants one more bounded execution window, not a usage reset.
 * Automatic supervision never calls this; only an authenticated author action does. */
export function goalResumeBudget(
  budget: { tokenLimit: bigint; activeTimeLimitMs: bigint; platformTokenCap: bigint; platformTimeCapMs: bigint;
    tokensUsed: bigint; tokensReserved: bigint; activeTimeMs: bigint },
  limited: boolean,
  allowance: { tokens: bigint; timeMs: bigint },
  change?: { tokenLimit?: number; activeTimeLimitMs?: number },
) {
  const max = (a: bigint, b: bigint) => a > b ? a : b
  const renew = !change && (limited || budget.tokensUsed + budget.tokensReserved >= budget.tokenLimit
    || budget.activeTimeMs >= budget.activeTimeLimitMs)
  const tokenLimit = renew ? max(budget.tokenLimit, budget.tokensUsed + budget.tokensReserved + allowance.tokens)
    : BigInt(change?.tokenLimit ?? budget.tokenLimit)
  const activeTimeLimitMs = renew ? max(budget.activeTimeLimitMs, budget.activeTimeMs + allowance.timeMs)
    : BigInt(change?.activeTimeLimitMs ?? budget.activeTimeLimitMs)
  return { tokenLimit, activeTimeLimitMs,
    platformTokenCap: renew ? max(budget.platformTokenCap, tokenLimit) : budget.platformTokenCap,
    platformTimeCapMs: renew ? max(budget.platformTimeCapMs, activeTimeLimitMs) : budget.platformTimeCapMs }
}
