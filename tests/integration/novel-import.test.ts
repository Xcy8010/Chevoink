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
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { drainNovelImportEffects } from '../../api/lib/novel-import-effects.js'
import { normalizeNovelStructure } from '../../api/lib/data/volume.js'
import { zipFiles } from '../unit/novel-import-parser.fixtures.js'

// Identity, host allowlist AND least-privilege role are verified, not just a name.
// Missing migrations on a reachable verified DB fail the suite; never catch/skip.
const available = await verifyTestDatabase(isTestDatabaseRequired())
const userId = randomUUID(), otherUserId = randomUUID()
const novelIds: string[] = []
const storageKeys: string[] = []
let novelId = '', directory = ''
const cookie = (owner = userId) => `chevoink_session=${buildSessionTokens(owner, 0).accessToken}`
const base = () => `/api/novels/${novelId}/imports`

async function prepare(source: string | Buffer = '第一章 起点\n这是作者拥有的测试正文。\n\n第二章 远行\n这是第二章的独立原文。', filename = 'book.txt') {
  const preflight = await request(app).post(`${base()}/preflight`).set('Cookie', cookie()).send({})
  expect(preflight.status).toBe(200)
  if (preflight.body.data.overwriteRequired) for (const step of [1, 2]) {
    const confirmation = await request(app).post(`${base()}/intents/${preflight.body.data.intentId}/confirm`).set('Cookie', cookie()).send({ step, targetHash: preflight.body.data.targetHash })
    expect(confirmation.status).toBe(200)
  }
  const create = await request(app).post(base()).set('Cookie', cookie()).send({ intentId: preflight.body.data.intentId })
  expect(create.status).toBe(200)
  const jobId: string = create.body.data.jobId
  const upload = await request(app).put(`${base()}/${jobId}/source?filename=${filename}`).set('Cookie', cookie()).type('application/octet-stream').send(typeof source === 'string' ? Buffer.from(source) : source)
  expect(upload.status).toBe(200)
  const analyze = await request(app).post(`${base()}/${jobId}/analyze`).set('Cookie', cookie()).send({})
  expect(analyze.status, JSON.stringify(analyze.body)).toBe(200)
  await vi.waitFor(async () => expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('ready'), { timeout: 10_000 })
  const preview = await request(app).get(`${base()}/${jobId}/preview`).set('Cookie', cookie())
  expect(preview.status).toBe(200)
  return { jobId, preview: preview.body.data, targetHash: preflight.body.data.targetHash as string }
}
async function approve(source?: string | Buffer, filename?: string) {
  const prepared = await prepare(source, filename)
  const grant = await request(app).post(`${base()}/${prepared.jobId}/confirm`).set('Cookie', cookie()).send({ manifestRevision: prepared.preview.manifestRevision, manifestHash: prepared.preview.manifestHash, targetHash: prepared.targetHash })
  expect(grant.status).toBe(200)
  return { ...prepared, input: { approvalId: grant.body.data.approvalId as string, idempotencyKey: randomUUID() } }
}
async function restoreApproval(jobId: string) {
  const impact = await request(app).get(`${base()}/${jobId}/restore-preview`).set('Cookie', cookie())
  expect(impact.status).toBe(200); expect(impact.body.data.canRestore).toBe(true)
  const grant = await request(app).post(`${base()}/${jobId}/restore-confirm`).set('Cookie', cookie()).send({ targetHash: impact.body.data.currentTargetHash })
  expect(grant.status).toBe(200)
  return { restoreApprovalId: grant.body.data.restoreApprovalId as string, targetHash: grant.body.data.targetHash as string, idempotencyKey: randomUUID() }
}

