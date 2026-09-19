import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { Prisma, type NovelImportJob, type NovelImportIntent } from '@prisma/client'
import { z } from 'zod'
import { NOVEL_IMPORT_LIMITS, novelImportCommitSchema, novelImportRestoreSchema, novelImportManifestEditSchema, novelImportModelSchema, novelImportVolumeSchema, novelImportSourceSchema, novelImportMetadataSchema, type NovelImportCapabilities, type NovelImportJobStatus, type NovelImportModelSelection, type NovelImportPreflight, type NovelImportPreview, type NovelImportReceipt, type NovelImportRestorePreview, type NovelImportRestoreReceipt } from '../../shared/contracts/novel-import.js'
import { prisma, DataAccessError } from './prisma.js'
import { requireSessionUserId } from './auth-session.js'
import { deleteUnreferencedImportBlob, discardImportBlob, importBytesHash, readImportBlob, storeImportJson, storeImportStream, validateImportFilename } from './novel-import-storage.js'
import { NovelImportParseError } from './novel-import/parsers/types.js'
import { getDocumentImportReadiness, parseConfiguredNovelImportDocument } from './novel-import/runtime.js'
import { applyContentSelection, applySourceReview, applyStructureEdit, assertLegacyContentConserved, canonicalPreviewHash, hasImportContent, hasImportMetadataSelection, previewReportDto, refreshPreviewWarnings, reportHash, routedContentCount } from './novel-import/preview.js'
import { hydrateStoredPreview, readPreviewArtifact, readStoredChapter, storePreviewImages, storePreviewParts, finalizeStoredImageReport, summarizePreview, verifyPreviewImages, type StoredPreview } from './novel-import/preview-storage.js'
import { novelImportReviewSchema, novelImportSelectionSchema, novelImportStructureSchema, type NovelImportDocumentReport, type NovelImportEvidencePreview, type NovelImportChapterDto } from '../../shared/contracts/novel-import-preview.js'
import { assertManagedAttachmentAccess, readAuthorizedAgentAttachment } from './agent-attachment-storage.js'
import { lockNovelActiveScope } from './data/novel-write-lock.js'
import { applyNovelImportChapterPositions, assertNovelImportMutationCount, hashNovelImportRows, hashNovelImportTarget, invalidateNovelImportSources, novelImportBackupSchema, novelImportMetadata } from './data/novel-import.js'
import { verifyNovelImportOrigin } from './novel-import-origin.js'
import { assertNovelImportPreviewComplete } from './novel-import/preview.js'
import { NOVEL_IMPORT_PARSE_DEADLINE_MS, startNovelImportParseLease } from './novel-import/parse-lease.js'
import { buildNovelImportPlacement } from './novel-import/placement.js'
import { saveStoryMemory } from './agent/story-memory.js'
export { NOVEL_IMPORT_PARSE_DEADLINE_MS } from './novel-import/parse-lease.js'

type Tx = Prisma.TransactionClient
export interface NovelImportScope { userId: string; novelId: string }
export interface NovelImportOrigin { runId: string; callId: string }
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
/** Runtime capability check for independently implemented human-only extensions. */
export function assertNovelImportHuman(human: NovelImportHuman): void { humanOnly(human) }
function fail(code: string, message: string, status = 409): never { throw new DataAccessError(status, code, message) }
const expiry = (ms: number) => new Date(Date.now() + ms)
const INTENT_MS = 30 * 60_000
const LEASE_MS = 150_000
const LIVE = ['uploading', 'uploaded', 'parsing', 'ready', 'needs_review', 'awaiting_confirmation']
export const NOVEL_IMPORT_DAILY_LIMITS = { jobs: 10, uploadedBytes: 250 * 1024 * 1024 } as const
export const NOVEL_IMPORT_PREVIEW_LIMITS = { revisions: 64, retainedRevisions: 2, pendingGarbage: 100 } as const
export function novelImportCapabilities(): NovelImportCapabilities {
  // The implementation keeps archived identities and uses the shared DB gate.
  // Rollout remains opt-in. Restoration is independent of the upload kill switch.
  const overwriteVerified = true
  return { enabled: process.env.NOVEL_IMPORT_ENABLED === 'true', overwriteVerified, restoreEnabled: true, retainsEmptyVolumes: true, overwriteEnabled: process.env.NOVEL_IMPORT_ENABLED === 'true' && process.env.NOVEL_IMPORT_OVERWRITE_ENABLED === 'true', sourceBytes: NOVEL_IMPORT_LIMITS.sourceBytes, aiEnabled: true,
    formats: ['txt', 'md', 'zip', 'docx', 'pdf', 'doc'].map(extension => ({ extension, enabled: extension !== 'doc', ...(extension === 'doc' ? { reason: '隔离 DOC 转换器未验收。' } : extension === 'pdf' ? { reason: '支持分页预览；页面完整性待核验，当前不承诺 PDF 可提交。' } : {}) })),
    limitations: ['确定性解析不调用 AI、不扣模型额度。', '覆盖需两次确认；旧卷章和已发布快照保留，新章仅为私有草稿。无章节时保留现有空卷。', '备份保留30天；导入后有新编辑、发布或原版本变化时禁止覆盖恢复。', 'DOC、扫描/OCR、图片完整性尚未全部验收。'] }
}
/** HTTP capability discovery uses the trusted runtime's cached real readiness.
 * The synchronous function above remains safe for admission/kill-switch checks. */
export async function getNovelImportCapabilities(): Promise<NovelImportCapabilities> {
  const caps = novelImportCapabilities()
  const native = await getDocumentImportReadiness()
  return { ...caps, formats: caps.formats.map(format => format.extension === 'doc'
    ? { extension: 'doc', enabled: native.ready, reason: native.ready ? '隔离转换可用；转换保真仍须人工核验。' : '隔离 DOC 转换器未启用或依赖自检未通过。' }
    : format.extension === 'pdf' ? { extension: 'pdf', enabled: true, reason: native.ready ? '隔离分页/OCR 可用；每页覆盖与识别质量须在报告中核验。' : '支持文本分页预览；扫描/OCR 未就绪，缺页与疑难内容阻止提交。' } : format),
    limitations: [...caps.limitations.filter(line => !line.startsWith('DOC、')), native.ready ? '依赖自检可用不等于 DOC/OCR 实际质量验收；每份报告仍需完整性确认。' : 'DOC 和扫描/OCR 尚未可用；不会把缺失页当作成功导入。'] }
}
function enabled() { if (!novelImportCapabilities().enabled) fail('IMPORT_DISABLED', '作品导入尚未开放。', 503) }

