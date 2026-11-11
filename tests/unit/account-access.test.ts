import { describe, expect, it } from 'vitest'
import { accountAccessError, isStudioAccountRoute } from '../../api/lib/account-access.js'
import { requiresStudioPhoneVerification } from '../../api/lib/account-email-auth-scope.js'
import { toUser } from '../../api/lib/data/internal.js'
import { env } from '../../api/config/env.js'

describe('account access', () => {
  it.each([
    ['/agent/sessions', 'GET'], ['/agent/runs', 'POST'], ['/changesets/id', 'GET'],
    ['/novels/id/studio', 'GET'], ['/novels/id/imports', 'GET'], ['/novels/id/chapters/id', 'GET'],
    ['/novels/id/volumes', 'GET'], ['/novels/id/structure', 'HEAD'], ['/novels/id', 'PATCH'],
    ['/novels/id/publish', 'POST'], ['/ai/cover-image', 'POST'], ['/credits/tasks/run', 'GET'],
  ])('identifies protected studio route %s %s', (path, method) => {
    expect(isStudioAccountRoute(path, method)).toBe(true)
  })

  it.each([
    ['/novels/id/detail', 'GET'], ['/novels/id/reader/chapter', 'GET'],
    ['/novels/id/favorite', 'POST'], ['/novels/exports/token', 'GET'],
    ['/ai/tts/synthesize', 'POST'], ['/users/me/profile', 'PATCH'], ['/feedback', 'POST'],
  ])('leaves non-studio route %s %s available to phone-skipped users', (path, method) => {
    expect(isStudioAccountRoute(path, method)).toBe(false)
  })

  it('requires a verified phone for the studio', () => {
    expect(accountAccessError(true, true)?.code).toBe('AUTH_PHONE_VERIFICATION_REQUIRED')
    expect(accountAccessError(true, false)).toBeUndefined()
    expect(accountAccessError(false, true)).toBeUndefined()
  })

  it('exempts only an active superadmin when the phone is unverified', () => {
    const superAdmin = { role: 'admin', isSuperAdmin: true, bannedAt: null }
    expect(requiresStudioPhoneVerification(superAdmin, true)).toBe(false)
    expect(requiresStudioPhoneVerification({ ...superAdmin, isSuperAdmin: false }, true)).toBe(true)
    expect(requiresStudioPhoneVerification({ ...superAdmin, role: 'user' }, true)).toBe(true)
    expect(requiresStudioPhoneVerification({ ...superAdmin, bannedAt: new Date() }, true)).toBe(true)
  })

  it('keeps contact information and verification state private', () => {
    const previous = env.accountEmailAuthEnabled
    env.accountEmailAuthEnabled = true
    try {
      const record = {
        id: 'fixture', nickname: '书友', role: 'user' as const, isAuthor: false,
        email: 'private@example.test', phone: '+8613900000021', passwordHash: 'unset:test',
        emailVerifiedAt: new Date(), phoneVerifiedAt: null, accountSetupStep: 2,
      }
      expect(toUser(record)).toMatchObject({
        email: 'private@example.test', emailVerified: true, phoneVerified: false, studioPhoneVerificationRequired: true, accountSetupStep: 2,
      })
      const profile = toUser(record, { publicProfile: true })
      expect(profile).toMatchObject({ email: null, phone: null })
      expect(profile).not.toHaveProperty('accountSetupStep')
      expect(profile).not.toHaveProperty('emailVerified')
      expect(profile).not.toHaveProperty('studioPhoneVerificationRequired')
    } finally {
      env.accountEmailAuthEnabled = previous
    }
  })
})
