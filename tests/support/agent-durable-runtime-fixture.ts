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
import { createDurableFixtureTasks, type DurableTestLifecycle, type DurableTestPhase } from './durable-test-lifecycle.js'

export const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
const fixtureTasks = createDurableFixtureTasks()
afterEach(async () => {
  try { await fixtureTasks.drain() }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks() }
})

export function fixture(work: (f: {
  userId: string; novelId: string; sessionId: string; chapterId: string; runId: string; sourceMessageId: string;
  spec: ReturnType<typeof buildTaskSpec>; rootId: string;
}) => Promise<void>, tokenBudget?: number, prompt = '修改本章', options?: { freezeWriting?: boolean; writingCoordinationProtocol?: 1; researchNavigationAdmission?: 1; continuityEvidenceProtocol?: 1; terminalEvidenceProtocol?: 1 | 2; terminalQuoteAddressProtocol?: 1; terminalCoverageProtocol?: 1 | 2; lifecycle?: DurableTestLifecycle }) {
  const lifecycle = options?.lifecycle
  let cleanupFailed = false
  const active = <T>(work: () => PromiseLike<T>) => lifecycle ? lifecycle.active(work) : Promise.resolve(work())
  const phase = <T>(name: DurableTestPhase, work: () => PromiseLike<T>) => lifecycle ? lifecycle.phase(name, work) : Promise.resolve(work())
  const execute = async () => {
    let cleanupUserId: string | undefined
    try {
      const data = await phase('fixture.setup', async () => {
        const user = await active(async () => {
          const created = await prisma.user.create({ data: { nickname: 'durable-runtime-fixture', passwordHash: 'test-only-unusable' } })
          // Capture the committed owner before active's post-await abort check.
          cleanupUserId = created.id
          return created
        })
        const userId = user.id
        const novel = await active(() => prisma.novel.create({ data: { authorId: userId, title: '持久执行测试', slug: randomUUID(), summary: '' } }))
        // Most protocol cases deliberately admit all tools; policy narrowing has
        // separate cases below and must not rely on an implicit default approval.
        const session = await active(() => prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '测试',
          toolPolicy: { network: 'allow', contentWrite: 'allow', bulkWrite: 'allow', publish: 'allow', destructive: 'allow' } } }))
        const volume = await active(() => prisma.volume.create({ data: { novelId: novel.id, title: '卷', orderIndex: 1 } }))
        const chapter = await active(() => prisma.chapter.create({ data: { authorId: userId, novelId: novel.id, volumeId: volume.id, title: '原章', content: '原文', orderIndex: 1, orderInVolume: 1, wordCount: 2 } }))
        const runId = randomUUID(), sourceMessageId = randomUUID()
        let spec = buildTaskSpec({ runId, novelId: novel.id, chapterId: chapter.id, prompt, researchAdmission: options?.researchNavigationAdmission, researchNavigationAdmission: options?.researchNavigationAdmission, continuityEvidenceProtocol: options?.continuityEvidenceProtocol, terminalEvidenceProtocol: options?.terminalEvidenceProtocol, terminalQuoteAddressProtocol: options?.terminalQuoteAddressProtocol, terminalCoverageProtocol: options?.terminalCoverageProtocol })
        await active(() => prisma.agentRun.create({ data: {
          id: runId, userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, status: 'queued',
          mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)),
        } }))
        await active(() => prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: prompt }] } }))
        if (options?.freezeWriting) {
          spec = await active(() => prisma.$transaction(tx => freezeWritingScope(tx, { userId, novelId: novel.id, runId }, spec, prompt)))
          await active(() => prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: JSON.parse(JSON.stringify(spec)) } }))
        }
        // Explicit isolated fixture admission before creating the root. Never
        // retrofit this marker into an existing production task or checkpoint.
        if (options?.writingCoordinationProtocol) {
          spec = { ...spec, writingPacing: 'explicit_writing', scope: { ...spec.scope, writingCoordinationProtocol: options.writingCoordinationProtocol } }
          await active(() => prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: JSON.parse(JSON.stringify(spec)) } }))
        }
        const root = await active(() => initializeDurableTask({ userId, runId, sourceMessageId, tokenBudget }))
        return { userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, runId, sourceMessageId, spec, rootId: root.id }
      })
      await phase('fixture.work', () => work(data))
    } finally {
      try {
        if (cleanupUserId) await phase('fixture.cleanup', () => prisma.$transaction(async tx => {
          const userId = cleanupUserId!
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
        })).catch(error => { cleanupFailed = true; throw error })
      } finally { lifecycle?.dispose() }
    }
  }
  return lifecycle ? fixtureTasks.track(execute, error => cleanupFailed || lifecycle.signal.aborted && error !== lifecycle.signal.reason) : execute()
}

export const claim = (f: { userId: string; runId: string }, ownerId = 'worker-a') => acquireRunLease({ ...f, ownerId, claimId: randomUUID() })
export const reported: ProviderUsageObservation = { source: 'reported', promptTokens: 10, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 10 }

export const novelFixture: typeof fixture = (work, tokenBudget) => fixture(work, tokenBudget, '授权自主创作全书，并修改已有章节及卷章结构。')

