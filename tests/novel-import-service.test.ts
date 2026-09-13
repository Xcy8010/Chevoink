import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const names = ['novel', 'volume', 'chapter', 'agentRun', 'agentSession', 'agentMessage', 'changeSet', 'aiModelConfig', 'novelImportIntent', 'novelImportJob', 'novelImportSource', 'novelImportManifest', 'novelImportApproval', 'novelImportCommit', 'novelImportBackup', 'novelImportGarbage']
  type Row = Record<string, unknown>
  const state: Record<string, Row[]> = Object.fromEntries(names.map(name => [name, []]))
  const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, value]) => {
    if (key === 'job') return matches(state.novelImportJob.find(job => job.id === row.jobId) ?? {}, value as Row)
    if (key === 'OR') return (value as Row[]).some(clause => matches(row, clause))
    if (key === 'jobId_revision') return matches(row, value as Row)
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const filter = value as Row
      if ('in' in filter) return (filter.in as unknown[]).includes(row[key])
      if ('not' in filter) return row[key] !== filter.not
      if ('gt' in filter) return Number(row[key]) > Number(filter.gt)
      if ('gte' in filter) return Number(row[key]) >= Number(filter.gte)
      if ('lte' in filter) return Number(row[key]) <= Number(filter.lte)
    }
    return row[key] === value
  })
  const modify = (row: Row, data: Row) => { for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value ? Number(row[key] ?? 0) + Number(value.increment) : value }
  const delegates = Object.fromEntries(names.map(name => [name, {
    findFirst: vi.fn(async ({ where = {} }: { where?: Row } = {}) => state[name].find(row => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: Row }) => state[name].find(row => matches(row, where)) ?? null),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => { const row = state[name].find(row => matches(row, where)); if (!row) throw new Error('fixture missing'); return row }),
    findMany: vi.fn(async ({ where = {} }: { where?: Row } = {}) => state[name].filter(row => matches(row, where)).map(row => ({ ...row }))),
    count: vi.fn(async ({ where = {} }: { where?: Row } = {}) => state[name].filter(row => matches(row, where)).length),
    create: vi.fn(async ({ data }: { data: Row }) => { const row = { createdAt: new Date(), status: 'uploading', jobVersion: 1, manifestRevision: 0, manifestHash: null, leaseEpoch: 0, leaseOwner: null, leaseUntil: null, parseEncoding: null, consumedAt: null, confirmationStep: 0, errorCode: null, ...data }; state[name].push(row); return { ...row } }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => { state[name].push(...data.map(row => ({ archivedAt: null, archivedByImportId: null, revision: 1, publishedContent: null, publishedRevision: null, publishedAt: null, ...row }))); return { count: data.length } }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => { const row = state[name].find(row => matches(row, where)); if (!row) throw new Error('fixture update missing'); modify(row, data); return { ...row } }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => { const rows = state[name].filter(row => matches(row, where)); rows.forEach(row => modify(row, data)); return { count: rows.length } }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => { const prior = state[name].length; state[name] = state[name].filter(row => !matches(row, where)); return { count: prior - state[name].length } }),
  }]))
  const db = { ...delegates, $transaction: vi.fn() }
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => {
    const backup = structuredClone(state)
    try { return await fn(db) } catch (error) { Object.assign(state, backup); throw error }
  })
  return { state, db, blobs: new Map<string, Buffer>(), parse: vi.fn(), attachmentRead: vi.fn(), attachmentAccess: vi.fn(), storeJson: vi.fn(), removeBlob: vi.fn() }
})
vi.mock('../api/lib/prisma.js', async importOriginal => ({ ...await importOriginal<typeof import('../api/lib/prisma.js')>(), prisma: fixture.db }))
vi.mock('../api/lib/auth-session.js', async () => {
  const { DataAccessError } = await import('../api/lib/prisma.js')
  return { requireSessionUserId: (req: Request) => { const user = req.headers['x-test-user']; if (typeof user !== 'string') throw new DataAccessError(401, 'AUTH_REQUIRED', '请登录。'); return user } }
})
vi.mock('../api/lib/agent-attachment-storage.js', () => ({ assertManagedAttachmentAccess: fixture.attachmentAccess, readAuthorizedAgentAttachment: fixture.attachmentRead }))
vi.mock('../api/lib/novel-import/isolated-parser.js', () => ({ parseNovelImportFileIsolated: fixture.parse }))
vi.mock('../api/lib/novel-import-storage.js', async () => {
  const { createHash, randomUUID } = await import('node:crypto')
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
  const store = (bytes: Buffer) => { const storageKey = `${randomUUID()}.blob`; fixture.blobs.set(storageKey, bytes); return { storageKey, bytes: bytes.length, sha256: hash(bytes) } }
  return { importBytesHash: hash, validateImportFilename: (name: string) => name,
    storeImportJson: fixture.storeJson.mockImplementation(async (value: unknown) => store(Buffer.from(JSON.stringify(value)))),
    storeImportStream: async (stream: AsyncIterable<Uint8Array>) => { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return store(Buffer.concat(chunks)) },
    readImportBlob: async (key: string, expected: string) => { const bytes = fixture.blobs.get(key); if (!bytes || hash(bytes) !== expected) throw new Error('integrity mismatch'); return bytes },
    discardImportBlob: async (key: string) => { fixture.blobs.delete(key) },
    deleteUnreferencedImportBlob: fixture.removeBlob.mockImplementation(async (key: string) => { fixture.blobs.delete(key) }),
  }
})

