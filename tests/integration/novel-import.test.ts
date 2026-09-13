import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { maintainNovelImports } from '../../api/lib/novel-import-maintenance.js'
import { readImportBlob } from '../../api/lib/novel-import-storage.js'

// Identity, host allowlist AND least-privilege role are verified, not just a name.
// Missing migrations on a reachable verified DB fail the suite; never catch/skip.
const available = await verifyTestDatabase(isTestDatabaseRequired())
const userId = randomUUID(), otherUserId = randomUUID()
const novelIds: string[] = []
const storageKeys: string[] = []
let novelId = '', directory = ''
const cookie = (owner = userId) => `chevoink_session=${buildSessionTokens(owner, 0).accessToken}`
const base = () => `/api/novels/${novelId}/imports`

async function prepare() {
  const preflight = await request(app).post(`${base()}/preflight`).set('Cookie', cookie()).send({})
  expect(preflight.status).toBe(200)
  const create = await request(app).post(base()).set('Cookie', cookie()).send({ intentId: preflight.body.data.intentId })
  expect(create.status).toBe(200)
  const jobId: string = create.body.data.jobId
  const upload = await request(app).put(`${base()}/${jobId}/source?filename=book.txt`).set('Cookie', cookie()).type('application/octet-stream').send(Buffer.from('第一章 起点\n这是作者拥有的测试正文。\n\n第二章 远行\n这是第二章的独立原文。'))
  expect(upload.status).toBe(200)
  const analyze = await request(app).post(`${base()}/${jobId}/analyze`).set('Cookie', cookie()).send({})
  expect(analyze.status).toBe(200)
  await vi.waitFor(async () => expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('ready'), { timeout: 10_000 })
  const preview = await request(app).get(`${base()}/${jobId}/preview`).set('Cookie', cookie())
  expect(preview.status).toBe(200)
  return { jobId, preview: preview.body.data, targetHash: preflight.body.data.targetHash as string }
}
async function approve() {
  const prepared = await prepare()
  const grant = await request(app).post(`${base()}/${prepared.jobId}/confirm`).set('Cookie', cookie()).send({ manifestRevision: prepared.preview.manifestRevision, manifestHash: prepared.preview.manifestHash, targetHash: prepared.targetHash })
  expect(grant.status).toBe(200)
  return { ...prepared, input: { approvalId: grant.body.data.approvalId as string, idempotencyKey: randomUUID() } }
}

afterAll(async () => {
  try {
    if (available) {
      // Record referenced blobs before normal deletion cascades queue them.
      const sources = await prisma.novelImportSource.findMany({ where: { job: { userId } }, select: { storageKey: true } })
      const manifests = await prisma.novelImportManifest.findMany({ where: { job: { userId } }, select: { storageKey: true } })
      storageKeys.push(...sources.map(row => row.storageKey), ...manifests.map(row => row.storageKey))
      await prisma.chapter.deleteMany({ where: { novelId: { in: novelIds }, authorId: userId } })
      await prisma.volume.deleteMany({ where: { novelId: { in: novelIds } } })
      await prisma.novel.deleteMany({ where: { id: { in: novelIds }, authorId: userId } })
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
      await prisma.novelImportGarbage.deleteMany({ where: { storageKey: { in: storageKeys } } })
    }
    if (directory) {
      if (!path.resolve(directory).startsWith(path.join(os.tmpdir(), 'novel-import-db-test-'))) throw new Error('unsafe fixture cleanup')
      for (const filename of await readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.blob$/.test(filename)) throw new Error('unexpected fixture file')
        await unlink(path.join(directory, filename))
      }
      await rmdir(directory)
    }
  } finally { vi.unstubAllEnvs(); await prisma.$disconnect() }
})

