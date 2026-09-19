import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const names = ['novel', 'volume', 'chapter', 'coverAsset', 'readingProgress', 'agentRun', 'agentQueuedRequest', 'agentSession', 'agentMessage', 'agentArtifact', 'changeSet', 'aiModelConfig', 'novelImportIntent', 'novelImportJob', 'novelImportSource', 'novelImportManifest', 'novelImportApproval', 'novelImportCommit', 'novelImportBackup', 'novelImportGarbage', 'novelImportArtifact', 'novelImportEvent', 'projectMemoryEntry', 'memoryExtractionJob', 'storyEvent', 'storyEntity', 'foreshadowThread', 'entityRelation', 'storyCompilation', 'sceneTask', 'chapterBridge', 'chapterQualityReport', 'styleProfile', 'styleLearningJob']
  type Row = Record<string, unknown>
  const state: Record<string, Row[]> = Object.fromEntries(names.map(name => [name, []]))
  const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, value]) => {
    if (key === 'job') return matches(state.novelImportJob.find(job => job.id === row.jobId) ?? {}, value as Row)
    if (key === 'OR') return (value as Row[]).some(clause => matches(row, clause))
    if (key === 'AND') return (value as Row[]).every(clause => matches(row, clause))
    if (key === 'evidence') return ((row.evidence ?? []) as Row[]).some(e => matches(e, (value as Row).some as Row))
    if (key === 'profile') return matches(state.styleProfile.find(p => p.id === row.profileId) ?? {}, value as Row)
    if (key === 'session') return matches(state.agentSession.find(s => s.id === row.sessionId) ?? {}, value as Row)
    if (key === 'patches') return ((row.patches ?? []) as Row[]).some(p => matches(p, (value as Row).some as Row))
    if (key === 'jobId_kind') return matches(row, value as Row)
    if (key === 'jobId_revision') return matches(row, value as Row)
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const filter = value as Row
      if ('in' in filter) return (filter.in as unknown[]).includes(row[key])
      if ('not' in filter) return row[key] !== filter.not
      if ('gt' in filter) return Number(row[key]) > Number(filter.gt)
      if ('gte' in filter) return Number(row[key]) >= Number(filter.gte)
      if ('lte' in filter) return Number(row[key]) <= Number(filter.lte)
      if ('startsWith' in filter) return typeof row[key] === 'string' && row[key].startsWith(String(filter.startsWith))
    }
    return row[key] === value
  })
  const modify = (row: Row, data: Row) => { for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value ? Number(row[key] ?? 0) + Number(value.increment) : value }
  const delegates = Object.fromEntries(names.map(name => [name, {
    findFirst: vi.fn(async ({ where = {} }: { where?: Row } = {}) => { const row = state[name].find(row => matches(row, where)); return row ? { ...row } : null }),
    findUnique: vi.fn(async ({ where }: { where: Row }) => state[name].find(row => matches(row, where)) ?? null),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => { const row = state[name].find(row => matches(row, where)); if (!row) throw new Error('fixture missing'); return row }),
    findMany: vi.fn(async ({ where = {} }: { where?: Row } = {}) => state[name].filter(row => matches(row, where)).map(row => ({ ...row }))),
    count: vi.fn(async ({ where = {} }: { where?: Row } = {}) => state[name].filter(row => matches(row, where)).length),
    create: vi.fn(async ({ data }: { data: Row }) => { const row = { createdAt: new Date(), status: 'uploading', jobVersion: 1, manifestRevision: 0, manifestHash: null, leaseEpoch: 0, leaseOwner: null, leaseUntil: null, parseEncoding: null, consumedAt: null, confirmationStep: 0, errorCode: null, restoredAt: null, restoreReceipt: null, restoreErrorCode: null, agentRunId: null, agentToolCallId: null, effectsPublishedAt: null, ...data }; state[name].push(row); return { ...row } }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => { state[name].push(...data.map(row => ({ archivedAt: null, archivedByImportId: null, revision: 1, publishedContent: null, publishedRevision: null, publishedAt: null, ...row }))); return { count: data.length } }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => { const row = state[name].find(row => matches(row, where)); if (!row) throw new Error('fixture update missing'); modify(row, data); return { ...row } }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => { const rows = state[name].filter(row => matches(row, where)); rows.forEach(row => modify(row, data)); return { count: rows.length } }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => { const prior = state[name].length; state[name] = state[name].filter(row => !matches(row, where)); return { count: prior - state[name].length } }),
  }]))
  const db = { ...delegates, $transaction: vi.fn(), $queryRaw: vi.fn(async (_strings: unknown, novelId: string) => state.novel.filter(n => n.id === novelId).map(n => ({ id: n.id }))) }
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => {
    const backup = structuredClone(state)
    try { return await fn(db) } catch (error) { Object.assign(state, backup); throw error }
  })
  return { state, db, blobs: new Map<string, Buffer>(), parse: vi.fn(), attachmentRead: vi.fn(), attachmentAccess: vi.fn(), storeJson: vi.fn(), removeBlob: vi.fn(), saveMemory: vi.fn(async (_input: unknown, _tx?: unknown) => ({ id: 'mem-created', action: 'created' as const, status: 'confirmed' as const })) }
})
vi.mock('../api/lib/prisma.js', async importOriginal => ({ ...await importOriginal<typeof import('../api/lib/prisma.js')>(), prisma: fixture.db }))
vi.mock('../api/lib/auth-session.js', async () => {
  const { DataAccessError } = await import('../api/lib/prisma.js')
  return { requireSessionUserId: (req: Request) => { const user = req.headers['x-test-user']; if (typeof user !== 'string') throw new DataAccessError(401, 'AUTH_REQUIRED', '请登录。'); return user } }
})
vi.mock('../api/lib/agent-attachment-storage.js', () => ({ assertManagedAttachmentAccess: fixture.attachmentAccess, readAuthorizedAgentAttachment: fixture.attachmentRead }))
vi.mock('../api/lib/novel-import/isolated-parser.js', () => ({ parseNovelImportFileIsolated: fixture.parse }))
vi.mock('../api/lib/novel-import/pipeline.js', () => ({ parseNovelImportDocument: async (bytes: Buffer, filename: string, options: { sourceId: string; sourceHash: string }) => {
  const parsed = await fixture.parse(bytes, filename, options)
  return { parsed, artifacts: [], report: { version: 1, sourceId: options.sourceId, sourceHash: options.sourceHash, parserVersion: parsed.parserVersion, complete: true,
    items: [{ id: 'source-item', kind: 'file', source: filename, status: 'native', excludable: true }],
    issues: parsed.warnings.filter((w: { code: string }) => !['IMPORT_CHAPTER_TOO_LARGE', 'IMPORT_CHAPTER_TOO_LONG'].includes(w.code)).map((w: { code: string; message: string; blocking: boolean }, i: number) => ({ ...w, id: `issue-${i}`, itemIds: ['source-item'], resolution: 'none' })) } }
} }))
vi.mock('../api/lib/novel-import/preview-storage.js', async original => ({ ...await original<typeof import('../api/lib/novel-import/preview-storage.js')>(), storePreviewParts: async (_claim: unknown, preview: unknown) => preview, storePreviewImages: async () => [] }))
// This suite isolates transaction/HTTP permissions; report integrity has its own
// real-helper suite, and real pipeline coverage remains in DB integration tests.
vi.mock('../api/lib/novel-import/preview.js', async original => ({ ...await original<typeof import('../api/lib/novel-import/preview.js')>(), assertNovelImportPreviewComplete: vi.fn() }))
// 创作记忆落库经 saveStoryMemory（自有测试覆盖）；此处仅隔离验证导入提交的委派参数。
vi.mock('../api/lib/agent/story-memory.js', async original => ({ ...await original<typeof import('../api/lib/agent/story-memory.js')>(), saveStoryMemory: fixture.saveMemory }))
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
import { analyzeNovelImport, assertNovelImportHuman, assertNovelImportRestoreBaseline, attachNovelImportSource, authenticateNovelImportHuman, cancelNovelImport, commitNovelImport, confirmNovelImport, confirmNovelImportIntent, confirmNovelImportSelectionIntent, editNovelImportPreview, getNovelImportPreview, getNovelImportRestorePreview, getNovelImportStatus, hashNovelImportPreview, listNovelImports, novelImportCapabilities, novelImportTransaction, preflightNovelImport, prepareNovelImport, previewNovelImportRestore, restoreNovelImport, selectNovelImportContent, uploadNovelImportSource, type NovelImportHuman } from '../api/lib/novel-import-service.js'
import { novelImportCommitSchema, novelImportSourceSchema } from '../shared/contracts/novel-import.js'
import importRouter from '../api/routes/novel-imports.js'
import { drainNovelImportEffects } from '../api/lib/novel-import-effects.js'

