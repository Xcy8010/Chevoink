import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { prisma, DataAccessError } from './prisma.js'
import { resolveDeviceLocation } from './device-location.js'
import { hasConfiguredPassword, verifyPassword } from './password.js'

function deviceName(req: Request) {
  const agent = req.headers['user-agent'] ?? ''
  const os = /Android/i.test(agent) ? 'Android' : /iPad/i.test(agent) ? 'iPad' : /iPhone/i.test(agent) ? 'iPhone' : /Windows/i.test(agent) ? 'Windows' : /Macintosh/i.test(agent) ? 'Mac' : /Linux/i.test(agent) ? 'Linux' : ''
  const browser = /; wv\)/i.test(agent) ? '应用' : /Edg/i.test(agent) ? 'Edge' : /Firefox|FxiOS/i.test(agent) ? 'Firefox' : /Chrome|CriOS/i.test(agent) ? 'Chrome' : /Safari/i.test(agent) ? 'Safari' : ''
  return [os, browser].filter(Boolean).join(' · ') || '未知设备'
}

export async function openDevice(userId: string, tokenVersion: number, req: Request, expiresAt: Date, legacyId?: string) {
  const data = { id: legacyId ?? randomUUID(), userId, tokenVersion, expiresAt,
    deviceName: legacyId ? '旧版登录（合并显示）' : deviceName(req),
    location: legacyId ? null : await resolveDeviceLocation(req) }
  if (legacyId) return prisma.accountDeviceSession.upsert({ where: { id: legacyId }, create: data, update: {} })
  await prisma.accountDeviceSession.deleteMany({ where: { userId, OR: [
    { expiresAt: { lt: new Date() }, id: { not: { startsWith: 'legacy-' } } },
    { tokenVersion: { lt: tokenVersion } },
  ] } })
  return prisma.accountDeviceSession.create({ data })
}

export async function listDevices(userId: string, current: string, tokenVersion: number) {
  const rows = await prisma.accountDeviceSession.findMany({ where: { userId, tokenVersion, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, deviceName: true, location: true, createdAt: true, lastActiveAt: true }, orderBy: { lastActiveAt: 'desc' } })
  return rows.map(row => ({ ...row, current: row.id === current, legacyGroup: row.id.startsWith('legacy-') }))
}

export async function removeDevice(userId: string, current: string, target: string, password: string, tokenVersion: number) {
  if (target === current) throw new DataAccessError(400, 'CURRENT_DEVICE', '请使用退出登录来退出当前设备。')
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, role: true, tokenVersion: true } })
  if (!hasConfiguredPassword(user.passwordHash)) throw new DataAccessError(409, 'PASSWORD_REQUIRED', '请先设置账号密码。')
  if (!verifyPassword(user.role === 'admin' ? password : password.trim(), user.passwordHash)) throw new DataAccessError(403, 'INVALID_PASSWORD', '密码不正确。')
  const result = await prisma.accountDeviceSession.updateMany({ where: { id: target, userId, tokenVersion, revokedAt: null,
    user: { tokenVersion, passwordHash: user.passwordHash, bannedAt: null } }, data: { revokedAt: new Date() } })
  if (!result.count) throw new DataAccessError(404, 'DEVICE_NOT_FOUND', '此设备已退出或不存在。')
}
