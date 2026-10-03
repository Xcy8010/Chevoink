import type { AgentGoal, Prisma } from '@prisma/client'
import { runtimeJson } from './runtime-common.js'

const LIMIT = 20
type SavedProgressEntry = {
  kind: 'chapter' | 'plan' | 'report' | 'import' | 'cover'
  id: string
  sourceRevision: number
  runId?: string
  verification: 'current' | 'changed' | 'unavailable' | 'historical_commit'
  requiresRevalidation: true
  title?: string
  currentRevision?: number
  committedRevision?: number | null
  provenanceHash?: string
}

/** Navigation provenance only; old revisions never receive current completion credit. */
export async function readGoalSavedProgress(tx: Prisma.TransactionClient, goal: Pick<AgentGoal, 'id' | 'userId' | 'novelId' | 'currentRevision'>) {
  const empty = { completionCredit: false as const, entries: [] as SavedProgressEntry[], truncated: false }
  if (goal.currentRevision <= 1) return empty
  const executions = await tx.agentGoalExecution.findMany({
    where: { goalId: goal.id, goalRevision: { lt: goal.currentRevision }, goal: { userId: goal.userId, novelId: goal.novelId },
      run: { userId: goal.userId, novelId: goal.novelId } },
    select: { runId: true, goalRevision: true }, orderBy: [{ goalRevision: 'desc' }, { continuationIndex: 'desc' }, { id: 'desc' }], take: LIMIT + 1,
  })
  const sources = new Map(executions.slice(0, LIMIT).map(row => [row.runId, row.goalRevision]))
  const runIds = [...sources.keys()]
  const [compilations, artifacts, imports, covers, novel] = await Promise.all([
    tx.storyCompilation.findMany({ where: { userId: goal.userId, novelId: goal.novelId, runId: { in: runIds }, status: 'completed', bridge: { committedAt: { not: null } } },
      select: { id: true, runId: true, chapterId: true, bridge: { select: { toChapterId: true, targetRevision: true } },
        chapter: { select: { id: true, authorId: true, novelId: true, archivedAt: true, title: true, revision: true, content: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: LIMIT + 1 }),
    tx.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId: goal.userId, novelId: goal.novelId }, artifactType: { in: ['chapterPlan', 'researchReport'] } },
      select: { id: true, runId: true, artifactType: true, title: true, content: true, metadata: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: LIMIT + 1 }),
    tx.novelImportJob.findMany({ where: { userId: goal.userId, novelId: goal.novelId, agentRunId: { in: runIds }, status: 'succeeded', commit: { isNot: null } },
      select: { id: true, agentRunId: true, commit: { select: { jobId: true } } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: LIMIT + 1 }),
    tx.agentGoalEvidence.findMany({ where: { goalId: goal.id, revision: { lt: goal.currentRevision }, criterionId: 'cover-applied', status: 'verified', targetId: { not: null },
      goal: { userId: goal.userId, novelId: goal.novelId } }, select: { revision: true, targetId: true }, orderBy: { revision: 'desc' }, take: LIMIT + 1 }),
    tx.novel.findFirst({ where: { id: goal.novelId, authorId: goal.userId }, select: { coverAssetId: true } }),
  ])
  if (!novel) return empty
  const entries: SavedProgressEntry[] = []
  for (const row of compilations.slice(0, LIMIT)) {
    const sourceRevision = row.runId ? sources.get(row.runId) : undefined
    if (sourceRevision === undefined) continue
    const chapter = row.chapter
    const owned = chapter?.authorId === goal.userId && chapter.novelId === goal.novelId
    const available = owned && !chapter.archivedAt && Boolean(chapter.content.trim())
    const current = available && row.bridge?.toChapterId === chapter.id && row.bridge.targetRevision === chapter.revision
    entries.push({ kind: 'chapter', id: row.chapterId ?? row.id, sourceRevision, runId: row.runId!, requiresRevalidation: true,
      verification: !available ? 'unavailable' : current ? 'current' : 'changed',
      ...(owned ? { title: chapter.title.slice(0, 160), currentRevision: chapter.revision, committedRevision: row.bridge?.targetRevision ?? null,
        provenanceHash: runtimeJson({ content: chapter.content }).hash } : {}) })
  }
  for (const row of artifacts.slice(0, LIMIT)) {
    const sourceRevision = sources.get(row.runId)
    if (sourceRevision === undefined) continue
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
    const saved = Boolean(row.content.trim()) && (row.artifactType === 'researchReport' || metadata.savedAsPlan === true && metadata.todoList !== true)
    entries.push({ kind: row.artifactType === 'chapterPlan' ? 'plan' : 'report', id: row.id, sourceRevision, runId: row.runId,
      verification: saved ? 'current' : 'unavailable', requiresRevalidation: true, title: row.title.slice(0, 160), provenanceHash: runtimeJson({ content: row.content }).hash })
  }
  for (const row of imports.slice(0, LIMIT)) {
    const sourceRevision = row.agentRunId ? sources.get(row.agentRunId) : undefined
    if (sourceRevision !== undefined && row.commit?.jobId === row.id) entries.push({ kind: 'import', id: row.id, sourceRevision,
      runId: row.agentRunId!, verification: 'historical_commit', requiresRevalidation: true })
  }
  for (const row of covers.slice(0, LIMIT)) if (row.targetId) entries.push({ kind: 'cover', id: row.targetId, sourceRevision: row.revision,
    verification: novel.coverAssetId === row.targetId ? 'current' : 'changed', requiresRevalidation: true })
  return { completionCredit: false as const, entries,
    truncated: [executions, compilations, artifacts, imports, covers].some(rows => rows.length > LIMIT) }
}