/** Retry DB serialization failures only. The callback must contain no I/O or model call. */
export async function novelImportTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 20_000 }) }
    catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))))
      if (attempt >= 2 || !retryable) throw error
    }
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
async function target(tx: Tx, scope: NovelImportScope, lock = true) {
  // Acquire the same gate as ordinary writers before observing even an empty tree.
  await owner(tx, scope)
  if (lock) await lockNovelActiveScope(tx, scope.novelId)
  const novel = await owner(tx, scope)
  const volumes = await tx.volume.findMany({ where: { novelId: scope.novelId, archivedAt: null }, orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }] })
  const chapters = await tx.chapter.findMany({ where: { novelId: scope.novelId, archivedAt: null }, orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }] })
  const publishedHistory = await tx.chapter.count({ where: { novelId: scope.novelId, OR: [{ status: 'published' }, { publishedAt: { not: null } }, { publishedContent: { not: null } }, { publishedRevision: { not: null } }] } })
  const hash = hashNovelImportTarget(novel, volumes, chapters, publishedHistory)
  return { novel, volumes, chapters, hash, publishedHistory }
}
function rollout(t: Awaited<ReturnType<typeof target>>) {
  if (t.chapters.length && !novelImportCapabilities().overwriteEnabled) fail('IMPORT_OVERWRITE_DISABLED', '已有章节的作品导入尚未开放。')
}
async function writeSafe(tx: Tx, scope: NovelImportScope, bound?: { agentRunId: string | null; agentToolCallId: string | null }, commitJobId?: string) {
  const activeRun = { novelId: scope.novelId, status: { in: ['queued', 'running', 'awaiting_approval'] as const } }
  const activeCount = await tx.agentRun.count({ where: { ...activeRun, status: { in: [...activeRun.status.in] } } })
  if (activeCount) {
    // A stopped origin no longer needs an exemption. The human may resume the
    // seven-day import through fresh intent/approval without reviving that run.
    const origin = bound?.agentRunId && bound.agentToolCallId ? await verifyNovelImportOrigin(tx, scope, { runId: bound.agentRunId, callId: bound.agentToolCallId }, commitJobId ? { commitJobId } : undefined) : null
    if (!origin || await tx.agentRun.count({ where: { ...activeRun, status: { in: [...activeRun.status.in] }, id: { not: origin.agentRunId } } })) fail('IMPORT_WRITE_BUSY', '作品有活动 Agent 任务，请停止或完成后重试。')
  }
  if (await tx.agentQueuedRequest.count({ where: { session: { novelId: scope.novelId }, status: { in: ['pending', 'held', 'dispatching'] } } })) fail('IMPORT_WRITE_BUSY', '作品有尚未发送的 Agent 需求，请先处理或取消后重试。')
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
export async function preflightNovelImport(scope: NovelImportScope, origin?: NovelImportOrigin) {
  enabled()
  return novelImportTransaction(async tx => {
    const t = await target(tx, scope); rollout(t)
    const binding = origin ? await verifyNovelImportOrigin(tx, scope, origin) : undefined
    await writeSafe(tx, scope, binding)
    if (binding) {
      const prior = await tx.novelImportIntent.findUnique({ where: { agentRunId_agentToolCallId: binding } })
      if (prior) return preflightDto(intentValid(prior, scope, t.hash, false), t)
    }
    if (await tx.novelImportIntent.count({ where: { userId: scope.userId, expiresAt: { gt: new Date() } } }) >= 20) fail('IMPORT_LIMIT_EXCEEDED', '确认次数过多，请稍后重试。', 429)
    const intent = await tx.novelImportIntent.create({ data: { id: randomUUID(), ...scope, ...binding, targetHash: t.hash, overwriteRequired: t.chapters.length > 0, expiresAt: expiry(INTENT_MS) } })
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
export async function confirmNovelImportSelectionIntent(human: NovelImportHuman, intentId: string, targetHash: string) {
  humanOnly(human); enabled()
  return novelImportTransaction(async tx => {
    const t = await target(tx, human); rollout(t)
    const intent = intentValid(await tx.novelImportIntent.findUnique({ where: { id: intentId } }), human, t.hash, false)
    if (targetHash !== t.hash) fail('IMPORT_TARGET_CHANGED', '作品已变化，请重新核对所选内容。')
    // The selection UI records one explicit human action. Step 2 is the legacy
    // storage representation of a completed intent, not two fabricated clicks.
    return preflightDto(await tx.novelImportIntent.update({ where: { id: intent.id }, data: { confirmationStep: 2 } }), t)
  })
}
export async function prepareNovelImport(scope: NovelImportScope, intentId: string, selection: NovelImportModelSelection = { kind: 'basic' }, replaceUnfinished = false) {
  if (replaceUnfinished) humanOnly(scope as NovelImportHuman)
  enabled(); const modelSelection = novelImportModelSchema.parse(selection)
  const id = await novelImportTransaction(async tx => {
    const t = await target(tx, scope); rollout(t)
    // Parsing creates only private preview data. Final content authorization still
    // requires the completed intent in confirm/commit before any manuscript write.
    const intent = intentValid(await tx.novelImportIntent.findUnique({ where: { id: intentId } }), scope, t.hash, false)
    const prior = await tx.novelImportJob.findUnique({ where: { intentId } }); if (prior) return prior.id
    if (await tx.novelImportJob.count({ where: { userId: scope.userId, createdAt: { gte: new Date(Date.now() - 86400_000) } } }) >= NOVEL_IMPORT_DAILY_LIMITS.jobs) fail('IMPORT_DAILY_JOB_LIMIT', '24小时内最多创建10个导入任务，取消不会重置配额；请使用已有任务或24小时后重试。', 429)
    // Replacing previews is authorized only by a new human file selection. The
    // novel lock serializes this with commits; retries reuse the intent above.
    const liveJobs = await tx.novelImportJob.findMany({ where: { userId: scope.userId, status: { in: LIVE }, expiresAt: { gt: new Date() } }, select: { id: true, novelId: true } })
    if (!replaceUnfinished && liveJobs.some(job => job.novelId === scope.novelId)) fail('IMPORT_ACTIVE_JOB_EXISTS', '此作品已有未完成导入，请继续已有任务或重新选择文件。')
    if (liveJobs.filter(job => !replaceUnfinished || job.novelId !== scope.novelId).length >= 3) fail('IMPORT_LIMIT_EXCEEDED', '其他作品仍有过多未完成导入任务，请完成或取消后重试。', 429)
    if (modelSelection.kind === 'custom' && !await tx.aiModelConfig.findFirst({ where: { id: modelSelection.customModelId, ownerUserId: scope.userId, enabled: true }, select: { id: true } })) fail('IMPORT_MODEL_UNAVAILABLE', '本次自定义模型不可用。', 403)
    if (replaceUnfinished) {
      // Keep a tombstone until normal retention cleanup: in-flight parsers and
      // uploads must observe cancellation, never publish after being replaced.
      await tx.novelImportJob.updateMany({ where: { ...scope, status: { in: [...LIVE, 'failed'] } }, data: { status: 'cancelled', errorCode: 'IMPORT_REPLACED', leaseEpoch: { increment: 1 }, leaseOwner: null, leaseUntil: null, jobVersion: { increment: 1 } } })
    }
    const job = await tx.novelImportJob.create({ data: { id: randomUUID(), ...scope, agentRunId: intent.agentRunId, agentToolCallId: intent.agentToolCallId, intentId: intent.id, targetHash: t.hash, modelSelection, expiresAt: expiry(7 * 86400_000) } })
    return job.id
  })
  return getNovelImportStatus(scope, id)
}
export async function getNovelImportStatus(scope: NovelImportScope, jobId: string): Promise<NovelImportJobStatus> {
  const job = await ownedJob(prisma, scope, jobId)
  const source = await prisma.novelImportSource.findUnique({ where: { jobId } })
  const commit = await prisma.novelImportCommit.findUnique({ where: { jobId } })
  const backup = await prisma.novelImportBackup.findUnique({ where: { jobId } })
  const event = commit ? await prisma.novelImportEvent.findUnique({ where: { jobId_kind: { jobId, kind: backup?.restoredAt ? 'restored' : 'imported' } } }) : null
  return { jobId, novelId: job.novelId, status: job.status as NovelImportJobStatus['status'], jobVersion: job.jobVersion, manifestRevision: job.manifestRevision, manifestHash: job.manifestHash, sourceHash: source?.sha256 ?? null, ...(source ? { source: { filename: source.filename, bytes: source.bytes } } : {}), targetHash: job.targetHash, errorCode: job.errorCode, expiresAt: job.expiresAt.toISOString(), receipt: commit ? commit.receipt as unknown as NovelImportReceipt : null,
    restore: backup ? { status: backup.restoredAt ? 'restored' : backup.expiresAt <= new Date() ? 'expired' : backup.restoreErrorCode ? 'restore_conflict' : 'available', expiresAt: backup.expiresAt.toISOString(), restoredAt: backup.restoredAt?.toISOString() ?? null, errorCode: backup.restoreErrorCode, receipt: backup.restoreReceipt as unknown as NovelImportRestoreReceipt | null } : null,
    effects: commit ? { status: commit.effectsPublishedAt && event ? 'published' : 'pending', publishedAt: commit.effectsPublishedAt?.toISOString() ?? null, eventId: event?.id ?? null, kind: event ? (backup?.restoredAt ? 'restored' : 'imported') : null } : null }
}
export async function listNovelImports(scope: NovelImportScope) {
  await owner(prisma, scope)
  const jobs = await prisma.novelImportJob.findMany({ where: { ...scope, OR: [{ errorCode: null }, { errorCode: { not: 'IMPORT_REPLACED' } }] }, orderBy: { createdAt: 'desc' }, take: 20 })
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
const parsedSchema = z.object({ volumes: z.array(parsedVolumeSchema).max(NOVEL_IMPORT_LIMITS.volumes), metadata: novelImportMetadataSchema, warnings: z.array(z.object({ code: z.string().max(128), message: z.string().max(4000), source: z.string().max(4096).optional(), blocking: z.boolean() })).max(5000), sourceChars: z.number().int().nonnegative().max(NOVEL_IMPORT_LIMITS.characters), parserVersion: z.string().min(1).max(128), plans: z.array(z.object({ title: z.string().trim().min(1).max(160), content: z.string().max(NOVEL_IMPORT_LIMITS.characters), source: novelImportSourceSchema.optional() }).strict()).max(200).optional(), memories: z.array(z.object({ memoryType: z.enum(['characterCard', 'worldbuilding', 'storyBible']), title: z.string().trim().min(1).max(160), content: z.string().max(NOVEL_IMPORT_LIMITS.characters), source: novelImportSourceSchema.optional() }).strict()).max(500).optional() })
export function assertNovelImportContent(volumes: NovelImportPreview['volumes'], options: { allowOversizedChapters?: boolean; allowEmptyBody?: boolean } = {}) {
  const chapters = volumes.flatMap(v => v.chapters)
  if (chapters.length > NOVEL_IMPORT_LIMITS.chapters || chapters.reduce((n, c) => n + c.content.length, 0) > NOVEL_IMPORT_LIMITS.characters) fail('IMPORT_LIMIT_EXCEEDED', '卷章或正文超过导入上限。', 413)
  if (!options.allowOversizedChapters && chapters.some(chapter => chapter.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters)) fail('IMPORT_CHAPTER_TOO_LONG', '单章超过10万字符，请在预览中拆分。')
  if (!options.allowEmptyBody && !chapters.some(c => c.content.trim())) fail('IMPORT_NO_BODY', '至少需要一章非空正文。')
}
export function hashNovelImportPreview(preview: Omit<NovelImportPreview, 'manifestHash'> | NovelImportPreview) {
  const { manifestHash: _ignored, ...body } = { ...preview, manifestHash: '' }
  return 'reportHash' in body ? canonicalPreviewHash(body) : importBytesHash(JSON.stringify(body))
}
async function cleanupPreviewBlob(storageKey: string): Promise<void> {
  try {
    // Recheck even on an uncertain transaction result: never unlink a blob
    // whose commit actually succeeded but whose response was lost.
    if (await prisma.novelImportManifest.count({ where: { storageKey } }) || await prisma.novelImportSource.count({ where: { storageKey } }) || await prisma.novelImportArtifact.count({ where: { storageKey } })) return
    await deleteUnreferencedImportBlob(storageKey)
    await prisma.novelImportGarbage.deleteMany({ where: { storageKey } })
  } catch {
    // No swallowed unlink failures: retain a durable exact-key retry record.
    await prisma.novelImportGarbage.createMany({ data: [{ storageKey }], skipDuplicates: true }).catch(() => undefined)
  }
}
async function persistPreview(scope: NovelImportScope, jobId: string, expected: NovelImportJob, preview: NovelImportEvidencePreview, lease?: string, signal?: AbortSignal) {
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
    signal?.throwIfAborted()
    blob = await storeImportJson(await storePreviewParts(claim, preview))
    signal?.throwIfAborted()
    const saved = blob
    const prunedKeys = await novelImportTransaction(async tx => {
      const job = await ownedJob(tx, scope, jobId); live(job)
      signal?.throwIfAborted()
      if (job.jobVersion !== claim.jobVersion || job.manifestRevision !== claim.manifestRevision || job.leaseEpoch !== claim.leaseEpoch || job.leaseOwner !== claim.leaseOwner || !job.leaseUntil || job.leaseUntil <= new Date()) fail('IMPORT_PREVIEW_CHANGED', '预览或任务已变化，请刷新。')
      await tx.novelImportManifest.create({ data: { id: randomUUID(), jobId, revision: preview.manifestRevision, hash: saved.sha256, storageKey: saved.storageKey } })
      await tx.novelImportApproval.updateMany({ where: { jobId, consumedAt: null }, data: { expiresAt: new Date() } })
      // Publish the usable preview and release its write lease atomically. A
      // reader may confirm as soon as this transaction commits, before pruning
      // or the failure-cleanup finally below has finished.
      await tx.novelImportJob.update({ where: { id: jobId }, data: { status: preview.warnings.some(w => w.blocking) || !hasImportContent(preview) ? 'needs_review' : 'ready', manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, leaseOwner: null, leaseUntil: null, jobVersion: { increment: 1 }, errorCode: null } })
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
async function readPreviewDocument(scope: NovelImportScope, jobId: string) {
  const job = await ownedJob(prisma, scope, jobId)
  const manifest = await prisma.novelImportManifest.findUnique({ where: { jobId_revision: { jobId, revision: job.manifestRevision } } })
  if (!manifest) fail('IMPORT_PREVIEW_UNAVAILABLE', '解析预览尚未就绪。')
  const stored = JSON.parse((await readImportBlob(manifest.storageKey, manifest.hash, 32 * 1024 * 1024)).toString('utf8')) as StoredPreview | NovelImportEvidencePreview
  const summary = 'storageVersion' in stored ? stored.summary : stored
  if (summary.manifestHash !== job.manifestHash || summary.manifestRevision !== job.manifestRevision) fail('IMPORT_PREVIEW_CHANGED', '预览校验失败，请重新解析。')
  return { job, stored }
}
export async function getNovelImportPreview(scope: NovelImportScope, jobId: string): Promise<NovelImportEvidencePreview> {
  const { job, stored } = await readPreviewDocument(scope, jobId)
  const preview = 'storageVersion' in stored ? await hydrateStoredPreview(jobId, stored) : stored
  if (preview.manifestHash !== job.manifestHash || hashNovelImportPreview(preview) !== job.manifestHash) fail('IMPORT_PREVIEW_CHANGED', '预览校验失败，请重新解析。')
  await verifyPreviewImages(scope, jobId, preview)
  return preview
}
export async function getNovelImportPreviewSummary(scope: NovelImportScope, jobId: string) {
  const { stored } = await readPreviewDocument(scope, jobId)
  return 'storageVersion' in stored ? stored.summary : summarizePreview(stored)
}
export async function getNovelImportChapter(scope: NovelImportScope, jobId: string, volumeIndex: number, chapterIndex: number, revision: number): Promise<NovelImportChapterDto> {
  const { job, stored } = await readPreviewDocument(scope, jobId)
  if (job.manifestRevision !== revision) fail('IMPORT_PREVIEW_CHANGED', '预览已变化，请刷新目录。')
  const chapter = 'storageVersion' in stored ? await readStoredChapter(jobId, stored, volumeIndex, chapterIndex) : stored.volumes[volumeIndex]?.chapters[chapterIndex]
  if (!chapter) fail('IMPORT_CHAPTER_UNAVAILABLE', '当前预览中没有此章节。', 404)
  return { manifestRevision: revision, manifestHash: job.manifestHash!, volumeIndex, chapterIndex, ...chapter, contentHash: importBytesHash(chapter.content), characters: chapter.content.length }
}
export async function getNovelImportReport(scope: NovelImportScope, jobId: string) {
  const { stored } = await readPreviewDocument(scope, jobId)
  if (!('storageVersion' in stored)) return previewReportDto(stored)
  const report: NovelImportDocumentReport = JSON.parse((await readPreviewArtifact(jobId, stored.reportArtifactId, 'report')).bytes.toString('utf8'))
  return previewReportDto({ ...stored.summary, volumes: [], report }, stored.contentHash)
}
export async function downloadNovelImportImage(scope: NovelImportScope, jobId: string, artifactId: string) {
  await ownedJob(prisma, scope, jobId)
  return readPreviewArtifact(jobId, artifactId, 'image')
}
/** Durable state is authoritative. In-memory promises only accelerate a DB claim. */
export async function analyzeNovelImport(scope: NovelImportScope, jobId: string, encoding?: string, reparse = false) {
  enabled()
  if (encoding !== undefined) encoding = z.string().min(1).max(32).parse(encoding)
  const claim = await novelImportTransaction(async tx => {
    const job = await ownedJob(tx, scope, jobId); live(job)
    if (job.status === 'parsing' && job.leaseUntil && job.leaseUntil > new Date()) return null
    // Recovery keeps the original wall-clock budget. Legacy/expired claims cannot
    // obtain another thirty minutes merely by crashing or losing their lease.
    if (job.status === 'parsing' && (!job.parseDeadlineAt || job.parseDeadlineAt <= new Date())) {
      await tx.novelImportJob.update({ where: { id: jobId }, data: { status: 'failed', errorCode: 'IMPORT_PARSE_TIMEOUT', leaseOwner: null, leaseUntil: null, leaseEpoch: { increment: 1 }, jobVersion: { increment: 1 } } })
      return null
    }
    if (job.manifestRevision >= NOVEL_IMPORT_PREVIEW_LIMITS.revisions) fail('IMPORT_PREVIEW_LIMIT', '本任务已保存64个预览版本；请下载原文件后创建新任务。', 429)
    if (job.leaseUntil && job.leaseUntil > new Date()) fail('IMPORT_WRITE_BUSY', '预览保存尚未完成，请稍后重试。', 429)
    const explicitReparse = (reparse || encoding !== undefined) && ['ready', 'needs_review', 'awaiting_confirmation'].includes(job.status)
    if (!['uploaded', 'failed', 'parsing'].includes(job.status) && !explicitReparse) fail('IMPORT_STATE_INVALID', '当前任务不能启动解析；请明确确认重新解析预览。')
    if (await tx.novelImportJob.count({ where: { status: 'parsing', leaseUntil: { gt: new Date() } } })) fail('IMPORT_WRITE_BUSY', '解析器繁忙，请稍后重试。', 429)
    const source = await tx.novelImportSource.findUnique({ where: { jobId } }); if (!source) fail('IMPORT_SOURCE_INVALID', '请先上传文件。')
    // Preserve the audit rows, but revoke every unconsumed old content grant.
    await tx.novelImportApproval.updateMany({ where: { jobId, consumedAt: null }, data: { expiresAt: new Date() } })
    const updated = await tx.novelImportJob.update({ where: { id: jobId }, data: { status: 'parsing', parseEncoding: encoding ?? job.parseEncoding, parseDeadlineAt: job.status === 'parsing' ? job.parseDeadlineAt : expiry(NOVEL_IMPORT_PARSE_DEADLINE_MS), leaseOwner: randomUUID(), leaseEpoch: { increment: 1 }, leaseUntil: expiry(LEASE_MS), jobVersion: { increment: 1 }, errorCode: null } })
    return { job: updated, source }
  })
  if (claim) void runParse(scope, claim, claim.job.parseEncoding ?? undefined).catch(() => undefined)
  return getNovelImportStatus(scope, jobId)
}
async function runParse(scope: NovelImportScope, claim: { job: NovelImportJob; source: { id: string; storageKey: string; sha256: string; filename: string } }, encoding?: string) {
  const controller = startNovelImportParseLease(claim.job)
  try {
    const bytes = await readImportBlob(claim.source.storageKey, claim.source.sha256)
    controller.signal.throwIfAborted()
    const document = await parseConfiguredNovelImportDocument(bytes, claim.source.filename, { sourceId: claim.source.id, sourceHash: claim.source.sha256, encoding, signal: controller.signal, deadlineAt: claim.job.parseDeadlineAt!.getTime() })
    const result = document.parsed
    const parsed = parsedSchema.parse({ ...result,
      plans: result.plans?.map(item => ({ ...item, ...(item.source ? { source: { memberPath: item.source } } : {}) })),
      memories: result.memories?.map(item => ({ ...item, ...(item.source ? { source: { memberPath: item.source } } : {}) })),
      volumes: result.volumes.map(volume => ({ ...volume, chapters: volume.chapters.map(chapter => ({ ...chapter, source: { memberPath: chapter.source } })) })) })
    if (parsed.volumes.some(v => v.chapters.some(c => c.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters))) parsed.warnings.push({ code: 'IMPORT_CHAPTER_TOO_LONG', message: '单章超过10万字符，请在预览中拆分。', blocking: true })
    const currentTarget = await target(prisma, scope, false)
    if (!currentTarget.chapters.length && currentTarget.volumes.length) parsed.warnings.push({ code: 'IMPORT_EMPTY_VOLUMES_RETAINED', message: `将保留现有 ${currentTarget.volumes.length} 个空卷；导入时优先复用能唯一匹配的卷，未匹配的来源另建新卷。`, blocking: false })
    controller.signal.throwIfAborted()
    const artifacts = await storePreviewImages(claim.job, document.artifacts)
    const persistedIds = new Set(artifacts.map(artifact => artifact.id))
    if (document.report.items.some(item => item.artifactId && !persistedIds.has(item.artifactId))) fail('IMPORT_IMAGE_INVALID', '来源报告引用了缺失图片，不能保存为完整预览。')
    // Only the machine storage condition is resolved here; human quality issues remain immutable.
    const report = finalizeStoredImageReport(document.report, artifacts)
    const body = refreshPreviewWarnings({ ...parsed, sourceHash: claim.source.sha256, metadataSelection: {}, manifestRevision: claim.job.manifestRevision + 1, manifestHash: '', report, reportHash: reportHash(report), artifacts, decisions: [], partialImport: false })
    const preview: NovelImportEvidencePreview = { ...body, manifestHash: hashNovelImportPreview(body) }
    await persistPreview(scope, claim.job.id, claim.job, preview, claim.job.leaseOwner ?? undefined, controller.signal)
  } catch (error) {
    await prisma.novelImportJob.updateMany({ where: { id: claim.job.id, status: 'parsing', leaseEpoch: claim.job.leaseEpoch, leaseOwner: claim.job.leaseOwner }, data: { status: 'failed', errorCode: controller.timedOut ? 'IMPORT_PARSE_TIMEOUT' : error instanceof DataAccessError || error instanceof NovelImportParseError ? error.code : controller.signal.aborted ? 'IMPORT_PARSE_CANCELLED' : 'IMPORT_PARSE_FAILED', leaseOwner: null, leaseUntil: null, jobVersion: { increment: 1 } } })
  } finally { controller.stop() }
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
  assertLegacyContentConserved(old, edit.volumes)
  // Parser blocking warnings cannot be erased via body edits. Resolving missing source requires reparsing.
  const body = refreshPreviewWarnings({ ...old, volumes: edit.volumes, metadataSelection: edit.metadataSelection ?? old.metadataSelection, manifestRevision: old.manifestRevision + 1, decisions: (old.decisions ?? []).filter(decision => decision.action === 'exclude') })
  if (edit.volumes.some(v => v.chapters.some(c => c.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters))) body.warnings.push({ code: 'IMPORT_CHAPTER_TOO_LARGE', message: '单章仍超过10万字符，请继续拆分后确认导入。', blocking: true })
  const preview = { ...body, manifestHash: hashNovelImportPreview(body) }
  await persistPreview(human, jobId, job, preview)
  return preview
}
export async function editNovelImportStructure(human: NovelImportHuman, jobId: string, input: unknown) {
  humanOnly(human); enabled()
  const edit = novelImportStructureSchema.parse(input)
  const job = await ownedJob(prisma, human, jobId); live(job)
  if (!['ready', 'needs_review', 'awaiting_confirmation'].includes(job.status)) fail('IMPORT_STATE_INVALID', '请等待解析完成后修改。')
  const old = await getNovelImportPreview(human, jobId)
  const body = { ...applyStructureEdit(old, edit), manifestRevision: old.manifestRevision + 1 }
  assertNovelImportContent(body.volumes, { allowOversizedChapters: true, allowEmptyBody: routedContentCount(body) > 0 || hasImportMetadataSelection(body) })
  const preview = { ...body, manifestHash: hashNovelImportPreview(body) }
  await persistPreview(human, jobId, job, preview)
  return summarizePreview(preview)
}
export async function selectNovelImportContent(human: NovelImportHuman, jobId: string, input: unknown) {
  humanOnly(human); enabled()
  const selection = novelImportSelectionSchema.parse(input)
  const job = await ownedJob(prisma, human, jobId); live(job)
  if (!['ready', 'needs_review', 'awaiting_confirmation'].includes(job.status)) fail('IMPORT_STATE_INVALID', '请等待解析完成后选择导入内容。')
  const old = await getNovelImportPreview(human, jobId)
  const body = { ...applyContentSelection(old, selection), manifestRevision: old.manifestRevision + 1 }
  const preview = { ...body, manifestHash: hashNovelImportPreview(body) }
  await persistPreview(human, jobId, job, preview)
  return summarizePreview(preview)
}
export async function reviewNovelImportSources(human: NovelImportHuman, jobId: string, input: unknown) {
  humanOnly(human); enabled()
  const review = novelImportReviewSchema.parse(input)
  const job = await ownedJob(prisma, human, jobId); live(job)
  if (!['ready', 'needs_review', 'awaiting_confirmation'].includes(job.status)) fail('IMPORT_STATE_INVALID', '请等待解析完成后复核。')
  const old = await getNovelImportPreview(human, jobId)
  const body = { ...applySourceReview(old, review), manifestRevision: old.manifestRevision + 1 }
  const preview = { ...body, manifestHash: hashNovelImportPreview(body) }
  await persistPreview(human, jobId, job, preview)
  return summarizePreview(preview)
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
  assertNovelImportPreviewComplete(preview, { verifiedImageStorage: true })
  assertNovelImportContent(preview.volumes, { allowEmptyBody: routedContentCount(preview) > 0 || hasImportMetadataSelection(preview) })
  if (preview.warnings.some(w => w.blocking)) fail('IMPORT_INCOMPLETE_CONTENT', '存在未解决的来源完整性问题。')
  return novelImportTransaction(async tx => {
    const job = await ownedJob(tx, human, jobId); live(job)
    const t = await target(tx, human); rollout(t); await writeSafe(tx, human, job, jobId)
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
export async function commitNovelImport(scope: NovelImportScope, jobId: string, input: { approvalId: string; idempotencyKey: string }, execution?: { beforeWrite: (tx: Tx) => Promise<void>; origin: NovelImportOrigin }): Promise<NovelImportReceipt> {
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
  assertNovelImportPreviewComplete(preview, { verifiedImageStorage: true })
  assertNovelImportContent(preview.volumes, { allowEmptyBody: routedContentCount(preview) > 0 || hasImportMetadataSelection(preview) })
  if (preview.warnings.some(w => w.blocking)) fail('IMPORT_INCOMPLETE_CONTENT', '存在未解决的完整性问题。')
  const source = await prisma.novelImportSource.findUniqueOrThrow({ where: { jobId } })
  await readImportBlob(source.storageKey, source.sha256)
  // No file promotion or database writes before the approval transaction. Raw
  // PNG is retained by CoverAsset (existing supported recovery format); the
  // durable effect consumer promotes only an already-committed cover locally.
  const selectedCover = preview.metadataSelection.coverArtifactId
  const descriptor = selectedCover ? preview.artifacts?.find(artifact => artifact.id === selectedCover && artifact.coverCandidate) : undefined
  if (selectedCover && !descriptor) fail('IMPORT_COVER_INVALID', '请选择当前报告中的封面候选。')
  const coverPrefix = `/api/novels/${encodeURIComponent(scope.novelId)}/imports/${encodeURIComponent(jobId)}/artifacts/`
  if (descriptor && (!descriptor.url.startsWith(coverPrefix) || !/^[a-f0-9-]{36}$/.test(descriptor.url.slice(coverPrefix.length)))) fail('IMPORT_COVER_INVALID', '封面候选不属于此任务。')
  const cover = descriptor ? await readPreviewArtifact(jobId, descriptor.url.slice(coverPrefix.length), 'image') : undefined
  if (cover && (cover.artifact.sha256 !== descriptor!.sha256 || cover.bytes.length !== descriptor!.bytes || cover.bytes.length > 3 * 1024 * 1024 || cover.artifact.mediaType !== 'image/png')) fail('IMPORT_COVER_INVALID', '封面图片校验失败或超过3MiB上限。')
  const coverImageUrl = cover ? `data:image/png;base64,${cover.bytes.toString('base64')}` : undefined
  return novelImportTransaction(async tx => {
    const job = await ownedJob(tx, scope, jobId)
    const prior = await tx.novelImportCommit.findUnique({ where: { jobId } })
    if (prior) {
      if (prior.approvalId !== input.approvalId || prior.idempotencyKey !== input.idempotencyKey) fail('IMPORT_IDEMPOTENCY_CONFLICT', '提交参数与原回执不一致。')
      return prior.receipt as unknown as NovelImportReceipt
    }
    live(job)
    if (job.leaseUntil && job.leaseUntil > new Date()) fail('IMPORT_WRITE_BUSY', '请等待预览保存完成。')
    const t = await target(tx, scope); rollout(t)
    if (execution) await execution.beforeWrite(tx)
    await writeSafe(tx, scope, execution ? { agentRunId: execution.origin.runId, agentToolCallId: execution.origin.callId } : job, jobId)
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
    let coverAssetId: string | undefined
    if (cover) {
      if (!await tx.novelImportArtifact.findFirst({ where: { id: cover.artifact.id, jobId, kind: 'image', sha256: cover.artifact.sha256, bytes: cover.artifact.bytes } })) fail('IMPORT_COVER_INVALID', '封面来源已变化。')
      const asset = await tx.coverAsset.create({ data: { id: randomUUID(), novelId: scope.novelId, ownerUserId: scope.userId, sourceType: 'upload', imageUrl: coverImageUrl!, width: descriptor!.width, height: descriptor!.height } })
      coverAssetId = asset.id
    }
    // Match chapters only inside their uniquely resolved destination volume.
    const placement = buildNovelImportPlacement(t.volumes, t.chapters, preview.volumes, randomUUID)
    for (const volume of placement.renamedVolumes) assertNovelImportMutationCount((await tx.volume.updateMany({ where: { id: volume.id, novelId: scope.novelId, archivedAt: null, title: volume.beforeTitle, revision: 1 }, data: { title: volume.title, revision: { increment: 1 } } })).count, 1)
    const archivedChapterRows = t.chapters.filter(chapter => placement.archivedChapterIds.includes(chapter.id))
    const archivedVolumeRows: typeof t.volumes = []
    if (t.volumes.length + placement.newVolumes.length > NOVEL_IMPORT_LIMITS.volumes) fail('IMPORT_LIMIT_EXCEEDED', '保留现有卷后总卷数超过200，请先整理卷。')
    if (archivedChapterRows.length) {
      assertNovelImportMutationCount((await tx.chapter.updateMany({ where: { novelId: scope.novelId, archivedAt: null, id: { in: placement.archivedChapterIds } }, data: { archivedAt: now, archivedByImportId: jobId, revision: { increment: 1 } } })).count, archivedChapterRows.length)
    }
    const changedVolumeIds = [...new Set(placement.chapters.map(chapter => chapter.volumeId))].filter(id => t.volumes.some(volume => volume.id === id))
    await invalidateNovelImportSources(tx, scope.novelId, placement.archivedChapterIds, changedVolumeIds)
    const volumes = placement.newVolumes.map(volume => ({ ...volume, novelId: scope.novelId }))
    if (volumes.length) assertNovelImportMutationCount((await tx.volume.createMany({ data: volumes })).count, volumes.length)
    // Shift retained chapters before insertion; both unique indexes are released
    // using disjoint temporary positions, and their original order is backed up.
    await applyNovelImportChapterPositions(tx, scope.novelId, placement.reorderedAfter)
    const chapters = placement.chapters.map(chapter => ({ ...chapter, novelId: scope.novelId, authorId: scope.userId, wordCount: chapter.content.length, status: 'draft' as const, visibility: 'private' as const }))
    if (chapters.length) assertNovelImportMutationCount((await tx.chapter.createMany({ data: chapters })).count, chapters.length)
    const firstChapterId = [...chapters].sort((a, b) => a.orderIndex - b.orderIndex)[0]?.id ?? ''
    const lastChapterTitle = placement.lastChapterTitle
    // 计划文件夹：复用该作品最近任务作载体（与手工新建计划同模式），同名计划就地更新。
    const plans = preview.plans ?? []
    if (plans.length) {
      let carrier = await tx.agentRun.findFirst({ where: { userId: scope.userId, novelId: scope.novelId }, orderBy: { createdAt: 'desc' }, select: { id: true } })
      if (!carrier) {
        const session = await tx.agentSession.create({ data: { userId: scope.userId, novelId: scope.novelId, title: `${t.novel.title} 写作会话`, status: 'active' }, select: { id: true } })
        carrier = await tx.agentRun.create({ data: { sessionId: session.id, userId: scope.userId, novelId: scope.novelId, mode: 'plan', action: 'planChapter', agentType: 'storyPlanner', status: 'completed', inputSummary: '一键导入写入计划', finishedAt: new Date() }, select: { id: true } })
      }
      const existingPlans = await tx.agentArtifact.findMany({ where: { artifactType: 'chapterPlan', metadata: { path: ['savedAsPlan'], equals: true }, run: { userId: scope.userId, novelId: scope.novelId } }, select: { id: true, title: true } })
      const planIdByTitle = new Map(existingPlans.map(plan => [plan.title.trim(), plan.id]))
      let planOrder = existingPlans.length
      for (const plan of plans) {
        const title = plan.title.trim().slice(0, 160) || '导入计划'
        const existingId = planIdByTitle.get(title)
        if (existingId) await tx.agentArtifact.update({ where: { id: existingId }, data: { content: plan.content, metadata: { savedAsPlan: true, importSource: true, importJobId: jobId } as Prisma.InputJsonValue } })
        else {
          planOrder += 1
          await tx.agentArtifact.create({ data: { runId: carrier.id, artifactType: 'chapterPlan', title, content: plan.content, metadata: { savedAsPlan: true, importSource: true, importJobId: jobId, planOrder } as Prisma.InputJsonValue } })
        }
      }
    }
    // 创作记忆：作者确认语义就地覆盖同名卡，重复导入不进冲突审核箱。
    const memories = preview.memories ?? []
    for (const memory of memories) {
      await saveStoryMemory({
        userId: scope.userId, novelId: scope.novelId, memoryType: memory.memoryType,
        layer: memory.memoryType === 'storyBible' ? 'L3' : 'L1',
        title: memory.title.trim().slice(0, 160), content: memory.content,
        importance: 75, confidence: 0.9, status: 'confirmed', overwrite: true,
        evidence: { sourceType: 'author_input', sourceId: jobId, confidence: 0.9 },
      }, tx)
    }
    const m = preview.metadataSelection
    // 字数/章数对合并后全部非归档章节重算：源中没有的保留章节同样计入作品总量。
    const retainedChapters = await tx.chapter.findMany({ where: { novelId: scope.novelId, archivedAt: null }, select: { wordCount: true } })
    const wordCount = retainedChapters.reduce((sum, chapter) => sum + (chapter.wordCount ?? 0), 0)
    await tx.novel.update({ where: { id: scope.novelId }, data: { ...(m.title !== undefined ? { title: m.title, displayTitle: m.title } : {}), ...(m.summary !== undefined ? { summary: m.summary } : {}), ...(m.tags !== undefined ? { tagNames: m.tags } : {}), ...(coverAssetId ? { coverAssetId, coverPrompt: null } : {}), wordCount, chapterCount: retainedChapters.length, lastChapterTitle: chapters.length ? lastChapterTitle : t.novel.lastChapterTitle ?? '', manuscriptRevision: { increment: 1 } } })
    const after = await target(tx, scope)
    const archivedVolumes = await tx.volume.findMany({ where: { id: { in: archivedVolumeRows.map(v => v.id) } }, orderBy: { id: 'asc' } })
    const archivedChapters = await tx.chapter.findMany({ where: { id: { in: archivedChapterRows.map(c => c.id) } }, orderBy: { id: 'asc' } })
    const snapshot = { version: 2, volumeIds: archivedVolumeRows.map(v => v.id), chapterIds: archivedChapterRows.map(c => c.id), retainedEmptyVolumeIds: [], reorderedChapters: placement.reorderedBefore, beforeVolumeCount: t.volumes.length, beforeChapterCount: t.chapters.length, importedVolumeIds: volumes.map(v => v.id), importedChapterIds: chapters.map(c => c.id), metadata: novelImportMetadata(t.novel), metadataKeys: [...(m.title !== undefined ? ['title'] : []), ...(m.summary !== undefined ? ['summary'] : []), ...(m.tags !== undefined ? ['tagNames'] : []), ...(coverAssetId ? ['coverAssetId'] : [])], retainedHash: hashNovelImportRows(archivedVolumes, archivedChapters) }
    await tx.novelImportBackup.create({ data: { id: backupId, jobId, snapshot: { ...snapshot, renamedVolumes: placement.renamedVolumes.map(volume => ({ id: volume.id, title: volume.beforeTitle })) }, beforeHash: t.hash, afterHash: after.hash, expiresAt: restoreExpiresAt } })
    const receipt: NovelImportReceipt = { jobId, novelId: scope.novelId, backupId, volumeCount: placement.volumeCount, chapterCount: chapters.length, wordCount, firstChapterId, targetHash: after.hash, restoreExpiresAt: restoreExpiresAt.toISOString(), partialImport: preview.partialImport === true, reportUrl: `/api/novels/${encodeURIComponent(scope.novelId)}/imports/${encodeURIComponent(jobId)}/report`, planCount: plans.length, memoryCount: memories.length }
    await tx.novelImportApproval.update({ where: { id: approval.id }, data: { consumedAt: now } })
    await tx.novelImportCommit.create({ data: { jobId, approvalId: approval.id, idempotencyKey: input.idempotencyKey, receipt: { ...receipt } } })
    await tx.novelImportJob.update({ where: { id: jobId }, data: { status: 'succeeded', jobVersion: { increment: 1 } } })
    if (execution) await execution.beforeWrite(tx)
    return receipt
  })
}

/** All four baselines must identify the same unchanged post-import manuscript. */
export function assertNovelImportRestoreBaseline(current: string, committed: string, requested = committed, approved = committed): void {
  if (current !== committed || current !== requested || current !== approved) fail('IMPORT_RESTORE_CONFLICT', '导入后已有修改，不能覆盖这些修改。')
}
function restoreBaseline(t: Awaited<ReturnType<typeof target>>, snapshot: z.infer<typeof novelImportBackupSchema>) {
  // Preserve restore compatibility for backups created before hash v2.
  const { title, summary, tagNames, wordCount, chapterCount, lastChapterTitle } = t.novel
  return snapshot.version === 2 ? t.hash : importBytesHash(JSON.stringify({ metadata: { title, summary, tagNames, wordCount, chapterCount, lastChapterTitle }, status: t.novel.status, publishedAt: t.novel.publishedAt, publishedHistory: t.publishedHistory, volumes: t.volumes, chapters: t.chapters }))
}
async function retainedRestoreRows(tx: Tx, scope: NovelImportScope, jobId: string, snapshot: z.infer<typeof novelImportBackupSchema>) {
  if (snapshot.metadata.coverAssetId && !await tx.coverAsset.findFirst({ where: { id: snapshot.metadata.coverAssetId, ownerUserId: scope.userId } })) fail('IMPORT_RESTORE_CONFLICT', '原封面资产已变化或不可用。')
  const volumes = await tx.volume.findMany({ where: { novelId: scope.novelId, id: { in: snapshot.volumeIds }, archivedByImportId: jobId, archivedAt: { not: null } }, orderBy: { id: 'asc' } })
  const chapters = await tx.chapter.findMany({ where: { novelId: scope.novelId, id: { in: snapshot.chapterIds }, archivedByImportId: jobId, archivedAt: { not: null } }, orderBy: { id: 'asc' } })
  const hash = snapshot.version === 2 ? hashNovelImportRows(volumes, chapters) : importBytesHash(JSON.stringify({ volumes, chapters }))
  if (volumes.length !== snapshot.volumeIds.length || chapters.length !== snapshot.chapterIds.length || hash !== snapshot.retainedHash) fail('IMPORT_RESTORE_CONFLICT', '原版本记录已变化，恢复已阻止。')
}

/** Read-only impact preview. Viewing history never mints a restore grant. */
export async function getNovelImportRestorePreview(scope: NovelImportScope, jobId: string): Promise<NovelImportRestorePreview> {
  return novelImportTransaction(async tx => {
    await ownedJob(tx, scope, jobId)
    const backup = await tx.novelImportBackup.findUnique({ where: { jobId } })
    if (!backup) fail('IMPORT_RESTORE_UNAVAILABLE', '没有可恢复的导入备份。')
    const snapshot = novelImportBackupSchema.parse(backup.snapshot)
    const t = await target(tx, scope)
    let reason: string | undefined
    if (backup.restoredAt) reason = 'IMPORT_ALREADY_RESTORED'
    else if (backup.expiresAt <= new Date()) reason = 'IMPORT_RESTORE_UNAVAILABLE'
    else {
      try { assertNovelImportRestoreBaseline(restoreBaseline(t, snapshot), backup.afterHash); await retainedRestoreRows(tx, scope, jobId, snapshot); await writeSafe(tx, scope) }
      catch (error) { if (!(error instanceof DataAccessError)) throw error; reason = error.code }
    }
    return { canRestore: !reason, ...(reason ? { reason } : {}), currentTargetHash: restoreBaseline(t, snapshot), backupExpiresAt: backup.expiresAt.toISOString(), before: { volumes: snapshot.beforeVolumeCount ?? snapshot.volumeIds.length + snapshot.retainedEmptyVolumeIds.length, chapters: snapshot.beforeChapterCount ?? snapshot.chapterIds.length }, current: { volumes: t.volumes.length, chapters: t.chapters.length }, metadataKeys: snapshot.metadataKeys ?? ['title', 'summary', 'tagNames'], restoredAt: backup.restoredAt?.toISOString() ?? null, receipt: backup.restoreReceipt as unknown as NovelImportRestoreReceipt | null }
  })
}

/** Separate HUMAN confirmation, bound to the impact preview the user saw. */
export async function previewNovelImportRestore(human: NovelImportHuman, jobId: string, requestedTargetHash: string) {
  humanOnly(human)
  return novelImportTransaction(async tx => {
    const job = await ownedJob(tx, human, jobId)
    const backup = await tx.novelImportBackup.findUnique({ where: { jobId } })
    if (!backup || backup.restoredAt || backup.expiresAt <= new Date()) fail('IMPORT_RESTORE_UNAVAILABLE', '恢复版本不可用或已过期。')
    const snapshot = novelImportBackupSchema.parse(backup.snapshot)
    const t = await target(tx, human); await writeSafe(tx, human)
    const hash = restoreBaseline(t, snapshot)
    if (!requestedTargetHash) fail('IMPORT_APPROVAL_REQUIRED', '请先查看恢复影响并确认。')
    assertNovelImportRestoreBaseline(hash, backup.afterHash, requestedTargetHash)
    await retainedRestoreRows(tx, human, jobId, snapshot)
    // Superseding a restore confirmation revokes older unconsumed grants.
    await tx.novelImportApproval.updateMany({ where: { jobId, kind: 'restore', consumedAt: null }, data: { expiresAt: new Date() } })
    const approval = await tx.novelImportApproval.create({ data: { id: randomUUID(), jobId, userId: human.userId, kind: 'restore', sourceHash: snapshot.retainedHash, manifestHash: job.manifestHash!, manifestRevision: job.manifestRevision, targetHash: hash, expiresAt: expiry(10 * 60_000) } })
    await tx.novelImportBackup.update({ where: { id: backup.id }, data: { restoreErrorCode: null } })
    return { restoreApprovalId: approval.id, targetHash: hash, expiresAt: approval.expiresAt.toISOString() }
  })
}
export async function restoreNovelImport(human: NovelImportHuman, jobId: string, input: z.infer<typeof novelImportRestoreSchema>): Promise<NovelImportRestoreReceipt> {
  humanOnly(human)
  input = novelImportRestoreSchema.parse(input)
  try { return await novelImportTransaction(async tx => {
    const job = await ownedJob(tx, human, jobId)
    // Lock before reading the restoration receipt: racing requests serialize.
    const t = await target(tx, human)
    const backup = await tx.novelImportBackup.findUnique({ where: { jobId } })
    const commit = await tx.novelImportCommit.findUnique({ where: { jobId } })
    if (!backup || !commit) fail('IMPORT_RESTORE_UNAVAILABLE', '恢复版本不可用。')
    // Exact authenticated replay survives source/backup TTL and later edits.
    if (backup.restoredAt) {
      if (backup.restoredApprovalId !== input.restoreApprovalId || backup.restoreIdempotencyKey !== input.idempotencyKey || input.targetHash !== backup.afterHash || !backup.restoreReceipt) fail('IMPORT_IDEMPOTENCY_CONFLICT', '恢复参数与原回执不一致。')
      return backup.restoreReceipt as unknown as NovelImportRestoreReceipt
    }
    if (backup.expiresAt <= new Date()) fail('IMPORT_RESTORE_UNAVAILABLE', '恢复版本已过期。')
    const approval = await tx.novelImportApproval.findFirst({ where: { id: input.restoreApprovalId, jobId, userId: human.userId, kind: 'restore' } })
    if (!approval) fail('IMPORT_APPROVAL_REQUIRED', '恢复需要独立确认。', 403)
    if (approval.consumedAt || approval.expiresAt <= new Date()) fail('IMPORT_APPROVAL_EXPIRED', '恢复确认已失效。')
    await writeSafe(tx, human)
    const snapshot = novelImportBackupSchema.parse(backup.snapshot)
    assertNovelImportRestoreBaseline(restoreBaseline(t, snapshot), backup.afterHash, input.targetHash, approval.targetHash)
    if (approval.sourceHash !== snapshot.retainedHash || approval.manifestHash !== job.manifestHash || approval.manifestRevision !== job.manifestRevision) fail('IMPORT_RESTORE_CONFLICT', '恢复备份与确认的版本不一致。')
    await retainedRestoreRows(tx, human, jobId, snapshot)
    const now = new Date()
    assertNovelImportMutationCount((await tx.chapter.updateMany({ where: { novelId: human.novelId, archivedAt: null, id: { in: snapshot.importedChapterIds } }, data: { archivedAt: now, archivedByImportId: jobId, revision: { increment: 1 } } })).count, snapshot.importedChapterIds.length)
    assertNovelImportMutationCount((await tx.volume.updateMany({ where: { novelId: human.novelId, archivedAt: null, id: { in: snapshot.importedVolumeIds } }, data: { archivedAt: now, archivedByImportId: jobId, revision: { increment: 1 } } })).count, snapshot.importedVolumeIds.length)
    await applyNovelImportChapterPositions(tx, human.novelId, snapshot.reorderedChapters ?? [])
    for (const volume of snapshot.renamedVolumes ?? []) assertNovelImportMutationCount((await tx.volume.updateMany({ where: { id: volume.id, novelId: human.novelId, archivedAt: null }, data: { title: volume.title, revision: { increment: 1 } } })).count, 1)
    assertNovelImportMutationCount((await tx.volume.updateMany({ where: { id: { in: snapshot.volumeIds }, novelId: human.novelId, archivedByImportId: jobId, archivedAt: { not: null } }, data: { archivedAt: null, archivedByImportId: null, revision: { increment: 1 } } })).count, snapshot.volumeIds.length)
    assertNovelImportMutationCount((await tx.chapter.updateMany({ where: { id: { in: snapshot.chapterIds }, novelId: human.novelId, archivedByImportId: jobId, archivedAt: { not: null } }, data: { archivedAt: null, archivedByImportId: null, revision: { increment: 1 } } })).count, snapshot.chapterIds.length)
    await invalidateNovelImportSources(tx, human.novelId, snapshot.importedChapterIds, [...new Set([...snapshot.importedVolumeIds, ...t.chapters.filter(chapter => snapshot.importedChapterIds.includes(chapter.id)).map(chapter => chapter.volumeId)])])
    // Previously archived derivations remain invalid/reviewable after reactivation.
    await tx.novel.update({ where: { id: human.novelId }, data: { ...snapshot.metadata, manuscriptRevision: { increment: 1 } } })
    const after = await target(tx, human)
    const receipt: NovelImportRestoreReceipt = { ...(commit.receipt as unknown as NovelImportReceipt), restored: true, restoredAt: now.toISOString(), restoredTargetHash: after.hash, restoredVolumeCount: after.volumes.length, restoredChapterCount: after.chapters.length }
    await tx.novelImportBackup.update({ where: { id: backup.id }, data: { restoredAt: now, restoredApprovalId: approval.id, restoreIdempotencyKey: input.idempotencyKey, restoreReceipt: { ...receipt }, restoreErrorCode: null } })
    await tx.novelImportApproval.update({ where: { id: approval.id }, data: { consumedAt: now } })
    await tx.novelImportJob.update({ where: { id: jobId }, data: { jobVersion: { increment: 1 } } })
    await tx.novelImportCommit.update({ where: { jobId }, data: { effectsPublishedAt: null } })
    return receipt
  }) } catch (error) {
    // Persist a useful status AFTER rollback, never a partial restoration.
    if (error instanceof DataAccessError && error.code === 'IMPORT_RESTORE_CONFLICT') await prisma.novelImportBackup.updateMany({ where: { jobId, restoredAt: null, job: { userId: human.userId, novelId: human.novelId } }, data: { restoreErrorCode: error.code } })
    throw error
  }
}
