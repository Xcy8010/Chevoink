import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ model: vi.fn() }))
vi.mock('../../api/lib/ai-service.js', async original => ({ ...await original<typeof import('../../api/lib/ai-service.js')>(), chatWithTools: fake.model }))
vi.mock('../../api/lib/novel-import/model-router.js', async original => ({ ...await original<typeof import('../../api/lib/novel-import/model-router.js')>(), resolveImportModelRoute: async () => ({ runtime: { tier: 'basic', modelName: 'isolated-fake', provider: 'compatible', contextWindowTokens: 128000, multiplierBps: 10000 }, route: { kind: 'basic', modelName: 'isolated-fake', fingerprint: 'b'.repeat(64), reasoningEffort: 'low' } }) }))
import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
const available = await verifyTestDatabase(isTestDatabaseRequired())
const userId = randomUUID(), novelId = randomUUID()
const cookie = `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`
const base = `/api/novels/${novelId}/imports`
let directory = ''
beforeAll(async () => {
  if (!available) return
  directory = await mkdtemp(path.join(os.tmpdir(), 'import-ai-fixture-'))
  vi.stubEnv('NOVEL_IMPORT_STORAGE_DIR', directory); vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
  await prisma.user.create({ data: { id: userId, nickname: 'AI-isolated-test', passwordHash: 'fixture' } })
  await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '测试', summary: '', slug: randomUUID(), visibility: 'private' } })
})
afterAll(async () => {
  if (available) {
    await prisma.novel.deleteMany({ where: { id: novelId, authorId: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    const files = directory ? await readdir(directory) : []
    for (const filename of files) {
      if (!/^[a-f0-9-]{36}\.blob$/.test(filename)) throw new Error('Unexpected fixture file')
      await unlink(path.join(directory, filename))
    }
    await prisma.novelImportGarbage.deleteMany({ where: { storageKey: { in: files } } })
    if (directory) await rmdir(directory)
  }
  vi.unstubAllEnvs(); await prisma.$disconnect()
})
describe.skipIf(!available)('import AI real persistent idempotency', () => {
  it('simultaneous human confirmations dispatch once and preserve no automatic chapter writes', async () => {
    const pre = await request(app).post(`${base}/preflight`).set('Cookie', cookie).send({})
    expect(pre.status).toBe(200)
    const create = await request(app).post(base).set('Cookie', cookie).send({ intentId: pre.body.data.intentId })
    expect(create.status).toBe(200)
    const jobId = create.body.data.jobId as string
    expect((await request(app).put(`${base}/${jobId}/source?filename=novel.txt`).set('Cookie', cookie).type('application/octet-stream').send(Buffer.from('第一章 起点\n作者原文。'))).status).toBe(200)
    expect((await request(app).post(`${base}/${jobId}/analyze`).set('Cookie', cookie).send({})).status).toBe(200)
    await vi.waitFor(async () => expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('ready'), { timeout: 10000 })
    const job = await prisma.novelImportJob.findUniqueOrThrow({ where: { id: jobId } })
    const selection = { manifestHash: job.manifestHash, manifestRevision: job.manifestRevision, volumeIndex: 0, chapterIndex: 0 }
    const quote = await request(app).post(`${base}/${jobId}/suggestions/quote`).set('Cookie', cookie).send(selection)
    expect(quote.status).toBe(200)
    fake.model.mockResolvedValue({ content: JSON.stringify({ boundaries: [{ offset: 0, title: '起点' }], note: '单章' }), finishReason: 'stop' })
    const results = await Promise.all(Array.from({ length: 4 }, () => request(app).post(`${base}/${jobId}/suggestions`).set('Cookie', cookie).send({ ...selection, fingerprint: quote.body.data.fingerprint, confirmed: true })))
    expect(results.map(result => result.status)).toEqual([200, 200, 200, 200])
    expect(fake.model).toHaveBeenCalledTimes(1)
    expect(await prisma.novelImportSuggestion.count({ where: { jobId } })).toBe(1)
    expect(await prisma.chapter.count({ where: { novelId } })).toBe(0)
    const list = await request(app).get(`${base}/${jobId}/suggestions`).set('Cookie', cookie)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].status).toBe('succeeded')
    expect((await request(app).get(`${base}/${jobId}/suggestions`)).status).toBe(401)
  })
})
