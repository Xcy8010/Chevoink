import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { applyMemoryExtractionJob, enqueueChapterMemoryExtraction, processMemoryExtractionJob } from '../../api/lib/agent/story-memory.js'
import { fixture } from '../support/agent-durable-runtime-fixture.js'

async function pendingMemory(f: { novelId: string; chapterId: string }) {
  const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
  // The transaction overload leaves scheduling to the caller after commit.
  return prisma.$transaction(tx => enqueueChapterMemoryExtraction({
    novelId: f.novelId, chapterId: chapter.id, chapterRevision: chapter.revision, before: '', after: chapter.content,
  }, tx))
}

describe('durable runtime fixture teardown', () => {
  it('waits for an in-flight memory transaction before sweeping its fixture rows', async () => {
    let release!: () => void, acquired!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { acquired = resolve })
    let writer: Promise<void> | undefined
    let writerPid = 0, userId = '', novelId = '', jobId = ''
    const cleanup = fixture(async f => {
      userId = f.userId; novelId = f.novelId
      jobId = await pendingMemory(f)
      writer = prisma.$transaction(async tx => {
        await lockNovelActiveScope(tx, f.novelId)
        // Keep the old teardown at chapter deletion, after its memory sweep.
        // The fixed teardown must wait at the novel lock before that sweep.
        await tx.$queryRaw`SELECT id FROM chapters WHERE id = ${f.chapterId} FOR UPDATE`
        writerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
        acquired(); await held
        const applied = await applyMemoryExtractionJob(tx, jobId)
        expect(applied.status).toBe('applied')
        expect(applied.memoryIds).toHaveLength(2)
      }, { timeout: 10_000 })
      // Also unblock the observer if transaction setup fails; its result below
      // still has to succeed, and all transactions are settled before exit.
      void writer.catch(() => acquired())
      await reached
    })
    const cleanupResult = Promise.allSettled([cleanup])
    try {
      await Promise.race([reached, cleanup])
      await vi.waitFor(async () => {
        const waiters = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE usename = current_user AND wait_event_type = 'Lock'
            AND ${writerPid}::integer = ANY(pg_blocking_pids(pid))
        `
        expect(waiters.length).toBeGreaterThan(0)
      }, { timeout: 3000 })
    } finally {
      release()
      await Promise.allSettled([cleanup, ...(writer ? [writer] : [])])
    }
    expect((await Promise.allSettled([writer!]))[0].status).toBe('fulfilled')
    expect((await cleanupResult)[0]).toEqual({ status: 'fulfilled', value: undefined })
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull()
    expect(await prisma.novel.findUnique({ where: { id: novelId } })).toBeNull()
    expect(await prisma.memoryExtractionJob.findUnique({ where: { id: jobId } })).toBeNull()
    expect(await prisma.projectMemoryEntry.count({ where: { novelId } })).toBe(0)
  }, 15_000)

  it('removes only its owned jobs and memories on callback failure, including work scheduled after teardown', async () => fixture(async other => {
    const otherJobId = await pendingMemory(other)
    const otherMemory = await prisma.projectMemoryEntry.create({ data: {
      novelId: other.novelId, memoryType: 'chapterSummary', title: 'other fixture', content: 'retain',
    } })
    const otherJob = await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: otherJobId } })
    const bodyError = new Error('fixture callback failure')
    let userId = '', novelId = '', jobId = ''
    await expect(fixture(async f => {
      userId = f.userId; novelId = f.novelId
      jobId = await pendingMemory(f)
      throw bodyError
    })).rejects.toBe(bodyError)
    await expect(processMemoryExtractionJob(jobId)).resolves.toBeUndefined()
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull()
    expect(await prisma.novel.findUnique({ where: { id: novelId } })).toBeNull()
    expect(await prisma.memoryExtractionJob.findUnique({ where: { id: jobId } })).toBeNull()
    expect(await prisma.projectMemoryEntry.count({ where: { novelId } })).toBe(0)
    expect(await prisma.memoryExtractionJob.findUnique({ where: { id: otherJobId } })).toEqual(otherJob)
    expect(await prisma.projectMemoryEntry.findUnique({ where: { id: otherMemory.id } })).toEqual(otherMemory)
    expect(await prisma.user.findUnique({ where: { id: other.userId } })).not.toBeNull()
  }))
})
