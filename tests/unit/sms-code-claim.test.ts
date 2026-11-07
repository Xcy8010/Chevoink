import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { prepareAuthSmsCode, verifyAuthSmsCode } from '../../api/lib/sms-service.js'

const db = vi.hoisted(() => ({
  smsVerificationCode: { findFirst: vi.fn(), updateMany: vi.fn() },
}))
vi.mock('../../api/lib/prisma.js', () => ({
  prisma: db,
  DataAccessError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message) }
  },
}))

const phone = '+8613900000021'
const input = { phone, code: '678123', purpose: 'register' as const }
const recordedAt = new Date('2026-11-07T03:00:00Z')
const expiresAt = new Date('2026-11-07T03:05:00Z')
const record = {
  id: 'registration-code',
  codeHash: createHash('sha256').update(`${env.authSessionSecret}:${phone}:register:${input.code}`).digest('hex'),
  expiresAt,
  consumedAt: null,
  attempts: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(recordedAt)
  db.smsVerificationCode.findFirst.mockResolvedValue(record)
  db.smsVerificationCode.updateMany.mockResolvedValue({ count: 1 })
})
afterEach(() => vi.useRealTimers())

it('scopes lookup to the exact normalized phone and purpose, and rejects an invalid code with a bounded attempt increment', async () => {
  await expect(verifyAuthSmsCode({ ...input, phone: '+86 139-0000-0021', code: '111111' })).rejects.toMatchObject({ code: 'SMS_CODE_INVALID' })
  expect(db.smsVerificationCode.findFirst).toHaveBeenCalledExactlyOnceWith({
    where: { phone, purpose: 'register' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  expect(db.smsVerificationCode.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { id: record.id, consumedAt: null, expiresAt: { gt: recordedAt }, attempts: { lt: 5 } },
    data: { attempts: { increment: 1 } },
  })
})

it.each([
  { consumedAt: recordedAt, code: 'SMS_CODE_INVALID' },
  { expiresAt: recordedAt, code: 'SMS_CODE_INVALID' },
  { attempts: 5, code: 'SMS_CODE_ATTEMPTS_EXCEEDED' },
])('does not fall back to an older code when the newest record is unavailable ($code)', async ({ code, ...fields }) => {
  db.smsVerificationCode.findFirst.mockResolvedValueOnce({ ...record, ...fields })
  await expect(verifyAuthSmsCode(input)).rejects.toMatchObject({ code })
  expect(db.smsVerificationCode.findFirst).toHaveBeenCalledTimes(1)
  expect(db.smsVerificationCode.updateMany).not.toHaveBeenCalled()
})

it('requires the transactional claim to still own one exact unconsumed, unexpired record', async () => {
  const proof = await prepareAuthSmsCode(input)
  expect(db.smsVerificationCode.updateMany).not.toHaveBeenCalled()
  vi.setSystemTime(expiresAt)
  const tx = { smsVerificationCode: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } }
  await expect(proof.consume(tx as unknown as Parameters<typeof proof.consume>[0])).rejects.toMatchObject({ code: 'SMS_CODE_INVALID' })
  expect(tx.smsVerificationCode.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { id: record.id, consumedAt: null, expiresAt: { gt: expiresAt }, attempts: { lt: 5 } },
    data: { consumedAt: expiresAt },
  })
})
