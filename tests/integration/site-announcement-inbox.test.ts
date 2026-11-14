import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { assertAnnouncementReadsState, readAnnouncementReadsState, assertUserNotificationsState, readUserNotificationsState } from '../../scripts/verify-release-migration.mjs'

const ready = await verifyTestDatabase(isTestDatabaseRequired())

describe.skipIf(!ready)('announcement inbox with isolated PostgreSQL', () => {
  it('persists one receipt across concurrent writes and keeps a subsequent publication unread', async () => {
    const { prisma } = await import('../../api/lib/prisma.js')
    const { markAnnouncementsRead, readAnnouncementInbox } = await import('../../api/lib/site-announcement-inbox.js')
    const authorId = randomUUID()
    const otherId = randomUUID()
    const contentId = randomUUID()
    const now = Date.now()
    const date = (offset: number) => new Date(now + offset)
    const payload = {
      title: '合成公告', body: '公告回归数据', scope: 'both',
      startsAt: date(-30_000).toISOString(), endsAt: null, dismissal: { mode: 'version' },
    }
    try {
      const catalog = await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
        return {
          announcementReads: await readAnnouncementReadsState(tx, 'after'),
          userNotifications: await readUserNotificationsState(tx, 'after'),
        }
      })
      const empty = { tables: [], columns: [], indexes: [], constraints: [], rowCount: null }
      // A CI shard already runs application fixtures on this migrated database.
      // Check the real catalog and exercise initial-row rejection independently.
      const reads = { ...catalog.announcementReads, rowCount: 0 }
      const notifications = { ...catalog.userNotifications, rowCount: 0 }
      assertAnnouncementReadsState(reads, 'after', empty)
      assertUserNotificationsState(notifications, 'after', empty)
      expect(() => assertAnnouncementReadsState({ ...reads, rowCount: 1 }, 'after', empty)).toThrow(/rowCount/)
      expect(() => assertUserNotificationsState({ ...notifications, rowCount: 1 }, 'after', empty)).toThrow(/rowCount/)
      await prisma.user.createMany({ data: [
        { id: authorId, nickname: '合成账号 A', passwordHash: 'unusable', createdAt: date(-60_000) },
        { id: otherId, nickname: '合成账号 B', passwordHash: 'unusable', createdAt: date(-45_000) },
      ] })
      await prisma.siteContent.create({ data: { id: contentId, kind: 'announcement', key: contentId, draft: payload } })
      const publish = async (contentVersion: number) => {
        const publication = await prisma.siteContentVersion.create({ data: {
          contentId, contentVersion, payload, hash: 'synthetic-fixture', publishedAt: date(-20_000 + contentVersion),
        } })
        await prisma.siteContent.update({ where: { id: contentId }, data: { publishedVersionId: publication.id } })
        return publication.id
      }
      const first = await publish(1)
      const mark = { viewerId: authorId, action: 'one', versionId: first } as const
      await Promise.all([markAnnouncementsRead(authorId, mark), markAnnouncementsRead(authorId, mark)])
      expect(await prisma.siteAnnouncementRead.count({ where: { userId: authorId, versionId: first } })).toBe(1)
      expect((await readAnnouncementInbox(authorId)).items.find(item => item.id === contentId)?.unread).toBe(false)
      expect((await readAnnouncementInbox(otherId)).items.find(item => item.id === contentId)?.unread).toBe(true)

      const second = await publish(2)
      expect((await readAnnouncementInbox(authorId)).items.find(item => item.id === contentId)).toMatchObject({ versionId: second, unread: true })
    } finally {
      await prisma.siteContentVersion.deleteMany({ where: { contentId } })
      await prisma.siteContent.deleteMany({ where: { id: contentId } })
      await prisma.user.deleteMany({ where: { id: { in: [authorId, otherId] } } })
      await prisma.$disconnect()
    }
  })

  it('delivers each committed credit change once, with owner-only list and read actions', async () => {
    const { prisma } = await import('../../api/lib/prisma.js')
    const { markAnnouncementsRead, readAnnouncementInbox } = await import('../../api/lib/site-announcement-inbox.js')
    const { adjustAdminBonusCredits } = await import('../../api/lib/admin-credit-adjustment.js')
    const { resetAdminUsersCredits, setAdminUsersSuspended } = await import('../../api/lib/admin-credit-model.js')
    const userId = randomUUID(), otherId = randomUUID(), adminId = randomUUID()
    try {
      await prisma.user.createMany({ data: [
        { id: userId, nickname: '合成收件人', passwordHash: 'unusable' },
        { id: otherId, nickname: '合成其他用户', passwordHash: 'unusable' },
        { id: adminId, nickname: '合成管理员', passwordHash: 'unusable', role: 'admin', isSuperAdmin: true },
      ] })
      const gift = { mode: 'add' as const, amountMilli: 500_000, expectedBonusBalanceMilli: 0, reason: '仅供后台测试的内部备注', requestKey: randomUUID() }
      await Promise.all([adjustAdminBonusCredits(adminId, userId, gift), adjustAdminBonusCredits(adminId, userId, gift)])
      const reset = randomUUID()
      await resetAdminUsersCredits([userId], adminId, reset)
      await resetAdminUsersCredits([userId], adminId, reset)
      await setAdminUsersSuspended([userId], false)
      await setAdminUsersSuspended([userId], true)
      await setAdminUsersSuspended([userId], true)
      await setAdminUsersSuspended([userId], false)

      const recipient = await readAnnouncementInbox(userId)
      const privateItems = recipient.personalItems!
      expect(privateItems.map(item => item.title).sort()).toEqual(['你收到了奖励额度', '每日额度已重置', '账户额度已暂停', '账户额度已恢复'].sort())
      expect(privateItems.every(item => item.unread)).toBe(true)
      expect(JSON.stringify(privateItems)).not.toContain(gift.reason)
      expect((await readAnnouncementInbox(otherId)).personalItems).toEqual([])
      expect((await readAnnouncementInbox(null)).personalItems).toBeUndefined()
      const notificationId = privateItems[0].id
      expect(await markAnnouncementsRead(otherId, { viewerId: otherId, action: 'personal', notificationId })).toEqual({ readVersionIds: [], readNotificationIds: [] })
      await expect(markAnnouncementsRead(otherId, { viewerId: userId, action: 'allNotifications' })).rejects.toMatchObject({ code: 'ANNOUNCEMENT_VIEWER_CHANGED' })
      await markAnnouncementsRead(userId, { viewerId: userId, action: 'all' })
      expect((await readAnnouncementInbox(userId)).personalItems?.filter(item => item.unread)).toHaveLength(4)
      const result = await markAnnouncementsRead(userId, { viewerId: userId, action: 'personal', notificationId })
      expect(result.readNotificationIds).toEqual([notificationId])
      const all = await markAnnouncementsRead(userId, { viewerId: userId, action: 'allNotifications' })
      expect(all.readNotificationIds).toHaveLength(3)
      expect((await readAnnouncementInbox(userId)).personalItems?.every(item => !item.unread)).toBe(true)
    } finally {
      await prisma.adminAuditLog.deleteMany({ where: { adminId } })
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherId, adminId] } } })
      await prisma.$disconnect()
    }
  })
})
