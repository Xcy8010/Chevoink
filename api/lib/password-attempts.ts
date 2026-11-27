const passwordAttemptBuckets = new Map<string, number>()
let passwordWindowEnd = 0
export function consumePasswordAttempt(ip: string) {
  const now = Date.now()
  if (now >= passwordWindowEnd) {
    passwordAttemptBuckets.clear()
    passwordWindowEnd = now + 5 * 60_000
  }
  const count = passwordAttemptBuckets.get(ip) ?? 0
  if (count >= 20) return false
  passwordAttemptBuckets.set(ip, count + 1)
  return true
}
