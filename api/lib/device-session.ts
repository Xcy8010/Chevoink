import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma, DataAccessError } from './prisma.js'
import { resolveDeviceLocation } from './device-location.js'
import { recordAccountPasswordFailure } from './account-security-observation.js'
import { deviceName } from './device-name.js'
import { hasConfiguredPassword, verifyPassword } from './password.js'

const legacyRows = { OR: ['legacy-', 'carry-', 'shared-'].map(prefix => ({ id: { startsWith: prefix } })) }
// This server-issued id is immutable across access/refresh rotation and bridge use.
// An activity report from one page cannot prove coverage of older, resident tabs.
const foregroundPrefix = 'fg1-'
export const enforcesForegroundIdle = (id: string) => id.startsWith(foregroundPrefix)
const idleCutoff = (now: Date) => new Date(now.getTime() - 30 * 86_400_000)
export const sessionIdleCutoff = (id: string, now: Date) => enforcesForegroundIdle(id) ? idleCutoff(now) : undefined
export function isRecognizedDevice(id: string) { return id.startsWith('carry-') || id.startsWith('shared-') }

async function lockLegacyAccount(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('device-migration'), hashtext(${userId}))`
}

export async function openDevice(userId: string, tokenVersion: number, req: Request | undefined, refreshTtlSeconds: number, foreground: boolean) {
  const lastActiveAt = new Date()
  const data = { id: (foreground ? foregroundPrefix : '') + randomUUID(), userId, tokenVersion, lastActiveAt, expiresAt: new Date(lastActiveAt.getTime() + refreshTtlSeconds * 1000),
    deviceName: deviceName(req), location: req ? await resolveDeviceLocation(req) : null }
  await prisma.accountDeviceSession.deleteMany({ where: { userId, OR: [
    { expiresAt: { lt: new Date() }, NOT: legacyRows },
    { tokenVersion: { lt: tokenVersion } },
  ] } })
  return prisma.accountDeviceSession.create({ data })
}

export async function registerRecognizedDevice(userId: string, tokenVersion: number, req: Request, expiresAt: Date, recognizedId: string, mixedGroup: string | undefined, allowCreation: boolean, lastActiveAt: Date) {
  const data = { id: recognizedId, userId, tokenVersion, expiresAt, lastActiveAt,
    deviceName: recognizedId?.startsWith('shared-') ? '旧版登录（合并显示）' : deviceName(req), location: req ? await resolveDeviceLocation(req) : null }
  return prisma.$transaction(async tx => {
    await lockLegacyAccount(tx, userId)
    const existing = await tx.accountDeviceSession.findUnique({ where: { id: recognizedId } })
    if (!existing && !allowCreation) return null
    if (existing && !mixedGroup) return existing
    // Old clients retained earlier tokens across renewals. A removed installation
    // must not use a previously unseen generation to recreate itself.
    const closed = await tx.accountDeviceSession.findFirst({ where: { userId, tokenVersion, revokedAt: { not: null }, ...legacyRows }, select: { id: true } })
    if (closed) return null
    if (mixedGroup) await tx.accountDeviceSession.createMany({ data: [{ ...data, id: mixedGroup, deviceName: '旧版登录（合并显示）', location: null,
      expiresAt: new Date(Math.max(expiresAt.getTime(), Date.now() + 30 * 86400_000)) }], skipDuplicates: true })
    return existing ?? tx.accountDeviceSession.create({ data })
  })
}

export async function listDevices(userId: string, current: string, tokenVersion: number) {
  const now = new Date()
  const rows = await prisma.accountDeviceSession.findMany({ where: { userId, tokenVersion, OR: [
    { id: { startsWith: 'legacy-' } }, { revokedAt: null, expiresAt: { gt: now }, OR: [
      { NOT: { id: { startsWith: foregroundPrefix } } }, { lastActiveAt: { gt: idleCutoff(now) } },
    ] },
  ] }, select: { id: true, deviceName: true, location: true, createdAt: true, lastActiveAt: true, revokedAt: true }, orderBy: { lastActiveAt: 'desc' } })
  const group = rows.find(row => row.id.startsWith('legacy-'))
  return rows.filter(row => row !== group && !(isRecognizedDevice(row.id) && group?.revokedAt))
    .map(({ revokedAt: _revokedAt, ...row }) => ({ ...row, current: row.id === current,
      legacyGroup: row.id.startsWith('shared-') || Boolean(group && isRecognizedDevice(row.id)), firstSeenOnly: isRecognizedDevice(row.id) }))
}

function requireDevicePassword() {
  return new DataAccessError(403, 'DEVICE_PASSWORD_REQUIRED', '请输入当前账号的登录密码。')
}

export async function revokeDevice(userId: string, tokenVersion: number, id: string, passwordHash?: string, protectCurrent?: string) {
  if (id === protectCurrent) throw requireDevicePassword()
  const where = { id, userId, tokenVersion, revokedAt: null, user: { tokenVersion, passwordHash, bannedAt: null } }
  const data = { revokedAt: new Date() }
  if (!isRecognizedDevice(id) && !id.startsWith('legacy-')) {
    const { count } = await prisma.accountDeviceSession.updateMany({ where, data })
    return { count, revokedLegacyGroup: false }
  }
  return prisma.$transaction(async tx => {
    await lockLegacyAccount(tx, userId)
    const result = await tx.accountDeviceSession.updateMany({ where, data })
    if (result.count && await tx.accountDeviceSession.findFirst({ where: { userId, tokenVersion, id: { startsWith: 'legacy-' } }, select: { id: true } })) {
      if (protectCurrent && isRecognizedDevice(protectCurrent)) throw requireDevicePassword()
      await tx.accountDeviceSession.updateMany({ where: { userId, tokenVersion, revokedAt: null, ...legacyRows }, data })
      return { count: result.count, revokedLegacyGroup: true }
    }
    return { count: result.count, revokedLegacyGroup: false }
  })
}

export async function removeDevice(userId: string, current: string, target: string, tokenVersion: number, password: string | undefined, verifiedUntil: number | null) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, role: true, tokenVersion: true } })
  if (!hasConfiguredPassword(user.passwordHash)) throw new DataAccessError(409, 'PASSWORD_REQUIRED', '请先设置账号密码。')
  if (password !== undefined) {
    if (!verifyPassword(user.role === 'admin' ? password : password.trim(), user.passwordHash)) {
      recordAccountPasswordFailure('device_revoke', current)
      throw new DataAccessError(403, 'INVALID_PASSWORD', '密码不正确。')
    }
  } else if (!verifiedUntil || verifiedUntil <= Date.now()) throw requireDevicePassword()
  const result = await revokeDevice(userId, tokenVersion, target, user.passwordHash, password === undefined ? current : undefined)
  if (!result.count) throw new DataAccessError(404, 'DEVICE_NOT_FOUND', '此设备已退出或不存在。')
  return { revoked: true as const, signedOutCurrent: target === current || (result.revokedLegacyGroup && isRecognizedDevice(current)) }
}
