export function isLegacyAccountMissingEmail({ phone, email, emailVerified }: {
  phone?: string | null
  email?: string | null
  emailVerified?: boolean
}) {
  return Boolean(phone?.trim() && !email?.trim() && !emailVerified)
}
