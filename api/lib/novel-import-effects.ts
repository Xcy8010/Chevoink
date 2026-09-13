import { randomUUID } from 'node:crypto'
import { prisma } from './prisma.js'
import { novelImportTransaction } from './novel-import-service.js'
import { lockNovelActiveScope } from './data/novel-write-lock.js'
import { storeImportedNovelCoverDataUrl } from './novel-cover-storage.js'

/** Durable, bounded projection of commit/restore into status-visible events.
 * A crash/failure leaves effectsPublishedAt NULL; a later tick retries. Both the
 * event and marker commit together, so duplicate ticks cannot lose notifications.
 * UI refreshes the active tree/metadata/memory on receipt or status replay.
 * Search uses DB active-scope indexes (updated by the commit itself); derivations
 * were invalidated synchronously there. Never enqueue paid extraction or rerun
 * broad invalidation here: newer editor/AI work may exist by the time we drain. */
export async function drainNovelImportEffects(options: { jobIds?: readonly string[] } = {}): Promise<{ processed: number; failed: number }> {
  if (options.jobIds && (options.jobIds.length > 10 || options.jobIds.some(id => !/^[a-f0-9-]{36}$/.test(id)))) throw new Error('Invalid bounded import effect scope')
  const candidates = await prisma.novelImportCommit.findMany({ where: { effectsPublishedAt: null, ...(options.jobIds ? { jobId: { in: [...options.jobIds] } } : {}) }, select: { jobId: true }, orderBy: { createdAt: 'asc' }, take: 10 })
  const result = { processed: 0, failed: 0 }
  for (const candidate of candidates) {
    try {
      // Filesystem work is outside the retried transaction, and only follows a
      // durable commit. A content hash filename prevents orphan fanout on retry.
      const ownedJob = await prisma.novelImportJob.findUnique({ where: { id: candidate.jobId } })
      if (!ownedJob) continue
      const observed = await prisma.novel.findUnique({ where: { id: ownedJob.novelId }, include: { coverAsset: true } })
      if (!observed) continue
      const originalUrl = observed.coverAsset?.imageUrl
      const promotedUrl = originalUrl?.startsWith('data:image/png;') ? await storeImportedNovelCoverDataUrl(originalUrl) : undefined
      const projected = await novelImportTransaction(async tx => {
        const job = await tx.novelImportJob.findUnique({ where: { id: candidate.jobId } })
        if (!job) return false
        await lockNovelActiveScope(tx, job.novelId)
        const commit = await tx.novelImportCommit.findUnique({ where: { jobId: job.id } })
        if (!commit || commit.effectsPublishedAt) return false
        const novel = await tx.novel.findUniqueOrThrow({ where: { id: job.novelId }, include: { coverAsset: true } })
        // A newer user-selected cover must win. Retry against it next tick.
        if (novel.coverAssetId !== observed.coverAssetId) return false
        let coverUrl = novel.coverAsset?.imageUrl ?? null
        if (promotedUrl && novel.coverAsset?.imageUrl === originalUrl) {
          await tx.coverAsset.update({ where: { id: novel.coverAsset.id }, data: { imageUrl: promotedUrl } })
          coverUrl = promotedUrl
        } else if (coverUrl?.startsWith('data:image/png;')) return false
        // Preserve public reading IDs/order/progress; update metadata only.
        await tx.readingProgress.updateMany({ where: { novelId: job.novelId }, data: { novelTitle: novel.displayTitle || novel.title, coverUrl } })
        const backup = await tx.novelImportBackup.findUnique({ where: { jobId: job.id } })
        const effects = [{ kind: 'imported', receipt: commit.receipt }, ...(backup?.restoredAt && backup.restoreReceipt ? [{ kind: 'restored', receipt: backup.restoreReceipt }] : [])]
        for (const effect of effects) {
          const prior = await tx.novelImportEvent.findUnique({ where: { jobId_kind: { jobId: job.id, kind: effect.kind } } })
          if (!prior) await tx.novelImportEvent.create({ data: { id: randomUUID(), jobId: job.id, kind: effect.kind, payload: { version: 1, novelId: job.novelId, kind: effect.kind, refresh: ['directory', 'metadata', 'memory', 'search'], receipt: effect.receipt } } })
        }
        await tx.novelImportJob.update({ where: { id: job.id }, data: { jobVersion: { increment: 1 } } })
        await tx.novelImportCommit.update({ where: { jobId: job.id }, data: { effectsPublishedAt: new Date() } })
        return true
      })
      if (projected) result.processed++
    } catch { result.failed++ }
  }
  return result
}
