import type { User } from '../../../shared/contracts'
import { isLegacyAccountMissingEmail } from '../../../shared/account-contact'

export function requiresLegacyEmailBinding(user: User | null | undefined) {
  return Boolean(user?.emailAuthEnabled && isLegacyAccountMissingEmail(user))
}
