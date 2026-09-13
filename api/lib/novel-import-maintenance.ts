import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { novelImportTransaction } from './novel-import-service.js'
import { deleteUnreferencedImportBlob } from './novel-import-storage.js'

const JOB_BATCH = 10
const BLOB_BATCH = 50
const RETENTION_MS = 7 * 86400_000
export interface NovelImportMaintenanceResult { expiredJobs: number; deletedBlobs: number; retainedBlobs: number; failedBlobs: number }
export function isNovelImportMaintenanceEnabled(): boolean {
  return process.env.NOVEL_IMPORT_MAINTENANCE_ENABLED === undefined
    ? process.env.NOVEL_IMPORT_ENABLED === 'true'
    : process.env.NOVEL_IMPORT_MAINTENANCE_ENABLED === 'true'
}

/** Bounded tick, no directory scans or recursive removals. A failed unlink keeps
 * its queue row. Immutable random blob keys are never adopted/reused by uploads.
 * Committed/backup resources and parsing/live claims are never TTL candidates. */
export async function maintainNovelImports(options: { jobIds?: readonly string[] } = {}): Promise<NovelImportMaintenanceResult> {
  const result: NovelImportMaintenanceResult = { expiredJobs: 0, deletedBlobs: 0, retainedBlobs: 0, failedBlobs: 0 }
  if (!isNovelImportMaintenanceEnabled()) return result
  if (options.jobIds && (options.jobIds.length > JOB_BATCH || options.jobIds.some(id => !/^[a-f0-9-]{36}$/.test(id)))) throw new Error('Invalid bounded maintenance scope')
  const now = new Date()
  // A process crash can leave parsing forever. Fence only expired jobs with no
  // live lease before TTL selection; never reclaim an in-flight parser.
  const abandonedParsers: Prisma.NovelImportJobWhereInput = {
    ...(options.jobIds ? { id: { in: [...options.jobIds] } } : {}),
    status: 'parsing', expiresAt: { lte: now },
    OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    commit: { is: null }, backup: { is: null },
  }
  const stale = await prisma.novelImportJob.findMany({ where: abandonedParsers, select: { id: true, jobVersion: true, leaseEpoch: true }, orderBy: { createdAt: 'asc' }, take: JOB_BATCH })
  for (const job of stale) await prisma.novelImportJob.updateMany({
    where: { ...abandonedParsers, id: job.id, jobVersion: job.jobVersion, leaseEpoch: job.leaseEpoch },
    data: { status: 'failed', errorCode: 'IMPORT_PARSE_EXPIRED', leaseOwner: null, leaseUntil: null, leaseEpoch: { increment: 1 }, jobVersion: { increment: 1 } },
  })
  const eligible: Prisma.NovelImportJobWhereInput = {
    ...(options.jobIds ? { id: { in: [...options.jobIds] } } : {}),
    createdAt: { lte: new Date(now.getTime() - RETENTION_MS) }, expiresAt: { lte: now },
    status: { notIn: ['parsing', 'succeeded', 'expired'] },
    OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    commit: { is: null }, backup: { is: null },
  }
  const jobs = await prisma.novelImportJob.findMany({ where: eligible, select: { id: true }, orderBy: { createdAt: 'asc' }, take: JOB_BATCH })
  const scopedKeys: string[] = []
  for (const candidate of jobs) {
    const expired = await novelImportTransaction(async tx => {
      const job = await tx.novelImportJob.findFirst({ where: { ...eligible, id: candidate.id } })
      if (!job) return null
      const keys = options.jobIds ? [
        ...await tx.novelImportSource.findMany({ where: { jobId: job.id }, select: { storageKey: true } }),
        ...await tx.novelImportManifest.findMany({ where: { jobId: job.id }, select: { storageKey: true } }),
      ].map(blob => blob.storageKey) : []
      // CAS/fencing and reference deletion commit together. Existing DB triggers
      // queue the exact removed source/manifest keys in this same transaction.
      await tx.novelImportJob.update({ where: { id: job.id }, data: { status: 'expired', jobVersion: { increment: 1 }, leaseEpoch: { increment: 1 }, leaseOwner: null, leaseUntil: null, manifestHash: null } })
      await tx.novelImportApproval.updateMany({ where: { jobId: job.id, consumedAt: null }, data: { expiresAt: now } })
      await tx.novelImportManifest.deleteMany({ where: { jobId: job.id } })
      await tx.novelImportSource.deleteMany({ where: { jobId: job.id } })
      return keys
    })
    if (expired) { result.expiredJobs++; scopedKeys.push(...expired) }
  }
  const garbage = await prisma.novelImportGarbage.findMany({ ...(options.jobIds ? { where: { storageKey: { in: scopedKeys } } } : {}), orderBy: { createdAt: 'asc' }, take: BLOB_BATCH })
  for (const blob of garbage) {
    try {
      // No caller-supplied paths, even if the queue has been corrupted.
      if (!/^[a-f0-9-]{36}\.blob$/.test(blob.storageKey)) { result.failedBlobs++; continue }
      const references = await prisma.novelImportSource.count({ where: { storageKey: blob.storageKey } }) + await prisma.novelImportManifest.count({ where: { storageKey: blob.storageKey } })
      if (references) { result.retainedBlobs++; continue }
      // File I/O is deliberately outside the retried DB transaction.
      await deleteUnreferencedImportBlob(blob.storageKey)
      await prisma.novelImportGarbage.deleteMany({ where: { storageKey: blob.storageKey } })
      result.deletedBlobs++
    } catch { result.failedBlobs++ }
  }
  return result
}
