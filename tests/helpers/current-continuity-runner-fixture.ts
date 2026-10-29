import { vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as humanity from '../../api/lib/agent/humanity-quality.js'
import * as locks from '../../api/lib/data/novel-write-lock.js'
import * as manuscript from '../../api/lib/agent/manuscript-scope.js'
import * as retirements from '../../api/lib/agent/cancelled-review-recovery.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import type { ContinuityReport, ContinuityOpinion } from '../../api/lib/agent/continuity-review.js'

/** Unit storage fixture for the current shared runner. It has no retired
 * reservation/phase runner, provider, database connection or receipt writer. */
export function currentContinuityRunnerFixture() {
  vi.spyOn(retirements, 'readRetiredReviewUsageIds').mockResolvedValue(new Set())
  const chapter = { id: 'chapter', authorId: 'owner', novelId: 'novel', title: '本章', revision: 5, content: '她把账簿放在桌上。账中总额是三十四万元。', orderIndex: 4 }
  const previous = [{ id: 'previous', title: '前章', revision: 2, content: '她带着账簿离开仓库。', orderIndex: 3 }]
  const compilation = { id: 'compilation', userId: 'owner', novelId: 'novel', runId: 'run', chapterId: chapter.id, status: 'active',
    validation: {} as Record<string, unknown>, preparedContext: {} as Record<string, unknown> }
  const artifacts = new Map<string, Record<string, unknown>>(), fees: Array<Record<string, unknown>> = [], operations: unknown[] = []
  vi.spyOn(original, 'readOriginalTaskRequest').mockImplementation(async (_db, ctx) => ({ taskId: ctx.runId === 'run' ? 'task' : 'another-task', prompt: '检查并修复第一章', spec: null, sourceRunId: ctx.runId, parentRunId: null }))
  vi.spyOn(original, 'originalTaskRunIds').mockImplementation(async (_db, ctx) => [ctx.runId])
  vi.spyOn(humanity, 'resolveQualityChapterTarget').mockImplementation(async args => args.chapterId ?? chapter.id)
  vi.spyOn(humanity, 'qualityCompilationScope').mockImplementation(async (_db, _user, _novel, runId) => ({ runId }))
  vi.spyOn(locks, 'lockNovelActiveScope').mockResolvedValue(undefined)
  vi.spyOn(manuscript, 'assertAgentManuscriptCurrent').mockResolvedValue(undefined)
  vi.spyOn(prisma.chapter, 'findFirst').mockImplementation(async args => args?.where?.id === chapter.id && args.where.authorId === chapter.authorId ? { ...chapter } as never : null)
  vi.spyOn(prisma.chapter, 'findMany').mockImplementation(async () => structuredClone(previous) as never)
  vi.spyOn(prisma.storyCompilation, 'findFirst').mockImplementation(async args => args?.where?.userId === compilation.userId && args.where.novelId === compilation.novelId
    && args.where.runId === compilation.runId && (!args.where.id || args.where.id === compilation.id) && args.where.chapterId === chapter.id ? { ...compilation } as never : null)
  vi.spyOn(prisma.storyCompilation, 'findUniqueOrThrow').mockImplementation(async () => ({ ...compilation } as never))
  const bind = vi.spyOn(prisma.storyCompilation, 'update').mockImplementation(async ({ data }) => { Object.assign(compilation, data); return { ...compilation } as never })
  vi.spyOn(prisma.agentArtifact, 'findUnique').mockImplementation(async ({ where }) => artifacts.get(where.id!) as never ?? null)
  const history = vi.spyOn(prisma.agentArtifact, 'findMany').mockResolvedValue([])
  vi.spyOn(prisma.agentArtifact, 'create').mockImplementation(async ({ data }) => { const row = { ...data, updatedAt: new Date() }; artifacts.set(data.id!, row); return row as never })
  vi.spyOn(prisma.agentArtifact, 'update').mockImplementation(async ({ where, data }) => { const row = { ...artifacts.get(where.id!), ...data, updatedAt: new Date() }; artifacts.set(where.id!, row); return row as never })
  vi.spyOn(prisma.aiUsageLog, 'findMany').mockImplementation(async () => fees as never)
  vi.spyOn(prisma.agentOperation, 'findMany').mockImplementation(async () => operations as never)
  vi.spyOn(prisma.agentSession, 'findUnique').mockResolvedValue({ sandboxMode: 'workspace', toolPolicy: { contentWrite: 'allow' } } as never)
  vi.spyOn(prisma.creditLedgerEntry, 'findUnique').mockResolvedValue(null)
  vi.spyOn(prisma.agentRunEvent, 'findFirst').mockResolvedValue(null)
  vi.spyOn(prisma, '$transaction').mockImplementation(async work => typeof work === 'function' ? work(prisma) : Promise.all(work) as never)
  const controller = new AbortController()
  const ctx: ToolContext = { userId: 'owner', novelId: 'novel', runId: 'run', sessionId: 'session', chapterId: chapter.id, callId: 'call', mode: 'build', creativeFreedom: 'stable',
    qualityMode: 'premium', signal: controller.signal, emit: () => {} }
  const requests: Array<{ system: string; content: string; action: string }> = []
  const dispatch = (answer: (request: { system: string; content: string; action: string }) => string | Promise<string>) => async (request: { system: string; content: string; action: string }) => {
    requests.push(request)
    const fee = { id: 'fee-' + requests.length, usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0 }
    fees.push(fee)
    return { content: await answer(request), usageIds: [fee.id], billingKnown: true }
  }
  const report = () => (Array.from(artifacts.values()).at(-1)!.metadata as { continuityReport: ContinuityReport }).continuityReport
  const opinion = (text = chapter.content, severity: 'error' | 'warning' = 'warning'): ContinuityOpinion => ({ signal: 'object', severity,
    explanation: '账簿仍在人物手中，衔接细节需要核对。', suggestion: '核对当前具体动作，保留没有实际冲突的正文。', evidence: [{ sourceId: buildQualityEvidenceSources({ userId: ctx.userId, novelId: ctx.novelId,
      chapterId: chapter.id, chapterRevision: chapter.revision }, text).entries[0].id.slice(0, 13) }] })
  return { chapter, previous, compilation, artifacts, fees, operations, bind, history, ctx, controller, requests, dispatch, report, opinion }
}
