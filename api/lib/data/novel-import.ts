import { createHash } from 'node:crypto'
import { Prisma, type Chapter, type Novel, type Volume } from '@prisma/client'
import { z } from 'zod'
import { DataAccessError } from '../prisma.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
export const novelImportMetadata = (novel: Pick<Novel, 'title' | 'displayTitle' | 'summary' | 'tagNames' | 'wordCount' | 'chapterCount' | 'lastChapterTitle' | 'coverAssetId' | 'coverPrompt'>) => ({ title: novel.title, displayTitle: novel.displayTitle, summary: novel.summary, tagNames: novel.tagNames, wordCount: novel.wordCount, chapterCount: novel.chapterCount, lastChapterTitle: novel.lastChapterTitle, coverAssetId: novel.coverAssetId, coverPrompt: novel.coverPrompt })

// Exclude reader counters/timestamps: comments and reads must not invalidate a
// restoration. Include every creative/publication field, not merely counts.
export function hashNovelImportRows(volumes: Volume[], chapters: Chapter[]): string {
  return digest(JSON.stringify({
    volumes: [...volumes].sort(byId).map(v => ({ id: v.id, novelId: v.novelId, title: v.title, summary: v.summary, orderIndex: v.orderIndex, revision: v.revision, archivedAt: v.archivedAt, archivedByImportId: v.archivedByImportId })),
    chapters: [...chapters].sort(byId).map(c => ({ id: c.id, novelId: c.novelId, authorId: c.authorId, title: c.title, summary: c.summary, contentHash: digest(c.content ?? ''), orderIndex: c.orderIndex, volumeId: c.volumeId, orderInVolume: c.orderInVolume, wordCount: c.wordCount, revision: c.revision, status: c.status, visibility: c.visibility, archivedAt: c.archivedAt, archivedByImportId: c.archivedByImportId, publishedTitle: c.publishedTitle, publishedSummary: c.publishedSummary, publishedContentHash: c.publishedContent === null ? null : digest(c.publishedContent ?? ''), publishedWordCount: c.publishedWordCount, publishedRevision: c.publishedRevision, publishedAt: c.publishedAt })),
  }))
}
export function hashNovelImportTarget(novel: Novel, volumes: Volume[], chapters: Chapter[], publishedHistory: number): string {
  return digest(JSON.stringify({ metadata: novelImportMetadata(novel), manuscriptRevision: novel.manuscriptRevision, slug: novel.slug, visibility: novel.visibility, status: novel.status, publishedAt: novel.publishedAt, coverAssetId: novel.coverAssetId, categoryId: novel.categoryId, categoryName: novel.categoryName, publishedHistory, rows: hashNovelImportRows(volumes, chapters) }))
}

export const novelImportBackupSchema = z.object({
  version: z.literal(2).optional(),
  volumeIds: z.array(z.string()), chapterIds: z.array(z.string()), retainedEmptyVolumeIds: z.array(z.string()),
  importedVolumeIds: z.array(z.string()), importedChapterIds: z.array(z.string()),
  metadata: z.object({ title: z.string(), displayTitle: z.string().nullable().optional(), summary: z.string(), tagNames: z.array(z.string()), wordCount: z.number(), chapterCount: z.number(), lastChapterTitle: z.string().nullable(), coverAssetId: z.string().nullable().optional(), coverPrompt: z.string().nullable().optional() }),
  metadataKeys: z.array(z.enum(['title', 'summary', 'tagNames', 'coverAssetId'])).optional(),
  retainedHash: z.string(),
})

export function assertNovelImportMutationCount(actual: number, expected: number): void {
  if (actual !== expected) throw new DataAccessError(409, 'IMPORT_TARGET_CHANGED', '卷章范围已变化，未执行部分导入或恢复。')
}

/** Invalidate derived facts in the SAME transaction as archival. Keep all rows
 * and human prose for review; never revive stale derived state on restoration.
 * No model calls, deletes, background work or filesystem effects here. */
