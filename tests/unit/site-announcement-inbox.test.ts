import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { markAnnouncementsRead, readAnnouncementInbox } from '../../api/lib/site-announcement-inbox.js'

const db = vi.hoisted(() => ({
  users: new Map<string, Date>(),
  reads: new Set<string>(),
  documents: [] as Array<ReturnType<typeof notice>>,
  createMany: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', () => {
  const prisma = {
    user: { findUnique: async ({ where }: { where: { id: string } }) => {
      const createdAt = db.users.get(where.id)
      return createdAt ? { createdAt } : null
    } },
    siteContent: { findMany: async ({ where }: { where: { kind: string; withdrawn: boolean; deletedAt: null } }) =>
      db.documents.filter(row => row.kind === where.kind && row.withdrawn === where.withdrawn && row.deletedAt === where.deletedAt) },
    siteAnnouncementRead: {
      findMany: async ({ where }: { where: { userId: string; versionId: { in: string[] } } }) =>
        where.versionId.in.filter(id => db.reads.has(where.userId + ':' + id)).map(versionId => ({ versionId })),
      createMany: db.createMany,
    },
    userNotification: { findMany: async () => [] },
  }
  return {
    DataAccessError: class extends Error {
      constructor(public status: number, public code: string, message: string) { super(message) }
    },
    prisma: { ...prisma, $transaction: (work: (tx: typeof prisma) => unknown) => work(prisma) },
  }
})

function notice(id: string, publishedAt: string, startsAt = publishedAt, endsAt: string | null = null) {
  return {
    id, kind: 'announcement', withdrawn: false, deletedAt: null as Date | null, publishedVersionId: id + '-v1',
    versions: [{
      id: id + '-v1', contentVersion: 1, publishedAt: new Date(publishedAt),
      payload: { title: id, body: '合成公告', startsAt, endsAt, scope: 'both', dismissal: { mode: 'session' } },
    }],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-08T12:00:00.000Z'))
  db.users.clear()
  db.users.set('a', new Date('2026-11-08T09:00:00.000Z'))
  db.users.set('b', new Date('2026-11-08T10:30:00.000Z'))
  db.reads.clear()
  db.createMany.mockReset().mockImplementation(async ({ data }: { data: Array<{ userId: string; versionId: string }> }) => {
    for (const { userId, versionId } of data) db.reads.add(userId + ':' + versionId)
  })
  db.documents = [
    notice('old', '2026-11-08T08:00:00.000Z'),
    notice('expired', '2026-11-08T10:00:00.000Z', '2026-11-08T10:00:00.000Z', '2026-11-08T11:00:00.000Z'),
    notice('scheduled', '2026-11-08T08:00:00.000Z', '2026-11-08T11:00:00.000Z'),
    notice('future', '2026-11-08T08:00:00.000Z', '2026-11-08T13:00:00.000Z'),
    { ...notice('withdrawn', '2026-11-08T10:00:00.000Z'), withdrawn: true },
    { ...notice('deleted', '2026-11-08T10:00:00.000Z'), deletedAt: new Date() },
    { ...notice('draft', '2026-11-08T10:00:00.000Z'), publishedVersionId: '' },
  ]
})
afterEach(() => vi.useRealTimers())

it('orders visible history by delivery time and computes unread from account creation', async () => {
  const status = async (viewer: string | null) => (await readAnnouncementInbox(viewer)).items.map(item => [item.id, item.unread])
  expect(await status('a')).toEqual([['scheduled', true], ['expired', true], ['old', false]])
  expect(await status('b')).toEqual([['scheduled', true], ['expired', false], ['old', false]])
  expect(await status(null)).toEqual([['scheduled', false], ['expired', false], ['old', false]])
})

it('reports the next activation and does not expose a superseded version when an update is scheduled', async () => {
  const original = notice('updated', '2026-11-08T09:30:00.000Z')
  db.documents.push(original)
  await markAnnouncementsRead('a', { viewerId: 'a', action: 'one', versionId: 'updated-v1' })

  const replacement = notice('updated', '2026-11-08T11:00:00.000Z', '2026-11-08T12:30:00.000Z').versions[0]
  original.publishedVersionId = 'updated-v2'
  original.versions.push({ ...replacement, id: original.publishedVersionId, contentVersion: 2 })

  const before = await readAnnouncementInbox('a')
  expect(before.items.find(item => item.id === original.id)).toBeUndefined()
  expect(before.nextBoundaryAt).toBe('2026-11-08T12:30:00.000Z')

  vi.setSystemTime(new Date('2026-11-08T12:30:00.000Z'))
  const after = await readAnnouncementInbox('a')
  expect(after.items.find(item => item.id === original.id)).toMatchObject({ versionId: 'updated-v2', unread: true })
})

it('isolates read receipts by account and version, including concurrent retries and new publications', async () => {
  const action = { viewerId: 'a', action: 'one', versionId: 'scheduled-v1' } as const
  await Promise.all([markAnnouncementsRead('a', action), markAnnouncementsRead('a', action)])
  expect(db.reads).toEqual(new Set(['a:scheduled-v1']))
  expect(db.createMany).toHaveBeenCalledWith({ data: [{ userId: 'a', versionId: 'scheduled-v1' }], skipDuplicates: true })
  expect((await readAnnouncementInbox('b')).items[0].unread).toBe(true)
  await expect(markAnnouncementsRead('b', action)).rejects.toMatchObject({ code: 'ANNOUNCEMENT_VIEWER_CHANGED' })
  expect(await markAnnouncementsRead('a', { ...action, versionId: 'future-v1' })).toEqual({ readVersionIds: [] })
  expect(await markAnnouncementsRead('a', { viewerId: 'a', action: 'all' })).toEqual({ readVersionIds: ['expired-v1'] })
  db.documents.push(notice('new', '2026-11-08T12:00:00.000Z'))
  expect((await readAnnouncementInbox('a')).items.filter(item => item.unread).map(item => item.id)).toEqual(['new'])
})