import { DataAccessError } from '../api/lib/prisma.js'
import { Prisma } from '@prisma/client'
import { analyzeNovelImport, assertNovelImportRestoreBaseline, attachNovelImportSource, authenticateNovelImportHuman, cancelNovelImport, commitNovelImport, confirmNovelImport, confirmNovelImportIntent, editNovelImportPreview, getNovelImportPreview, getNovelImportStatus, hashNovelImportPreview, listNovelImports, novelImportCapabilities, novelImportTransaction, preflightNovelImport, prepareNovelImport, previewNovelImportRestore, restoreNovelImport, uploadNovelImportSource, type NovelImportHuman } from '../api/lib/novel-import-service.js'
import { novelImportCommitSchema, novelImportSourceSchema } from '../shared/contracts/novel-import.js'
import importRouter from '../api/routes/novel-imports.js'

const scope = { userId: 'user-a', novelId: 'novel-a' }
const human = () => authenticateNovelImportHuman({ params: { novelId: scope.novelId }, headers: { 'x-test-user': scope.userId } } as unknown as Request)
async function prepared() {
  const intent = await preflightNovelImport(scope)
  const job = await prepareNovelImport(scope, intent.intentId)
  await uploadNovelImportSource(scope, job.jobId, 'original.txt', (async function* () { yield Buffer.from('第一章\n原文不改写') })())
  await analyzeNovelImport(scope, job.jobId)
  await vi.waitFor(() => expect(fixture.state.novelImportJob[0].status).toBe('ready'))
  const preview = await getNovelImportPreview(scope, job.jobId)
  return { job: await getNovelImportStatus(scope, job.jobId), preview, intent }
}
async function approved() {
  const result = await prepared()
  const approval = await confirmNovelImport(human(), result.job.jobId, { manifestRevision: result.preview.manifestRevision, manifestHash: result.preview.manifestHash, targetHash: result.job.targetHash })
  return { ...result, approval, input: { approvalId: approval.approvalId, idempotencyKey: 'logical-import-operation' } }
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true'); vi.stubEnv('NOVEL_IMPORT_OVERWRITE_ENABLED', 'false')
  for (const name of Object.keys(fixture.state)) fixture.state[name] = []
  fixture.blobs.clear()
  fixture.state.novel.push({ id: scope.novelId, authorId: scope.userId, title: '原书', summary: '简介', tagNames: ['原标签'], status: 'draft', publishedAt: null, wordCount: 0, chapterCount: 0, lastChapterTitle: null })
  fixture.parse.mockResolvedValue({ volumes: [{ title: '正文卷', chapters: [{ title: '第一章', content: '原文不改写', source: 'original.txt#char=0-8' }] }], metadata: { title: '候选书名' }, warnings: [], sourceChars: 8, parserVersion: 'fixture-1' })
})

