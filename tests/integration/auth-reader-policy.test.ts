import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { buildSessionTokens, evictUserBanCache } from '../../api/lib/auth-session.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const userId = randomUUID(), novelId = randomUUID(), volumeId = randomUUID()
const publishedId = randomUUID(), privateId = randomUUID(), draftId = randomUUID(), futureId = randomUUID()
const cookie = `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`
// Prisma delegates are proxy-backed; freeze their real bindings before spies so
// repeated fault injection cannot inherit a restored proxy's stale mock wrapper.
const findUser = prisma.user.findUnique.bind(prisma.user)
const revokeDevice = prisma.accountDeviceSession.updateMany.bind(prisma.accountDeviceSession)
beforeEach(() => {
  vi.spyOn(prisma.user, 'findUnique').mockImplementation(findUser)
  vi.spyOn(prisma.accountDeviceSession, 'updateMany').mockImplementation(revokeDevice)
})
afterEach(() => { vi.restoreAllMocks(); evictUserBanCache(userId) })
afterAll(async () => {
  try {
    if (available) await prisma.$transaction([
      prisma.novelRead.deleteMany({ where: { novelId } }),
      prisma.chapter.deleteMany({ where: { novelId, authorId: userId } }),
      prisma.volume.deleteMany({ where: { id: volumeId, novelId } }),
      prisma.novel.deleteMany({ where: { id: novelId, authorId: userId } }),
      prisma.user.deleteMany({ where: { id: userId } }),
    ])
  } finally { await prisma.$disconnect() }
})
describe.skipIf(!available)('R03 HTTP authentication and public-reader boundaries', () => {
  beforeAll(async () => {
    await prisma.$transaction(async tx => {
      await tx.user.create({ data: { id: userId, nickname: 'auth-reader-fixture', passwordHash: 'fixture-only', role: 'admin' } })
      await tx.novel.create({ data: { id: novelId, authorId: userId, title: 'public-fixture', slug: randomUUID(), summary: '', status: 'published', visibility: 'public' } })
      await tx.volume.create({ data: { id: volumeId, novelId, title: 'fixture-volume', orderIndex: 0 } })
      for (const [index, id] of [publishedId, privateId, draftId, futureId].entries()) {
        await tx.chapter.create({ data: {
          id, novelId, volumeId, authorId: userId, title: `chapter-${index}`, content: 'private-working-copy',
          orderIndex: index, orderInVolume: index, status: id === draftId ? 'draft' : 'published',
          visibility: id === privateId ? 'private' : 'public',
          publishedAt: id === futureId ? new Date('2099-01-01') : new Date('2020-01-01'),
          publishedRevision: id === draftId ? null : 1, publishedContent: 'public-snapshot', publishedWordCount: 15,
        } })
      }
    })
  })
  function failAuthRead() {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(prisma.user, 'findUnique').mockRejectedValueOnce(new Error('injected auth lookup failure'))
  }

  it.each(['/api/users/me', '/api/admin/me'])('returns recoverable 503 for %s, not an authenticated response or logout', async url => {
    failAuthRead()
    const res = await request(app).get(url).set('Cookie', cookie)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('AUTH_SESSION_UNAVAILABLE')
    expect(res.headers['set-cookie']).toBeUndefined()
  })
  it('rejects writes before validation/business execution when identity cannot be verified', async () => {
    failAuthRead()
    const res = await request(app).post('/api/novels').set('Cookie', cookie).send({})
    expect(res.status).toBe(503)
    expect(await prisma.novel.count({ where: { authorId: userId } })).toBe(1)
  })
  it.each(['/api/auth/logout', '/api/admin/logout'])('does not report successful revocation or clear cookies when %s fails', async url => {
    vi.spyOn(prisma.accountDeviceSession, 'updateMany').mockRejectedValueOnce(new Error('injected revocation failure'))
    const res = await request(app).post(url).set('Cookie', cookie).send({})
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('AUTH_REVOCATION_UNAVAILABLE')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).tokenVersion).toBe(0)
  })
  it('serves only the published public reader snapshot and public navigation on auth failure', async () => {
    failAuthRead()
    const res = await request(app).get(`/api/novels/${novelId}/reader/${publishedId}`).set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.data.currentChapter.content).toBe('public-snapshot')
    expect(res.body.data.chapterList.map((chapter: { id: string }) => chapter.id)).toEqual([publishedId])
    expect(res.body.data.nextChapterId).toBeNull()
    expect(await prisma.novelRead.count({ where: { novelId } })).toBe(0)
  })
  it.each([privateId, draftId, futureId])('does not expose restricted chapter %s to an anonymous reader', async chapterId => {
    const res = await request(app).get(`/api/novels/${novelId}/reader/${chapterId}`)
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('private-working-copy')
  })
  it('blocks anonymous reading after the novel is made private, preserving owner preview', async () => {
    await prisma.novel.update({ where: { id: novelId }, data: { visibility: 'private' } })
    try {
      const anonymous = await request(app).get(`/api/novels/${novelId}/reader/${publishedId}`)
      expect(anonymous.status).toBe(404)
      const owner = await request(app).get(`/api/novels/${novelId}/reader/${draftId}`).set('Cookie', cookie)
      expect(owner.status).toBe(200)
      expect(owner.body.data.currentChapter.content).toBe('private-working-copy')
    } finally { await prisma.novel.update({ where: { id: novelId }, data: { visibility: 'public' } }) }
  })
  it('does not expose an archived public novel through details or direct reader URLs', async () => {
    await prisma.novel.update({ where: { id: novelId }, data: { status: 'archived' } })
    try {
      expect((await request(app).get(`/api/novels/${novelId}`)).status).toBe(404)
      expect((await request(app).get(`/api/novels/${novelId}/reader/${publishedId}`)).status).toBe(404)
    } finally { await prisma.novel.update({ where: { id: novelId }, data: { status: 'published' } }) }
  })
  it('keeps public metadata and cached-home access anonymous during an auth lookup failure', async () => {
    // Seed only the public payload cache, never an authenticated response cache.
    expect((await request(app).get('/api/home')).status).toBe(200)
    for (const url of ['/api/home', '/api/meta']) {
      failAuthRead()
      const res = await request(app).get(url).set('Cookie', cookie)
      expect(res.status).toBe(200)
      expect(res.headers['set-cookie']).toBeUndefined()
    }
  })
  it('revokes a real v2 token before reporting a successful logout', async () => {
    const res = await request(app).post('/api/auth/logout').set('Cookie', cookie).send({})
    expect(res.status).toBe(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).tokenVersion).toBe(0)
    expect((await request(app).get('/api/admin/me').set('Cookie', cookie)).status).toBe(401)
  })
})
