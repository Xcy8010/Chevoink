import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { Prisma, type NovelImportJob, type NovelImportIntent } from '@prisma/client'
import { z } from 'zod'
import { NOVEL_IMPORT_LIMITS, novelImportCommitSchema, novelImportManifestEditSchema, novelImportModelSchema, novelImportVolumeSchema, novelImportMetadataSchema, type NovelImportCapabilities, type NovelImportJobStatus, type NovelImportModelSelection, type NovelImportPreflight, type NovelImportPreview, type NovelImportReceipt } from '../../shared/contracts/novel-import.js'
import { prisma, DataAccessError } from './prisma.js'
import { requireSessionUserId } from './auth-session.js'
import { deleteUnreferencedImportBlob, discardImportBlob, importBytesHash, readImportBlob, storeImportJson, storeImportStream, validateImportFilename } from './novel-import-storage.js'
import { NovelImportParseError } from './novel-import/parsers/types.js'
import { parseNovelImportFileIsolated } from './novel-import/isolated-parser.js'
import { assertManagedAttachmentAccess, readAuthorizedAgentAttachment } from './agent-attachment-storage.js'

type Tx = Prisma.TransactionClient
export interface NovelImportScope { userId: string; novelId: string }
const humanBrand = Symbol('verified-import-http-human')
export interface NovelImportHuman extends NovelImportScope { readonly [humanBrand]: true }
const humanRequests = new WeakSet<NovelImportHuman>()
/** Only HTTP handlers may mint this capability; never expose via Agent tools. */
export function authenticateNovelImportHuman(req: Request): NovelImportHuman {
  const human: NovelImportHuman = { userId: requireSessionUserId(req), novelId: req.params.novelId, [humanBrand]: true }
  humanRequests.add(human)
  return human
}
function humanOnly(scope: NovelImportHuman) { if (!humanRequests.has(scope)) fail('IMPORT_APPROVAL_REQUIRED', '此操作需要用户在导入面板亲自确认。', 403) }
function fail(code: string, message: string, status = 409): never { throw new DataAccessError(status, code, message) }
const expiry = (ms: number) => new Date(Date.now() + ms)
const INTENT_MS = 30 * 60_000
const LEASE_MS = 150_000
const LIVE = ['uploading', 'uploaded', 'parsing', 'ready', 'needs_review', 'awaiting_confirmation']
export const NOVEL_IMPORT_DAILY_LIMITS = { jobs: 10, uploadedBytes: 250 * 1024 * 1024 } as const
export const NOVEL_IMPORT_PREVIEW_LIMITS = { revisions: 64, retainedRevisions: 2, pendingGarbage: 100 } as const
export function novelImportCapabilities(): NovelImportCapabilities {
  // An environment variable alone cannot bypass the incomplete archive audit.
  const overwriteVerified = false as const
  return { enabled: process.env.NOVEL_IMPORT_ENABLED === 'true', overwriteVerified, restoreEnabled: false, retainsEmptyVolumes: true, overwriteEnabled: overwriteVerified && process.env.NOVEL_IMPORT_OVERWRITE_ENABLED === 'true', sourceBytes: NOVEL_IMPORT_LIMITS.sourceBytes, aiEnabled: false,
    formats: ['txt', 'md', 'zip', 'docx', 'pdf', 'doc'].map(extension => ({ extension, enabled: extension !== 'doc', ...(extension === 'doc' ? { reason: '隔离 DOC 转换器未验收。' } : extension === 'pdf' ? { reason: '支持分页预览；页面完整性待核验，当前不承诺 PDF 可提交。' } : {}) })),
    limitations: ['确定性解析不调用 AI、不扣模型额度。', '已有章节及已发布作品导入暂不开放；无章节时保留现有空卷并在其后导入新卷。', '备份保留30天；归档兼容未验收，恢复入口暂不开放。', 'DOC、扫描/OCR、图片完整性尚未全部验收。'] }
}
function enabled() { if (!novelImportCapabilities().enabled) fail('IMPORT_DISABLED', '作品导入尚未开放。', 503) }