describe('staged import authorization and durability (DB mocked; not concurrency release evidence)', () => {
  it('is default OFF and environment variables cannot enable unaudited overwrite/restore', () => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED', ''); vi.stubEnv('NOVEL_IMPORT_OVERWRITE_ENABLED', 'true')
    expect(novelImportCapabilities()).toMatchObject({ enabled: false, overwriteEnabled: false, overwriteVerified: false, restoreEnabled: false, aiEnabled: false })
  })
  it('fails closed for another owner before reading any private source', async () => {
    await expect(getNovelImportStatus({ ...scope, userId: 'user-b' }, randomUUID())).rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
    expect(fixture.db.novelImportSource.findUnique).not.toHaveBeenCalled()
  })
  it('rejects existing chapters until the archive audit is verified', async () => {
    fixture.state.chapter.push({ id: 'old-chapter', novelId: scope.novelId, archivedAt: null, publishedContent: null, publishedAt: null, publishedRevision: null })
    await expect(preflightNovelImport(scope)).rejects.toMatchObject({ code: 'IMPORT_OVERWRITE_DISABLED' })
    expect(fixture.state.novelImportIntent).toHaveLength(0)
  })
  it('retains every preexisting empty volume unchanged and appends new volumes after them', async () => {
    const original = { id: 'default-volume', novelId: scope.novelId, title: '第一卷', orderIndex: 1, revision: 1, archivedAt: null }
    fixture.state.volume.push({ ...original })
    const result = await approved()
    expect(result.preview.warnings).toContainEqual(expect.objectContaining({ code: 'IMPORT_EMPTY_VOLUMES_RETAINED', blocking: false }))
    await commitNovelImport(scope, result.job.jobId, result.input)
    expect(fixture.state.volume[0]).toEqual(original)
    expect(fixture.state.volume[1].orderIndex).toBe(2)
    expect(fixture.db.volume.updateMany).not.toHaveBeenCalled()
    expect(fixture.db.chapter.updateMany).not.toHaveBeenCalled()
  })
  it('blocks retained publication snapshots regardless of chapter/novel status', async () => {
    fixture.state.chapter.push({ id: 'archived', novelId: scope.novelId, status: 'draft', archivedAt: new Date(), publishedContent: '公开历史', publishedAt: null, publishedRevision: 2 })
    await expect(preflightNovelImport(scope)).rejects.toMatchObject({ code: 'IMPORT_PUBLISHED_OVERWRITE_BLOCKED' })
  })
  it('does not accept booleans or forged human capabilities', async () => {
    expect(novelImportCommitSchema.safeParse({ confirmed: true }).success).toBe(false)
    expect(novelImportSourceSchema.safeParse({ filename: 'x', arbitrary: 'unbounded input' }).success).toBe(false)
    await expect(confirmNovelImportIntent(scope as NovelImportHuman, randomUUID(), 1, 'hash')).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    await expect(editNovelImportPreview(scope as NovelImportHuman, randomUUID(), {})).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
  })
  it('requires two independent ordered requests and rejects duplicate/skip steps', async () => {
    const intent = await preflightNovelImport(scope)
    fixture.state.novelImportIntent[0].overwriteRequired = true
    await expect(confirmNovelImportIntent(human(), intent.intentId, 2, intent.targetHash)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    expect((await confirmNovelImportIntent(human(), intent.intentId, 1, intent.targetHash)).confirmationStep).toBe(1)
    await expect(confirmNovelImportIntent(human(), intent.intentId, 1, intent.targetHash)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    expect((await confirmNovelImportIntent(human(), intent.intentId, 2, intent.targetHash)).confirmationStep).toBe(2)
  })
  it('rejects ownership mismatch and disabled custom model without fallback', async () => {
    const intent = await preflightNovelImport(scope)
    await expect(prepareNovelImport(scope, intent.intentId, { kind: 'custom', customModelId: 'someone-elses-model' })).rejects.toMatchObject({ code: 'IMPORT_MODEL_UNAVAILABLE' })
    expect(fixture.state.novelImportJob).toHaveLength(0)
  })
  it('persists exactly the selected owned model without calling AI', async () => {
    fixture.state.aiModelConfig.push({ id: 'chosen', ownerUserId: scope.userId, enabled: true }, { id: 'newer', ownerUserId: scope.userId, enabled: true })
    const intent = await preflightNovelImport(scope)
    await prepareNovelImport(scope, intent.intentId, { kind: 'custom', customModelId: 'chosen' })
    expect(fixture.state.novelImportJob[0].modelSelection).toEqual({ kind: 'custom', customModelId: 'chosen' })
  })
  it('cancelled jobs still exhaust the finite rolling 24h creation budget', async () => {
    for (let n = 0; n < 10; n++) fixture.state.novelImportJob.push({ id: randomUUID(), ...scope, status: 'cancelled', createdAt: new Date() })
    const intent = await preflightNovelImport(scope)
    await expect(prepareNovelImport(scope, intent.intentId)).rejects.toMatchObject({ code: 'IMPORT_DAILY_JOB_LIMIT', status: 429 })
    expect(fixture.state.novelImportJob).toHaveLength(10)
  })
  it('reserves upload capacity before reading the incoming stream', async () => {
    const intent = await preflightNovelImport(scope); const job = await prepareNovelImport(scope, intent.intentId)
    fixture.db.novelImportSource.findMany.mockResolvedValueOnce([{ bytes: 250 * 1024 * 1024 }])
    let read = false
    await expect(uploadNovelImportSource(scope, job.jobId, 'x.txt', (async function* () { read = true; yield Buffer.from('no') })())).rejects.toMatchObject({ code: 'IMPORT_DAILY_UPLOAD_LIMIT', status: 429 })
    expect(read).toBe(false)
    expect(fixture.state.novelImportSource).toHaveLength(0)
  })
  it('persists preview/source/revisions and never applies inferred metadata by default', async () => {
    const result = await approved()
    const receipt = await commitNovelImport(scope, result.job.jobId, result.input)
    expect(receipt).toMatchObject({ chapterCount: 1, volumeCount: 1, wordCount: 5 })
    expect(fixture.state.chapter[0]).toMatchObject({ content: '原文不改写', status: 'draft', visibility: 'private' })
    expect(fixture.state.novel[0].title).toBe('原书')
    expect(fixture.state.novelImportBackup).toHaveLength(1)
    expect(fixture.state.novelImportApproval[0].consumedAt).toBeInstanceOf(Date)
    expect(fixture.state.novelImportManifest).toHaveLength(1)
  })
  it('repeat commit returns identical receipt even with source gone, without more rows', async () => {
    const result = await approved()
    const receipt = await commitNovelImport(scope, result.job.jobId, result.input)
    fixture.blobs.clear()
    expect(await commitNovelImport(scope, result.job.jobId, result.input)).toEqual(receipt)
    expect(fixture.state.chapter).toHaveLength(1)
    expect(fixture.state.novelImportCommit).toHaveLength(1)
    await expect(commitNovelImport(scope, result.job.jobId, { ...result.input, idempotencyKey: 'different-operation' })).rejects.toMatchObject({ code: 'IMPORT_IDEMPOTENCY_CONFLICT' })
  })
  it('changed preview invalidates the prior grant without writing chapters', async () => {
    const result = await approved()
    const edited = await editNovelImportPreview(human(), result.job.jobId, { expectedManifestRevision: 1, volumes: [{ title: '新卷名', chapters: result.preview.volumes[0].chapters }] })
    expect(edited.manifestRevision).toBe(2); expect(edited.manifestHash).not.toBe(result.preview.manifestHash)
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toBeInstanceOf(DataAccessError)
    expect(fixture.state.chapter).toHaveLength(0)
    await expect(editNovelImportPreview(human(), result.job.jobId, { expectedManifestRevision: 1, volumes: result.preview.volumes })).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_CHANGED' })
  })
  it('enforces revision cap before allocating any blob and keeps only two preview histories', async () => {
    const result = await prepared()
    for (let revision = 1; revision < 5; revision++) await editNovelImportPreview(human(), result.job.jobId, { expectedManifestRevision: revision, volumes: result.preview.volumes })
    expect(fixture.state.novelImportManifest.map(row => row.revision)).toEqual([4, 5])
    expect(fixture.blobs.size).toBe(3) // original source + two previews
    const calls = fixture.storeJson.mock.calls.length
    fixture.state.novelImportJob[0].manifestRevision = 64
    await expect(editNovelImportPreview(human(), result.job.jobId, { expectedManifestRevision: 64, volumes: result.preview.volumes })).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_LIMIT', status: 429 })
    await expect(analyzeNovelImport(scope, result.job.jobId, 'utf-8')).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_LIMIT', status: 429 })
    expect(fixture.storeJson).toHaveBeenCalledTimes(calls)
  })
  it('claims one save before blob writing; overlapping stale saves allocate no orphan fanout', async () => {
    const result = await prepared()
    const originalWriter = fixture.storeJson.getMockImplementation()!
    let release!: () => void
    fixture.storeJson.mockImplementationOnce(async (value: unknown) => { await new Promise<void>(resolve => { release = resolve }); return originalWriter(value) })
    const edit = { expectedManifestRevision: 1, volumes: result.preview.volumes }
    const first = editNovelImportPreview(human(), result.job.jobId, edit)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const calls = fixture.storeJson.mock.calls.length
    const competitors = await Promise.allSettled(Array.from({ length: 8 }, () => editNovelImportPreview(human(), result.job.jobId, edit)))
    expect(competitors.every(result => result.status === 'rejected')).toBe(true)
    expect(fixture.storeJson).toHaveBeenCalledTimes(calls)
    release(); await first
    expect(fixture.state.novelImportManifest).toHaveLength(2)
    expect(fixture.blobs.size).toBe(3)
  })
  it('queues failed history unlink and blocks new blob allocation when cleanup is backlogged', async () => {
    const result = await prepared()
    await editNovelImportPreview(human(), result.job.jobId, { expectedManifestRevision: 1, volumes: result.preview.volumes })
    const oldKey = fixture.state.novelImportManifest[0].storageKey
    fixture.removeBlob.mockRejectedValueOnce(new Error('EACCES'))
    await editNovelImportPreview(human(), result.job.jobId, { expectedManifestRevision: 2, volumes: result.preview.volumes })
    expect(fixture.state.novelImportGarbage).toContainEqual(expect.objectContaining({ storageKey: oldKey }))
    const calls = fixture.storeJson.mock.calls.length
    fixture.db.novelImportGarbage.count.mockResolvedValueOnce(100)
    await expect(editNovelImportPreview(human(), result.job.jobId, { expectedManifestRevision: 3, volumes: result.preview.volumes })).rejects.toMatchObject({ code: 'IMPORT_STORAGE_BUSY' })
    expect(fixture.storeJson).toHaveBeenCalledTimes(calls)
  })
  it('target edits and active Agent runs fail closed at final transaction', async () => {
    const result = await approved()
    fixture.state.novel[0].summary = '别人刚保存了简介'
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_TARGET_CHANGED' })
    fixture.state.novel[0].summary = '简介'
    fixture.state.agentRun.push({ id: 'writing', novelId: scope.novelId, status: 'running' })
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_WRITE_BUSY' })
    expect(fixture.state.chapter).toHaveLength(0)
  })
  it('cancel before commit writes zero chapters; cancel after success is honest', async () => {
    const result = await approved()
    expect((await cancelNovelImport(scope, result.job.jobId)).status).toBe('cancelled')
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(fixture.state.chapter).toHaveLength(0)
  })
  it('transaction failure rolls back chapter insert, backup, approval consumption and receipt', async () => {
    const result = await approved()
    fixture.db.novelImportCommit.create.mockRejectedValueOnce(new Error('injected transaction failure'))
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toThrow('injected')
    expect(fixture.state.chapter).toHaveLength(0)
    expect(fixture.state.volume).toHaveLength(0)
    expect(fixture.state.novelImportBackup).toHaveLength(0)
    expect(fixture.state.novelImportApproval[0].consumedAt).toBeNull()
  })
  it('late parser output after cancellation cannot persist a preview', async () => {
    let finish!: (value: unknown) => void
    fixture.parse.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const intent = await preflightNovelImport(scope); const job = await prepareNovelImport(scope, intent.intentId)
    await uploadNovelImportSource(scope, job.jobId, 'file.txt', (async function* () { yield Buffer.from('正文') })())
    await analyzeNovelImport(scope, job.jobId)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await cancelNovelImport(scope, job.jobId)
    finish({ volumes: [], metadata: {}, warnings: [], sourceChars: 0, parserVersion: 'late' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fixture.state.novelImportJob[0].status).toBe('cancelled')
    expect(fixture.state.novelImportManifest).toHaveLength(0)
  })
  it('keeps incomplete parser warnings blocking even after a human edit', async () => {
    fixture.parse.mockResolvedValueOnce({ volumes: [{ title: '卷', chapters: [{ title: '章', content: '部分正文', source: 'x.pdf' }] }], metadata: {}, warnings: [{ code: 'IMPORT_VISION_REQUIRED', message: '扫描页待处理', blocking: true }], sourceChars: 4, parserVersion: 'partial' })
    const intent = await preflightNovelImport(scope); const job = await prepareNovelImport(scope, intent.intentId)
    await uploadNovelImportSource(scope, job.jobId, 'x.pdf', (async function* () { yield Buffer.from('pdf fixture') })())
    await analyzeNovelImport(scope, job.jobId)
    await vi.waitFor(() => expect(fixture.state.novelImportJob[0].status).toBe('needs_review'))
    const preview = await getNovelImportPreview(scope, job.jobId)
    await editNovelImportPreview(human(), job.jobId, { expectedManifestRevision: 1, volumes: preview.volumes })
    const newer = await getNovelImportPreview(scope, job.jobId)
    await expect(confirmNovelImport(human(), job.jobId, { ...newer, targetHash: job.targetHash })).rejects.toMatchObject({ code: 'IMPORT_INCOMPLETE_CONTENT' })
  })
  it('persists oversized preview bodies and partial splits; only a fully bounded split clears size blocking', async () => {
    const original = '原'.repeat(210_000)
    fixture.parse.mockResolvedValueOnce({ volumes: [{ title: '卷', chapters: [{ title: '长章', content: original, source: 'long.txt' }] }], metadata: {}, warnings: [{ code: 'IMPORT_CHAPTER_TOO_LARGE', message: '请拆分', blocking: true }], sourceChars: original.length, parserVersion: 'long' })
    const intent = await preflightNovelImport(scope); const job = await prepareNovelImport(scope, intent.intentId)
    await uploadNovelImportSource(scope, job.jobId, 'long.txt', (async function* () { yield Buffer.from(original) })())
    await analyzeNovelImport(scope, job.jobId)
    await vi.waitFor(() => expect(fixture.state.novelImportJob[0].status).toBe('needs_review'))
    const preview = await getNovelImportPreview(scope, job.jobId)
    expect(preview.volumes[0].chapters[0].content).toBe(original)
    const partial = await editNovelImportPreview(human(), job.jobId, { expectedManifestRevision: 1, volumes: [{ title: '卷', chapters: [
      { title: '一', content: original.slice(0, 100_000), source: { filename: 'long.txt' } },
      { title: '二', content: original.slice(100_000), source: { filename: 'long.txt' } },
    ] }] })
    expect(partial.warnings.some(w => w.blocking)).toBe(true)
    const complete = await editNovelImportPreview(human(), job.jobId, { expectedManifestRevision: 2, volumes: [{ title: '卷', chapters: [
      { title: '一', content: original.slice(0, 100_000), source: { filename: 'long.txt' } },
      { title: '二', content: original.slice(100_000, 200_000), source: { filename: 'long.txt' } },
      { title: '三', content: original.slice(200_000), source: { filename: 'long.txt' } },
    ] }] })
    expect(complete.volumes[0].chapters.map(c => c.content).join('')).toBe(original)
    expect(complete.warnings.some(w => w.blocking)).toBe(false)
  })
  it('restore is failclosed during rollout, even for a verified human and a succeeded job', async () => {
    const result = await approved(); await commitNovelImport(scope, result.job.jobId, result.input)
    await expect(previewNovelImportRestore(human(), result.job.jobId)).rejects.toMatchObject({ code: 'IMPORT_RESTORE_DISABLED' })
    await expect(restoreNovelImport(human(), result.job.jobId, { restoreApprovalId: randomUUID(), targetHash: result.job.targetHash })).rejects.toMatchObject({ code: 'IMPORT_RESTORE_DISABLED' })
    expect(fixture.state.chapter[0].archivedAt).toBeNull()
  })
  it('restore baseline rejects changed current content, request or grant instead of overwriting edits', () => {
    expect(() => assertNovelImportRestoreBaseline('same', 'same')).not.toThrow()
    for (const hashes of [['edited', 'old', 'old', 'old'], ['old', 'old', 'stale', 'old'], ['old', 'old', 'old', 'stale']]) {
      expect(() => assertNovelImportRestoreBaseline(...hashes as [string, string, string, string])).toThrow(expect.objectContaining({ code: 'IMPORT_RESTORE_CONFLICT' }))
    }
  })
  it('attachment handoff rejects URLs not in the original user message before reading bytes', async () => {
    const intent = await preflightNovelImport(scope); const job = await prepareNovelImport(scope, intent.intentId)
    fixture.state.agentRun.push({ id: 'run', userId: scope.userId, novelId: scope.novelId, sessionId: 'session' })
    fixture.state.agentSession.push({ id: 'session', userId: scope.userId, novelId: scope.novelId })
    fixture.state.agentMessage.push({ runId: 'run', sessionId: 'session', role: 'user', parts: [] })
    await expect(attachNovelImportSource(human(), job.jobId, { runId: 'run', url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'IMPORT_ATTACHMENT_SCOPE' })
    expect(fixture.attachmentRead).not.toHaveBeenCalled()
  })
  it('status/list do not leak source paths, bodies or other users jobs', async () => {
    await prepared()
    const status = await listNovelImports(scope)
    expect(JSON.stringify(status)).not.toContain('原文不改写')
    expect(JSON.stringify(status)).not.toContain('storageKey')
    await expect(listNovelImports({ ...scope, userId: 'user-b' })).rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
  })
  it('hash binds every preview edit but not its self hash', async () => {
    const { preview } = await prepared()
    expect(hashNovelImportPreview({ ...preview, manifestHash: 'ignored' })).toBe(preview.manifestHash)
    expect(hashNovelImportPreview({ ...preview, metadataSelection: { title: 'changed' } })).not.toBe(preview.manifestHash)
  })
  it('uses Serializable and retries only DB P2034 with a bounded limit', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6.12.0' })
    fixture.db.$transaction.mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict)
    await expect(novelImportTransaction(async () => 'ok')).resolves.toBe('ok')
    expect(fixture.db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'Serializable' }))
    const calls = fixture.db.$transaction.mock.calls.length
    fixture.db.$transaction.mockRejectedValueOnce(new Error('not retryable'))
    await expect(novelImportTransaction(async () => 'no')).rejects.toThrow('not retryable')
    expect(fixture.db.$transaction.mock.calls.length).toBe(calls + 1)
  })
})

