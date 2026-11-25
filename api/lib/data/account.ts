import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { assertPreviewAccountAllowed, assertPreviewEmailAllowed } from '../account-email-auth-scope.js'
import { recordAccountPasswordFailure } from '../account-security-observation.js'
import { evictUserBanCache } from '../auth-session.js'
import { invalidAccountCode, lockAccountKey, prepareAccountEmailCode } from '../email-verification.js'
import { hashPassword, hasConfiguredPassword, isLegacyPasswordHash, verifyPassword } from '../password.js'
import { normalizeAccountPhoneNumber } from '../phone.js'
import { DataAccessError, prisma } from '../prisma.js'
import { prepareAuthSmsCode } from '../sms-service.js'
import { ensureUserExists, toUser } from './internal.js'
import { creditTransaction } from '../credit-policy.js'
import { updateCreditPhoneEligibility } from '../credits.js'

type Identity = { email: string } | { phone: string }
type ProofPurpose = 'reset_password' | 'change_password'

export function accountIdentity(identifier: string): Identity {
  const value = identifier.trim()
  if (value.includes('@')) {
    const email = z.string().email().max(254).safeParse(value.toLowerCase())
    if (!email.success) throw new DataAccessError(400, 'VALIDATION_ERROR', '请输入有效的邮箱地址。')
    return { email: email.data }
  }
  return { phone: normalizeAccountPhoneNumber(value) }
}

export async function findAccountByIdentity(identity: Identity, verifiedPhone = false) {
  return prisma.user.findFirst({
    where: 'email' in identity
      ? { email: { equals: identity.email, mode: 'insensitive' }, emailVerifiedAt: { not: null } }
      : { phone: identity.phone, ...(verifiedPhone ? { phoneVerifiedAt: { not: null } } : {}) },
  })
}

export async function canSendRegistrationEmail(email: string) {
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true },
  })
  return !existing
}

export async function canSendBindingEmail(userId: string, email: string) {
  const account = await ensureUserExists(userId)
  const conflict = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, id: { not: userId } }, select: { id: true },
  })
  return !account.emailVerifiedAt && !conflict
}

export async function canSendBindingPhone(userId: string, phone: string) {
  const account = await ensureUserExists(userId)
  const existing = await findAccountByIdentity({ phone })
  return Boolean(!account.phoneVerifiedAt
    && (!account.phone || account.phone === phone) && (!existing || existing.id === userId))
}

const dummyPasswordHash = 'scrypt:6a7b37e1c7f68cd8f8ac04c1bed0d398:' + '0'.repeat(128)

export async function loginAccountUserData(identity: Identity, password: string) {
  if ('email' in identity) assertPreviewEmailAllowed(identity.email)
  // The provisioned superadmin address is a password login identifier only.
  const reservedAdmin = 'email' in identity && identity.email === 'admin@chevoink.local'
    ? await prisma.user.findUnique({
        where: { email: identity.email, role: 'admin', isSuperAdmin: true, bannedAt: null },
      })
    : null
  const user = reservedAdmin ?? await findAccountByIdentity(identity)
  // Match the admin login's exact password while preserving account password normalization.
  const loginPassword = reservedAdmin ? password : password.trim()
  const hashed = user?.passwordHash ?? dummyPasswordHash
  // Keep a password derivation on unknown, unset and historical hash paths.
  const configuredScrypt = hashed.startsWith('scrypt:')
  const matched = verifyPassword(loginPassword, configuredScrypt ? hashed : dummyPasswordHash)
  if (!user) return null
  if (!(configuredScrypt ? matched : verifyPassword(loginPassword, hashed))) {
    recordAccountPasswordFailure('password_login', user.id)
    return null
  }
  assertPreviewAccountAllowed(user)

  if (isLegacyPasswordHash(hashed)) {
    await prisma.user.updateMany({ where: { id: user.id, passwordHash: hashed }, data: { passwordHash: hashPassword(loginPassword) } })
  }
  return { user: toUser(user), tokenVersion: user.tokenVersion }
}

export async function loginAccountEmailCodeData(email: string, code: string) {
  const user = await findAccountByIdentity({ email })
  const consume = await prepareAccountEmailCode({ email, userId: user?.id ?? null, purpose: 'login' }, code)
  if (!user || user.bannedAt) throw invalidAccountCode()
  await prisma.$transaction(consume)
  return { user: toUser(user), tokenVersion: user.tokenVersion }
}