/** Retry DB serialization failures only. The callback must contain no I/O or model call. */
export async function novelImportTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 20_000 }) }
    catch (error) { if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034') throw error }
  }
}
async function owner(tx: Tx, scope: NovelImportScope) {
  if (!scope.userId) fail('AUTH_REQUIRED', '请先登录。', 401)
  const novel = await tx.novel.findFirst({ where: { id: scope.novelId, authorId: scope.userId } })
  if (!novel) fail('NOVEL_NOT_FOUND', '未找到作品。', 404)
  return novel
}
async function ownedJob(tx: Tx, scope: NovelImportScope, jobId: string) {
  await owner(tx, scope)
  const job = await tx.novelImportJob.findFirst({ where: { id: jobId, ...scope } })
  if (!job) fail('IMPORT_NOT_FOUND', '未找到导入任务。', 404)
  return job
}
function live(job: NovelImportJob) {
  if (job.expiresAt <= new Date()) fail('IMPORT_EXPIRED', '任务已过期，请重新上传。')
  if (job.status === 'cancelled') fail('IMPORT_CANCELLED', '任务已取消。')
  if (job.status === 'succeeded') fail('IMPORT_ALREADY_COMMITTED', '任务已导入完成。')
}
const novelMetadata = (novel: { title: string; summary: string; tagNames: string[]; wordCount: number; chapterCount: number; lastChapterTitle: string | null }) => ({ title: novel.title, summary: novel.summary, tagNames: novel.tagNames, wordCount: novel.wordCount, chapterCount: novel.chapterCount, lastChapterTitle: novel.lastChapterTitle })
async function target(tx: Tx, scope: NovelImportScope) {
  const novel = await owner(tx, scope)
  const volumes = await tx.volume.findMany({ where: { novelId: scope.novelId, archivedAt: null }, orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }] })
  const chapters = await tx.chapter.findMany({ where: { novelId: scope.novelId, archivedAt: null }, orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }] })
  const publishedHistory = await tx.chapter.count({ where: { novelId: scope.novelId, OR: [{ status: 'published' }, { publishedAt: { not: null } }, { publishedContent: { not: null } }, { publishedRevision: { not: null } }] } })
  const hash = importBytesHash(JSON.stringify({ metadata: novelMetadata(novel), status: novel.status, publishedAt: novel.publishedAt, publishedHistory, volumes, chapters }))
  return { novel, volumes, chapters, hash, publishedHistory }
}
function rollout(t: Awaited<ReturnType<typeof target>>) {
  if (t.novel.status === 'published' || t.novel.publishedAt || t.publishedHistory) fail('IMPORT_PUBLISHED_OVERWRITE_BLOCKED', '发布兼容尚未验收，暂不能导入已发布作品。')
  if (t.chapters.length && !novelImportCapabilities().overwriteEnabled) fail('IMPORT_OVERWRITE_DISABLED', '已有章节的作品导入尚未开放。')
}
async function writeSafe(tx: Tx, scope: NovelImportScope) {
  // Conservative: no arbitrary runId exemption. Parent may later bind an origin task grant.
  if (await tx.agentRun.count({ where: { novelId: scope.novelId, status: { in: ['queued', 'running', 'awaiting_approval'] } } })) fail('IMPORT_WRITE_BUSY', '作品有活动 Agent 任务，请停止或完成后重试。')
  if (await tx.changeSet.count({ where: { novelId: scope.novelId, status: { in: ['draft', 'approved', 'applying'] } } })) fail('IMPORT_WRITE_BUSY', '作品存在待处理修改，请先处理后重试。')
}
function intentValid(intent: NovelImportIntent | null, scope: NovelImportScope, hash: string, complete: boolean) {
  if (!intent || intent.userId !== scope.userId || intent.novelId !== scope.novelId) fail('IMPORT_APPROVAL_REQUIRED', '请重新进行导入确认。')
  if (intent.expiresAt <= new Date()) fail('IMPORT_APPROVAL_EXPIRED', '确认已过期，请重新确认。')
  if (intent.targetHash !== hash) fail('IMPORT_TARGET_CHANGED', '作品已变化，请重新核对并确认。')
  if (complete && intent.overwriteRequired && intent.confirmationStep !== 2) fail('IMPORT_APPROVAL_REQUIRED', '覆盖需要两次独立确认。')
  return intent
}
function preflightDto(intent: NovelImportIntent, t: Awaited<ReturnType<typeof target>>): NovelImportPreflight {
  return { intentId: intent.id, targetHash: t.hash, volumeCount: t.volumes.length, chapterCount: t.chapters.length, nonEmptyChapterCount: t.chapters.filter(c => c.content.trim()).length, overwriteRequired: intent.overwriteRequired, confirmationStep: intent.confirmationStep, expiresAt: intent.expiresAt.toISOString() }
}
export async function preflightNovelImport(scope: NovelImportScope) {
  enabled()
  return novelImportTransaction(async tx => {
    const t = await target(tx, scope); rollout(t); await writeSafe(tx, scope)
    if (await tx.novelImportIntent.count({ where: { userId: scope.userId, expiresAt: { gt: new Date() } } }) >= 20) fail('IMPORT_LIMIT_EXCEEDED', '确认次数过多，请稍后重试。', 429)
    const intent = await tx.novelImportIntent.create({ data: { id: randomUUID(), ...scope, targetHash: t.hash, overwriteRequired: t.chapters.length > 0, expiresAt: expiry(INTENT_MS) } })
    return preflightDto(intent, t)
  })
}
export async function confirmNovelImportIntent(human: NovelImportHuman, intentId: string, step: 1 | 2, targetHash: string) {
  humanOnly(human); enabled()
  return novelImportTransaction(async tx => {
    const t = await target(tx, human); rollout(t)
    const intent = intentValid(await tx.novelImportIntent.findUnique({ where: { id: intentId } }), human, t.hash, false)
    if (targetHash !== t.hash || !intent.overwriteRequired || step !== intent.confirmationStep + 1) fail('IMPORT_APPROVAL_REQUIRED', '请按顺序分别完成两次确认。')
    return preflightDto(await tx.novelImportIntent.update({ where: { id: intent.id }, data: { confirmationStep: step } }), t)
  })
}
export async function prepareNovelImport(scope: NovelImportScope, intentId: string, selection: NovelImportModelSelection = { kind: 'basic' }) {
  enabled(); const modelSelection = novelImportModelSchema.parse(selection)
  const id = await novelImportTransaction(async tx => {
    const t = await target(tx, scope); rollout(t)
    const intent = intentValid(await tx.novelImportIntent.findUnique({ where: { id: intentId } }), scope, t.hash, true)
    const prior = await tx.novelImportJob.findUnique({ where: { intentId } }); if (prior) return prior.id
    if (await tx.novelImportJob.count({ where: { userId: scope.userId, createdAt: { gte: new Date(Date.now() - 86400_000) } } }) >= NOVEL_IMPORT_DAILY_LIMITS.jobs) fail('IMPORT_DAILY_JOB_LIMIT', '24小时内最多创建10个导入任务，取消不会重置配额；请使用已有任务或24小时后重试。', 429)
    if (await tx.novelImportJob.count({ where: { userId: scope.userId, status: { in: LIVE }, expiresAt: { gt: new Date() } } }) >= 3) fail('IMPORT_LIMIT_EXCEEDED', '请完成或取消已有导入任务。', 429)
    if (modelSelection.kind === 'custom' && !await tx.aiModelConfig.findFirst({ where: { id: modelSelection.customModelId, ownerUserId: scope.userId, enabled: true }, select: { id: true } })) fail('IMPORT_MODEL_UNAVAILABLE', '本次自定义模型不可用。', 403)
    const job = await tx.novelImportJob.create({ data: { id: randomUUID(), ...scope, intentId: intent.id, targetHash: t.hash, modelSelection, expiresAt: expiry(7 * 86400_000) } })
    return job.id
  })
  return getNovelImportStatus(scope, id)
}
export async function getNovelImportStatus(scope: NovelImportScope, jobId: string): Promise<NovelImportJobStatus> {
  const job = await ownedJob(prisma, scope, jobId)
  const source = await prisma.novelImportSource.findUnique({ where: { jobId } })
  const commit = await prisma.novelImportCommit.findUnique({ where: { jobId } })
  return { jobId, novelId: job.novelId, status: job.status as NovelImportJobStatus['status'], jobVersion: job.jobVersion, manifestRevision: job.manifestRevision, manifestHash: job.manifestHash, sourceHash: source?.sha256 ?? null, targetHash: job.targetHash, errorCode: job.errorCode, expiresAt: job.expiresAt.toISOString(), receipt: commit ? commit.receipt as unknown as NovelImportReceipt : null }
}
export async function listNovelImports(scope: NovelImportScope) {
  await owner(prisma, scope)
  const jobs = await prisma.novelImportJob.findMany({ where: scope, orderBy: { createdAt: 'desc' }, take: 20 })
  return Promise.all(jobs.map(j => getNovelImportStatus(scope, j.id)))
}
export async function downloadNovelImportSource(scope: NovelImportScope, jobId: string) {
  await ownedJob(prisma, scope, jobId)
  const source = await prisma.novelImportSource.findUnique({ where: { jobId } })
  if (!source) fail('IMPORT_SOURCE_UNAVAILABLE', '原文件尚未上传或保留期已结束。', 404)
  const filename = validateImportFilename(source.filename)
  const bytes = await readImportBlob(source.storageKey, source.sha256)
  return { filename, bytes }
}
export async function uploadNovelImportSource(scope: NovelImportScope, jobId: string, filename: string, stream: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
  enabled(); validateImportFilename(filename)
  const claim = await novelImportTransaction(async tx => {
    const job = await ownedJob(tx, scope, jobId); live(job)
    if (job.status !== 'uploading' || (job.leaseUntil && job.leaseUntil > new Date())) fail('IMPORT_WRITE_BUSY', '任务不能接收此上传。')
    const recentSources = await tx.novelImportSource.findMany({ where: { job: { userId: scope.userId }, createdAt: { gte: new Date(Date.now() - 86400_000) } }, select: { bytes: true } })
    const reserved = await tx.novelImportJob.count({ where: { userId: scope.userId, status: 'uploading', leaseUntil: { gt: new Date() } } })
    if (recentSources.reduce((sum, source) => sum + source.bytes, 0) + (reserved + 1) * NOVEL_IMPORT_LIMITS.sourceBytes > NOVEL_IMPORT_DAILY_LIMITS.uploadedBytes) fail('IMPORT_DAILY_UPLOAD_LIMIT', '24小时导入上传限额为250MiB；每次上传先预留50MiB，取消不重置已上传用量。请等待其他上传完成或24小时后重试。', 429)
    return tx.novelImportJob.update({ where: { id: jobId }, data: { leaseOwner: randomUUID(), leaseEpoch: { increment: 1 }, leaseUntil: expiry(LEASE_MS), jobVersion: { increment: 1 } } })
  })
  let blob: Awaited<ReturnType<typeof storeImportStream>> | undefined
  try {
    blob = await storeImportStream(stream, { signal })
    const saved = blob
    await novelImportTransaction(async tx => {
      const job = await ownedJob(tx, scope, jobId); live(job)
      if (job.status !== 'uploading' || job.leaseEpoch !== claim.leaseEpoch || job.leaseOwner !== claim.leaseOwner || !job.leaseUntil || job.leaseUntil <= new Date()) fail('IMPORT_LEASE_LOST', '上传已失效，请重试。')
      await tx.novelImportSource.create({ data: { id: randomUUID(), jobId, filename, ...saved } })
      await tx.novelImportJob.update({ where: { id: jobId }, data: { status: 'uploaded', leaseOwner: null, leaseUntil: null, jobVersion: { increment: 1 } } })
    })
  } catch (error) {
    if (blob) await discardImportBlob(blob.storageKey)
    await prisma.novelImportJob.updateMany({ where: { id: jobId, ...scope, status: 'uploading', leaseEpoch: claim.leaseEpoch }, data: { leaseOwner: null, leaseUntil: null } })
    throw error
  }
  return getNovelImportStatus(scope, jobId)
}

