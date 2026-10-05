/** Storage compatibility only. Continue never grants an allowance or resets usage.
 * Explicit changes still require authenticated immutable provenance in goal-service. */
export function goalResumeBudget(
  budget: { tokenLimit: bigint; activeTimeLimitMs: bigint; platformTokenCap: bigint; platformTimeCapMs: bigint;
    tokensUsed: bigint; tokensReserved: bigint; activeTimeMs: bigint },
  limited: boolean,
  allowance: { tokens: bigint; timeMs: bigint },
  change?: { tokenLimit?: number; activeTimeLimitMs?: number },
) {
  void limited
  void allowance
  return { tokenLimit: BigInt(change?.tokenLimit ?? budget.tokenLimit), activeTimeLimitMs: BigInt(change?.activeTimeLimitMs ?? budget.activeTimeLimitMs),
    platformTokenCap: budget.platformTokenCap, platformTimeCapMs: budget.platformTimeCapMs }
}