afterAll(async () => {
  try {
    if (available) {
      // Record referenced blobs before normal deletion cascades queue them.
      const sources = await prisma.novelImportSource.findMany({ where: { job: { userId } }, select: { storageKey: true } })
      const manifests = await prisma.novelImportManifest.findMany({ where: { job: { userId } }, select: { storageKey: true } })
      const artifacts = await prisma.novelImportArtifact.findMany({ where: { job: { userId } }, select: { storageKey: true } })
      storageKeys.push(...sources.map(row => row.storageKey), ...manifests.map(row => row.storageKey), ...artifacts.map(row => row.storageKey))
      // The published-overwrite assertion may fail before its inline cleanup.
      // Restrict cleanup to novels actually owned by this suite, even on failure.
      await prisma.projectMemoryEntry.deleteMany({ where: { novelId: { in: novelIds }, novel: { authorId: userId } } })
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
    vi.stubEnv('NOVEL_IMPORT_OVERWRITE_ENABLED', 'true')
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
    try {
      for (const job of jobs) {
        const cancelled = await request(app).post(`/api/novels/${job.novelId}/imports/${job.id}/cancel`).set('Cookie', cookie()).send({})
        expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
      }
    } finally {
      // Fencing is fixture cleanup, not a bypass in admission. Even a failed
      // cancel assertion must not strand this suite's synthetic global lease.
      await prisma.novelImportJob.updateMany({ where: { userId, status: { notIn: ['succeeded', 'cancelled'] } }, data: { status: 'cancelled', leaseOwner: null, leaseUntil: null, leaseEpoch: { increment: 1 } } })
    }
    // This suite exercises >10 logical imports. Age only its own finished
    // fixtures outside the rolling admission window instead of weakening limits.
    await prisma.novelImportJob.updateMany({ where: { userId, status: { in: ['succeeded', 'cancelled'] } }, data: { createdAt: new Date(Date.now() - 2 * 86400_000) } })
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
    const projections = await Promise.all([drainNovelImportEffects({ jobIds: [ready.jobId] }), drainNovelImportEffects({ jobIds: [ready.jobId] })])
    expect(projections.reduce((sum, result) => sum + result.processed, 0)).toBe(1)
    expect(projections.every(result => !result.failed)).toBe(true)
    expect(await prisma.novelImportEvent.count({ where: { jobId: ready.jobId, kind: 'imported' } })).toBe(1)
    expect((await request(app).get(`${base()}/${ready.jobId}`).set('Cookie', cookie())).body.data.effects).toMatchObject({ status: 'published', kind: 'imported' })
  })
  it('preview edits invalidate old grants and preserve an unchanged empty work', async () => {
    const ready = await approve()
    ready.preview.volumes[0].title = '用户改名'
    const edit = await request(app).patch(`${base()}/${ready.jobId}/manifest`).set('Cookie', cookie()).send({ expectedManifestRevision: ready.preview.manifestRevision, volumes: ready.preview.volumes })
    expect(edit.status).toBe(200)
    expect(edit.body.data.manifestRevision).toBe(ready.preview.manifestRevision + 1)
    const result = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('IMPORT_APPROVAL_EXPIRED')
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
  it('unauthorized reads and restore without separate human approval remain failclosed', async () => {
    const ready = await approve()
    expect((await request(app).get(`${base()}/${ready.jobId}/preview`).set('Cookie', cookie(otherUserId))).status).toBe(404)
    expect((await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)).status).toBe(200)
    expect((await request(app).get(`${base()}/${ready.jobId}/restore-preview`).set('Cookie', cookie(otherUserId))).status).toBe(404)
    expect((await request(app).post(`${base()}/${ready.jobId}/restore-preview`).set('Cookie', cookie()).send({})).body.error.code).toBe('IMPORT_INPUT_INVALID')
    expect((await request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send({ restoreApprovalId: randomUUID(), targetHash: ready.targetHash, idempotencyKey: randomUUID() })).body.error.code).toBe('IMPORT_APPROVAL_REQUIRED')
    expect(await prisma.chapter.count({ where: { novelId, archivedAt: { not: null } } })).toBe(0)
  })
  it('normal whole-work deletion cascades preview jobs and queues exact private blob keys', async () => {
    const ready = await prepare()
    const source = await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId: ready.jobId } })
    const manifest = await prisma.novelImportManifest.findMany({ where: { jobId: ready.jobId } })
    const artifacts = await prisma.novelImportArtifact.findMany({ where: { jobId: ready.jobId } })
    storageKeys.push(source.storageKey, ...manifest.map(row => row.storageKey), ...artifacts.map(row => row.storageKey))
    await prisma.novel.delete({ where: { id: novelId } })
    expect(await prisma.novelImportJob.findUnique({ where: { id: ready.jobId } })).toBeNull()
    expect(await prisma.novelImportGarbage.findUnique({ where: { storageKey: source.storageKey } })).not.toBeNull()
    for (const artifact of artifacts) expect(await prisma.novelImportGarbage.findUnique({ where: { storageKey: artifact.storageKey } })).not.toBeNull()
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
    expect(imported).toEqual([])
    expect(await prisma.chapter.count({ where: { novelId, volumeId: original.id, archivedAt: null } })).toBe(2)
    expect(await prisma.volume.count({ where: { novelId, archivedAt: { not: null } } })).toBe(0)
  })
  it.each([1, 3])('renames the empty default volume at revision %s and restores the old name', async revision => {
    const original = await prisma.volume.create({ data: { novelId, title: '第一卷', orderIndex: 1, revision } })
    const ready = await approve('第一章 合成起点\n仅供测试的合成正文。')
    // Synthetic preview rename models the unnumbered ZIP directory without private source text.
    const edited = await request(app).patch(`${base()}/${ready.jobId}/manifest`).set('Cookie', cookie()).send({ expectedManifestRevision: ready.preview.manifestRevision, volumes: ready.preview.volumes.map((v: { chapters: unknown[] }) => ({ title: '淬火', chapters: v.chapters })), metadataSelection: {} })
    expect(edited.status, JSON.stringify(edited.body)).toBe(200)
    const preview = edited.body.data
    const grant = await request(app).post(`${base()}/${ready.jobId}/confirm`).set('Cookie', cookie()).send({ manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, targetHash: ready.targetHash })
    expect(grant.status).toBe(200)
    const committed = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send({ approvalId: grant.body.data.approvalId, idempotencyKey: randomUUID() })
    expect(committed.status, JSON.stringify(committed.body)).toBe(200)
    expect(await prisma.volume.findMany({ where: { novelId, archivedAt: null } })).toEqual([expect.objectContaining({ id: original.id, title: '淬火', orderIndex: 1, revision: revision + 1 })])
    const restored = await request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send(await restoreApproval(ready.jobId))
    expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    expect(await prisma.volume.findMany({ where: { novelId, archivedAt: null } })).toEqual([expect.objectContaining({ id: original.id, title: '第一卷', orderIndex: 1, revision: revision + 2 })])
    expect(await prisma.chapter.count({ where: { novelId, archivedAt: null } })).toBe(0)
  })
  it('imports an unnumbered export ZIP into the actual newly-created and normalized default volume', async () => {
    const created = await request(app).post('/api/novels').set('Cookie', cookie()).send({ title: `新建链路-${randomUUID()}`, summary: '合成测试作品', visibility: 'private', status: 'draft', tags: [] })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    novelId = created.body.data.novel.id; novelIds.push(novelId)
    const listed = await request(app).get(`/api/novels/${novelId}/volumes`).set('Cookie', cookie())
    expect(listed.status).toBe(200)
    await prisma.$transaction(tx => normalizeNovelStructure(tx, novelId))
    const original = await prisma.volume.findFirstOrThrow({ where: { novelId, archivedAt: null } })
    expect(original).toMatchObject({ title: '第一卷', orderIndex: 1, revision: 1, summary: null })
    const source = zipFiles(Object.fromEntries([1, 2, 3, 4].map(n => [`正文/淬火/第${String(n).padStart(4, '0')}章 合成${n}.txt`, `仅供回归测试的合成正文${n}。`])))
    const ready = await approve(source, 'synthetic.zip')
    const committed = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(committed.status, JSON.stringify(committed.body)).toBe(200)
    expect(await prisma.volume.findMany({ where: { novelId, archivedAt: null } })).toEqual([expect.objectContaining({ id: original.id, title: '淬火', orderIndex: 1 })])
    expect(await prisma.chapter.count({ where: { novelId, volumeId: original.id, archivedAt: null } })).toBe(4)
  })
  it('repairs the historical empty first volume during reimport and restores exact original structure', async () => {
    const first = await prisma.volume.create({ data: { novelId, title: '第一卷', orderIndex: 1 } })
    const second = await prisma.volume.create({ data: { novelId, title: '淬火', orderIndex: 2 } })
    const old = await prisma.chapter.create({ data: { novelId, authorId: userId, volumeId: second.id, title: '起点', content: '合成旧正文', orderIndex: 1, orderInVolume: 1 } })
    await prisma.novel.update({ where: { id: novelId }, data: { chapterCount: 1, wordCount: old.content.length, lastChapterTitle: old.title } })
    const ready = await approve(zipFiles({ '正文/淬火/第0001章 起点.txt': '合成更新正文。' }), 'synthetic.zip')
    const committed = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(committed.status, JSON.stringify(committed.body)).toBe(200)
    expect(await prisma.volume.findMany({ where: { novelId, archivedAt: null } })).toEqual([expect.objectContaining({ id: second.id, orderIndex: 1, title: '淬火' })])
    expect(await prisma.volume.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ archivedAt: expect.any(Date), archivedByImportId: ready.jobId })
    const restored = await request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send(await restoreApproval(ready.jobId))
    expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    expect((await prisma.volume.findMany({ where: { novelId, archivedAt: null }, orderBy: { orderIndex: 'asc' } })).map(v => [v.id, v.title, v.orderIndex])).toEqual([[first.id, first.title, 1], [second.id, second.title, 2]])
    expect(await prisma.chapter.findMany({ where: { novelId, archivedAt: null } })).toEqual([expect.objectContaining({ id: old.id, volumeId: second.id, content: old.content, orderIndex: 1, orderInVolume: 1 })])
  })
  it('reuses the first volume, isolates namesakes in the second, and restores unique chapter positions', async () => {
    const first = await prisma.volume.create({ data: { novelId, title: '第一卷', orderIndex: 1 } })
    const second = await prisma.volume.create({ data: { novelId, title: '第二卷', orderIndex: 2 } })
    const a = await prisma.chapter.create({ data: { novelId, authorId: userId, volumeId: first.id, title: '第一章 起点', content: '第一卷旧原文', orderIndex: 1, orderInVolume: 1 } })
    const b = await prisma.chapter.create({ data: { novelId, authorId: userId, volumeId: second.id, title: '第一章 起点', content: '第二卷独立原文', orderIndex: 2, orderInVolume: 1 } })
    await prisma.novel.update({ where: { id: novelId }, data: { chapterCount: 2, wordCount: a.content.length + b.content.length, lastChapterTitle: b.title } })
    const ready = await approve('第一卷\n第一章 起点\n第一卷更新后的原文。\n第二章 继续\n第一卷新增的正文。')
    const committed = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(committed.status, JSON.stringify(committed.body)).toBe(200)
    const active = await prisma.chapter.findMany({ where: { novelId, archivedAt: null }, orderBy: { orderIndex: 'asc' } })
    expect(active.map(c => [c.volumeId, c.orderIndex, c.orderInVolume])).toEqual([[first.id, 1, 1], [first.id, 2, 2], [second.id, 3, 1]])
    expect(active[2]).toMatchObject({ id: b.id, title: b.title, content: b.content })
    expect(await prisma.volume.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })).toEqual([first, second])
    const restored = await request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send(await restoreApproval(ready.jobId))
    expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    const originals = await prisma.chapter.findMany({ where: { novelId, archivedAt: null }, orderBy: { orderIndex: 'asc' } })
    expect(originals.map(c => [c.id, c.volumeId, c.orderIndex, c.orderInVolume, c.content])).toEqual([[a.id, first.id, 1, 1, a.content], [b.id, second.id, 2, 1, b.content]])
    expect(await prisma.volume.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })).toEqual([first, second])
  })
  it('explicit encoding reanalysis preserves the original source and expires old human grants', async () => {
    const ready = await approve()
    const sourceBefore = await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId: ready.jobId } })
    const implicit = await request(app).post(`${base()}/${ready.jobId}/analyze`).set('Cookie', cookie()).send({})
    expect(implicit.status).toBe(409)
    const reparse = await request(app).post(`${base()}/${ready.jobId}/analyze`).set('Cookie', cookie()).send({ encoding: 'utf-8' })
    expect(reparse.status, JSON.stringify(reparse.body)).toBe(200)
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
  it('published overwrite and concurrent restore preserve old identity, counters, order and snapshot', async () => {
    const volume = await prisma.volume.create({ data: { novelId, title: '公开原卷', orderIndex: 1 } })
    // Title matches the import fixture (第一章 起点) so smart-merge archives this published row by title and rebuilds it, exercising published-identity preservation across archive/restore.
    const chapter = await prisma.chapter.create({ data: { novelId, authorId: userId, volumeId: volume.id, title: '第一章 起点', content: '作者保存的旧草稿', orderIndex: 1, orderInVolume: 1, status: 'published', visibility: 'public', publishedTitle: '读者原来看到的标题', publishedContent: '读者原文', publishedRevision: 1, publishedAt: new Date('2025-01-01') } })
    await prisma.novel.update({ where: { id: novelId }, data: { chapterCount: 1, wordCount: 8, lastChapterTitle: chapter.title } })
    const memory = await prisma.projectMemoryEntry.create({ data: { novelId, sourceChapterId: chapter.id, memoryType: 'characterCard', title: '人工关联记忆', content: '这段人工内容必须保留', status: 'confirmed' } })
    const ready = await approve()
    const committed = await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)
    expect(committed.status).toBe(200)
    const archived = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })
    expect(archived).toMatchObject({ archivedAt: expect.any(Date), revision: chapter.revision + 1, title: chapter.title, volumeId: volume.id, orderIndex: 1, publishedTitle: chapter.publishedTitle, publishedContent: chapter.publishedContent, publishedAt: chapter.publishedAt })
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ content: memory.content, status: 'invalid', reviewStatus: 'pending' })
    await prisma.chapter.update({ where: { id: chapter.id }, data: { commentCount: { increment: 1 } } })
    const input = await restoreApproval(ready.jobId)
    const restore = () => request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send(input)
    const [a, b] = await Promise.all([restore(), restore()])
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(a.body.data).toEqual(b.body.data)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ archivedAt: null, revision: chapter.revision + 2, publishedContent: chapter.publishedContent, commentCount: 1 })
    expect(await prisma.chapter.count({ where: { novelId, archivedAt: null } })).toBe(1)
    expect(await prisma.chapter.count({ where: { novelId, archivedAt: { not: null } } })).toBe(2)
    expect((await prisma.novel.findUniqueOrThrow({ where: { id: novelId } })).manuscriptRevision).toBe(2)
    expect((await prisma.novelImportCommit.findUniqueOrThrow({ where: { jobId: ready.jobId } })).receipt).toEqual(committed.body.data)
    const backup = await prisma.novelImportBackup.findUniqueOrThrow({ where: { jobId: ready.jobId } })
    expect(backup).toMatchObject({ restoredApprovalId: input.restoreApprovalId, restoreIdempotencyKey: input.idempotencyKey, restoredAt: expect.any(Date) })
    await prisma.novelImportBackup.update({ where: { id: backup.id }, data: { expiresAt: new Date(0) } })
    expect((await restore()).body.data).toEqual(a.body.data)
    expect(await drainNovelImportEffects({ jobIds: [ready.jobId] })).toEqual({ processed: 1, failed: 0 })
    expect(await prisma.novelImportEvent.count({ where: { jobId: ready.jobId } })).toBe(2)
    await prisma.projectMemoryEntry.delete({ where: { id: memory.id } })
  })
  it('ordinary writer winning the shared gate makes an already-approved import fail without archival', async () => {
    const ready = await approve()
    let unlock!: () => void; let acquired!: () => void
    const locked = new Promise<void>(resolve => { acquired = resolve })
    const hold = new Promise<void>(resolve => { unlock = resolve })
    const writer = prisma.$transaction(async tx => {
      await lockNovelActiveScope(tx, novelId); acquired(); await hold
      await tx.volume.create({ data: { novelId, title: '并发新卷必须保留', orderIndex: 1 } })
    })
    await locked
    const importing = request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input).then(response => response)
    unlock(); await writer
    expect((await importing).body.error.code).toBe('IMPORT_TARGET_CHANGED')
    expect(await prisma.novelImportCommit.count({ where: { jobId: ready.jobId } })).toBe(0)
    expect(await prisma.volume.findFirstOrThrow({ where: { novelId } })).toMatchObject({ title: '并发新卷必须保留', archivedAt: null })
  })
  it('restore rejects later current edits and preserves both versions with a durable conflict status', async () => {
    const volume = await prisma.volume.create({ data: { novelId, title: '原卷', orderIndex: 1 } })
    // Title matches the import fixture so smart-merge archives this row; a later edit to an imported chapter must block restore and leave this row archived.
    const old = await prisma.chapter.create({ data: { novelId, authorId: userId, volumeId: volume.id, title: '第一章 起点', content: '', orderIndex: 1, orderInVolume: 1 } })
    const ready = await approve()
    expect((await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)).status).toBe(200)
    const input = await restoreApproval(ready.jobId)
    const current = await prisma.chapter.findFirstOrThrow({ where: { novelId, archivedAt: null } })
    await prisma.$transaction(async tx => { await lockNovelActiveScope(tx, novelId); await tx.chapter.update({ where: { id: current.id }, data: { content: '导入后新增正文不能被恢复抹掉', revision: { increment: 1 } } }) })
    const result = await request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send(input)
    expect(result.body.error.code).toBe('IMPORT_RESTORE_CONFLICT')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({ content: '导入后新增正文不能被恢复抹掉', archivedAt: null })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: old.id } })).archivedAt).not.toBeNull()
    expect((await request(app).get(`${base()}/${ready.jobId}`).set('Cookie', cookie())).body.data.restore.status).toBe('restore_conflict')
  })
  it('an expired restore approval cannot consume the backup and disabled uploads do not disable restoration', async () => {
    const ready = await approve()
    expect((await request(app).post(`${base()}/${ready.jobId}/commit`).set('Cookie', cookie()).send(ready.input)).status).toBe(200)
    const first = await restoreApproval(ready.jobId)
    await prisma.novelImportApproval.update({ where: { id: first.restoreApprovalId }, data: { expiresAt: new Date(0) } })
    expect((await request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send(first)).body.error.code).toBe('IMPORT_APPROVAL_EXPIRED')
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'false')
    try {
      const second = await restoreApproval(ready.jobId)
      const restored = await request(app).post(`${base()}/${ready.jobId}/restore`).set('Cookie', cookie()).send(second)
      expect(restored.status).toBe(200); expect(restored.body.data.restoredChapterCount).toBe(0)
    } finally { vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true') }
  })
})