describe('import HTTP boundary', () => {
  const app = express().use('/api/novels/:novelId/imports', importRouter)
  const base = '/api/novels/novel-a/imports'
  it('authenticates before parsing bodies or exposing capabilities', async () => {
    expect((await request(app).get(`${base}/capabilities`)).status).toBe(401)
    expect((await request(app).post(`${base}/preflight`).type('json').send('{invalid')).status).toBe(401)
    expect((await request(app).get(`${base}/capabilities`).set('x-test-user', scope.userId)).body.data.restoreEnabled).toBe(false)
  })
  it('rejects cross-site Origin even without fetch metadata and blocks HTML form intents', async () => {
    expect((await request(app).post(`${base}/preflight`).set('x-test-user', scope.userId).set('Origin', 'https://evil.example').send({})).status).toBe(403)
    expect((await request(app).post(`${base}/preflight`).set('x-test-user', scope.userId).type('form').send({})).status).toBe(415)
    expect(fixture.state.novelImportIntent).toHaveLength(0)
  })
  it('does not leak a malformed JSON request body into errors', async () => {
    const result = await request(app).post(`${base}/preflight`).set('x-test-user', scope.userId).type('json').send('{"private-novel-body":')
    expect(result.status).toBe(400)
    expect(JSON.stringify(result.body)).not.toContain('private-novel-body')
    expect(result.body.error.code).toBe('IMPORT_INPUT_INVALID')
  })
  it('rejects disabled mutation before JSON parsing, preserving cancellation and readonly source/status', async () => {
    const { job } = await prepared()
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'false')
    const malformed = await request(app).post(`${base}/preflight`).set('x-test-user', scope.userId).type('json').send('{"broken":')
    expect(malformed.status).toBe(503)
    expect(malformed.body.error.code).toBe('IMPORT_DISABLED')
    const large = await request(app).patch(`${base}/${job.jobId}/manifest`).set('x-test-user', scope.userId).send({ ignored: 'x'.repeat(20_000) })
    expect(large.body.error.code).toBe('IMPORT_DISABLED')
    expect((await request(app).get(`${base}/${job.jobId}/source`).set('x-test-user', scope.userId)).status).toBe(200)
    expect((await request(app).get(`${base}/${job.jobId}`).set('x-test-user', scope.userId)).status).toBe(200)
    expect((await request(app).post(`${base}/${job.jobId}/cancel`).set('x-test-user', scope.userId).send({})).body.data.status).toBe('cancelled')
  })
  it('limits small mutation bodies to 16KiB but allows a larger valid manifest', async () => {
    const tooBig = await request(app).post(`${base}/preflight`).set('x-test-user', scope.userId).send({ ignored: 'x'.repeat(17_000) })
    expect(tooBig.status).toBe(413)
    const { job, preview } = await prepared()
    const edited = await request(app).patch(`${base}/${job.jobId}/manifest`).set('x-test-user', scope.userId).send({ expectedManifestRevision: 1, volumes: [{ ...preview.volumes[0], chapters: [{ ...preview.volumes[0].chapters[0], content: '原'.repeat(20_000) }] }] })
    expect(edited.status).toBe(200)
    expect(edited.body.data.volumes[0].chapters[0].content.length).toBe(20_000)
  })
  it('returns direct standard data and rejects confirmed=true as a commit grant', async () => {
    const intent = await request(app).post(`${base}/preflight`).set('x-test-user', scope.userId).send({})
    expect(intent.body).toMatchObject({ success: true, data: { chapterCount: 0, confirmationStep: 0 } })
    const job = await request(app).post(base).set('x-test-user', scope.userId).send({ intentId: intent.body.data.intentId })
    expect(job.body.data.status).toBe('uploading')
    const invalid = await request(app).post(`${base}/${job.body.data.jobId}/commit`).set('x-test-user', scope.userId).send({ confirmed: true })
    expect(invalid.status).toBe(400)
    expect(fixture.state.chapter).toHaveLength(0)
  })
  it('downloads only the owned hash-verified original with safe attachment headers', async () => {
    const { job } = await prepared()
    fixture.state.novelImportSource[0].filename = "测试'().txt"
    const denied = await request(app).get(`${base}/${job.jobId}/source`).set('x-test-user', 'user-b')
    expect(denied.status).toBe(404)
    const downloaded = await request(app).get(`${base}/${job.jobId}/source`).set('x-test-user', scope.userId)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers['content-type']).toBe('application/octet-stream')
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff')
    expect(downloaded.headers['cache-control']).toBe('private, no-store')
    expect(downloaded.headers['content-disposition']).toContain("filename*=UTF-8''%E6%B5%8B%E8%AF%95%27%28%29.txt")
    expect(downloaded.body.toString()).toBe('第一章\n原文不改写')
    fixture.state.novelImportSource[0].sha256 = '0'.repeat(64)
    const corrupted = await request(app).get(`${base}/${job.jobId}/source`).set('x-test-user', scope.userId)
    expect(corrupted.status).toBe(503)
    expect(JSON.stringify(corrupted.body)).not.toContain('原文不改写')
  })
})