export async function loginAccountSmsCodeData(phone: string, code: string) {
  const user = await findAccountByIdentity({ phone })
  assertPreviewAccountAllowed(user)
  const proof = await prepareAuthSmsCode({ phone, code, purpose: 'login', ownerId: user?.id ?? null })
  if (!user || user.bannedAt) throw invalidAccountCode()
  const updated = await creditTransaction(async tx => {
    await proof.consume(tx)
    const verified = await tx.user.updateMany({
      where: { id: user.id, phone, bannedAt: null, phoneVerifiedAt: null },
      data: { phoneVerifiedAt: new Date() },
    })
    const account = await tx.user.findFirst({ where: { id: user.id, phone, bannedAt: null } })
    if (!account || (!verified.count && !account.phoneVerifiedAt)) throw invalidAccountCode()
    if (verified.count) await updateCreditPhoneEligibility(tx, user.id, phone)
    return account
  })
  return { user: toUser(updated), tokenVersion: user.tokenVersion }
}

export async function bindAccountEmailData(userId: string, email: string, code: string) {
  const consume = await prepareAccountEmailCode({ email, userId, purpose: 'bind' }, code)
  const user = await prisma.$transaction(async tx => {
    await lockAccountKey(tx, `account-email-owner:${email}`)
    const conflict = await tx.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, id: { not: userId } },
      select: { id: true },
    })
    if (conflict) throw new DataAccessError(409, 'AUTH_EMAIL_UNAVAILABLE', '暂时无法绑定此邮箱，请使用其他邮箱。')
    await consume(tx)
    const updated = await tx.user.updateMany({
      where: { id: userId, bannedAt: null, emailVerifiedAt: null },
      data: { email, emailVerifiedAt: new Date() },
    })
    if (!updated.count) throw new DataAccessError(409, 'AUTH_EMAIL_ALREADY_VERIFIED', '账号已绑定邮箱，请刷新后继续。')
    return tx.user.findUniqueOrThrow({ where: { id: userId } })
  })
  return toUser(user)
}

export async function bindAccountPhoneData(userId: string, phone: string, code: string) {
  const proof = await prepareAuthSmsCode({ phone, code, purpose: 'bind_phone', ownerId: userId })
  const user = await creditTransaction(async tx => {
    await proof.consume(tx)
    const conflict = await tx.user.findFirst({ where: { phone, id: { not: userId } }, select: { id: true } })
    if (conflict) throw new DataAccessError(409, 'AUTH_PHONE_UNAVAILABLE', '暂时无法绑定此手机号。')
    const updated = await tx.user.updateMany({
      where: { id: userId, bannedAt: null, phoneVerifiedAt: null,
        OR: [{ phone: null }, { phone }] },
      data: { phone, phoneVerifiedAt: new Date() },
    })
    if (!updated.count) throw new DataAccessError(409, 'AUTH_PHONE_UNAVAILABLE', '暂时无法绑定此手机号，请刷新后继续。')
    await updateCreditPhoneEligibility(tx, userId, phone)
    return tx.user.findUniqueOrThrow({ where: { id: userId } })
  })
  return toUser(user)
}

export async function accountPasswordIdentity(userId: string, channel: 'email' | 'sms'): Promise<Identity> {
  const user = await ensureUserExists(userId)
  if (channel === 'email' && user.email && user.emailVerifiedAt) return { email: user.email.toLowerCase() }
  if (channel === 'sms' && user.phone && user.phoneVerifiedAt) return { phone: user.phone }
  throw new DataAccessError(400, 'AUTH_CONTACT_UNVERIFIED', '请使用已验证的邮箱或手机号。')
}

async function invalidatePasswordCodes(tx: Prisma.TransactionClient, userId: string) {
  const consumedAt = new Date()
  const purposes: ProofPurpose[] = ['reset_password', 'change_password']
  await tx.emailVerificationCode.updateMany({
    where: { userId, purpose: { in: purposes }, consumedAt: null }, data: { consumedAt },
  })
  await tx.smsVerificationCode.updateMany({
    where: { userId, purpose: { in: purposes }, consumedAt: null }, data: { consumedAt },
  })
}

export async function setInitialAccountPasswordData(userId: string, tokenVersion: number, password: string) {
  const owner = await ensureUserExists(userId)
  assertPreviewAccountAllowed(owner)
  const unavailable = () => new DataAccessError(409, 'AUTH_SETUP_PASSWORD_UNAVAILABLE', '这一步已完成或账号已有密码，请刷新后继续。')
  if (owner.tokenVersion !== tokenVersion || owner.bannedAt || !owner.emailVerifiedAt || owner.accountSetupStep !== 2
    || !owner.passwordHash || hasConfiguredPassword(owner.passwordHash)) throw unavailable()

  const passwordHash = hashPassword(password)
  const updated = await prisma.$transaction(async tx => {
    await lockAccountKey(tx, `account-password:${userId}`)
    const [user] = await tx.user.updateManyAndReturn({
      where: { id: userId, tokenVersion, bannedAt: null, emailVerifiedAt: { not: null },
        accountSetupStep: 2, passwordHash: owner.passwordHash },
      data: { passwordHash, accountSetupStep: 3, tokenVersion: { increment: 1 } },
    })
    if (!user) throw unavailable()
    await invalidatePasswordCodes(tx, userId)
    return user
  })
  evictUserBanCache(userId)
  return { user: toUser(updated), tokenVersion: updated.tokenVersion }
}

