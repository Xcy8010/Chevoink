import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { verifyTestDatabase } from '../support/database-preflight.js'

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
})
