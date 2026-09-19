import { randomUUID } from 'node:crypto'
import type { NovelImportJob } from '@prisma/client'
import type { NovelImportArtifactDescriptor, NovelImportDocumentReport, NovelImportEvidencePreview, NovelImportPreviewSummary } from '../../../shared/contracts/novel-import-preview.js'
import { prisma, DataAccessError } from '../prisma.js'
import { deleteUnreferencedImportBlob, importBytesHash, readImportBlob, storeImportStream } from '../novel-import-storage.js'
import { IMPORT_RESOURCE_LIMITS, type ImportImage } from './document-types.js'
import { previewContentHash } from './preview.js'

type Claim = Pick<NovelImportJob, 'id' | 'userId' | 'novelId' | 'leaseOwner' | 'leaseEpoch'>
export type StoredPreview = { storageVersion: 2; summary: NovelImportPreviewSummary; reportArtifactId: string; chapterArtifactIds: string[][]; contentHash: string }
const fail = (code: string, message: string): never => { throw new DataAccessError(409, code, message) }
const MAX_JOB_BYTES = 256 * 1024 * 1024

async function validClaim(claim: Claim) {
  const job = await prisma.novelImportJob.findFirst({ where: { id: claim.id, userId: claim.userId, novelId: claim.novelId, leaseOwner: claim.leaseOwner, leaseEpoch: claim.leaseEpoch, leaseUntil: { gt: new Date() }, expiresAt: { gt: new Date() }, status: { in: ['parsing', 'ready', 'needs_review', 'awaiting_confirmation'] } } })
  if (!claim.leaseOwner || !job) fail('IMPORT_LEASE_LOST', '预览存储租约已失效。')
}
async function storeArtifact(claim: Claim, kind: 'report' | 'image' | 'chapter', bytes: Buffer, logicalId: string) {
  await validClaim(claim)
  const sha256 = importBytesHash(bytes)
  const prior = await prisma.novelImportArtifact.findFirst({ where: { jobId: claim.id, kind, sha256 } })
  if (prior) { await readImportBlob(prior.storageKey, sha256, 32 * 1024 * 1024); return prior }
  const existing = await prisma.novelImportArtifact.findMany({ where: { jobId: claim.id }, select: { bytes: true }, take: 10001 })
  if (existing.length >= 10000 || existing.reduce((sum, row) => sum + row.bytes, 0) + bytes.length > MAX_JOB_BYTES) fail('IMPORT_STORAGE_LIMIT', '本任务持久预览达到容量限制，请下载原文件并重新创建任务。')
  const blob = await storeImportStream((async function* () { yield bytes })(), { maxBytes: 32 * 1024 * 1024 })
  try {
    return await prisma.$transaction(async tx => {
      const job = await tx.novelImportJob.findFirst({ where: { id: claim.id, userId: claim.userId, novelId: claim.novelId, leaseOwner: claim.leaseOwner, leaseEpoch: claim.leaseEpoch, leaseUntil: { gt: new Date() }, expiresAt: { gt: new Date() }, status: { in: ['parsing', 'ready', 'needs_review', 'awaiting_confirmation'] } } })
      if (!job) fail('IMPORT_LEASE_LOST', '预览存储租约已失效。')
      return tx.novelImportArtifact.create({ data: { id: randomUUID(), jobId: claim.id, kind, logicalId, ...blob, mediaType: kind === 'image' ? 'image/png' : kind === 'report' ? 'application/json' : 'text/plain; charset=utf-8' } })
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    // On an uncertain DB response, re-check references before exact-key deletion.
    try {
      if (!await prisma.novelImportArtifact.count({ where: { storageKey: blob.storageKey } })) await deleteUnreferencedImportBlob(blob.storageKey)
    } catch { await prisma.novelImportGarbage.createMany({ data: [{ storageKey: blob.storageKey }], skipDuplicates: true }).catch(() => undefined) }
    throw error
  }
}

export async function storePreviewImages(claim: Claim, images: ImportImage[]): Promise<NovelImportArtifactDescriptor[]> {
  if (images.length > IMPORT_RESOURCE_LIMITS.images || images.reduce((sum, image) => sum + image.byteLength, 0) > IMPORT_RESOURCE_LIMITS.bytes || new Set(images.map(image => image.id)).size !== images.length) fail('IMPORT_LIMIT_EXCEEDED', '图片资源超过安全限制。')
  const descriptors: NovelImportArtifactDescriptor[] = []
  for (const image of images) {
    const bytes = Buffer.from(image.bytes)
    if (image.mediaType !== 'image/png' || bytes.length !== image.byteLength || bytes.length > IMPORT_RESOURCE_LIMITS.imageBytes || importBytesHash(bytes) !== image.sha256 || bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height || image.width * image.height > IMPORT_RESOURCE_LIMITS.pixels) fail('IMPORT_IMAGE_INVALID', '图片资源未通过完整性校验。')
    const artifact = await storeArtifact(claim, 'image', bytes, image.id)
    descriptors.push({ id: image.id, storageArtifactId: artifact.id, source: image.source, sha256: image.sha256, bytes: image.byteLength, width: image.width, height: image.height, mediaType: 'image/png', coverCandidate: image.coverCandidate,
      url: `/api/novels/${encodeURIComponent(claim.novelId)}/imports/${encodeURIComponent(claim.id)}/artifacts/${artifact.id}` })
  }
  return descriptors
}

/** Call only after storePreviewImages has verified and persisted every image. */
export function finalizeStoredImageReport(report: NovelImportDocumentReport, artifacts: NovelImportArtifactDescriptor[]): NovelImportDocumentReport {
  const ids = new Set(artifacts.map(image => image.id))
  if (report.items.some(item => item.artifactId && !ids.has(item.artifactId))) fail('IMPORT_IMAGE_INVALID', '来源报告引用了缺失图片。')
  const storageIssue = report.issues.some(issue => issue.code === 'IMPORT_IMAGE_STORAGE_REQUIRED')
  if (storageIssue && !artifacts.length) fail('IMPORT_IMAGE_INVALID', '图片存储确认缺少已保存资源。')
  const issues = report.issues.filter(issue => issue.code !== 'IMPORT_IMAGE_STORAGE_REQUIRED')
  return { ...report, issues, complete: (report.complete || storageIssue) && !issues.some(issue => issue.blocking)
    && !report.items.some(item => item.status === 'failed' || item.status === 'needs_review') }
}

export function summarizePreview(preview: NovelImportEvidencePreview): NovelImportPreviewSummary {
  const { report: _report, volumes, ...summary } = preview
  return { ...summary, volumes: volumes.map((volume, vi) => ({ title: volume.title, chapters: volume.chapters.map((chapter, ci) => ({ title: chapter.title, source: chapter.source, volumeIndex: vi, chapterIndex: ci, contentHash: importBytesHash(chapter.content), characters: chapter.content.length, nonEmpty: !!chapter.content.trim() })) })) }
}
export async function storePreviewParts(claim: Claim, preview: NovelImportEvidencePreview): Promise<StoredPreview> {
  if (!preview.report) fail('IMPORT_REPORT_UNAVAILABLE', '预览没有持久来源报告。')
  const report = await storeArtifact(claim, 'report', Buffer.from(JSON.stringify(preview.report)), preview.reportHash!)
  const chapterArtifactIds: string[][] = []
  for (const volume of preview.volumes) {
    const ids: string[] = []
    for (const chapter of volume.chapters) {
      // Empty chapters have an explicit zero-content marker; private blob storage refuses zero bytes.
      const artifact = await storeArtifact(claim, 'chapter', Buffer.from(JSON.stringify({ content: chapter.content })), importBytesHash(chapter.content))
      ids.push(artifact.id)
    }
    chapterArtifactIds.push(ids)
  }
  return { storageVersion: 2, summary: summarizePreview(preview), reportArtifactId: report.id, chapterArtifactIds, contentHash: previewContentHash(preview) }
}
export async function readPreviewArtifact(jobId: string, artifactId: string, kind: 'image' | 'chapter' | 'report') {
  const artifact = await prisma.novelImportArtifact.findFirst({ where: { id: artifactId, jobId, kind } })
  if (!artifact) fail('IMPORT_ARTIFACT_UNAVAILABLE', '本任务资源不存在或保留期已结束。')
  return { artifact: artifact!, bytes: await readImportBlob(artifact!.storageKey, artifact!.sha256, 32 * 1024 * 1024) }
}
/** All resources must still be readable when a full preview is consumed for approval/commit. */
export async function verifyPreviewImages(scope: { novelId: string }, jobId: string, preview: NovelImportEvidencePreview): Promise<void> {
  const prefix = `/api/novels/${encodeURIComponent(scope.novelId)}/imports/${encodeURIComponent(jobId)}/artifacts/`
  const descriptors = new Map((preview.artifacts ?? []).map(image => [image.id, image]))
  if (preview.report?.items.some(item => item.artifactId && !descriptors.has(item.artifactId))) fail('IMPORT_IMAGE_INVALID', '来源图片引用未完整保存。')
  for (const image of descriptors.values()) {
    const artifactId = image.url.startsWith(prefix) ? image.url.slice(prefix.length) : ''
    if (!/^[a-f0-9-]{36}$/.test(artifactId)) fail('IMPORT_IMAGE_INVALID', '图片不属于当前导入任务。')
    if (image.storageArtifactId && image.storageArtifactId !== artifactId) fail('IMPORT_IMAGE_INVALID', '图片存储引用不一致。')
    const { artifact, bytes } = await readPreviewArtifact(jobId, artifactId, 'image')
    if (artifact.sha256 !== image.sha256 || bytes.length !== image.bytes) fail('IMPORT_IMAGE_INVALID', '图片资源已变化，请重新解析。')
  }
}
export async function readStoredChapter(jobId: string, stored: StoredPreview, vi: number, ci: number) {
  const chapter = stored.summary.volumes[vi]?.chapters[ci]
  const id = stored.chapterArtifactIds[vi]?.[ci]
  if (!chapter || !id) fail('IMPORT_CHAPTER_UNAVAILABLE', '当前预览中没有此章节。')
  const body: unknown = JSON.parse((await readPreviewArtifact(jobId, id!, 'chapter')).bytes.toString('utf8'))
  if (!body || typeof body !== 'object' || !('content' in body) || typeof body.content !== 'string' || importBytesHash(body.content) !== chapter!.contentHash || body.content.length !== chapter!.characters) fail('IMPORT_PREVIEW_CHANGED', '章节正文完整性校验失败。')
  return { title: chapter!.title, source: chapter!.source, content: (body as { content: string }).content }
}
export async function hydrateStoredPreview(jobId: string, stored: StoredPreview): Promise<NovelImportEvidencePreview> {
  const report: NovelImportDocumentReport = JSON.parse((await readPreviewArtifact(jobId, stored.reportArtifactId, 'report')).bytes.toString('utf8'))
  const volumes: NovelImportEvidencePreview['volumes'] = []
  for (let vi = 0; vi < stored.summary.volumes.length; vi++) {
    const volume = stored.summary.volumes[vi]
    const chapters = []
    for (let ci = 0; ci < volume.chapters.length; ci++) chapters.push(await readStoredChapter(jobId, stored, vi, ci))
    volumes.push({ title: volume.title, chapters })
  }
  return { ...stored.summary, volumes, report }
}
