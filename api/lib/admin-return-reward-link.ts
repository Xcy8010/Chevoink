import { createHash, randomBytes } from 'node:crypto'

// Store only a UUID-sized digest in the existing unique provider attempt key.
// Provider receipts and the admin audit may expose that key, never the claim token.
export function rewardAttemptId(token: string) {
  const hex = createHash('sha256').update('creator-return-v1:').update(token).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function createRewardLink(mode: 'mock' | 'tencent') {
  const token = randomBytes(32).toString('base64url')
  const path = mode === 'tencent' ? 'api/credits/return-reward/open' : 'return-reward'
  return { workspacePath: `${path}#${token}`, attemptId: rewardAttemptId(token) }
}