/** Human handoff from exactly the original user message of this owned run. */
export async function attachNovelImportSource(human: NovelImportHuman, jobId: string, input: { runId: string; url: string }, signal?: AbortSignal) {
  humanOnly(human); enabled()
  await ownedJob(prisma, human, jobId)
  const run = await prisma.agentRun.findFirst({ where: { id: input.runId, userId: human.userId, novelId: human.novelId }, select: { id: true, sessionId: true } })
  if (!run) fail('IMPORT_ATTACHMENT_SCOPE', '附件不属于此作品任务。', 403)
  const session = await prisma.agentSession.findFirst({ where: { id: run.sessionId, userId: human.userId, novelId: human.novelId }, select: { id: true } })
  if (!session) fail('IMPORT_ATTACHMENT_SCOPE', '附件会话归属无效。', 403)
  const original = await prisma.agentMessage.findFirst({ where: { runId: run.id, sessionId: session.id, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
  const partSchema = z.object({ type: z.literal('attachment'), kind: z.literal('file'), name: z.string().min(1).max(255), url: z.string().max(1024) })
  const attachment = (Array.isArray(original?.parts) ? original.parts : []).map(part => partSchema.safeParse(part)).find(part => part.success && part.data.url === input.url)
  if (!attachment?.success) fail('IMPORT_ATTACHMENT_SCOPE', '本次原始用户消息中没有此文件，请重新上传。', 403)
  await assertManagedAttachmentAccess(input.url, human.userId)
  signal?.throwIfAborted()
  const bytes = await readAuthorizedAgentAttachment(input.url, human.userId)
  return uploadNovelImportSource(human, jobId, attachment.data.name, (async function* () { yield bytes })(), signal)
}

const parsedVolumeSchema = novelImportVolumeSchema.extend({ chapters: z.array(novelImportVolumeSchema.shape.chapters.element.extend({ content: z.string().max(NOVEL_IMPORT_LIMITS.characters) })).max(NOVEL_IMPORT_LIMITS.chapters) })
const parsedSchema = z.object({ volumes: z.array(parsedVolumeSchema).max(NOVEL_IMPORT_LIMITS.volumes), metadata: novelImportMetadataSchema, warnings: z.array(z.object({ code: z.string().max(128), message: z.string().max(4000), source: z.string().max(4096).optional(), blocking: z.boolean() })).max(5000), sourceChars: z.number().int().nonnegative().max(NOVEL_IMPORT_LIMITS.characters), parserVersion: z.string().min(1).max(128) })
export function assertNovelImportContent(volumes: NovelImportPreview['volumes'], options: { allowOversizedChapters?: boolean } = {}) {
  const chapters = volumes.flatMap(v => v.chapters)
  if (chapters.length > NOVEL_IMPORT_LIMITS.chapters || chapters.reduce((n, c) => n + c.content.length, 0) > NOVEL_IMPORT_LIMITS.characters) fail('IMPORT_LIMIT_EXCEEDED', '卷章或正文超过导入上限。', 413)
  if (!options.allowOversizedChapters && chapters.some(chapter => chapter.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters)) fail('IMPORT_CHAPTER_TOO_LONG', '单章超过10万字符，请在预览中拆分。')
  if (!chapters.some(c => c.content.trim())) fail('IMPORT_NO_BODY', '至少需要一章非空正文。')
}
export function hashNovelImportPreview(preview: Omit<NovelImportPreview, 'manifestHash'> | NovelImportPreview) {
  const { manifestHash: _ignored, ...body } = { ...preview, manifestHash: '' }
  return importBytesHash(JSON.stringify(body))
}
async function cleanupPreviewBlob(storageKey: string): Promise<void> {
  try {
    // Recheck even on an uncertain transaction result: never unlink a blob
    // whose commit actually succeeded but whose response was lost.
    if (await prisma.novelImportManifest.count({ where: { storageKey } }) || await prisma.novelImportSource.count({ where: { storageKey } })) return
    await deleteUnreferencedImportBlob(storageKey)
    await prisma.novelImportGarbage.deleteMany({ where: { storageKey } })
  } catch {
    // No swallowed unlink failures: retain a durable exact-key retry record.
    await prisma.novelImportGarbage.createMany({ data: [{ storageKey }], skipDuplicates: true }).catch(() => undefined)
  }
}
async function persistPreview(scope: NovelImportScope, jobId: string, expected: NovelImportJob, preview: NovelImportPreview, lease?: string) {
  // The claim precedes serialization/filesystem work. Parallel stale saves can
  // neither allocate a blob nor consume an unbounded history revision.
  const claim = await novelImportTransaction(async tx => {
    const job = await ownedJob(tx, scope, jobId); live(job)
    if (job.manifestRevision >= NOVEL_IMPORT_PREVIEW_LIMITS.revisions) fail('IMPORT_PREVIEW_LIMIT', '本任务已保存64个预览版本；请下载原文件后创建新任务。', 429)
    if (job.jobVersion !== expected.jobVersion || job.manifestRevision !== expected.manifestRevision || preview.manifestRevision !== job.manifestRevision + 1) fail('IMPORT_PREVIEW_CHANGED', '预览或任务已变化，请刷新。')
    if (await tx.novelImportGarbage.count() >= NOVEL_IMPORT_PREVIEW_LIMITS.pendingGarbage) fail('IMPORT_STORAGE_BUSY', '历史文件清理积压，请稍后再保存；当前预览已保留。', 429)
    if (lease) {
      if (job.leaseOwner !== lease || job.leaseEpoch !== expected.leaseEpoch || !job.leaseUntil || job.leaseUntil <= new Date()) fail('IMPORT_LEASE_LOST', '解析保存租约已失效。')
      return job
    }
    if (job.leaseUntil && job.leaseUntil > new Date()) fail('IMPORT_WRITE_BUSY', '预览正在保存，请等待完成后刷新。', 429)
    return tx.novelImportJob.update({ where: { id: jobId }, data: { leaseOwner: randomUUID(), leaseEpoch: { increment: 1 }, leaseUntil: expiry(LEASE_MS), jobVersion: { increment: 1 } } })
  })
  let blob: Awaited<ReturnType<typeof storeImportJson>> | undefined
  try {
    blob = await storeImportJson(preview)
    const saved = blob
    const prunedKeys = await novelImportTransaction(async tx => {
      const job = await ownedJob(tx, scope, jobId); live(job)
      if (job.jobVersion !== claim.jobVersion || job.manifestRevision !== claim.manifestRevision || job.leaseEpoch !== claim.leaseEpoch || job.leaseOwner !== claim.leaseOwner || !job.leaseUntil || job.leaseUntil <= new Date()) fail('IMPORT_PREVIEW_CHANGED', '预览或任务已变化，请刷新。')
      await tx.novelImportManifest.create({ data: { id: randomUUID(), jobId, revision: preview.manifestRevision, hash: saved.sha256, storageKey: saved.storageKey } })
      await tx.novelImportJob.update({ where: { id: jobId }, data: { status: preview.warnings.some(w => w.blocking) || !preview.volumes.some(v => v.chapters.some(c => c.content.trim())) ? 'needs_review' : 'ready', manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, jobVersion: { increment: 1 }, errorCode: null } })
      const obsolete = await tx.novelImportManifest.findMany({ where: { jobId, revision: { lte: preview.manifestRevision - NOVEL_IMPORT_PREVIEW_LIMITS.retainedRevisions } }, select: { id: true, storageKey: true }, take: NOVEL_IMPORT_PREVIEW_LIMITS.revisions })
      await tx.novelImportManifest.deleteMany({ where: { jobId, id: { in: obsolete.map(row => row.id) } } })
      return obsolete.map(row => row.storageKey)
    })
    // Triggers already queued obsolete keys. Eager cleanup bounds on-disk history
    // between periodic ticks; failures stay queued and activate backpressure.
    for (const key of prunedKeys) await cleanupPreviewBlob(key)
  } catch (error) { if (blob) await cleanupPreviewBlob(blob.storageKey); throw error }
  finally {
    await prisma.novelImportJob.updateMany({ where: { id: jobId, leaseEpoch: claim.leaseEpoch, leaseOwner: claim.leaseOwner }, data: { leaseOwner: null, leaseUntil: null } })
  }
}
export async function getNovelImportPreview(scope: NovelImportScope, jobId: string): Promise<NovelImportPreview> {
  const job = await ownedJob(prisma, scope, jobId)
  const manifest = await prisma.novelImportManifest.findUnique({ where: { jobId_revision: { jobId, revision: job.manifestRevision } } })
  if (!manifest) fail('IMPORT_PREVIEW_UNAVAILABLE', '解析预览尚未就绪。')
  const preview = JSON.parse((await readImportBlob(manifest.storageKey, manifest.hash, 32 * 1024 * 1024)).toString('utf8')) as NovelImportPreview
  if (preview.manifestHash !== job.manifestHash || hashNovelImportPreview(preview) !== job.manifestHash) fail('IMPORT_PREVIEW_CHANGED', '预览校验失败，请重新解析。')
  return preview
}
/** Durable state is authoritative. In-memory promises only accelerate a DB claim. */
export async function analyzeNovelImport(scope: NovelImportScope, jobId: string, encoding?: string) {
  enabled()
  if (encoding !== undefined) encoding = z.string().min(1).max(32).parse(encoding)
  const claim = await novelImportTransaction(async tx => {
    const job = await ownedJob(tx, scope, jobId); live(job)
    if (job.status === 'parsing' && job.leaseUntil && job.leaseUntil > new Date()) return null
    if (job.manifestRevision >= NOVEL_IMPORT_PREVIEW_LIMITS.revisions) fail('IMPORT_PREVIEW_LIMIT', '本任务已保存64个预览版本；请下载原文件后创建新任务。', 429)
    if (job.leaseUntil && job.leaseUntil > new Date()) fail('IMPORT_WRITE_BUSY', '预览保存尚未完成，请稍后重试。', 429)
    const explicitReparse = encoding !== undefined && ['ready', 'needs_review', 'awaiting_confirmation'].includes(job.status)
    if (!['uploaded', 'failed', 'parsing'].includes(job.status) && !explicitReparse) fail('IMPORT_STATE_INVALID', '当前任务不能启动解析；重新解析预览时请明确选择编码。')
    if (await tx.novelImportJob.count({ where: { status: 'parsing', leaseUntil: { gt: new Date() } } })) fail('IMPORT_WRITE_BUSY', '解析器繁忙，请稍后重试。', 429)
    const source = await tx.novelImportSource.findUnique({ where: { jobId } }); if (!source) fail('IMPORT_SOURCE_INVALID', '请先上传文件。')
    // Preserve the audit rows, but revoke every unconsumed old content grant.
    await tx.novelImportApproval.updateMany({ where: { jobId, consumedAt: null }, data: { expiresAt: new Date() } })
    const updated = await tx.novelImportJob.update({ where: { id: jobId }, data: { status: 'parsing', parseEncoding: encoding ?? job.parseEncoding, leaseOwner: randomUUID(), leaseEpoch: { increment: 1 }, leaseUntil: expiry(LEASE_MS), jobVersion: { increment: 1 }, errorCode: null } })
    return { job: updated, source }
  })
  if (claim) void runParse(scope, claim, claim.job.parseEncoding ?? undefined).catch(() => undefined)
  return getNovelImportStatus(scope, jobId)
}
async function runParse(scope: NovelImportScope, claim: { job: NovelImportJob; source: { storageKey: string; sha256: string; filename: string } }, encoding?: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  const poll = setInterval(() => { void prisma.novelImportJob.findUnique({ where: { id: claim.job.id }, select: { status: true, leaseEpoch: true } }).then(current => { if (!current || current.status !== 'parsing' || current.leaseEpoch !== claim.job.leaseEpoch) controller.abort() }).catch(() => controller.abort()) }, 1000)
  try {
    const bytes = await readImportBlob(claim.source.storageKey, claim.source.sha256)
    controller.signal.throwIfAborted()
    const result = await parseNovelImportFileIsolated(bytes, claim.source.filename, { encoding, signal: controller.signal })
    const parsed = parsedSchema.parse({ ...result, volumes: result.volumes.map(volume => ({ ...volume, chapters: volume.chapters.map(chapter => ({ ...chapter, source: { memberPath: chapter.source } })) })) })
    if (parsed.volumes.some(v => v.chapters.some(c => c.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters))) parsed.warnings.push({ code: 'IMPORT_CHAPTER_TOO_LONG', message: '单章超过10万字符，请在预览中拆分。', blocking: true })
    const currentTarget = await target(prisma, scope)
    if (!currentTarget.chapters.length && currentTarget.volumes.length) parsed.warnings.push({ code: 'IMPORT_EMPTY_VOLUMES_RETAINED', message: `将保留现有 ${currentTarget.volumes.length} 个空卷，并在其后导入新卷；不会删除或改名原空卷。`, blocking: false })
    controller.signal.throwIfAborted()
    const body = { ...parsed, sourceHash: claim.source.sha256, metadataSelection: {}, manifestRevision: claim.job.manifestRevision + 1 }
    const preview: NovelImportPreview = { ...body, manifestHash: hashNovelImportPreview(body) }
    await persistPreview(scope, claim.job.id, claim.job, preview, claim.job.leaseOwner ?? undefined)
  } catch (error) {
    await prisma.novelImportJob.updateMany({ where: { id: claim.job.id, status: 'parsing', leaseEpoch: claim.job.leaseEpoch, leaseOwner: claim.job.leaseOwner }, data: { status: 'failed', errorCode: error instanceof DataAccessError || error instanceof NovelImportParseError ? error.code : controller.signal.aborted ? 'IMPORT_PARSE_CANCELLED' : 'IMPORT_PARSE_FAILED', leaseOwner: null, leaseUntil: null, jobVersion: { increment: 1 } } })
  } finally { clearTimeout(timer); clearInterval(poll) }
}
/** Call on startup / bounded scheduler tick. Reclaims expired claims, never approvals. */
export async function recoverNovelImportJobs(): Promise<void> {
  if (!novelImportCapabilities().enabled) return
  const jobs = await prisma.novelImportJob.findMany({ where: { status: 'parsing', leaseUntil: { lte: new Date() }, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'asc' }, take: 1 })
  for (const job of jobs) await analyzeNovelImport({ userId: job.userId, novelId: job.novelId }, job.id).catch(() => undefined)
}
export async function editNovelImportPreview(human: NovelImportHuman, jobId: string, input: unknown) {
  humanOnly(human); enabled()
  const edit = novelImportManifestEditSchema.parse(input)
  const job = await ownedJob(prisma, human, jobId); live(job)
  if (job.manifestRevision >= NOVEL_IMPORT_PREVIEW_LIMITS.revisions) fail('IMPORT_PREVIEW_LIMIT', '本任务已保存64个预览版本；请下载原文件后创建新任务。', 429)
  if (!['ready', 'needs_review', 'awaiting_confirmation'].includes(job.status) || edit.expectedManifestRevision !== job.manifestRevision) fail('IMPORT_PREVIEW_CHANGED', '预览已变化，请刷新。')
  const old = await getNovelImportPreview(human, jobId)
  assertNovelImportContent(edit.volumes, { allowOversizedChapters: true })
  // Parser blocking warnings cannot be erased via body edits. Resolving missing source requires reparsing.
  const body = { ...old, volumes: edit.volumes, metadataSelection: edit.metadataSelection ?? old.metadataSelection, manifestRevision: old.manifestRevision + 1, warnings: old.warnings.filter(w => !['IMPORT_CHAPTER_TOO_LONG', 'IMPORT_CHAPTER_TOO_LARGE'].includes(w.code)) }
  if (edit.volumes.some(v => v.chapters.some(c => c.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters))) body.warnings.push({ code: 'IMPORT_CHAPTER_TOO_LARGE', message: '单章仍超过10万字符，请继续拆分后确认导入。', blocking: true })
  const preview = { ...body, manifestHash: hashNovelImportPreview(body) }
  await persistPreview(human, jobId, job, preview)
  return preview
}
export async function rebaseNovelImport(human: NovelImportHuman, jobId: string, intentId: string) {
  humanOnly(human); enabled()
  await novelImportTransaction(async tx => {
    const job = await ownedJob(tx, human, jobId); live(job)
    if (job.status === 'parsing' || job.leaseOwner) fail('IMPORT_WRITE_BUSY', '请等待当前操作结束。')
    const t = await target(tx, human); rollout(t)
    intentValid(await tx.novelImportIntent.findUnique({ where: { id: intentId } }), human, t.hash, true)
    await tx.novelImportJob.update({ where: { id: jobId }, data: { intentId, targetHash: t.hash, status: job.manifestRevision ? 'needs_review' : job.status, jobVersion: { increment: 1 } } })
    await tx.novelImportApproval.updateMany({ where: { jobId, consumedAt: null }, data: { expiresAt: new Date() } })
  })
  return getNovelImportStatus(human, jobId)
}
export async function confirmNovelImport(human: NovelImportHuman, jobId: string, input: { manifestRevision: number; manifestHash: string; targetHash: string }) {
  humanOnly(human); enabled()
  const preview = await getNovelImportPreview(human, jobId)
  assertNovelImportContent(preview.volumes)
  if (preview.warnings.some(w => w.blocking)) fail('IMPORT_INCOMPLETE_CONTENT', '存在未解决的来源完整性问题。')
  return novelImportTransaction(async tx => {
    const job = await ownedJob(tx, human, jobId); live(job)
    const t = await target(tx, human); rollout(t); await writeSafe(tx, human)
    if (job.leaseUntil && job.leaseUntil > new Date()) fail('IMPORT_WRITE_BUSY', '请等待预览保存完成。')
    if (!['ready', 'needs_review', 'awaiting_confirmation'].includes(job.status)) fail('IMPORT_STATE_INVALID', '请等待解析完成后确认。')
    intentValid(await tx.novelImportIntent.findUnique({ where: { id: job.intentId } }), human, t.hash, true)
    if (t.hash !== input.targetHash || t.hash !== job.targetHash) fail('IMPORT_TARGET_CHANGED', '作品已变化，请重新确认。')
    if (job.manifestRevision !== input.manifestRevision || job.manifestHash !== input.manifestHash || preview.manifestHash !== job.manifestHash) fail('IMPORT_PREVIEW_CHANGED', '预览已变化，请重新确认。')
    const source = await tx.novelImportSource.findUniqueOrThrow({ where: { jobId } })
    if (source.sha256 !== preview.sourceHash) fail('IMPORT_SOURCE_CHANGED', '来源已变化。')
    const approval = await tx.novelImportApproval.create({ data: { id: randomUUID(), jobId, userId: human.userId, kind: 'commit', sourceHash: source.sha256, manifestHash: job.manifestHash, manifestRevision: job.manifestRevision, targetHash: t.hash, expiresAt: expiry(10 * 60_000) } })
    await tx.novelImportJob.update({ where: { id: jobId }, data: { status: 'awaiting_confirmation', jobVersion: { increment: 1 } } })
    return { approvalId: approval.id, expiresAt: approval.expiresAt.toISOString() }
  })
}

export async function cancelNovelImport(scope: NovelImportScope, jobId: string) {
  await novelImportTransaction(async tx => {
    const job = await ownedJob(tx, scope, jobId)
    if (job.status === 'succeeded' || job.status === 'cancelled') return
    await tx.novelImportJob.update({ where: { id: jobId }, data: { status: 'cancelled', leaseEpoch: { increment: 1 }, leaseOwner: null, leaseUntil: null, jobVersion: { increment: 1 } } })
  })
  return getNovelImportStatus(scope, jobId)
}

/** Agent may call only with an existing human grant ID, never booleans or new content. */
export async function commitNovelImport(scope: NovelImportScope, jobId: string, input: { approvalId: string; idempotencyKey: string }): Promise<NovelImportReceipt> {
  enabled()
  await ownedJob(prisma, scope, jobId)
  input = novelImportCommitSchema.parse(input)
  // Authenticated replay is independent of source TTL and consumed grant state.
  const existing = await prisma.novelImportCommit.findUnique({ where: { jobId } })
  if (existing) {
    if (existing.approvalId !== input.approvalId || existing.idempotencyKey !== input.idempotencyKey) fail('IMPORT_IDEMPOTENCY_CONFLICT', '提交参数与原回执不一致。')
    return existing.receipt as unknown as NovelImportReceipt
  }
  const preview = await getNovelImportPreview(scope, jobId)
  assertNovelImportContent(preview.volumes)
  if (preview.warnings.some(w => w.blocking)) fail('IMPORT_INCOMPLETE_CONTENT', '存在未解决的完整性问题。')
  const source = await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId } })
  await readImportBlob(source.storageKey, source.sha256)
  return novelImportTransaction(async tx => {
    const job = await ownedJob(tx, scope, jobId)
    const prior = await tx.novelImportCommit.findUnique({ where: { jobId } })
    if (prior) {
      if (prior.approvalId !== input.approvalId || prior.idempotencyKey !== input.idempotencyKey) fail('IMPORT_IDEMPOTENCY_CONFLICT', '提交参数与原回执不一致。')
      return prior.receipt as unknown as NovelImportReceipt
    }
    live(job)
    if (job.leaseUntil && job.leaseUntil > new Date()) fail('IMPORT_WRITE_BUSY', '请等待预览保存完成。')
    const t = await target(tx, scope); rollout(t); await writeSafe(tx, scope)
    intentValid(await tx.novelImportIntent.findUnique({ where: { id: job.intentId } }), scope, t.hash, true)
    const approval = await tx.novelImportApproval.findFirst({ where: { id: input.approvalId, jobId, userId: scope.userId, kind: 'commit', consumedAt: null } })
    if (!approval) fail('IMPORT_APPROVAL_REQUIRED', '需要有效的用户导入批准。', 403)
    if (approval.expiresAt <= new Date()) fail('IMPORT_APPROVAL_EXPIRED', '导入批准已过期。')
    if (approval.targetHash !== t.hash || job.targetHash !== t.hash) fail('IMPORT_TARGET_CHANGED', '作品已变化，请重新确认。')
    if (approval.manifestHash !== job.manifestHash || approval.manifestRevision !== job.manifestRevision || preview.manifestHash !== job.manifestHash) fail('IMPORT_PREVIEW_CHANGED', '预览已变化，请重新确认。')
    if (job.status !== 'awaiting_confirmation') fail('IMPORT_APPROVAL_REQUIRED', '请重新确认具体预览。')
    const currentSource = await tx.novelImportSource.findUniqueOrThrow({ where: { jobId } })
    if (approval.sourceHash !== currentSource.sha256 || currentSource.sha256 !== source.sha256 || source.sha256 !== preview.sourceHash) fail('IMPORT_SOURCE_CHANGED', '来源校验失败。')
    const backupId = randomUUID(); const now = new Date(); const restoreExpiresAt = expiry(30 * 86400_000)
    // Retain complete original rows and references. No deleteMany, no ID reuse.
    const replacing = t.chapters.length > 0
    if (!replacing && t.volumes.length + preview.volumes.length > NOVEL_IMPORT_LIMITS.volumes) fail('IMPORT_LIMIT_EXCEEDED', '保留空卷后总卷数超过200，请先整理空卷。')
    if (replacing) {
      await tx.chapter.updateMany({ where: { novelId: scope.novelId, archivedAt: null }, data: { archivedAt: now, archivedByImportId: jobId, revision: { increment: 1 } } })
      await tx.volume.updateMany({ where: { novelId: scope.novelId, archivedAt: null }, data: { archivedAt: now, archivedByImportId: jobId, revision: { increment: 1 } } })
    }
    let orderIndex = 0; let wordCount = 0; let firstChapterId = ''; let lastChapterTitle = ''
    const volumeOffset = replacing ? 0 : Math.max(0, ...t.volumes.map(volume => volume.orderIndex))
    const volumes = preview.volumes.map((v, index) => ({ id: randomUUID(), novelId: scope.novelId, title: v.title, orderIndex: volumeOffset + index + 1 }))
    await tx.volume.createMany({ data: volumes })
    const chapters = preview.volumes.flatMap((volume, vi) => volume.chapters.map((chapter, ci) => {
      const id = randomUUID(); if (!firstChapterId) firstChapterId = id
      orderIndex++; wordCount += chapter.content.length; lastChapterTitle = chapter.title
      return { id, novelId: scope.novelId, authorId: scope.userId, title: chapter.title, content: chapter.content, volumeId: volumes[vi].id, orderIndex, orderInVolume: ci + 1, wordCount: chapter.content.length, status: 'draft' as const, visibility: 'private' as const }
    }))
    await tx.chapter.createMany({ data: chapters })
    const m = preview.metadataSelection
    await tx.novel.update({ where: { id: scope.novelId }, data: { ...(m.title !== undefined ? { title: m.title } : {}), ...(m.summary !== undefined ? { summary: m.summary } : {}), ...(m.tags !== undefined ? { tagNames: m.tags } : {}), wordCount, chapterCount: orderIndex, lastChapterTitle } })
    const after = await target(tx, scope)
    const archivedVolumes = await tx.volume.findMany({ where: { id: { in: replacing ? t.volumes.map(v => v.id) : [] } }, orderBy: { id: 'asc' } })
    const archivedChapters = await tx.chapter.findMany({ where: { id: { in: t.chapters.map(c => c.id) } }, orderBy: { id: 'asc' } })
    const snapshot = { volumeIds: replacing ? t.volumes.map(v => v.id) : [], chapterIds: t.chapters.map(c => c.id), retainedEmptyVolumeIds: replacing ? [] : t.volumes.map(v => v.id), importedVolumeIds: volumes.map(v => v.id), importedChapterIds: chapters.map(c => c.id), metadata: novelMetadata(t.novel), retainedHash: importBytesHash(JSON.stringify({ volumes: archivedVolumes, chapters: archivedChapters })) }
    await tx.novelImportBackup.create({ data: { id: backupId, jobId, snapshot, beforeHash: t.hash, afterHash: after.hash, expiresAt: restoreExpiresAt } })
    const receipt: NovelImportReceipt = { jobId, novelId: scope.novelId, backupId, volumeCount: volumes.length, chapterCount: chapters.length, wordCount, firstChapterId, targetHash: after.hash, restoreExpiresAt: restoreExpiresAt.toISOString() }
    await tx.novelImportApproval.update({ where: { id: approval.id }, data: { consumedAt: now } })
    await tx.novelImportCommit.create({ data: { jobId, approvalId: approval.id, idempotencyKey: input.idempotencyKey, receipt: { ...receipt } } })
    await tx.novelImportJob.update({ where: { id: jobId }, data: { status: 'succeeded', jobVersion: { increment: 1 } } })
    return receipt
  })
}

