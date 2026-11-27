import type { Request } from 'express'
import { prisma } from '../../api/lib/prisma.js'
import { requireAppReleaseCapability } from '../../api/lib/app-releases.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { workdayDue, reporterReceipt } from '../../api/lib/governance-cases.js'
import { issueAppealProof, verifyAppealProof } from '../../api/lib/governance-appeals.js'
import { allowedReasons } from '../../shared/contracts/governance-cases.js'
import { verifySessionToken } from '../../api/lib/auth-session.js'

describe('governance receipt and independent appeal authority', () => {
  const original = env.authSessionSecret
  beforeEach(() => {
    env.authSessionSecret = 'synthetic-governance-secret-for-tests'
  })
  afterEach(() => {
    env.authSessionSecret = original
  })
  it('starts deadlines on the China business calendar with makeup days and holidays', () => {
    const date = new Date('2026-11-26T16:30:00.000Z')
    expect(workdayDue(date, 3, '2026-11-30', '2026-11-28').toISOString()).toBe('2026-12-01T16:30:00.000Z')
  })
  it('authorizes only the verified subject for twenty minutes and cannot open a regular session', () => {
    const time = Date.UTC(2026, 10, 28)
    const token = issueAppealProof('synthetic-a', time)
    expect(verifyAppealProof(token, time + 1)).toBe('synthetic-a')
    expect(verifySessionToken(token, 'access')).toBeNull()
    expect(() => verifyAppealProof(token, time + 20 * 60000)).toThrow()
    expect(() =>
      verifyAppealProof(
        token.replace(
          /^[^.]+/,
          Buffer.from(JSON.stringify(['synthetic-b', time + 1000])).toString('base64url'),
        ),
        time,
      ),
    ).toThrow()
  })
  it('returns reporter-safe final feedback and a separate query secret without alleged-user details', () => {
    const record = { id: 'SYN-1', requestKey: 'test-idempotency', status: 'dismissed', publicProgress: null }
    const receipt = reporterReceipt(record)
    expect(receipt.message).toContain('尚未发现足以认定违规的依据')
    expect(receipt.receipt).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt).not.toHaveProperty('requestKey')
    expect(reporterReceipt({ ...record, requestKey: 'other' }).receipt).not.toBe(receipt.receipt)
    expect(allowedReasons('platform')).not.toContain('sexual')
  })
})

it('keeps production governance closed if both release channels are disabled', async () => {
  const before = env.appEnv
  const channels = vi.spyOn(prisma.appReleaseChannel, 'findMany').mockResolvedValue([])
  try {
    env.appEnv = 'production'
    const req = { headers: {}, get: () => undefined } as unknown as Request
    await expect(requireAppReleaseCapability(req, 'platformGovernance')).rejects.toMatchObject({ code: 'APP_RELEASE_CAPABILITY_DISABLED' })
    await expect(requireAppReleaseCapability(req, 'siteContent')).resolves.toMatchObject({ mode: 'legacy' })
  } finally {
    env.appEnv = before
    channels.mockRestore()
  }
})
