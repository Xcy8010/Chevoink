import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  db: {
    novelImportJob: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    novelImportSource: { count: vi.fn(), deleteMany: vi.fn() },
    novelImportManifest: { count: vi.fn(), deleteMany: vi.fn() },
    novelImportApproval: { updateMany: vi.fn() },
    novelImportGarbage: { findMany: vi.fn(), deleteMany: vi.fn() },
  }, remove: vi.fn(),
}))
vi.mock('../api/lib/prisma.js', () => ({ prisma: mocks.db }))
vi.mock('../api/lib/novel-import-service.js', () => ({ novelImportTransaction: (fn: (tx: typeof mocks.db) => Promise<unknown>) => fn(mocks.db) }))
vi.mock('../api/lib/novel-import-storage.js', () => ({ deleteUnreferencedImportBlob: mocks.remove }))
import { maintainNovelImports } from '../api/lib/novel-import-maintenance.js'
const key = '11111111-1111-4111-8111-111111111111.blob'
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
  vi.stubEnv('NOVEL_IMPORT_MAINTENANCE_ENABLED', undefined)
  mocks.db.novelImportJob.findMany.mockResolvedValue([])
  mocks.db.novelImportGarbage.findMany.mockResolvedValue([])
  mocks.db.novelImportSource.count.mockResolvedValue(0)
  mocks.db.novelImportManifest.count.mockResolvedValue(0)
  mocks.remove.mockResolvedValue(undefined)
})
describe('bounded import maintenance', () => {
  it('does nothing when import is disabled', async () => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'false')
    expect(await maintainNovelImports()).toEqual({ expiredJobs: 0, deletedBlobs: 0, retainedBlobs: 0, failedBlobs: 0 })
    expect(mocks.db.novelImportJob.findMany).not.toHaveBeenCalled()
  })
  it('independently enables cleanup after rollout is disabled, and honors an explicit cleanup OFF', async () => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'false'); vi.stubEnv('NOVEL_IMPORT_MAINTENANCE_ENABLED', 'true')
    await maintainNovelImports()
    expect(mocks.db.novelImportJob.findMany).toHaveBeenCalledTimes(2)
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true'); vi.stubEnv('NOVEL_IMPORT_MAINTENANCE_ENABLED', 'false')
    await maintainNovelImports()
    expect(mocks.db.novelImportJob.findMany).toHaveBeenCalledTimes(2)
  })
  it('selects only expired old uncommitted jobs without parsing/live lease or backup refs', async () => {
    mocks.db.novelImportJob.findMany.mockResolvedValue([{ id: 'old' }])
    mocks.db.novelImportJob.findFirst.mockResolvedValue({ id: 'old' })
    expect((await maintainNovelImports()).expiredJobs).toBe(1)
    expect(mocks.db.novelImportJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10, where: expect.objectContaining({ commit: { is: null }, backup: { is: null }, status: { notIn: ['parsing', 'succeeded', 'expired'] }, OR: expect.arrayContaining([{ leaseUntil: null }]) }) }))
    expect(mocks.db.novelImportJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'expired', leaseEpoch: { increment: 1 } }) }))
    expect(mocks.db.novelImportSource.deleteMany).toHaveBeenCalledWith({ where: { jobId: 'old' } })
    expect(mocks.db.novelImportManifest.deleteMany).toHaveBeenCalledWith({ where: { jobId: 'old' } })
  })
  it('rechecks eligibility in the transaction and skips newly referenced jobs', async () => {
    mocks.db.novelImportJob.findMany.mockResolvedValue([{ id: 'changed' }])
    mocks.db.novelImportJob.findFirst.mockResolvedValue(null)
    expect((await maintainNovelImports()).expiredJobs).toBe(0)
    expect(mocks.db.novelImportSource.deleteMany).not.toHaveBeenCalled()
  })
  it('retains referenced blobs and invalid keys without touching the filesystem', async () => {
    mocks.db.novelImportGarbage.findMany.mockResolvedValue([{ storageKey: key }, { storageKey: '../secret' }])
    mocks.db.novelImportSource.count.mockResolvedValue(1)
    expect(await maintainNovelImports()).toMatchObject({ retainedBlobs: 1, failedBlobs: 1, deletedBlobs: 0 })
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.db.novelImportGarbage.deleteMany).not.toHaveBeenCalled()
  })
  it('failed unlink never drops the durable queue and successful retry removes the exact key', async () => {
    mocks.db.novelImportGarbage.findMany.mockResolvedValue([{ storageKey: key }])
    mocks.remove.mockRejectedValueOnce(new Error('EACCES'))
    expect((await maintainNovelImports()).failedBlobs).toBe(1)
    expect(mocks.db.novelImportGarbage.deleteMany).not.toHaveBeenCalled()
    expect((await maintainNovelImports()).deletedBlobs).toBe(1)
    expect(mocks.db.novelImportGarbage.deleteMany).toHaveBeenCalledWith({ where: { storageKey: key } })
    expect(mocks.db.novelImportGarbage.findMany).toHaveBeenLastCalledWith({ orderBy: { createdAt: 'asc' }, take: 50 })
  })
  it('fences expired parsing claims with a version/epoch/live-lease CAS before TTL cleanup', async () => {
    mocks.db.novelImportJob.findMany.mockResolvedValueOnce([{ id: 'stale', jobVersion: 5, leaseEpoch: 2 }]).mockResolvedValueOnce([])
    await maintainNovelImports()
    expect(mocks.db.novelImportJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'stale', status: 'parsing', jobVersion: 5, leaseEpoch: 2, expiresAt: { lte: expect.any(Date) }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: expect.any(Date) } }] }),
      data: expect.objectContaining({ status: 'failed', errorCode: 'IMPORT_PARSE_EXPIRED', leaseEpoch: { increment: 1 }, leaseOwner: null }),
    }))
    expect(mocks.db.novelImportSource.deleteMany).not.toHaveBeenCalled()
  })
})
