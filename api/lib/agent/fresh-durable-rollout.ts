import { env } from '../../config/env.js'

/** Admission rollout only, not tool/user authority. Never read on Continue. */
export function isFreshDurableAdmissionEnabled(userId: string): boolean {
  return env.agentDurableRolloutUserIds?.includes('*') === true || env.agentDurableRolloutUserIds?.includes(userId) === true
}
