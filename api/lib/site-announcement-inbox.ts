import type { Prisma } from '@prisma/client'
import {
  publishedAnnouncementSchema,
  type AnnouncementInbox,
  type AnnouncementNotification,
  type ReadAnnouncementsRequest,
  type ReadAnnouncementsResult,
} from '../../shared/contracts/site-content.js'
import { DataAccessError, prisma } from './prisma.js'

export async function readAnnouncementInbox(
  viewerId: string | null,
  db: Prisma.TransactionClient = prisma,
  includePersonal = true,
): Promise<AnnouncementInbox> {
  const [documents, viewer] = await Promise.all([
    db.siteContent.findMany({
      where: { kind: 'announcement', withdrawn: false, deletedAt: null, publishedVersionId: { not: null } },
      select: {
        id: true,
        publishedVersionId: true,
        versions: { select: { id: true, contentVersion: true, payload: true, publishedAt: true } },
      },
    }),
    viewerId ? db.user.findUnique({ where: { id: viewerId }, select: { createdAt: true } }) : null,
  ])
  if (viewerId && !viewer) throw new DataAccessError(401, 'AUTH_REQUIRED', '请先登录后再继续。')

  const now = Date.now()
  let nextBoundary = Infinity
  const items: AnnouncementNotification[] = []
  for (const document of documents) {
    const version = document.versions.find(candidate => candidate.id === document.publishedVersionId)
    if (!version) continue
    const { title, body, startsAt, endsAt } = publishedAnnouncementSchema.parse(version.payload)
    const availableAt = Math.max(version.publishedAt.getTime(), Date.parse(startsAt))
    if (endsAt !== null && availableAt >= Date.parse(endsAt)) continue
    if (availableAt > now) {
      nextBoundary = Math.min(nextBoundary, availableAt)
      continue
    }
    items.push({
      id: document.id,
      versionId: version.id,
      contentVersion: version.contentVersion,
      title,
      body,
      publishedAt: new Date(availableAt).toISOString(),
      unread: Boolean(viewer && availableAt >= viewer.createdAt.getTime()),
    })
  }

  const candidates = items.filter(item => item.unread).map(item => item.versionId)
  if (viewerId && candidates.length) {
    const reads = await db.siteAnnouncementRead.findMany({
      where: { userId: viewerId, versionId: { in: candidates } },
      select: { versionId: true },
    })
    const readIds = new Set(reads.map(read => read.versionId))
    for (const item of items) if (readIds.has(item.versionId)) item.unread = false
  }
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.versionId.localeCompare(a.versionId))
  const personal = viewerId && includePersonal
    ? await db.userNotification.findMany({
      where: { userId: viewerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, title: true, body: true, createdAt: true, readAt: true },
    })
    : null
  return {
    viewerId,
    ...(personal && { personalItems: personal.map(({ createdAt, readAt, ...item }) => ({
      ...item, publishedAt: createdAt.toISOString(), unread: readAt === null,
    })) }),
    serverNow: new Date(now).toISOString(),
    nextBoundaryAt: Number.isFinite(nextBoundary) ? new Date(nextBoundary).toISOString() : null,
    items,
  }
}

export async function markAnnouncementsRead(
  userId: string,
  input: ReadAnnouncementsRequest,
): Promise<ReadAnnouncementsResult> {
  if (input.viewerId !== userId) throw new DataAccessError(409, 'ANNOUNCEMENT_VIEWER_CHANGED', '登录账号已变更，请刷新后重试。')
  if (input.action === 'personal') {
    const updated = await prisma.userNotification.updateMany({
      where: { id: input.notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { readVersionIds: [], readNotificationIds: updated.count ? [input.notificationId] : [] }
  }
  return prisma.$transaction(async tx => {
    const { items, serverNow } = await readAnnouncementInbox(userId, tx, false)
    const readVersionIds = items
      .filter(item => item.unread && (input.action !== 'one' || item.versionId === input.versionId))
      .map(item => item.versionId)
    if (readVersionIds.length) {
      await tx.siteAnnouncementRead.createMany({
        data: readVersionIds.map(versionId => ({ userId, versionId })),
        skipDuplicates: true,
      })
    }
    if (input.action !== 'allNotifications') return { readVersionIds }
    const cutoff = new Date(serverNow)
    const updated = await tx.userNotification.updateManyAndReturn({
      where: { userId, readAt: null, createdAt: { lte: cutoff } },
      data: { readAt: cutoff },
      select: { id: true },
    })
    return { readVersionIds, readNotificationIds: updated.map(item => item.id) }
  })
}