export async function updateAccountPasswordWithOldPassword(userId: string, tokenVersion: number, oldPassword: string, password: string) {
  const owner = await ensureUserExists(userId)
  assertPreviewAccountAllowed(owner)
  if (!verifyPassword(owner.role === 'admin' ? oldPassword : oldPassword.trim(), owner.passwordHash)) {
    throw new DataAccessError(403, 'AUTH_INVALID_CREDENTIALS', '当前密码不正确。')
  }
  const passwordHash = hashPassword(password)
  const updated = await prisma.$transaction(async tx => {
    await lockAccountKey(tx, `account-password:${userId}`)
    const [user] = await tx.user.updateManyAndReturn({
      where: { id: userId, tokenVersion, bannedAt: null, passwordHash: owner.passwordHash },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    })
    if (!user) throw new DataAccessError(409, 'AUTH_SESSION_CHANGED', '账号状态已更改，请重新登录。')
    await invalidatePasswordCodes(tx, userId)
    return user
  })
  evictUserBanCache(userId)
  return { user: toUser(updated), tokenVersion: updated.tokenVersion }
}

export async function updateAccountPasswordWithCode(
  identity: Identity, purpose: ProofPurpose, code: string, password: string, userId?: string,
) {
  if ('email' in identity) assertPreviewEmailAllowed(identity.email)
  const owner = await findAccountByIdentity(identity, true)
  assertPreviewAccountAllowed(owner)
  const scopeId = owner?.id ?? null
  const consume = 'email' in identity
    ? await prepareAccountEmailCode({ email: identity.email, userId: scopeId, purpose }, code)
    : (await prepareAuthSmsCode({ phone: identity.phone, ownerId: scopeId, purpose, code })).consume
  if (!owner || owner.bannedAt || (userId && owner.id !== userId)) throw invalidAccountCode()
  const ownerId = owner.id

  const passwordHash = hashPassword(password)
  const updated = await prisma.$transaction(async tx => {
    await lockAccountKey(tx, `account-password:${ownerId}`)
    await consume(tx)
    const result = await tx.user.updateMany({
      where: { id: ownerId, bannedAt: null, tokenVersion: owner.tokenVersion,
        ...('email' in identity ? { email: owner.email, emailVerifiedAt: { not: null } }
          : { phone: identity.phone, phoneVerifiedAt: { not: null } }) },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    })
    if (!result.count) throw invalidAccountCode()
    await invalidatePasswordCodes(tx, ownerId)
    return tx.user.findUniqueOrThrow({ where: { id: ownerId } })
  })
  evictUserBanCache(ownerId)
  return { user: toUser(updated), tokenVersion: updated.tokenVersion }
}

export async function advanceAccountSetupData(userId: string, step: 1 | 2 | 3, skip: boolean) {
  const user = await ensureUserExists(userId)
  if (user.accountSetupStep !== step) return toUser(user)
  if (!skip && ((step === 1 && !user.phoneVerifiedAt) || (step === 2 && !hasConfiguredPassword(user.passwordHash)))) {
    throw new DataAccessError(409, 'AUTH_SETUP_INCOMPLETE', '请完成当前步骤，或选择跳过。')
  }
  const where: Prisma.UserWhereInput = { id: userId, accountSetupStep: step, emailVerifiedAt: { not: null }, bannedAt: null }
  if (!skip && step === 1) where.phoneVerifiedAt = { not: null }
  if (!skip && step === 2) where.passwordHash = user.passwordHash
  await prisma.user.updateMany({
    where,
    data: {
      accountSetupStep: step === 3 ? null : step + 1,
      ...(skip ? { accountSetupSkippedSteps: { push: step } } : {}),
      ...(step === 3 ? { accountSetupFinishedAt: new Date() } : {}),
    },
  })
  return toUser(await ensureUserExists(userId))
}

export async function goBackAccountSetupData(userId: string, tokenVersion: number, step: 2 | 3) {
  const owner = await ensureUserExists(userId)
  assertPreviewAccountAllowed(owner)
  if (owner.accountSetupStep !== step) return toUser(owner)
  const previous = step === 3 ? 2 : 1
  const [user] = await prisma.user.updateManyAndReturn({
    where: { id: userId, tokenVersion, bannedAt: null, emailVerifiedAt: { not: null }, accountSetupStep: step,
      accountSetupFinishedAt: null, accountSetupSkippedSteps: { equals: owner.accountSetupSkippedSteps } },
    data: { accountSetupStep: previous, accountSetupSkippedSteps: owner.accountSetupSkippedSteps.filter(value => value !== previous) },
  })
  return toUser(user ?? await ensureUserExists(userId))
}