const scope = { userId: 'user-a', novelId: 'novel-a' }
const human = () => authenticateNovelImportHuman({ params: { novelId: scope.novelId }, headers: { 'x-test-user': scope.userId } } as unknown as Request)
async function prepared() {
  const intent = await preflightNovelImport(scope)
  if (intent.overwriteRequired) {
    await confirmNovelImportIntent(human(), intent.intentId, 1, intent.targetHash)
    await confirmNovelImportIntent(human(), intent.intentId, 2, intent.targetHash)
  }
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
function existingBook(content = '旧稿正文', published = false) {
  vi.stubEnv('NOVEL_IMPORT_OVERWRITE_ENABLED', 'true')
  const volume = { id: 'old-volume', novelId: scope.novelId, title: '旧卷', summary: null, orderIndex: 1, revision: 4, archivedAt: null, archivedByImportId: null }
  // 标题与默认解析产物「第一章」一致：智能合并下同名章节命中→归档旧行+导入新版本（等价旧的整卷替换路径）。
  const chapter = { id: 'old-chapter', novelId: scope.novelId, authorId: scope.userId, volumeId: volume.id, title: '第一章', summary: null, content, orderIndex: 1, orderInVolume: 1, wordCount: content.length, revision: 7, status: published ? 'published' : 'draft', visibility: 'public', archivedAt: null, archivedByImportId: null, publishedTitle: published ? '公开旧标题' : null, publishedContent: published ? '公开原文快照' : null, publishedRevision: published ? 5 : null, publishedAt: published ? new Date('2025-01-01') : null }
  fixture.state.volume.push(volume); fixture.state.chapter.push(chapter)
  Object.assign(fixture.state.novel[0], { chapterCount: 1, wordCount: content.length, lastChapterTitle: chapter.title })
  return { volume: { ...volume }, chapter: { ...chapter } }
}
async function committedForRestore() {
  const result = await approved()
  const receipt = await commitNovelImport(scope, result.job.jobId, result.input)
  const impact = await getNovelImportRestorePreview(scope, result.job.jobId)
  const grant = await previewNovelImportRestore(human(), result.job.jobId, impact.currentTargetHash)
  return { ...result, receipt, restoreInput: { restoreApprovalId: grant.restoreApprovalId, targetHash: grant.targetHash, idempotencyKey: 'restore-once-only' } }
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true'); vi.stubEnv('NOVEL_IMPORT_OVERWRITE_ENABLED', 'false')
  for (const name of Object.keys(fixture.state)) fixture.state[name] = []
  fixture.blobs.clear()
  fixture.state.novel.push({ id: scope.novelId, authorId: scope.userId, title: '原书', summary: '简介', tagNames: ['原标签'], status: 'draft', publishedAt: null, wordCount: 0, chapterCount: 0, lastChapterTitle: null, manuscriptRevision: 0 })
  fixture.parse.mockResolvedValue({ volumes: [{ title: '正文卷', chapters: [{ title: '第一章', content: '原文不改写', source: 'original.txt#char=0-8' }] }], metadata: { title: '候选书名' }, warnings: [], sourceChars: 8, parserVersion: 'fixture-1' })
})