export async function invalidateNovelImportSources(tx: Prisma.TransactionClient, novelId: string, chapterIds: string[], volumeIds: string[]): Promise<void> {
  if (!chapterIds.length && !volumeIds.length) return
  const memoryWhere: Prisma.ProjectMemoryEntryWhereInput = { novelId, OR: [
    { sourceChapterId: { in: chapterIds } },
    { evidence: { some: { OR: [{ sourceType: 'chapter', sourceId: { in: chapterIds } }, { sourceType: 'volume', sourceId: { in: volumeIds } }] } } },
  ] }
  const memories = await tx.projectMemoryEntry.findMany({ where: memoryWhere, select: { id: true } })
  const sourceIds = [...chapterIds, ...volumeIds, ...memories.map(memory => memory.id)]
  const changes = await tx.changeSet.findMany({ where: { novelId, status: { in: ['draft', 'approved', 'conflicted', 'failed'] }, patches: { some: { OR: [{ targetType: 'chapter', targetId: { in: chapterIds } }, { targetType: 'volume', targetId: { in: volumeIds } }] } } }, select: { id: true, validations: true } })
  for (const change of changes) {
    const previous = Array.isArray(change.validations) ? change.validations : []
    await tx.changeSet.update({ where: { id: change.id }, data: { status: 'failed', validations: [...previous, { code: 'IMPORT_SCOPE_CHANGED', status: 'failed', message: '来源稿件已导入或恢复，需重新预览。', targetIds: [...chapterIds, ...volumeIds] }] as Prisma.InputJsonArray } })
  }
  await tx.projectMemoryEntry.updateMany({ where: memoryWhere, data: { status: 'invalid', reviewStatus: 'pending', version: { increment: 1 }, embedding: Prisma.DbNull, embeddingRef: null } })
  await tx.memoryExtractionJob.updateMany({ where: { novelId, chapterId: { in: chapterIds }, status: { in: ['pending', 'processing'] } }, data: { status: 'failed', leaseUntil: null, errorMessage: 'IMPORT_SOURCE_ARCHIVED' } })
  await tx.storyEvent.updateMany({ where: { novelId, sourceId: { in: sourceIds } }, data: { status: 'invalid' } })
  await tx.foreshadowThread.updateMany({ where: { novelId, OR: [{ sourceId: { in: sourceIds } }, { plantedAt: { in: chapterIds } }] }, data: { status: 'invalid' } })
  // A negative source revision cannot match a live chapter. Historical edges
  // remain available to audit; active consumers also check source scope.
  await tx.entityRelation.updateMany({ where: { OR: [{ sourceId: { in: sourceIds } }, { sourceId: { startsWith: 'ai-graph:' } }], fromEntity: { novelId }, toEntity: { novelId } }, data: { revision: -1 } })
  await tx.storyEntity.updateMany({ where: { novelId, status: 'inferred', description: { startsWith: '[AI关系网] ' } }, data: { status: 'invalid' } })
  await tx.storyCompilation.updateMany({ where: { novelId }, data: { status: 'abandoned' } })
  await tx.sceneTask.updateMany({ where: { novelId }, data: { status: 'abandoned' } })
  await tx.chapterBridge.updateMany({ where: { novelId }, data: { committedAt: null, sourceRevision: -1, targetRevision: -1 } })
  await tx.chapterQualityReport.updateMany({ where: { novelId }, data: { status: 'stale' } })
  await tx.styleProfile.updateMany({ where: { novelId, confirmed: true }, data: { confirmed: false } })
  await tx.styleLearningJob.updateMany({ where: { profile: { novelId } }, data: { status: 'paused', pauseRequested: true, enabled: false, claimToken: null, leaseUntil: null, revision: { increment: 1 }, error: 'IMPORT_SOURCE_ARCHIVED' } })
}
