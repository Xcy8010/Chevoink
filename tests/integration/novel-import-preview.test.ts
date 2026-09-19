import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { prisma } from '../../api/lib/prisma.js'
import { readImportBlob } from '../../api/lib/novel-import-storage.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { zipFiles } from '../unit/novel-import-parser.fixtures.js'
import type { NovelImportPreviewSummary, NovelImportReportDto } from '../../shared/contracts/novel-import-preview.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
const userId = randomUUID(), otherId = randomUUID(), novels: string[] = []
let novelId = '', directory = ''
const cookie = (id = userId) => `chevoink_session=${buildSessionTokens(id, 0).accessToken}`
const root = () => `/api/novels/${novelId}/imports`
async function prepare(bytes = Buffer.from('第一章 开始\n原文甲\n\n第二章 继续\n原文乙'), filename = 'book.txt') {
  const preflight = await request(app).post(`${root()}/preflight`).set('Cookie', cookie()).send({})
  expect(preflight.status, JSON.stringify(preflight.body)).toBe(200)
  const created = await request(app).post(root()).set('Cookie', cookie()).send({ intentId: preflight.body.data.intentId })
  expect(created.status).toBe(200)
  const jobId = created.body.data.jobId as string
  const base = `${root()}/${jobId}`
  expect((await request(app).put(`${base}/source?filename=${filename}`).set('Cookie', cookie()).type('application/octet-stream').send(bytes)).status).toBe(200)
  await vi.waitFor(async () => {
    const response = await request(app).post(`${base}/analyze`).set('Cookie', cookie()).send({})
    if (response.status !== 200) expect(response.body.error.code).toBe('IMPORT_WRITE_BUSY')
    expect(response.status).toBe(200)
  }, { timeout: 30_000, interval: 300 })
  await vi.waitFor(async () => {
    const job = await prisma.novelImportJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(['ready', 'needs_review'], job.errorCode ?? job.status).toContain(job.status)
  }, { timeout: 30_000, interval: 200 })
  const summaryResponse = await request(app).get(`${base}/preview?view=summary`).set('Cookie', cookie())
  expect(summaryResponse.status, JSON.stringify(summaryResponse.body)).toBe(200)
  return { jobId, base, targetHash: preflight.body.data.targetHash as string, summary: summaryResponse.body.data as NovelImportPreviewSummary }
}
async function report(base: string): Promise<NovelImportReportDto> {
  const response = await request(app).get(`${base}/report`).set('Cookie', cookie())
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body.data as NovelImportReportDto
}
async function commit(base: string, targetHash: string, summary: NovelImportPreviewSummary) {
  const approved = await request(app).post(`${base}/confirm`).set('Cookie', cookie()).send({ manifestRevision: summary.manifestRevision, manifestHash: summary.manifestHash, targetHash })
  expect(approved.status, JSON.stringify(approved.body)).toBe(200)
  const committed = await request(app).post(`${base}/commit`).set('Cookie', cookie()).send({ approvalId: approved.body.data.approvalId, idempotencyKey: randomUUID() })
  expect(committed.status, JSON.stringify(committed.body)).toBe(200)
  return committed
}
afterAll(async () => {
  try {
    if (available) {
      const keys = [...await prisma.novelImportSource.findMany({ where: { job: { userId } }, select: { storageKey: true } }), ...await prisma.novelImportManifest.findMany({ where: { job: { userId } }, select: { storageKey: true } }), ...await prisma.novelImportArtifact.findMany({ where: { job: { userId } }, select: { storageKey: true } })].map(row => row.storageKey)
      await prisma.chapter.deleteMany({ where: { novelId: { in: novels }, authorId: userId } })
      await prisma.volume.deleteMany({ where: { novelId: { in: novels } } })
      await prisma.novel.updateMany({ where: { id: { in: novels }, authorId: userId }, data: { coverAssetId: null } })
      await prisma.coverAsset.deleteMany({ where: { ownerUserId: userId } })
      await prisma.novel.deleteMany({ where: { id: { in: novels }, authorId: userId } })
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } })
      await prisma.novelImportGarbage.deleteMany({ where: { storageKey: { in: keys } } })
    }
    if (directory) {
      if (!path.resolve(directory).startsWith(path.join(os.tmpdir(), 'import-preview-db-'))) throw new Error('unsafe fixture directory')
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.blob$/.test(name)) throw new Error('unexpected fixture file')
        await unlink(path.join(directory, name))
      }
      await rmdir(directory)
    }
  } finally { vi.unstubAllEnvs(); await prisma.$disconnect() }
})
describe.skipIf(!available)('import report, resources and lazy preview in isolated PostgreSQL', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'import-preview-db-'))
    vi.stubEnv('NOVEL_IMPORT_STORAGE_DIR', directory); vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
    await prisma.user.createMany({ data: [userId, otherId].map(id => ({ id, nickname: 'preview-fixture', passwordHash: 'synthetic-only' })) })
  })
  beforeEach(async () => {
    novelId = randomUUID(); novels.push(novelId)
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '预览测试', slug: randomUUID(), summary: '', visibility: 'private' } })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await prisma.novelImportJob.updateMany({ where: { userId, status: { notIn: ['succeeded', 'cancelled'] } }, data: { status: 'cancelled', leaseOwner: null, leaseUntil: null, leaseEpoch: { increment: 1 } } })
  })
  it('persists split blobs, reads summary/report without chapter blobs, and hydrates one selected chapter', async () => {
    const ready = await prepare()
    const manifest = await prisma.novelImportManifest.findUniqueOrThrow({ where: { jobId_revision: { jobId: ready.jobId, revision: 1 } } })
    const header = JSON.parse((await readImportBlob(manifest.storageKey, manifest.hash)).toString())
    expect(header.storageVersion).toBe(2)
    expect(JSON.stringify(header)).not.toContain('原文甲')
    expect(header.summary.volumes[0].chapters[0]).not.toHaveProperty('content')
    await request(app).get(`${ready.base}/preview?view=summary`).set('Cookie', cookie()).expect(200)
    expect((await report(ready.base)).items.every(item => !('text' in item))).toBe(true)
    const chapter = await request(app).get(`${ready.base}/chapters/0/0?manifestRevision=1`).set('Cookie', cookie())
    expect(chapter.status).toBe(200); expect(chapter.body.data.content).toBe('原文甲\n\n')
    await request(app).get(`${ready.base}/chapters/0/0?manifestRevision=2`).set('Cookie', cookie()).expect(409)
    const full = await request(app).get(`${ready.base}/preview`).set('Cookie', cookie())
    expect(full.status, JSON.stringify(full.body)).toBe(200)
    expect(full.body.data.manifestHash).toBe(ready.summary.manifestHash)
    // Fault injection uses only this synthetic task's exact temporary chapter blob.
    // Unreadable chapter 2 must not prevent summary/report or chapter 1 reads.
    const second = await prisma.novelImportArtifact.findFirstOrThrow({ where: { id: header.chapterArtifactIds[0][1], jobId: ready.jobId, kind: 'chapter' } })
    expect(second.storageKey).toMatch(/^[a-f0-9-]{36}\.blob$/)
    await unlink(path.join(directory, second.storageKey))
    await request(app).get(`${ready.base}/preview?view=summary`).set('Cookie', cookie()).expect(200)
    await request(app).get(`${ready.base}/report`).set('Cookie', cookie()).expect(200)
    await request(app).get(`${ready.base}/chapters/0/0?manifestRevision=1`).set('Cookie', cookie()).expect(200)
    await request(app).get(`${ready.base}/preview`).set('Cookie', cookie()).expect(503)
  }, 60_000)
  it('rejects full-body rewriting and incomplete ranges without publishing new revision', async () => {
    const ready = await prepare()
    const full = (await request(app).get(`${ready.base}/preview`).set('Cookie', cookie())).body.data
    full.volumes[0].chapters[0].content = '未经授权的新正文'
    const response = await request(app).patch(`${ready.base}/manifest`).set('Cookie', cookie()).send({ expectedManifestRevision: 1, volumes: full.volumes })
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('IMPORT_CONTENT_NOT_CONSERVED')
    await request(app).patch(`${ready.base}/structure`).set('Cookie', cookie()).send({ expectedManifestRevision: 1, manifestHash: ready.summary.manifestHash, volumes: [{ title: '卷', chapters: [{ title: '丢章', segments: [{ volumeIndex: 0, chapterIndex: 0, start: 0, end: 1 }] }] }] }).expect(409)
    expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { id: ready.jobId } })).manifestRevision).toBe(1)
    expect(await prisma.chapter.count({ where: { novelId } })).toBe(0)
  }, 60_000)
  it('allows an oversized preserved chapter to split into bounded chapters and commit verbatim', async () => {
    const body = '原文'.repeat(105_000)
    const ready = await prepare(Buffer.from(`第一章 开始\n${body}`))
    expect(ready.summary.volumes[0].chapters[0].characters).toBe(body.length)
    const saved = await request(app).patch(`${ready.base}/structure`).set('Cookie', cookie()).send({ expectedManifestRevision: 1, manifestHash: ready.summary.manifestHash, volumes: [{ title: '卷', chapters: [0, 1, 2].map(i => ({ title: `分章${i}`, segments: [{ volumeIndex: 0, chapterIndex: 0, start: i * 70000, end: (i + 1) * 70000 }] })) }] })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.data.warnings.some((w: { blocking: boolean }) => w.blocking)).toBe(false)
    await commit(ready.base, ready.targetHash, saved.body.data)
    const chapters = await prisma.chapter.findMany({ where: { novelId, archivedAt: null }, orderBy: { orderIndex: 'asc' } })
    expect(chapters.map(c => c.content).join('')).toBe(body)
    expect(chapters.map(c => c.content.length)).toEqual([70000, 70000, 70000])
  }, 60_000)
  it('failed members cannot be reviewed away, explicit exclusion commits a durable partial import', async () => {
    const ready = await prepare(zipFiles({ '第一章.txt': '第一章\n合法原文', 'cover.jpg': 'not an image' }), 'book.zip')
    const evidence = await report(ready.base)
    const item = evidence.items.find(item => item.status === 'failed')!
    expect(item).toBeDefined()
    const input = { expectedManifestRevision: 1, manifestHash: ready.summary.manifestHash, reportHash: evidence.reportHash, decisions: [{ itemId: item.id, action: 'review', reason: '看过了' }] }
    await request(app).post(`${ready.base}/review`).set('Cookie', cookie()).send(input).expect(409)
    const saved = await request(app).post(`${ready.base}/review`).set('Cookie', cookie()).send({ ...input, decisions: [{ itemId: item.id, action: 'exclude', reason: '此次只导入文字，明确排除失败图片' }] })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200); expect(saved.body.data.partialImport).toBe(true)
    await request(app).post(`${ready.base}/review`).set('Cookie', cookie()).send(input).expect(409)
    await commit(ready.base, ready.targetHash, saved.body.data)
    expect((await report(ready.base)).decisions[0].reason).toContain('明确排除')
    expect((await report(ready.base)).partialImport).toBe(true)
  }, 60_000)
  it('stores safe images privately and rejects cross-owner, cross-job and non-image artifact access', async () => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).png().toBuffer()
    const ready = await prepare(zipFiles({ '第一章.txt': '第一章\n合法原文', 'cover.png': image }), 'book.zip')
    const evidence = await report(ready.base)
    expect(evidence.artifacts).toHaveLength(1)
    expect(evidence.issues.some(issue => issue.code === 'IMPORT_IMAGE_STORAGE_REQUIRED')).toBe(false)
    const url = evidence.artifacts[0].url
    const response = await request(app).get(url).set('Cookie', cookie())
    expect(response.status).toBe(200); expect(response.headers['content-type']).toContain('image/png'); expect(response.headers['cache-control']).toContain('no-store')
    expect(response.body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    await request(app).get(url).set('Cookie', cookie(otherId)).expect(404)
    await request(app).get(url).expect(401)
    await request(app).get(url.replace(ready.jobId, randomUUID())).set('Cookie', cookie()).expect(404)
    const privateReport = await prisma.novelImportArtifact.findFirstOrThrow({ where: { jobId: ready.jobId, kind: 'report' } })
    await request(app).get(`${ready.base}/artifacts/${privateReport.id}`).set('Cookie', cookie()).expect(409)
    expect(JSON.stringify(evidence)).not.toContain('storageKey')
    const decisions = [...new Set(evidence.issues.filter(issue => issue.blocking).flatMap(issue => issue.itemIds))].map(itemId => ({ itemId, action: 'review', reason: '人工核对图片用途及完整性' }))
    const saved = await request(app).post(`${ready.base}/review`).set('Cookie', cookie()).send({ expectedManifestRevision: 1, manifestHash: ready.summary.manifestHash, reportHash: evidence.reportHash, decisions })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    await commit(ready.base, ready.targetHash, saved.body.data)
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'false')
    await request(app).get(url).set('Cookie', cookie()).expect(200)
    await request(app).get(`${ready.base}/report`).set('Cookie', cookie()).expect(200)
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
  }, 60_000)
  it('imports an exported WebP cover with its original chapters after real image storage without artificial review', async () => {
    const webp = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#246' } }).webp().toBuffer()
    const ready = await prepare(zipFiles({
      '原书/正文/第一卷/第0001章 开始.txt': '开始\n\n逐字保留的章节正文',
      '原书/作品信息以及发布建议/作品信息.txt': '作品名称：原书\n作者：测试',
      '原书/作品信息以及发布建议/封面.webp': webp,
    }), 'export.zip')
    const evidence = await report(ready.base)
    expect(evidence.issues.filter(issue => issue.blocking)).toEqual([])
    const image = evidence.artifacts[0]
    expect(image.source).toMatch(/封面\.webp$/)
    expect(image.id).not.toBe(image.storageArtifactId)
    expect(image.url).toBe(`${ready.base}/artifacts/${image.storageArtifactId}`)
    await request(app).get(image.url).set('Cookie', cookie()).expect(200)
    const full = await request(app).get(`${ready.base}/preview`).set('Cookie', cookie())
    expect(full.status, JSON.stringify(full.body)).toBe(200)
    expect(full.body.data.report.complete).toBe(true)
    const saved = await request(app).post(`${ready.base}/selection`).set('Cookie', cookie()).send({
      expectedManifestRevision: ready.summary.manifestRevision, manifestHash: ready.summary.manifestHash,
      chapters: [{ volumeIndex: 0, chapterIndex: 0 }], plans: [], memories: [], metadataSelection: { coverArtifactId: image.id },
    })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect((await report(ready.base)).decisions).toEqual([])
    await commit(ready.base, ready.targetHash, saved.body.data)
    const novel = await prisma.novel.findUniqueOrThrow({ where: { id: novelId } })
    expect(novel.coverAssetId).toBeTruthy()
    const chapters = await prisma.chapter.findMany({ where: { novelId, archivedAt: null } })
    expect(chapters.map(chapter => chapter.content)).toEqual(['逐字保留的章节正文'])
  }, 60_000)
})