describe('staged import authorization and durability (DB mocked; not concurrency release evidence)', () => {
  it('publishes ready and releases the preview lease in the same database update', async () => {
    const result = await prepared()
    // Checking only the final row would miss the old ready-before-finally race.
    expect(fixture.db.novelImportJob.update).toHaveBeenCalledWith({ where: { id: result.job.jobId }, data: expect.objectContaining({ status: 'ready', manifestRevision: 1, leaseOwner: null, leaseUntil: null }) })
    await expect(confirmNovelImport(human(), result.job.jobId, { manifestRevision: result.preview.manifestRevision, manifestHash: result.preview.manifestHash, targetHash: result.job.targetHash })).resolves.toHaveProperty('approvalId')
  })
  it('keeps new imports opt-in while history restoration survives the kill switch', () => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED', ''); vi.stubEnv('NOVEL_IMPORT_OVERWRITE_ENABLED', 'true')
    expect(novelImportCapabilities()).toMatchObject({ enabled: false, overwriteEnabled: false, overwriteVerified: true, restoreEnabled: true, aiEnabled: true })
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
  it('reuses the preexisting empty default volume without changing its identity', async () => {
    const original = { id: 'default-volume', novelId: scope.novelId, title: '第一卷', orderIndex: 1, revision: 1, archivedAt: null }
    fixture.state.volume.push({ ...original })
    const result = await approved()
    expect(result.preview.warnings).toContainEqual(expect.objectContaining({ code: 'IMPORT_EMPTY_VOLUMES_RETAINED', blocking: false }))
    await commitNovelImport(scope, result.job.jobId, result.input)
    expect(fixture.state.volume[0]).toEqual(original)
    expect(fixture.state.volume).toHaveLength(1)
    expect(fixture.state.chapter[0]).toMatchObject({ volumeId: original.id, orderIndex: 1, orderInVolume: 1 })
    expect(fixture.db.volume.updateMany).not.toHaveBeenCalled()
    expect(fixture.db.chapter.updateMany).not.toHaveBeenCalled()
  })
  it('keeps retained publication snapshots visible and never edits their identity', async () => {
    fixture.state.chapter.push({ id: 'archived', novelId: scope.novelId, status: 'draft', archivedAt: new Date(), publishedContent: '公开历史', publishedAt: null, publishedRevision: 2 })
    const old = { ...fixture.state.chapter[0] }
    const result = await approved(); await commitNovelImport(scope, result.job.jobId, result.input)
    expect(fixture.state.chapter[0]).toEqual(old)
  })
  it('does not accept booleans or forged human capabilities', async () => {
    expect(novelImportCommitSchema.safeParse({ confirmed: true }).success).toBe(false)
    expect(novelImportSourceSchema.safeParse({ filename: 'x', arbitrary: 'unbounded input' }).success).toBe(false)
    await expect(confirmNovelImportIntent(scope as NovelImportHuman, randomUUID(), 1, 'hash')).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    await expect(editNovelImportPreview(scope as NovelImportHuman, randomUUID(), {})).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    expect(() => assertNovelImportHuman(scope as NovelImportHuman)).toThrow(expect.objectContaining({ code: 'IMPORT_APPROVAL_REQUIRED' }))
    expect(() => assertNovelImportHuman(human())).not.toThrow()
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
  it.each([null, 'gb18030'])('明确重解析无需另选编码，保留已有编码 %s 并撤销旧提交授权', async parseEncoding => {
    const result = await approved()
    fixture.state.novelImportJob[0].parseEncoding = parseEncoding
    const before = structuredClone(fixture.state.novelImportJob)
    await expect(analyzeNovelImport(scope, result.job.jobId)).rejects.toMatchObject({ code: 'IMPORT_STATE_INVALID' })
    expect(fixture.state.novelImportJob).toEqual(before)
    expect(Number(fixture.state.novelImportApproval[0].expiresAt)).toBeGreaterThan(Date.now())
    await analyzeNovelImport(scope, result.job.jobId, undefined, true)
    expect(fixture.state.novelImportJob[0].parseEncoding).toBe(parseEncoding)
    expect(Number(fixture.state.novelImportApproval[0].expiresAt)).toBeLessThanOrEqual(Date.now())
    await vi.waitFor(() => expect(fixture.state.novelImportJob[0].status).toBe('ready'))
    expect(fixture.state.novelImportJob[0].manifestRevision).toBe(result.preview.manifestRevision + 1)
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_EXPIRED' })
    expect(fixture.state.chapter).toHaveLength(0)
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
  it('restores even an initially empty book with independent approval and durable exact replay', async () => {
    const result = await approved(); const committed = await commitNovelImport(scope, result.job.jobId, result.input)
    const impact = await getNovelImportRestorePreview(scope, result.job.jobId)
    expect(impact).toMatchObject({ canRestore: true, before: { volumes: 0, chapters: 0 }, current: { volumes: 1, chapters: 1 } })
    expect(fixture.state.novelImportApproval).toHaveLength(1) // read only
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'false')
    const approval = await previewNovelImportRestore(human(), result.job.jobId, impact.currentTargetHash)
    const input = { restoreApprovalId: approval.restoreApprovalId, targetHash: approval.targetHash, idempotencyKey: 'restore-operation' }
    const receipt = await restoreNovelImport(human(), result.job.jobId, input)
    expect(receipt).toMatchObject({ restored: true, restoredChapterCount: 0, restoredVolumeCount: 0 })
    expect(fixture.state.chapter[0].archivedAt).toBeInstanceOf(Date)
    expect(fixture.state.novel[0].manuscriptRevision).toBe(2)
    expect(fixture.state.novel[0].chapterCount).toBe(0)
    fixture.blobs.clear(); fixture.state.novelImportBackup[0].expiresAt = new Date(0)
    fixture.state.novel[0].summary = '恢复之后的新修改'
    expect(await restoreNovelImport(human(), result.job.jobId, input)).toEqual(receipt)
    await expect(restoreNovelImport(human(), result.job.jobId, { ...input, idempotencyKey: 'another-restore' })).rejects.toMatchObject({ code: 'IMPORT_IDEMPOTENCY_CONFLICT' })
    expect(fixture.state.novelImportCommit[0].receipt).toEqual(committed)
    expect(await getNovelImportStatus(scope, result.job.jobId)).toMatchObject({ source: { filename: 'original.txt' }, restore: { status: 'restored', receipt } })
  })
  it('restore baseline rejects changed current content, request or grant instead of overwriting edits', () => {
    expect(() => assertNovelImportRestoreBaseline('same', 'same')).not.toThrow()
    for (const hashes of [['edited', 'old', 'old', 'old'], ['old', 'old', 'stale', 'old'], ['old', 'old', 'old', 'stale']]) {
      expect(() => assertNovelImportRestoreBaseline(...hashes as [string, string, string, string])).toThrow(expect.objectContaining({ code: 'IMPORT_RESTORE_CONFLICT' }))
    }
  })
  it('已有空章节可先解析选择，作品写入批准仍要求完整intent确认', async () => {
    existingBook('')
    const intent = await preflightNovelImport(scope)
    expect(intent).toMatchObject({ chapterCount: 1, nonEmptyChapterCount: 0, overwriteRequired: true })
    const job = await prepareNovelImport(scope, intent.intentId)
    await uploadNovelImportSource(scope, job.jobId, 'original.txt', (async function* () { yield Buffer.from('正文') })())
    await analyzeNovelImport(scope, job.jobId)
    await vi.waitFor(() => expect(fixture.state.novelImportJob[0].status).toBe('ready'))
    const preview = await getNovelImportPreview(scope, job.jobId)
    const confirmation = { manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, targetHash: job.targetHash }
    await expect(confirmNovelImport(human(), job.jobId, confirmation)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    await expect(commitNovelImport(scope, job.jobId, { approvalId: randomUUID(), idempotencyKey: 'no-human-approval' })).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    await confirmNovelImportIntent(human(), intent.intentId, 1, intent.targetHash)
    await expect(confirmNovelImport(human(), job.jobId, confirmation)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    expect(fixture.state.chapter).toHaveLength(1)
    expect(fixture.state.chapter[0].archivedAt).toBeNull()
    expect(fixture.state.novelImportApproval).toHaveLength(0)
    await confirmNovelImportIntent(human(), intent.intentId, 2, intent.targetHash)
    expect(await confirmNovelImport(human(), job.jobId, confirmation)).toMatchObject({ approvalId: expect.any(String) })
  })
  it('archives and restores the same old IDs without changing published snapshot/order/title', async () => {
    const old = existingBook('旧草稿正文', true)
    const result = await committedForRestore()
    expect(fixture.state.chapter[0]).toMatchObject({ ...old.chapter, archivedAt: expect.any(Date), archivedByImportId: result.job.jobId, revision: 8 })
    expect(fixture.state.volume[0]).toEqual(old.volume)
    expect(fixture.state.chapter[1]).toMatchObject({ status: 'draft', visibility: 'private', publishedContent: null })
    // Public comments/views are not creative edits and don't invalidate restoration.
    Object.assign(fixture.state.chapter[0], { commentCount: 19, updatedAt: new Date() })
    await restoreNovelImport(human(), result.job.jobId, result.restoreInput)
    expect(fixture.state.chapter[0]).toMatchObject({ ...old.chapter, revision: 9 })
    expect(fixture.state.volume[0]).toEqual(old.volume)
    expect(fixture.state.chapter).toHaveLength(2)
    expect(fixture.state.chapter[1].archivedAt).toBeInstanceOf(Date)
    expect(fixture.state.novelImportCommit).toHaveLength(1)
    expect(fixture.db.chapter.deleteMany).not.toHaveBeenCalled()
    expect(fixture.db.volume.deleteMany).not.toHaveBeenCalled()
  })
  it('invalidates derived source facts atomically, keeps manual prose and does not revive old derivations', async () => {
    existingBook()
    fixture.state.projectMemoryEntry.push(
      { id: 'auto', novelId: scope.novelId, sourceChapterId: 'old-chapter', status: 'confirmed', version: 2, content: '自动事实' },
      { id: 'human-linked', novelId: scope.novelId, sourceChapterId: null, evidence: [{ sourceType: 'volume', sourceId: 'old-volume' }], status: 'confirmed', version: 1, content: '人工写的关联记忆' },
      { id: 'human-independent', novelId: scope.novelId, sourceChapterId: null, status: 'confirmed', version: 1, content: '独立作者设定' },
    )
    fixture.state.memoryExtractionJob.push({ id: 'extract', novelId: scope.novelId, chapterId: 'old-chapter', status: 'processing' })
    fixture.state.chapterBridge.push({ id: 'bridge', novelId: scope.novelId, committedAt: new Date(), sourceRevision: 7 })
    fixture.state.styleProfile.push({ id: 'style', novelId: scope.novelId, confirmed: true })
    fixture.state.styleLearningJob.push({ id: 'learning', profileId: 'style', status: 'running', claimToken: 'stale-token', revision: 3 })
    const result = await committedForRestore()
    expect(fixture.state.projectMemoryEntry[0]).toMatchObject({ status: 'invalid', reviewStatus: 'pending', content: '自动事实', version: 3 })
    expect(fixture.state.projectMemoryEntry[1]).toMatchObject({ status: 'invalid', reviewStatus: 'pending', content: '人工写的关联记忆' })
    expect(fixture.state.projectMemoryEntry[2]).toMatchObject({ status: 'confirmed', version: 1 })
    expect(fixture.state.memoryExtractionJob[0]).toMatchObject({ status: 'failed', errorMessage: 'IMPORT_SOURCE_ARCHIVED' })
    expect(fixture.state.chapterBridge[0]).toMatchObject({ committedAt: null, sourceRevision: -1 })
    expect(fixture.state.styleLearningJob[0]).toMatchObject({ status: 'paused', claimToken: null, revision: 4, enabled: false })
    await restoreNovelImport(human(), result.job.jobId, result.restoreInput)
    expect(fixture.state.projectMemoryEntry[0].status).toBe('invalid')
  })
  it('智能合并：同名章节归档重建，源中没有的现有章节保留，新章节追加', async () => {
    vi.stubEnv('NOVEL_IMPORT_OVERWRITE_ENABLED', 'true')
    fixture.state.volume.push({ id: 'v1', novelId: scope.novelId, title: '卷A', summary: null, orderIndex: 1, revision: 1, archivedAt: null, archivedByImportId: null })
    fixture.state.chapter.push(
      { id: 'c-match', novelId: scope.novelId, authorId: scope.userId, volumeId: 'v1', title: '第一章', summary: null, content: '旧第一章', orderIndex: 1, orderInVolume: 1, wordCount: 4, revision: 1, status: 'draft', visibility: 'public', archivedAt: null, archivedByImportId: null },
      { id: 'c-keep', novelId: scope.novelId, authorId: scope.userId, volumeId: 'v1', title: '保留章', summary: null, content: '别动我', orderIndex: 2, orderInVolume: 2, wordCount: 3, revision: 1, status: 'draft', visibility: 'public', archivedAt: null, archivedByImportId: null },
    )
    Object.assign(fixture.state.novel[0], { chapterCount: 2, wordCount: 7, lastChapterTitle: '保留章' })
    // 源：同名「第一章」更新 + 新增「第二章」；没有「保留章」。
    fixture.parse.mockResolvedValue({ volumes: [{ title: '卷A', chapters: [
      { title: '第一章', content: '新第一章正文', source: 'original.txt#char=0-6' },
      { title: '第二章', content: '新第二章', source: 'original.txt#char=6-10' },
    ] }], metadata: {}, warnings: [], sourceChars: 10, parserVersion: 'fixture-1' })
    const result = await approved()
    const receipt = await commitNovelImport(scope, result.job.jobId, result.input)
    // 同名旧章被归档（保留可恢复），源中没有的现有章原样保留
    expect(fixture.state.chapter.find(c => c.id === 'c-match')!.archivedAt).toBeInstanceOf(Date)
    const keep = fixture.state.chapter.find(c => c.id === 'c-keep')!
    expect(keep.archivedAt).toBeNull(); expect(keep.content).toBe('别动我')
    // 同卷替换保留原位置，新章追加在该卷末尾，不另建同名卷。
    expect(fixture.state.volume.find(v => v.id === 'v1')!.archivedAt).toBeNull()
    expect(fixture.state.volume).toHaveLength(1)
    expect(receipt).toMatchObject({ volumeCount: 1, chapterCount: 2 })
    const live = fixture.state.chapter.filter(c => c.archivedAt === null)
    expect(live.map(c => c.title).sort()).toEqual(['保留章', '第一章', '第二章'].sort())
    expect([...live].sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex)).map(c => [c.title, c.volumeId, c.orderInVolume])).toEqual([['第一章', 'v1', 1], ['保留章', 'v1', 2], ['第二章', 'v1', 3]])
    // 字数/章数对全部非归档章节重算：别动我3 + 新第一章6 + 新第二章4 = 13，共3章
    expect(fixture.state.novel[0]).toMatchObject({ wordCount: 13, chapterCount: 3 })
    // 备份快照只记被归档的旧行，可恢复
    const snapshot = fixture.state.novelImportBackup[0].snapshot as { chapterIds: string[]; volumeIds: string[] }
    expect(snapshot.chapterIds).toEqual(['c-match'])
    expect(snapshot.volumeIds).toEqual([])
  })
  it('选择作品信息而不选正文只更新元数据，旧授权失效且不写卷章', async () => {
    const result = await approved()
    const input = { expectedManifestRevision: result.preview.manifestRevision, manifestHash: result.preview.manifestHash, chapters: [], plans: [], memories: [], metadataSelection: { title: '只更新书名' } }
    const selected = await selectNovelImportContent(human(), result.job.jobId, input)
    expect(selected.manifestRevision).toBe(result.preview.manifestRevision + 1)
    expect(selected.volumes).toEqual([])
    expect(selected.contentExclusions).toEqual([expect.objectContaining({ kind: 'chapter', title: '第一章' })])
    expect(selected.partialImport).toBe(true)
    expect(fixture.state.novel[0].title).toBe('原书')
    await expect(selectNovelImportContent(human(), result.job.jobId, input)).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_CHANGED' })
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_EXPIRED' })
    const grant = await confirmNovelImport(human(), result.job.jobId, { manifestRevision: selected.manifestRevision, manifestHash: selected.manifestHash, targetHash: result.job.targetHash })
    const receipt = await commitNovelImport(scope, result.job.jobId, { approvalId: grant.approvalId, idempotencyKey: 'metadata-only-selection' })
    expect(receipt).toMatchObject({ volumeCount: 0, chapterCount: 0, firstChapterId: '', partialImport: true })
    expect(fixture.state.chapter).toHaveLength(0)
    expect(fixture.state.volume).toHaveLength(0)
    expect(fixture.state.novel[0].title).toBe('只更新书名')
  })
  it('选择接口拒绝全空、其他用户与取消任务，未选内容不能直接写入', async () => {
    const result = await prepared()
    const input = { expectedManifestRevision: result.preview.manifestRevision, manifestHash: result.preview.manifestHash, chapters: [], plans: [], memories: [] }
    await expect(selectNovelImportContent(human(), result.job.jobId, input)).rejects.toMatchObject({ code: 'IMPORT_NO_BODY' })
    const outsider = authenticateNovelImportHuman({ params: { novelId: scope.novelId }, headers: { 'x-test-user': 'user-b' } } as unknown as Request)
    await expect(selectNovelImportContent(outsider, result.job.jobId, input)).rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
    await cancelNovelImport(scope, result.job.jobId)
    await expect(selectNovelImportContent(human(), result.job.jobId, input)).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(fixture.state.novelImportManifest).toHaveLength(1)
    expect(fixture.state.chapter).toHaveLength(0)
  })
  it('仅导入计划/记忆时完全不写卷章，计划入计划夹、记忆委派 saveStoryMemory', async () => {
    existingBook()
    fixture.parse.mockResolvedValue({ volumes: [], plans: [{ title: '主线大纲', content: '这是主线规划' }], memories: [{ memoryType: 'worldbuilding', title: '世界观设定', content: '大陆分为东西两域。' }], metadata: {}, warnings: [], sourceChars: 30, parserVersion: 'fixture-1' })
    const result = await approved()
    const receipt = await commitNovelImport(scope, result.job.jobId, result.input)
    expect(receipt).toMatchObject({ volumeCount: 0, chapterCount: 0, planCount: 1, memoryCount: 1 })
    // 现有卷章一律保留、未归档，作品总量不变
    expect(fixture.state.chapter).toHaveLength(1)
    expect(fixture.state.chapter[0].archivedAt).toBeNull()
    expect(fixture.state.volume[0].archivedAt).toBeNull()
    expect(fixture.state.novel[0]).toMatchObject({ chapterCount: 1 })
    // 计划写入计划夹（chapterPlan + savedAsPlan），载体 run 自动创建
    const plan = fixture.state.agentArtifact.find(a => a.artifactType === 'chapterPlan')
    expect(plan).toMatchObject({ title: '主线大纲', content: '这是主线规划' })
    expect((plan!.metadata as Record<string, unknown>).savedAsPlan).toBe(true)
    expect(fixture.state.agentRun.some(r => r.inputSummary === '一键导入写入计划')).toBe(true)
    // 记忆以 confirmed + overwrite 委派 saveStoryMemory，重复导入就地更新不进冲突箱
    expect(fixture.saveMemory).toHaveBeenCalledTimes(1)
    expect(fixture.saveMemory.mock.calls[0][0]).toMatchObject({ memoryType: 'worldbuilding', title: '世界观设定', status: 'confirmed', overwrite: true, layer: 'L1', importance: 75, evidence: expect.objectContaining({ sourceType: 'author_input' }) })
  })
  it('不同 intent 不取消同作品 LIVE 任务，明确取消后才可新建', async () => {
    const future = new Date(Date.now() + 86400_000)
    fixture.state.novelImportJob.push(
      { id: 'live-same-1', userId: scope.userId, novelId: scope.novelId, status: 'ready', expiresAt: future, leaseEpoch: 0, leaseOwner: null, leaseUntil: null, jobVersion: 1 },
      { id: 'live-same-2', userId: scope.userId, novelId: scope.novelId, status: 'parsing', expiresAt: future, leaseEpoch: 0, leaseOwner: null, leaseUntil: null, jobVersion: 1 },
      { id: 'live-other', userId: scope.userId, novelId: 'novel-b', status: 'ready', expiresAt: future, leaseEpoch: 0, leaseOwner: null, leaseUntil: null, jobVersion: 1 },
    )
    const intent = await preflightNovelImport(scope)
    const before = structuredClone(fixture.state.novelImportJob)
    await expect(prepareNovelImport(scope, intent.intentId)).rejects.toMatchObject({ code: 'IMPORT_ACTIVE_JOB_EXISTS', status: 409 })
    expect(fixture.state.novelImportJob).toEqual(before)
    await cancelNovelImport(scope, 'live-same-1')
    await cancelNovelImport(scope, 'live-same-2')
    const job = await prepareNovelImport(scope, intent.intentId)
    expect(fixture.state.novelImportJob.find(j => j.id === 'live-other')!.status).toBe('ready')
    expect(job.status).toBe('uploading')
  })
  it('同 intent 重复创建优先返回原任务，不触发活动任务冲突', async () => {
    const intent = await preflightNovelImport(scope)
    const job = await prepareNovelImport(scope, intent.intentId)
    const before = structuredClone(fixture.state.novelImportJob)
    expect((await prepareNovelImport(scope, intent.intentId)).jobId).toBe(job.jobId)
    expect(fixture.state.novelImportJob).toEqual(before)
  })
  it('其他作品三个活动任务仍阻止新建，且不改变任何已有任务', async () => {
    fixture.state.novelImportJob.push(...['b', 'c', 'd'].map(id => ({ id, userId: scope.userId, novelId: `novel-${id}`, status: 'ready', expiresAt: new Date(Date.now() + 86400_000) })))
    const intent = await preflightNovelImport(scope)
    const before = structuredClone(fixture.state.novelImportJob)
    await expect(prepareNovelImport(scope, intent.intentId)).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED', status: 429 })
    expect(fixture.state.novelImportJob).toEqual(before)
  })
  it.each(['content', 'title', 'revision', 'orderIndex', 'volumeId', 'publishedContent'])('target hash binds chapter %s changes, even without a count change', async field => {
    existingBook()
    const result = await approved()
    fixture.state.chapter[0][field] = ['revision', 'orderIndex'].includes(field) ? 12 : 'changed'
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_TARGET_CHANGED' })
    expect(fixture.state.novelImportCommit).toHaveLength(0)
    expect(fixture.state.chapter[0].archivedAt).toBeNull()
  })
  it('a manuscript epoch change prevents ABA reuse of unchanged text and counts', async () => {
    const result = await approved()
    fixture.state.novel[0].manuscriptRevision = 2
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_TARGET_CHANGED' })
  })
  it.each(['intent', 'approval'])('expired %s cannot be consumed to overwrite', async kind => {
    existingBook()
    const result = await approved()
    fixture.state[kind === 'intent' ? 'novelImportIntent' : 'novelImportApproval'][0].expiresAt = new Date(0)
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_EXPIRED' })
    expect(fixture.state.chapter[0].archivedAt).toBeNull()
    expect(fixture.state.novelImportApproval[0].consumedAt).toBeNull()
  })
  it('rolls back old archival and dependent invalidation if insertion fails', async () => {
    existingBook()
    const result = await approved()
    const before = structuredClone(fixture.state)
    fixture.db.chapter.createMany.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toThrow('disk unavailable')
    expect(fixture.state).toEqual(before)
  })
  it('mutation row-count mismatch aborts the whole import rather than accepting partial writes', async () => {
    existingBook(); const result = await approved()
    fixture.db.chapter.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_TARGET_CHANGED' })
    expect(fixture.state.chapter[0].archivedAt).toBeNull()
    expect(fixture.state.novelImportBackup).toHaveLength(0)
  })
  it.each(['current-content', 'current-metadata', 'retained-content', 'retained-missing'])('restore refuses %s changes and persists a conflict without partial writes', async change => {
    existingBook(); const result = await committedForRestore()
    if (change === 'current-content') fixture.state.chapter[1].content = '新写的内容不能丢'
    if (change === 'current-metadata') fixture.state.novel[0].summary = '新简介不能丢'
    if (change === 'retained-content') fixture.state.chapter[0].content = '原备份被改'
    if (change === 'retained-missing') fixture.state.chapter.shift()
    const chapters = structuredClone(fixture.state.chapter)
    await expect(restoreNovelImport(human(), result.job.jobId, result.restoreInput)).rejects.toMatchObject({ code: 'IMPORT_RESTORE_CONFLICT' })
    expect(fixture.state.chapter).toEqual(chapters)
    expect(await getNovelImportStatus(scope, result.job.jobId)).toMatchObject({ restore: { status: 'restore_conflict' } })
  })
  it('expired and superseded restore grants cannot consume a backup', async () => {
    const result = await committedForRestore()
    const first = fixture.state.novelImportApproval.find(a => a.id === result.restoreInput.restoreApprovalId)!
    first.expiresAt = new Date(0)
    await expect(restoreNovelImport(human(), result.job.jobId, result.restoreInput)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_EXPIRED' })
    const second = await previewNovelImportRestore(human(), result.job.jobId, result.restoreInput.targetHash)
    await previewNovelImportRestore(human(), result.job.jobId, result.restoreInput.targetHash)
    await expect(restoreNovelImport(human(), result.job.jobId, { ...result.restoreInput, restoreApprovalId: second.restoreApprovalId })).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_EXPIRED' })
    expect(fixture.state.novelImportBackup[0].restoredAt).toBeNull()
  })
  it('restore requires a human grant, matching input baseline and an available backup', async () => {
    const result = await committedForRestore()
    await expect(restoreNovelImport(scope as NovelImportHuman, result.job.jobId, result.restoreInput)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    await expect(restoreNovelImport(human(), result.job.jobId, { ...result.restoreInput, restoreApprovalId: result.approval.approvalId })).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    await expect(restoreNovelImport(human(), result.job.jobId, { ...result.restoreInput, targetHash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'IMPORT_RESTORE_CONFLICT' })
    fixture.state.novelImportBackup[0].expiresAt = new Date(0)
    await expect(restoreNovelImport(human(), result.job.jobId, result.restoreInput)).rejects.toMatchObject({ code: 'IMPORT_RESTORE_UNAVAILABLE' })
  })
  it('restore rollback keeps both versions and its grant when the final receipt cannot persist', async () => {
    existingBook(); const result = await committedForRestore()
    const before = structuredClone(fixture.state)
    fixture.db.novelImportBackup.update.mockRejectedValueOnce(new Error('receipt write failed'))
    await expect(restoreNovelImport(human(), result.job.jobId, result.restoreInput)).rejects.toThrow('receipt write failed')
    expect(fixture.state).toEqual(before)
  })
  it('shared lock precedes archival and raw SQL deadlocks retry only within the bound', async () => {
    existingBook(); const result = await approved()
    await commitNovelImport(scope, result.job.jobId, result.input)
    expect(fixture.db.$queryRaw.mock.invocationCallOrder.at(-2)).toBeLessThan(fixture.db.chapter.updateMany.mock.invocationCallOrder[0])
    const conflict = new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2010', meta: { code: '40P01' }, clientVersion: '6.12.0' })
    fixture.db.$transaction.mockRejectedValueOnce(conflict)
    expect(await novelImportTransaction(async () => 'retried')).toBe('retried')
  })
  it('queued Agent prompts cannot be silently dispatched into an imported manuscript', async () => {
    const result = await approved()
    fixture.state.agentSession.push({ id: 'session', novelId: scope.novelId })
    fixture.state.agentQueuedRequest.push({ id: 'request', sessionId: 'session', status: 'pending' })
    await expect(commitNovelImport(scope, result.job.jobId, result.input)).rejects.toMatchObject({ code: 'IMPORT_WRITE_BUSY' })
    expect(fixture.state.novelImportCommit).toHaveLength(0)
  })
  it('a stopped Agent origin does not permanently lock a valid human-owned preview', async () => {
    const result = await approved()
    fixture.state.novelImportJob[0].agentRunId = 'stopped-origin'
    fixture.state.novelImportJob[0].agentToolCallId = 'old-call'
    fixture.state.agentRun.push({ id: 'stopped-origin', novelId: scope.novelId, status: 'paused' })
    expect((await commitNovelImport(scope, result.job.jobId, result.input)).chapterCount).toBe(1)
  })
  it('marks retryable old patches permanently stale across import/restore, retaining all history', async () => {
    existingBook()
    fixture.state.changeSet.push({ id: 'stale-set', novelId: scope.novelId, status: 'failed', validations: [{ code: 'prior', status: 'failed', message: '旧提示' }], patches: [{ targetType: 'chapter', targetId: 'old-chapter', after: '不得自动应用' }] })
    const result = await committedForRestore()
    expect(fixture.state.changeSet[0].validations).toContainEqual(expect.objectContaining({ code: 'IMPORT_SCOPE_CHANGED', status: 'failed' }))
    expect(fixture.state.changeSet[0].patches).toEqual([{ targetType: 'chapter', targetId: 'old-chapter', after: '不得自动应用' }])
    await restoreNovelImport(human(), result.job.jobId, result.restoreInput)
    expect(fixture.state.changeSet[0].validations).toContainEqual(expect.objectContaining({ code: 'IMPORT_SCOPE_CHANGED' }))
  })
  it('outbox failure rolls back its event and marker, then retries exactly once even with imports disabled', async () => {
    const result = await approved(); await commitNovelImport(scope, result.job.jobId, result.input)
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'false')
    fixture.db.novelImportCommit.update.mockRejectedValueOnce(new Error('marker persistence failed'))
    expect(await drainNovelImportEffects({ jobIds: [result.job.jobId] })).toEqual({ processed: 0, failed: 1 })
    expect(fixture.state.novelImportEvent).toHaveLength(0)
    expect(fixture.state.novelImportCommit[0].effectsPublishedAt).toBeNull()
    expect(await drainNovelImportEffects({ jobIds: [result.job.jobId] })).toEqual({ processed: 1, failed: 0 })
    expect(await drainNovelImportEffects({ jobIds: [result.job.jobId] })).toEqual({ processed: 0, failed: 0 })
    expect(fixture.state.novelImportEvent).toHaveLength(1)
    expect(await getNovelImportStatus(scope, result.job.jobId)).toMatchObject({ effects: { status: 'published', kind: 'imported' } })
  })
  it('outbox projects both import and restore if the server was offline between the two', async () => {
    const result = await committedForRestore()
    await restoreNovelImport(human(), result.job.jobId, result.restoreInput)
    expect(await drainNovelImportEffects({ jobIds: [result.job.jobId] })).toEqual({ processed: 1, failed: 0 })
    expect(fixture.state.novelImportEvent.map(e => e.kind)).toEqual(['imported', 'restored'])
    expect(await getNovelImportStatus(scope, result.job.jobId)).toMatchObject({ effects: { status: 'published', kind: 'restored' } })
    await expect(drainNovelImportEffects({ jobIds: ['not-a-owned-uuid'] })).rejects.toThrow('Invalid bounded')
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
  it('选择UI一次真实确认完成intent，缺少confirmed、目标过期或跨用户均不授权', async () => {
    existingBook()
    const intent = await preflightNovelImport(scope)
    const endpoint = `${base}/intents/${intent.intentId}/confirm-selection`
    expect((await request(app).post(endpoint).set('x-test-user', scope.userId).send({ targetHash: intent.targetHash })).status).toBe(400)
    expect((await request(app).post(endpoint).set('x-test-user', scope.userId).send({ targetHash: intent.targetHash, confirmed: false })).status).toBe(400)
    expect((await request(app).post(endpoint).set('x-test-user', 'user-b').send({ targetHash: intent.targetHash, confirmed: true })).status).toBe(404)
    expect((await request(app).post(endpoint).set('x-test-user', scope.userId).send({ targetHash: 'a'.repeat(64), confirmed: true })).body.error.code).toBe('IMPORT_TARGET_CHANGED')
    expect(fixture.state.novelImportIntent[0].confirmationStep).toBe(0)
    await expect(confirmNovelImportSelectionIntent(scope as NovelImportHuman, intent.intentId, intent.targetHash)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_REQUIRED' })
    const result = await request(app).post(endpoint).set('x-test-user', scope.userId).send({ targetHash: intent.targetHash, confirmed: true })
    expect(result.status).toBe(200)
    expect(result.body.data.confirmationStep).toBe(2)
    const replay = await request(app).post(endpoint).set('x-test-user', scope.userId).send({ targetHash: intent.targetHash, confirmed: true })
    expect(replay.status).toBe(200)
    expect(replay.body.data.confirmationStep).toBe(2)
    expect(fixture.state.novelImportApproval).toHaveLength(0)
    expect(fixture.state.chapter[0].archivedAt).toBeNull()
    fixture.state.novelImportIntent[0].expiresAt = new Date(0)
    expect((await request(app).post(endpoint).set('x-test-user', scope.userId).send({ targetHash: intent.targetHash, confirmed: true })).body.error.code).toBe('IMPORT_APPROVAL_EXPIRED')
  })
  it('authenticates before parsing bodies or exposing capabilities', async () => {
    expect((await request(app).get(`${base}/capabilities`)).status).toBe(401)
    expect((await request(app).post(`${base}/preflight`).type('json').send('{invalid')).status).toBe(401)
    expect((await request(app).get(`${base}/capabilities`).set('x-test-user', scope.userId)).body.data.restoreEnabled).toBe(true)
  })
  it('selection HTTP接口绑定版本，拒绝外来正文与跨用户访问', async () => {
    const { job, preview } = await prepared()
    const input = { expectedManifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, chapters: [{ volumeIndex: 0, chapterIndex: 0 }], plans: [], memories: [] }
    expect((await request(app).post(`${base}/${job.jobId}/selection`).send(input)).status).toBe(401)
    expect((await request(app).post(`${base}/${job.jobId}/selection`).set('x-test-user', 'user-b').send(input)).status).toBe(404)
    expect((await request(app).post(`${base}/${job.jobId}/selection`).set('x-test-user', scope.userId).send({ ...input, content: '不能注入正文' })).status).toBe(400)
    const selected = await request(app).post(`${base}/${job.jobId}/selection`).set('x-test-user', scope.userId).send(input)
    expect(selected.status).toBe(200)
    expect(selected.body.data.manifestRevision).toBe(preview.manifestRevision + 1)
    expect((await request(app).post(`${base}/${job.jobId}/selection`).set('x-test-user', scope.userId).send(input)).body.error.code).toBe('IMPORT_PREVIEW_CHANGED')
    expect(fixture.state.chapter).toHaveLength(0)
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
    fixture.parse.mockResolvedValueOnce({ volumes: [{ title: '卷', chapters: [{ title: '长原文', content: '原'.repeat(20_000), source: 'original.txt' }] }], metadata: {}, warnings: [], sourceChars: 20_000, parserVersion: 'fixture-1' })
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