/** Separately testable even while restoration is hardlocked for rollout. */
export function assertNovelImportRestoreBaseline(current: string, committed: string, requested = committed, approved = committed): void {
  if (current !== committed || current !== requested || current !== approved) fail('IMPORT_RESTORE_CONFLICT', '导入后已有修改，不能覆盖这些修改。')
}
export async function previewNovelImportRestore(human: NovelImportHuman, jobId: string) {
  humanOnly(human)
  if (!novelImportCapabilities().restoreEnabled) fail('IMPORT_RESTORE_DISABLED', '归档兼容尚未验收，恢复暂不开放。', 503)
  return novelImportTransaction(async tx => {
    const job = await ownedJob(tx, human, jobId)
    const backup = await tx.novelImportBackup.findUnique({ where: { jobId } })
    if (!backup || backup.restoredAt || backup.expiresAt <= new Date()) fail('IMPORT_RESTORE_UNAVAILABLE', '恢复版本不可用或已过期。')
    const t = await target(tx, human); await writeSafe(tx, human)
    assertNovelImportRestoreBaseline(t.hash, backup.afterHash)
    const source = await tx.novelImportSource.findUniqueOrThrow({ where: { jobId } })
    const approval = await tx.novelImportApproval.create({ data: { id: randomUUID(), jobId, userId: human.userId, kind: 'restore', sourceHash: source.sha256, manifestHash: job.manifestHash!, manifestRevision: job.manifestRevision, targetHash: t.hash, expiresAt: expiry(10 * 60_000) } })
    return { restoreApprovalId: approval.id, targetHash: t.hash, expiresAt: approval.expiresAt.toISOString() }
  })
}
const backupSchema = z.object({ volumeIds: z.array(z.string()), chapterIds: z.array(z.string()), retainedEmptyVolumeIds: z.array(z.string()), importedVolumeIds: z.array(z.string()), importedChapterIds: z.array(z.string()), metadata: z.object({ title: z.string(), summary: z.string(), tagNames: z.array(z.string()), wordCount: z.number(), chapterCount: z.number(), lastChapterTitle: z.string().nullable() }), retainedHash: z.string() })
export async function restoreNovelImport(human: NovelImportHuman, jobId: string, input: { restoreApprovalId: string; targetHash: string }) {
  humanOnly(human)
  if (!novelImportCapabilities().restoreEnabled) fail('IMPORT_RESTORE_DISABLED', '归档兼容尚未验收，恢复暂不开放。', 503)
  return novelImportTransaction(async tx => {
    await ownedJob(tx, human, jobId)
    const backup = await tx.novelImportBackup.findUnique({ where: { jobId } })
    const commit = await tx.novelImportCommit.findUnique({ where: { jobId } })
    if (!backup || !commit || backup.expiresAt <= new Date()) fail('IMPORT_RESTORE_UNAVAILABLE', '恢复版本不可用。')
    const approval = await tx.novelImportApproval.findFirst({ where: { id: input.restoreApprovalId, jobId, userId: human.userId, kind: 'restore' } })
    if (!approval) fail('IMPORT_APPROVAL_REQUIRED', '恢复需要独立确认。', 403)
    if (backup.restoredAt && approval.consumedAt) return { ...(commit.receipt as unknown as NovelImportReceipt), restored: true }
    if (backup.restoredAt || approval.consumedAt || approval.expiresAt <= new Date()) fail('IMPORT_APPROVAL_EXPIRED', '恢复确认已失效。')
    const t = await target(tx, human); await writeSafe(tx, human)
    assertNovelImportRestoreBaseline(t.hash, backup.afterHash, input.targetHash, approval.targetHash)
    const snapshot = backupSchema.parse(backup.snapshot)
    const volumes = await tx.volume.findMany({ where: { novelId: human.novelId, id: { in: snapshot.volumeIds }, archivedByImportId: jobId, archivedAt: { not: null } }, orderBy: { id: 'asc' } })
    const chapters = await tx.chapter.findMany({ where: { novelId: human.novelId, id: { in: snapshot.chapterIds }, archivedByImportId: jobId, archivedAt: { not: null } }, orderBy: { id: 'asc' } })
    if (importBytesHash(JSON.stringify({ volumes, chapters })) !== snapshot.retainedHash) fail('IMPORT_RESTORE_CONFLICT', '原版本记录已变化，恢复已阻止。')
    const now = new Date()
    await tx.chapter.updateMany({ where: { novelId: human.novelId, archivedAt: null, id: { in: snapshot.importedChapterIds } }, data: { archivedAt: now, archivedByImportId: jobId, revision: { increment: 1 } } })
    await tx.volume.updateMany({ where: { novelId: human.novelId, archivedAt: null, id: { in: snapshot.importedVolumeIds } }, data: { archivedAt: now, archivedByImportId: jobId, revision: { increment: 1 } } })
    await tx.volume.updateMany({ where: { id: { in: snapshot.volumeIds }, novelId: human.novelId }, data: { archivedAt: null, archivedByImportId: null, revision: { increment: 1 } } })
    await tx.chapter.updateMany({ where: { id: { in: snapshot.chapterIds }, novelId: human.novelId }, data: { archivedAt: null, archivedByImportId: null, revision: { increment: 1 } } })
    await tx.novel.update({ where: { id: human.novelId }, data: snapshot.metadata })
    await tx.novelImportBackup.update({ where: { id: backup.id }, data: { restoredAt: now } })
    await tx.novelImportApproval.update({ where: { id: approval.id }, data: { consumedAt: now } })
    await tx.novelImportCommit.update({ where: { jobId }, data: { effectsPublishedAt: null } })
    return { ...(commit.receipt as unknown as NovelImportReceipt), restored: true }
  })
}
