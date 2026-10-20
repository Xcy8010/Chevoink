/** Fixed tool fees are independent of model token prices. Round once to milli-Credits. */
export const WEB_TOOL_BASE_MILLI = 2000
export function webToolChargeMilli(multiplierBps: number): number {
  if (!Number.isSafeInteger(multiplierBps) || multiplierBps < 0 || multiplierBps > 1_000_000) {
    throw new RangeError('Invalid web tool multiplier')
  }
  return Number((BigInt(WEB_TOOL_BASE_MILLI) * BigInt(multiplierBps) + 9999n) / 10000n)
}