describe.skipIf(!available)('staged novel import actual PostgreSQL transactions', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'novel-import-db-test-'))
    vi.stubEnv('NOVEL_IMPORT_STORAGE_DIR', directory)
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
    vi.stubEnv('NOVEL_IMPORT_OVERWRITE_ENABLED', 'true') // still hardlocked in code
    await prisma.user.createMany({ data: [userId, otherUserId].map(id => ({ id, nickname: 'import-fixture', passwordHash: 'fixture-only' })) })
  })
  beforeEach(async () => {
    novelId = randomUUID(); novelIds.push(novelId)
    // A true zero-volume/zero-chapter fixture, unlike ordinary new-work defaults.
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '导入测试作品', slug: randomUUID(), summary: '原简介', visibility: 'private' } })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    // Release only this test owner's unfinished jobs; exercise the real quota
    // rather than weakening admission limits to accommodate shared fixtures.
    const jobs = await prisma.novelImportJob.findMany({ where: { userId, status: { notIn: ['succeeded', 'cancelled'] } }, select: { id: true, novelId: true } })
    for (const job of jobs) await request(app).post(`/api/novels/${job.novelId}/imports/${job.id}/cancel`).set('Cookie', cookie()).send({})
  })

  it('concurrent duplicate commit has one atomic receipt, backup and contiguous private draft tree', async () => {
    const usageBefore = await prisma.aiUsageLog.count({ where: { userId } })
    const ledgerBefore = await prisma.creditLedgerEntry.count({ where: { userId } })
    const ready = await approve()
    const send = () => request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    const [a, b] = await Promise.all([send(), send()])
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(a.body.data).toEqual(b.body.data)
    expect(await prisma.novelImportCommit.count({ where: { jobId: ready.jobId } })).toBe(1)
    expect(await prisma.novelImportBackup.count({ where: { jobId: ready.jobId } })).toBe(1)
    const chapters = await prisma.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    expect(chapters.map(chapter => chapter.orderIndex)).toEqual(chapters.map((_chapter, index) => index + 1))
    expect(chapters.every(chapter => chapter.authorId === userId && chapter.status === 'draft' && chapter.publishedContent === null && chapter.archivedAt === null)).toBe(true)
    expect((await prisma.novel.findUniqueOrThrow({ where: { id: novelId } })).summary).toBe('原简介')
    expect((await request(app).post(`${base()}/${ready.jobId}/cancel`).set('Cookie', cookie()).send({})).body.data.status).toBe('succeeded')
    expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(usageBefore)
    expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(ledgerBefore)
  })
  it('preview edits invalidate old grants and preserve an unchanged empty work', async () => {
    const ready = await approve()
    ready.preview.volumes[0].title = '用户改名'
    const edit = await request(app).patch(`${base()}/${ready.jobId}/manifest`).set('Cookie', cookie()).send({ expectedManifestRevision: ready.preview.manifestRevision, volumes: ready.preview.volumes })
    expect(edit.status).toBe(200)
    expect(edit.body.data.manifestRevision).toBe(ready.preview.manifestRevision + 1)
    const result = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('IMPORT_PREVIEW_CHANGED')
    expect(await prisma.chapter.count({ where: { novelId } })).toBe(0)
    expect(await prisma.novelImportBackup.count({ where: { jobId: ready.jobId } })).toBe(0)
    expect((await prisma.novelImportApproval.findUniqueOrThrow({ where: { id: ready.input.approvalId } })).consumedAt).toBeNull()
  })
  it('expired human approval fails closed without consuming it', async () => {
    const ready = await approve()
    await prisma.novelImportApproval.update({ where: { id: ready.input.approvalId }, data: { expiresAt: new Date(0) } })
    const result = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('IMPORT_APPROVAL_EXPIRED')
    expect(await prisma.chapter.count({ where: { novelId } })).toBe(0)
  })
  it('changed target baseline invalidates the grant rather than overwriting the edit', async () => {
    const ready = await approve()
    await prisma.novel.update({ where: { id: novelId }, data: { summary: '导入期间的新修改' } })
    const result = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(result.body.error.code).toBe('IMPORT_TARGET_CHANGED')
    expect(await prisma.chapter.count({ where: { novelId } })).toBe(0)
    expect((await prisma.novel.findUniqueOrThrow({ where: { id: novelId } })).summary).toBe('导入期间的新修改')
  })
  it('cancel/commit race reports the database winner and never a half-written book', async () => {
    const ready = await approve()
    await Promise.all([
      request(app).post(`${base()}/${ready.jobId}/cancel`).set('Cookie', cookie()).send({}),
      request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input),
    ])
    const job = await prisma.novelImportJob.findUniqueOrThrow({ where: { id: ready.jobId } })
    const commit = await prisma.novelImportCommit.findUnique({ where: { jobId: ready.jobId } })
    expect(['succeeded', 'cancelled']).toContain(job.status)
    expect(Boolean(commit)).toBe(job.status === 'succeeded')
    expect(await prisma.chapter.count({ where: { novelId } })).toBe(job.status === 'succeeded' ? ready.preview.volumes.reduce((n: number, v: { chapters: unknown[] }) => n + v.chapters.length, 0) : 0)
  })
  it('unauthorized reads and restore-off remain failclosed after a successful import', async () => {
    const ready = await approve()
    expect((await request(app).get(`${base()}/${ready.jobId}/preview`).set('Cookie', cookie(otherUserId))).status).toBe(404)
    expect((await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)).status).toBe(200)
    expect((await request(app).post(`${base()}/${ready.jobId}/restore-preview`).set('Cookie', cookie()).send({})).body.error.code).toBe('IMPORT_RESTORE_DISABLED')
    expect((await request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send({ restoreApprovalId: randomUUID(), targetHash: ready.targetHash })).body.error.code).toBe('IMPORT_RESTORE_DISABLED')
    expect(await prisma.chapter.count({ where: { novelId, archivedAt: { not: null } } })).toBe(0)
  })
  it('normal whole-work deletion cascades preview jobs and queues exact private blob keys', async () => {
    const ready = await prepare()
    const source = await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId: ready.jobId } })
    const manifest = await prisma.novelImportManifest.findMany({ where: { jobId: ready.jobId } })
    storageKeys.push(source.storageKey, ...manifest.map(row => row.storageKey))
    await prisma.novel.delete({ where: { id: novelId } })
    expect(await prisma.novelImportJob.findUnique({ where: { id: ready.jobId } })).toBeNull()
    expect(await prisma.novelImportGarbage.findUnique({ where: { storageKey: source.storageKey } })).not.toBeNull()
  })
  it('active partial indexes permit retained rows but still reject duplicate active positions', async () => {
    const archivedId = randomUUID()
    await prisma.volume.create({ data: { id: archivedId, novelId, title: '旧卷', orderIndex: 1, archivedAt: new Date(), archivedByImportId: randomUUID() } })
    await prisma.volume.create({ data: { novelId, title: '当前卷', orderIndex: 1 } })
    await expect(prisma.volume.create({ data: { novelId, title: '冲突卷', orderIndex: 1 } })).rejects.toMatchObject({ code: 'P2002' })
    expect(await prisma.volume.count({ where: { novelId } })).toBe(2)
    expect((await prisma.volume.findUniqueOrThrow({ where: { id: archivedId } })).title).toBe('旧卷')
  })
  it('retains a normal empty default volume without updating its identity, revision or archive fields', async () => {
    const original = await prisma.volume.create({ data: { novelId, title: '第一卷', orderIndex: 1 } })
    const ready = await approve()
    expect(ready.preview.warnings).toContainEqual(expect.objectContaining({ code: 'IMPORT_EMPTY_VOLUMES_RETAINED', blocking: false }))
    const result = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(result.status).toBe(200)
    expect(await prisma.volume.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original)
    const imported = await prisma.volume.findMany({ where: { novelId, id: { not: original.id } }, orderBy: { orderIndex: 'asc' } })
    expect(imported[0].orderIndex).toBe(2)
    expect(await prisma.volume.count({ where: { novelId, archivedAt: { not: null } } })).toBe(0)
  })
  it('explicit encoding reanalysis preserves the original source and expires old human grants', async () => {
    const ready = await approve()
    const sourceBefore = await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId: ready.jobId } })
    const implicit = await request(app).post(`${base()}/${ready.jobId}/analyze`).set('Cookie', cookie()).send({})
    expect(implicit.status).toBe(409)
    const reparse = await request(app).post(`${base()}/${ready.jobId}/analyze`).set('Cookie', cookie()).send({ encoding: 'utf-8' })
    expect(reparse.status).toBe(200)
    await vi.waitFor(async () => expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { id: ready.jobId } })).manifestRevision).toBe(ready.preview.manifestRevision + 1), { timeout: 10_000 })
    expect(await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId: ready.jobId } })).toEqual(sourceBefore)
    expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { id: ready.jobId } })).parseEncoding).toBe('utf-8')
    const old = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(old.status).toBe(409)
    expect(old.body.error.code).toBe('IMPORT_APPROVAL_EXPIRED')
    expect(await prisma.chapter.count({ where: { novelId } })).toBe(0)
  })
  it('TTL maintenance expires old uncommitted sources but preserves committed/backup source references', async () => {
    const ready = await prepare()
    const abandonedSource = await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId: ready.jobId } })
    const committed = await prisma.novelImportJob.findFirstOrThrow({ where: { userId, status: 'succeeded' }, include: { source: true, backup: true } })
    const old = new Date(Date.now() - 8 * 86400_000)
    await prisma.novelImportJob.updateMany({ where: { id: { in: [ready.jobId, committed.id] } }, data: { createdAt: old, expiresAt: old } })
    // Simulate the API crashing mid-parse before the seven-day expiry.
    await prisma.novelImportJob.update({ where: { id: ready.jobId }, data: { status: 'parsing', leaseOwner: randomUUID(), leaseUntil: old, leaseEpoch: { increment: 1 } } })
    // Scope this tick to our exact UUIDs: concurrent suites' old fixtures and
    // unrelated garbage must not be processed by this integration test.
    const result = await maintainNovelImports({ jobIds: [ready.jobId, committed.id] })
    expect(result.expiredJobs).toBeGreaterThanOrEqual(1)
    expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { id: ready.jobId } })).status).toBe('expired')
    expect(await prisma.novelImportSource.findUnique({ where: { jobId: ready.jobId } })).toBeNull()
    expect(await prisma.novelImportManifest.count({ where: { jobId: ready.jobId } })).toBe(0)
    expect(await prisma.novelImportGarbage.findUnique({ where: { storageKey: abandonedSource.storageKey } })).toBeNull()
    await expect(readImportBlob(abandonedSource.storageKey, abandonedSource.sha256)).rejects.toThrow()
    expect(await prisma.novelImportSource.findUnique({ where: { jobId: committed.id } })).toEqual(committed.source)
    expect(await prisma.novelImportBackup.findUnique({ where: { jobId: committed.id } })).toEqual(committed.backup)
    expect((await readImportBlob(committed.source!.storageKey, committed.source!.sha256)).length).toBeGreaterThan(0)
  })
  it('concurrent preview saves allocate one new blob, prune history, and stop at the hard revision cap', async () => {
    const ready = await prepare()
    const before = (await readdir(directory)).length
    const body = { expectedManifestRevision: 1, volumes: ready.preview.volumes }
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(app).patch(`${base()}/${ready.jobId}/manifest`).set('Cookie', cookie()).send(body)))
    expect(responses.filter(response => response.status === 200)).toHaveLength(1)
    expect(responses.every(response => [200, 409, 429].includes(response.status))).toBe(true)
    expect((await readdir(directory)).length).toBe(before + 1)
    expect(await prisma.novelImportManifest.count({ where: { jobId: ready.jobId } })).toBe(2)
    for (let revision = 2; revision < 5; revision++) {
      expect((await request(app).patch(`${base()}/${ready.jobId}/manifest`).set('Cookie', cookie()).send({ ...body, expectedManifestRevision: revision })).status).toBe(200)
    }
    expect(await prisma.novelImportManifest.count({ where: { jobId: ready.jobId } })).toBe(2)
    expect((await readdir(directory)).length).toBe(before + 1)
    await prisma.novelImportJob.update({ where: { id: ready.jobId }, data: { manifestRevision: 64 } })
    const capped = await request(app).patch(`${base()}/${ready.jobId}/manifest`).set('Cookie', cookie()).send({ ...body, expectedManifestRevision: 64 })
    expect(capped.status).toBe(429)
    expect(capped.body.error.code).toBe('IMPORT_PREVIEW_LIMIT')
    expect((await readdir(directory)).length).toBe(before + 1)
  })
  it('maintenance never touches an expired parsing job with a still-live lease', async () => {
    const ready = await prepare()
    const source = await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId: ready.jobId } })
    const old = new Date(Date.now() - 8 * 86400_000)
    await prisma.novelImportJob.update({ where: { id: ready.jobId }, data: { createdAt: old, expiresAt: old, status: 'parsing', leaseOwner: randomUUID(), leaseUntil: new Date(Date.now() + 60_000), leaseEpoch: { increment: 1 } } })
    await maintainNovelImports({ jobIds: [ready.jobId] })
    expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { id: ready.jobId } })).status).toBe('parsing')
    expect(await prisma.novelImportSource.findUnique({ where: { jobId: ready.jobId } })).toEqual(source)
  })
})
