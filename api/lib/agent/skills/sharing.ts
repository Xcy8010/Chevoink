import { createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import type { SkillSharePayload, SkillShareInviteView } from '../../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../../prisma.js'

const NOVEL_SCOPE = 'novel'
const INVITE_DAYS = 7

async function assertOwnedNovel(userId: string, novelId: string, transaction?: Prisma.TransactionClient) {
  const novel = await (transaction ?? prisma).novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true, title: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权共享技能。')
  return novel
}

function toView(row: {
  id: string
  userId: string
  status: string
  skillId: string
  version: string
  message: string
  expiresAt: Date
  createdAt: Date
  skill: { name: string }
  user: { id: string; nickname: string }
  recipient: { id: string; nickname: string }
  novel: { id: string; title: string }
}, viewerId: string): SkillShareInviteView {
  const sent = row.userId === viewerId
  return {
    id: row.id,
    direction: sent ? 'sent' : 'received',
    status: row.status as SkillShareInviteView['status'],
    skillId: row.skillId,
    skillName: row.skill.name,
    version: row.version,
    message: row.message,
    counterpart: sent ? row.recipient : row.user,
    sourceNovel: row.novel,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

export async function createSkillShareInvite(input: {
  userId: string
  novelId: string
  skillId: string
  recipientAccount: string
  version?: string
  message: string
}): Promise<SkillShareInviteView> {
  await assertOwnedNovel(input.userId, input.novelId)
  const recipient = await prisma.user.findFirst({
    where: { OR: [{ id: input.recipientAccount }, { email: input.recipientAccount }, { phone: input.recipientAccount }] },
    select: { id: true },
  })
  if (!recipient) throw new DataAccessError(404, 'SKILL_SHARE_RECIPIENT_NOT_FOUND', '未找到该账号；请输入对方用户 ID、邮箱或手机号。')
  if (recipient.id === input.userId) throw new DataAccessError(400, 'SKILL_SHARE_SELF', '不能向自己发送技能邀请。')
  const skill = await prisma.agentSkillDefinition.findFirst({
    where: { id: input.skillId, ownerUserId: input.userId, status: 'active' },
    include: { versions: true },
  })
  if (!skill) throw new DataAccessError(404, 'SKILL_NOT_SHAREABLE', '只有自己已发布的技能可以邀请共享。')
  const versionName = input.version ?? skill.defaultVersion
  const version = skill.versions.find((item) => item.version === versionName && item.status === 'active')
  if (!version) throw new DataAccessError(409, 'SKILL_VERSION_NOT_PUBLISHED', '要共享的技能版本尚未发布。')
  const [audit, positiveEval, negativeEval] = await Promise.all([
    prisma.agentSkillAudit.findFirst({ where: { skillId: skill.id, version: versionName, status: 'passed' }, orderBy: { createdAt: 'desc' } }),
    prisma.agentSkillEval.findFirst({ where: { skillId: skill.id, version: versionName, passed: true, input: { path: ['expectMatch'], equals: true } } }),
    prisma.agentSkillEval.findFirst({ where: { skillId: skill.id, version: versionName, passed: true, input: { path: ['expectMatch'], equals: false } } }),
  ])
  if (!audit || !positiveEval || !negativeEval) throw new DataAccessError(409, 'SKILL_SHARE_GATES_REQUIRED', '技能必须通过静态审计及“应命中/不应命中”测试后才能共享。')
  const rawToken = randomBytes(24).toString('hex')
  const row = await prisma.skillShareInvite.create({
    data: {
      userId: input.userId,
      novelId: input.novelId,
      recipientUserId: recipient.id,
      skillId: skill.id,
      version: versionName,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      message: input.message,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
    },
    include: { skill: { select: { name: true } }, user: { select: { id: true, nickname: true } }, recipient: { select: { id: true, nickname: true } }, novel: { select: { id: true, title: true } } },
  })
  await prisma.agentSkillDefinition.update({ where: { id: skill.id }, data: { visibility: 'invite_only' } })
  return toView(row, input.userId)
}

export async function listSkillShareInvites(userId: string, transaction?: Prisma.TransactionClient): Promise<SkillSharePayload> {
  const db = transaction ?? prisma
  await db.skillShareInvite.updateMany({ where: { OR: [{ userId }, { recipientUserId: userId }], status: 'pending', expiresAt: { lte: new Date() } }, data: { status: 'expired' } })
  const rows = await db.skillShareInvite.findMany({
    where: { OR: [{ userId }, { recipientUserId: userId }] },
    include: { skill: { select: { name: true } }, user: { select: { id: true, nickname: true } }, recipient: { select: { id: true, nickname: true } }, novel: { select: { id: true, title: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  const views = rows.map((row) => toView(row, userId))
  return { sent: views.filter((item) => item.direction === 'sent'), received: views.filter((item) => item.direction === 'received') }
}

export async function acceptSkillShareInvite(userId: string, inviteId: string, destinationNovelId: string, transaction?: Prisma.TransactionClient): Promise<void> {
  const db = transaction ?? prisma
  await assertOwnedNovel(userId, destinationNovelId, transaction)
  const invite = await db.skillShareInvite.findFirst({
    where: { id: inviteId, recipientUserId: userId, status: 'pending' },
    include: { skill: { include: { versions: true } } },
  })
  if (!invite) throw new DataAccessError(404, 'SKILL_SHARE_INVITE_NOT_FOUND', '技能邀请不存在、已处理或不属于当前账号。')
  if (invite.expiresAt <= new Date()) {
    await db.skillShareInvite.update({ where: { id: invite.id }, data: { status: 'expired' } })
    throw new DataAccessError(409, 'SKILL_SHARE_INVITE_EXPIRED', '技能邀请已过期。')
  }
  const version = invite.skill.versions.find((item) => item.version === invite.version && item.status === 'active')
  if (!version || invite.skill.status !== 'active') throw new DataAccessError(409, 'SKILL_SHARE_VERSION_UNAVAILABLE', '共享的技能版本已下线，不能安装。')
  const manifest = version.manifest && typeof version.manifest === 'object' && !Array.isArray(version.manifest) ? version.manifest as Record<string, unknown> : {}
  const writes = [
    db.agentSkillInstallation.upsert({
      where: { skillId_userId_scope_scopeId: { skillId: invite.skillId, userId, scope: NOVEL_SCOPE, scopeId: destinationNovelId } },
      create: { skillId: invite.skillId, userId, scope: NOVEL_SCOPE, scopeId: destinationNovelId, enabled: true, lockedVersion: invite.version, priority: typeof manifest.priority === 'number' ? manifest.priority : 70 },
      update: { enabled: true, lockedVersion: invite.version, priority: typeof manifest.priority === 'number' ? manifest.priority : 70 },
    }),
    db.skillShareInvite.update({ where: { id: invite.id }, data: { status: 'accepted', acceptedAt: new Date() } }),
  ]
  if (transaction) { for (const write of writes) await write }
  else await prisma.$transaction(writes)
}

export async function declineSkillShareInvite(userId: string, inviteId: string): Promise<void> {
  const updated = await prisma.skillShareInvite.updateMany({ where: { id: inviteId, recipientUserId: userId, status: 'pending' }, data: { status: 'declined' } })
  if (updated.count !== 1) throw new DataAccessError(404, 'SKILL_SHARE_INVITE_NOT_FOUND', '技能邀请不存在、已处理或不属于当前账号。')
}
