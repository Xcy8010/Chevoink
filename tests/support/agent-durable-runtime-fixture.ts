import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease } from '../../api/lib/agent/runtime-lease.js'
import type { ProviderUsageObservation } from '../../api/lib/agent/runtime-operations.js'
import { handleTestDatabaseUnavailable } from './database-availability.js'

export const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

export async function fixture(work: (f: {
  userId: string; novelId: string; sessionId: string; chapterId: string; runId: string; sourceMessageId: string;
  spec: ReturnType<typeof buildTaskSpec>; rootId: string;
}) => Promise<void>, tokenBudget?: number, prompt = '修改本章', options?: { freezeWriting?: boolean }) {
  const user = await prisma.user.create({ data: { nickname: 'durable-runtime-fixture', passwordHash: 'test-only-unusable' } })
  const userId = user.id
  try {
    const novel = await prisma.novel.create({ data: { authorId: userId, title: '持久执行测试', slug: randomUUID(), summary: '' } })
    // Most protocol cases deliberately admit all tools; policy narrowing has
    // separate cases below and must not rely on an implicit default approval.
    const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '测试',
      toolPolicy: { network: 'allow', contentWrite: 'allow', bulkWrite: 'allow', publish: 'allow', destructive: 'allow' } } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: userId, novelId: novel.id, volumeId: volume.id, title: '原章', content: '原文', orderIndex: 1, orderInVolume: 1, wordCount: 2 } })
    const runId = randomUUID(), sourceMessageId = randomUUID()
    let spec = buildTaskSpec({ runId, novelId: novel.id, chapterId: chapter.id, prompt })
    await prisma.agentRun.create({ data: {
      id: runId, userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, status: 'queued',
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)),
    } })
    await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    if (options?.freezeWriting) {
      spec = await prisma.$transaction(tx => freezeWritingScope(tx, { userId, novelId: novel.id, runId }, spec, prompt))
      await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: JSON.parse(JSON.stringify(spec)) } })
    }
    const root = await initializeDurableTask({ userId, runId, sourceMessageId, tokenBudget })
    await work({ userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, runId, sourceMessageId, spec, rootId: root.id })
  } finally {
    await prisma.$transaction(async tx => {
      // Serialize with derived memory writes before sweeping exact fixture ownership.
      const novels = await tx.novel.findMany({ where: { authorId: userId }, select: { id: true }, orderBy: { id: 'asc' } })
      for (const novel of novels) await lockNovelActiveScope(tx, novel.id)
      await tx.memoryExtractionJob.deleteMany({ where: { novel: { authorId: userId } } })
      await tx.creditRateCardEvent.deleteMany({ where: { card: { createdBy: userId } } })
      await tx.creditRateCard.deleteMany({ where: { createdBy: userId } })
      await tx.agentArtifact.deleteMany({ where: { run: { userId } } })
      await tx.projectMemoryEntry.deleteMany({ where: { novel: { authorId: userId } } })
      // New roots cascade after their original runs are removed.
      await tx.agentRun.deleteMany({ where: { userId } })
      await tx.agentSession.deleteMany({ where: { userId } })
      await tx.chapter.deleteMany({ where: { authorId: userId } })
      await tx.novel.deleteMany({ where: { authorId: userId } })
      await tx.user.delete({ where: { id: userId } })
    })
  }
}

export const claim = (f: { userId: string; runId: string }, ownerId = 'worker-a') => acquireRunLease({ ...f, ownerId, claimId: randomUUID() })
export const reported: ProviderUsageObservation = { source: 'reported', promptTokens: 10, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 10 }

export const novelFixture: typeof fixture = (work, tokenBudget) => fixture(work, tokenBudget, '授权自主创作全书，并修改已有章节及卷章结构。')

