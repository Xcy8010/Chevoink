import { createHash } from 'node:crypto'
import { env } from '../../api/config/env.js'
import { normalizePhoneNumber } from '../../api/lib/phone.js'
import { prisma } from '../../api/lib/prisma.js'
import { integrationLegalConsent } from './legal-consent.js'

/** Seed the same verification record a successful SMS delivery would leave in the isolated test DB. */
export async function integrationSmsRegistration(inputPhone: string) {
  const consent = await integrationLegalConsent()
  const phone = normalizePhoneNumber(inputPhone)
  const code = '678123'
  await prisma.smsVerificationCode.create({
    data: {
      phone,
      purpose: 'register',
      codeHash: createHash('sha256').update(`${env.authSessionSecret}:${phone}:register:${code}`).digest('hex'),
      expiresAt: new Date(Date.now() + 5 * 60_000),
      provider: 'integration-fixture',
    },
  })
  return { ...consent, code }
}
