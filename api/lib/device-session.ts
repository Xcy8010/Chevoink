import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma, DataAccessError } from './prisma.js'
import { resolveDeviceLocation } from './device-location.js'
import { hasConfiguredPassword, verifyPassword } from './password.js'

function deviceName(req: Request | undefined) {
  const agent = req?.headers['user-agent'] ?? ''
  const os = /Android/i.test(agent) ? 'Android' : /iPad/i.test(agent) ? 'iPad' : /iPhone/i.test(agent) ? 'iPhone' : /Windows/i.test(agent) ? 'Windows' : /Macintosh/i.test(agent) ? 'Mac' : /Linux/i.test(agent) ? 'Linux' : ''
  const browser = /; wv\)/i.test(agent) ? '应用' : /Edg/i.test(agent) ? 'Edge' : /Firefox|FxiOS/i.test(agent) ? 'Firefox' : /Chrome|CriOS/i.test(agent) ? 'Chrome' : /Safari/i.test(agent) ? 'Safari' : ''
  return [os, browser].filter(Boolean).join(' · ') || '未知设备'
}

const legacyRows = { OR: ['legacy-', 'carry-', 'shared-'].map(prefix => ({ id: { startsWith: prefix } })) }
export function isRecognizedDevice(id: string) { return id.startsWith('carry-') || id.startsWith('shared-') }

async function lockLegacyAccount(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('device-migration'), hashtext(${userId}))`
}

export async function openDevice(userId: string, tokenVersion: number, req: Request | undefined, expiresAt: Date) {
  const data = { id: randomUUID(), userId, tokenVersion, expiresAt,
    deviceName: deviceName(req), location: req ? await resolveDeviceLocation(req) : null }
  await prisma.accountDeviceSession.deleteMany({ where: { userId, OR: [
    { expiresAt: { lt: new Date() }, NOT: legacyRows },
    { tokenVersion: { lt: tokenVersion } },
  ] } })
  return prisma.accountDeviceSession.create({ data })
}

export async function registerRecognizedDevice(userId: string, tokenVersion: number, req: Request, expiresAt: Date, recognizedId: string, mixedGroup: string | undefined, allowCreation: boolean) {
  const data = { id: recognizedId, userId, tokenVersion, expiresAt,
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
  const rows = await prisma.accountDeviceSession.findMany({ where: { userId, tokenVersion, OR: [
    { id: { startsWith: 'legacy-' } }, { revokedAt: null, expiresAt: { gt: new Date() } },
  ] }, select: { id: true, deviceName: true, location: true, createdAt: true, lastActiveAt: true, revokedAt: true }, orderBy: { lastActiveAt: 'desc' } })
  const group = rows.find(row => row.id.startsWith('legacy-'))
  return rows.filter(row => row !== group && !(isRecognizedDevice(row.id) && group?.revokedAt))
    .map(({ revokedAt: _revokedAt, ...row }) => ({ ...row, current: row.id === current,
      legacyGroup: row.id.startsWith('shared-') || Boolean(group && isRecognizedDevice(row.id)), firstSeenOnly: isRecognizedDevice(row.id) }))
}

export async function revokeDevice(userId: string, tokenVersion: number, id: string, passwordHash?: string) {
  const where = { id, userId, tokenVersion, revokedAt: null, user: { tokenVersion, passwordHash, bannedAt: null } }
  const data = { revokedAt: new Date() }
  if (!isRecognizedDevice(id) && !id.startsWith('legacy-')) return prisma.accountDeviceSession.updateMany({ where, data })
  return prisma.$transaction(async tx => {
    await lockLegacyAccount(tx, userId)
    const result = await tx.accountDeviceSession.updateMany({ where, data })
    if (result.count && await tx.accountDeviceSession.findFirst({ where: { userId, tokenVersion, id: { startsWith: 'legacy-' } }, select: { id: true } })) {
      await tx.accountDeviceSession.updateMany({ where: { userId, tokenVersion, revokedAt: null, ...legacyRows }, data })
    }
    return result
  })
}

export async function removeDevice(userId: string, current: string, target: string, password: string, tokenVersion: number) {
  if (target === current) throw new DataAccessError(400, 'CURRENT_DEVICE', '请使用退出登录来退出当前设备。')
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, role: true, tokenVersion: true } })
  if (!hasConfiguredPassword(user.passwordHash)) throw new DataAccessError(409, 'PASSWORD_REQUIRED', '请先设置账号密码。')
  if (!verifyPassword(user.role === 'admin' ? password : password.trim(), user.passwordHash)) throw new DataAccessError(403, 'INVALID_PASSWORD', '密码不正确。')
  const result = await revokeDevice(userId, tokenVersion, target, user.passwordHash)
  if (!result.count) throw new DataAccessError(404, 'DEVICE_NOT_FOUND', '此设备已退出或不存在。')
}
