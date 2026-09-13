import { createHash } from 'node:crypto'

import type { Prisma, ProjectMemoryType, StoryMemoryLayer, StoryMemoryStatus, EntityRelation, StoryEvent } from '@prisma/client'
import { z } from 'zod'

import type { MemoryEvidence, MemoryGraph, MemorySearchHit } from '../../../shared/contracts/index.js'
import { generateTextCompletion } from '../ai-service.js'
import { getAuxiliaryModelRuntime } from '../credits.js'
import { DataAccessError, prisma } from '../prisma.js'
import { activeChapterScope, activeVolumeWhere } from '../data/internal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { memoryGraphProposalSchema, projectReviewedMemoryGraph, type MemoryGraphProposal } from './memory-graph-proposal.js'

type EvidenceInput = {
  sourceType: MemoryEvidence['sourceType']
  sourceId: string
  revision?: number
  span?: { start: number; end: number; quoteHash?: string }
  confidence: number
}

type SaveMemoryInput = {
  userId: string
  novelId: string
  runId?: string | null
  sourceChapterId?: string | null
  memoryType: ProjectMemoryType
  layer: StoryMemoryLayer
  title: string
  content: string
  importance: number
  confidence: number
  status: StoryMemoryStatus
  evidence: EvidenceInput
  /** 定向修订：传原卡片 id 时就地覆盖，不走同名匹配与冲突箱（作者明确改设定时的主路径） */
  memoryId?: string | null
  /** 作者确认式覆盖：同名旧卡直接就地替换，不进冲突审核箱 */
  overwrite?: boolean
  /** Server-only: model output is a proposal, not author confirmation. */
  agentGenerated?: boolean
  /** Deterministic server projections only; never accepted from tool arguments. */
  systemDerived?: boolean
  graphProposal?: MemoryGraphProposal
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/\s+/g, '')
}

/** 显示层映射：Agent 把章节/卷 ID 写进标题（如「章节:cmxxx」「卷:cmxxx」）时替换为真实名称，避免记忆中心显示一串码 */
function displayMemoryTitle(title: string, chapterTitles: Map<string, string>, volumeTitles: Map<string, string>): string {
  const trimmed = title.trim()
  const chapterMatch = /^(?:章节|chapter)[:：]\s*(.+)$/i.exec(trimmed)
  if (chapterMatch) return chapterTitles.get(chapterMatch[1].trim()) ?? title
  const volumeMatch = /^(?:卷|volume)[:：]\s*(.+)$/i.exec(trimmed)
  if (volumeMatch) return volumeTitles.get(volumeMatch[1].trim()) ?? title
  return title
}

function tokens(value: string): string[] {
  const text = normalize(value)
  const result = new Set<string>()
  for (const word of value.toLocaleLowerCase('zh-CN').match(/[a-z0-9_]+|[\u4e00-\u9fff]{1,6}/g) ?? []) result.add(word)
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2))
  return [...result]
}

function hashVector(value: string, size = 64): number[] {
  const vector = Array<number>(size).fill(0)
  for (const token of tokens(value)) {
    const digest = createHash('sha256').update(token).digest()
    const index = digest.readUInt16BE(0) % size
    vector[index] += digest[2] % 2 === 0 ? 1 : -1
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1
  return vector.map((item) => item / norm)
}

function cosine(left: number[], right: number[]): number {
  return left.reduce((sum, item, index) => sum + item * (right[index] ?? 0), 0)
}

function lexicalScore(query: string, text: string): number {
  const queryTokens = tokens(query)
  const target = new Set(tokens(text))
  if (!queryTokens.length) return 0
  const overlap = queryTokens.filter((token) => target.has(token)).length / queryTokens.length
  const exact = normalize(text).includes(normalize(query)) ? 1 : 0
  return overlap * 0.65 + exact * 0.35
}

function evidenceRecord(record: {
  id: string; memoryId: string; sourceType: string; sourceId: string; revision: number | null
  spanStart: number | null; spanEnd: number | null; quoteHash: string | null; confidence: number; createdAt: Date
}): MemoryEvidence {
  return {
    id: record.id, memoryId: record.memoryId, sourceType: record.sourceType as MemoryEvidence['sourceType'],
    sourceId: record.sourceId, ...(record.revision ? { revision: record.revision } : {}),
    ...(record.spanStart !== null && record.spanEnd !== null
      ? { span: { start: record.spanStart, end: record.spanEnd, ...(record.quoteHash ? { quoteHash: record.quoteHash } : {}) } }
      : {}),
    confidence: record.confidence, createdAt: record.createdAt.toISOString(),
  }
}

async function addEvidence(memoryId: string, evidence: EvidenceInput, db: Prisma.TransactionClient = prisma) {
  const exists = await db.memoryEvidence.findFirst({
    where: { memoryId, sourceType: evidence.sourceType, sourceId: evidence.sourceId, revision: evidence.revision ?? null },
  })
  if (exists) return
  await db.memoryEvidence.create({
    data: {
      memoryId, sourceType: evidence.sourceType, sourceId: evidence.sourceId, revision: evidence.revision,
      spanStart: evidence.span?.start, spanEnd: evidence.span?.end, quoteHash: evidence.span?.quoteHash,
      confidence: evidence.confidence,
    },
  })
}

export async function saveStoryMemory(input: SaveMemoryInput, transaction?: Prisma.TransactionClient): Promise<{ id: string; action: 'created' | 'updated' | 'conflict'; status: StoryMemoryStatus }> {
  if (!transaction) return prisma.$transaction(tx => saveStoryMemory(input, tx))
  const db = transaction
  await lockNovelActiveScope(db, input.novelId)
  if (input.runId) await assertAgentManuscriptCurrent(db, { userId: input.userId, novelId: input.novelId, runId: input.runId })
  const novel = await db.novel.findFirst({ where: { id: input.novelId, authorId: input.userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权写入记忆。')
  const chapterIds = [...new Set([...(input.sourceChapterId ? [input.sourceChapterId] : []),
    ...(input.evidence.sourceType === 'chapter' ? [input.evidence.sourceId] : [])])]
  for (const id of chapterIds) {
    const source = await db.chapter.findFirst({ where: { id, ...activeChapterScope(input.novelId) }, select: { revision: true } })
    if (!source || (input.evidence.sourceType === 'chapter' && input.evidence.sourceId === id
      && input.evidence.revision !== undefined && source.revision !== input.evidence.revision)) {
      throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '记忆来源章节已归档或变化，未保存旧结果。')
    }
  }
  if (input.evidence.sourceType === 'volume') {
    const source = await db.volume.findFirst({ where: { id: input.evidence.sourceId, novelId: input.novelId, ...activeVolumeWhere }, select: { revision: true } })
    if (!source || (input.evidence.revision !== undefined && source.revision !== input.evidence.revision)) {
      throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '记忆来源卷已归档或变化，未保存旧结果。')
    }
  }
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:${input.novelId}`}, 0))::text`
  const title = input.title.trim()
  const content = input.content.trim()
  const deleted = await db.projectMemoryEntry.findFirst({ where: { novelId: input.novelId,
    memoryType: input.memoryType, title, status: 'invalid', revisions: { some: { reason: 'author_delete' } } } })
  if (deleted) {
    if (input.systemDerived) return { id: deleted.id, action: 'updated', status: 'invalid' }
    throw new DataAccessError(409, 'MEMORY_DELETED', '作者已删除此记忆，不得自动重建；请使用原文并向作者核对。')
  }
  // A supplied ID must never silently become a new card or resurrect a deleted card.
  const target = input.memoryId ? await db.projectMemoryEntry.findFirst({ where: { id: input.memoryId, novelId: input.novelId } }) : null
  if (input.memoryId && (!target || ['invalid', 'superseded'].includes(target.status))) {
    throw new DataAccessError(409, 'MEMORY_TARGET_MISSING', '原卡片不存在或已删除/失效，未覆盖也未新建。')
  }
  if (input.agentGenerated) {
    const canonicalTitle = target?.title ?? title
    const baseline = target ?? await db.projectMemoryEntry.findFirst({ where: { novelId: input.novelId,
      memoryType: input.memoryType, title: canonicalTitle, status: { in: ['confirmed', 'inferred'] }, reviewStatus: { in: ['none', 'accepted'] } } })
    const duplicate = await db.projectMemoryEntry.findFirst({ where: { novelId: input.novelId,
      memoryType: input.memoryType, title: canonicalTitle, content, status: { notIn: ['invalid', 'superseded'] } } })
    if (duplicate) return { id: duplicate.id, action: duplicate.reviewStatus === 'pending' ? 'conflict' : 'updated', status: duplicate.status }
    const candidate = await db.projectMemoryEntry.create({ data: {
      novelId: input.novelId, runId: input.runId, sourceChapterId: input.sourceChapterId,
      memoryType: input.memoryType, layer: input.layer, title: canonicalTitle, content,
      importance: input.importance, confidence: Math.min(input.confidence, 0.8),
      status: 'inferred', reviewStatus: 'pending', embedding: hashVector(`${canonicalTitle}\n${content}`),
      ...(input.graphProposal ? { graphProposal: { title: canonicalTitle, content, proposal: memoryGraphProposalSchema.parse(input.graphProposal) } } : {}),
    } })
    await addEvidence(candidate.id, input.evidence, db)
    if (baseline) await db.memoryRevision.create({ data: { memoryId: candidate.id, before: baseline.content, after: content,
      reason: `agent_proposal@${baseline.version}`, supersededBy: baseline.id } })
    return { id: candidate.id, action: 'conflict', status: 'inferred' }
  }

  // 定向修订：作者/Agent 明确指定原卡片 id 时就地覆盖（记录修订历史），避免同名卡泛滥
  if (input.memoryId) {
    const target = await db.projectMemoryEntry.findFirst({ where: { id: input.memoryId, novelId: input.novelId } })
    if (target) {
      if (normalize(target.content) !== normalize(content) || target.title !== title) {
        await Promise.all([
          db.memoryRevision.create({ data: { memoryId: target.id, before: target.content, after: content, reason: 'targeted_update' } }),
          db.projectMemoryEntry.update({
            where: { id: target.id },
            data: {
              title, content, importance: input.importance, confidence: input.confidence, status: input.status,
              reviewStatus: 'none', runId: input.runId ?? target.runId, sourceChapterId: input.sourceChapterId ?? target.sourceChapterId,
              version: { increment: 1 }, embedding: hashVector(`${title}\n${content}`),
            },
          }),
        ])
      }
      await addEvidence(target.id, input.evidence, db)
      return { id: target.id, action: 'updated', status: input.status }
    }
  }

  const existing = await db.projectMemoryEntry.findFirst({
    where: { novelId: input.novelId, memoryType: input.memoryType, title, status: { notIn: ['superseded', 'invalid'] } },
    orderBy: { updatedAt: 'desc' },
    include: { evidence: { where: { sourceType: input.evidence.sourceType, sourceId: input.evidence.sourceId }, take: 1 } },
  })

  if (!existing) {
    const created = await db.projectMemoryEntry.create({
      data: {
        novelId: input.novelId, runId: input.runId, sourceChapterId: input.sourceChapterId,
        memoryType: input.memoryType, layer: input.layer, title, content, importance: input.importance,
        confidence: input.confidence, status: input.status,
        reviewStatus: input.status === 'conflicted' ? 'pending' : 'none', embedding: hashVector(`${title}\n${content}`),
      },
    })
    await addEvidence(created.id, input.evidence, db)
    if (input.memoryType === 'characterCard') {
      const entity = await db.storyEntity.upsert({
        where: { novelId_entityType_canonicalName: { novelId: input.novelId, entityType: 'character', canonicalName: title } },
        create: { novelId: input.novelId, entityType: 'character', canonicalName: title, description: content, status: input.status },
        update: { description: content, status: input.status },
      })
      await db.entityAlias.upsert({
        where: { entityId_alias: { entityId: entity.id, alias: title } },
        create: { entityId: entity.id, alias: title, sourceId: input.evidence.sourceId }, update: {},
      })
    }
    return { id: created.id, action: 'created', status: created.status }
  }

  if (normalize(existing.content) === normalize(content)) {
    await addEvidence(existing.id, input.evidence, db)
    return { id: existing.id, action: 'updated', status: existing.status }
  }

  const authorEdited = await db.memoryRevision.findFirst({ where: { memoryId: existing.id, reason: 'author_edit' } })
  const sameVersionedSource = !authorEdited && (input.systemDerived && existing.evidence.length > 0 || input.evidence.revision !== undefined
    && existing.evidence.some((evidence) => evidence.revision !== null && input.evidence.revision! > evidence.revision))
  // overwrite=true：作者确认式覆盖（改设定场景），同名旧卡就地替换而不是再建一张进审核箱
  const canReplace = !authorEdited && (sameVersionedSource || input.overwrite === true || existing.status === 'inferred' && input.status === 'confirmed')
  if (canReplace) {
    await Promise.all([
      db.memoryRevision.create({ data: { memoryId: existing.id, before: existing.content, after: content, reason: input.overwrite === true ? 'author_overwrite' : sameVersionedSource ? 'source_revision_advanced' : 'author_confirmation' } }),
      db.projectMemoryEntry.update({
        where: { id: existing.id },
        data: {
          content, importance: input.importance, confidence: input.confidence, status: input.status,
          reviewStatus: 'none', runId: input.runId, sourceChapterId: input.sourceChapterId,
          version: { increment: 1 }, embedding: hashVector(`${title}\n${content}`),
        },
      }),
    ])
    await addEvidence(existing.id, input.evidence, db)
    return { id: existing.id, action: 'updated', status: input.status }
  }

  const conflict = await db.projectMemoryEntry.create({
    data: {
      novelId: input.novelId, runId: input.runId, sourceChapterId: input.sourceChapterId,
      memoryType: input.memoryType, layer: input.layer, title, content, importance: input.importance,
      confidence: input.confidence, status: 'conflicted', reviewStatus: 'pending', embedding: hashVector(`${title}\n${content}`),
    },
  })
  await Promise.all([
    addEvidence(conflict.id, input.evidence, db),
    db.memoryRevision.create({ data: { memoryId: existing.id, before: existing.content, after: content, reason: `conflict_candidate:${conflict.id}` } }),
  ])
  return { id: conflict.id, action: 'conflict', status: 'conflicted' }
}

export async function searchStoryMemory(input: {
  userId: string; novelId: string; query: string; memoryType?: ProjectMemoryType; limit?: number
}, transaction?: Prisma.TransactionClient): Promise<MemorySearchHit[]> {
  const db = transaction ?? prisma
  const novel = await db.novel.findFirst({ where: { id: input.novelId, authorId: input.userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权检索记忆。')
  const [entries, graphEntities] = await Promise.all([
    db.projectMemoryEntry.findMany({
      where: {
        novelId: input.novelId, status: { in: ['confirmed', 'inferred'] }, reviewStatus: { in: ['none', 'accepted'] },
        OR: [{ sourceChapterId: null }, { sourceChapter: activeChapterScope(input.novelId) }],
        ...(input.memoryType ? { memoryType: input.memoryType } : {}),
      },
      include: { evidence: { orderBy: { createdAt: 'desc' }, take: 8 } },
      orderBy: { updatedAt: 'desc' }, take: 2000,
    }),
    db.storyEntity.findMany({
      where: {
        novelId: input.novelId,
        status: { in: ['confirmed', 'inferred'] },
        OR: [{ canonicalName: { contains: input.query, mode: 'insensitive' } }, { aliases: { some: { alias: { contains: input.query, mode: 'insensitive' } } } }],
      },
      include: { aliases: true,
        relationsFrom: { where: { OR: [{ revision: null }, { revision: { gte: 0 } }] }, include: { toEntity: true } },
        relationsTo: { where: { OR: [{ revision: null }, { revision: { gte: 0 } }] }, include: { fromEntity: true } } },
      take: 20,
    }),
  ])
  const queryVector = hashVector(input.query)
  const graphTerms = new Set(graphEntities.flatMap((entity) => [
    entity.canonicalName, ...entity.aliases.map((item) => item.alias),
    ...entity.relationsFrom.map((item) => item.toEntity.canonicalName),
    ...entity.relationsTo.map((item) => item.fromEntity.canonicalName),
  ]))
  const raw = entries.map((entry) => {
    const text = `${entry.title}\n${entry.content}`
    const stored = Array.isArray(entry.embedding) ? entry.embedding.filter((item): item is number => typeof item === 'number') : []
    const semantic = Math.max(0, cosine(queryVector, stored.length ? stored : hashVector(text)))
    const lexical = lexicalScore(input.query, text)
    const graph = [...graphTerms].some((term) => normalize(text).includes(normalize(term))) ? 1 : 0
    return { entry, lexical, semantic, graph, importance: entry.importance / 100 }
  })
  const ranks = (selector: (item: typeof raw[number]) => number) => new Map(
    [...raw].sort((left, right) => selector(right) - selector(left)).map((item, index) => [item.entry.id, index + 1]),
  )
  const lexicalRanks = ranks((item) => item.lexical)
  const semanticRanks = ranks((item) => item.semantic)
  const graphRanks = ranks((item) => item.graph)
  const importanceRanks = ranks((item) => item.importance)
  return raw
    .map((item) => ({
      id: item.entry.id, memoryType: item.entry.memoryType, layer: item.entry.layer, status: item.entry.status,
      title: item.entry.title, content: item.entry.content,
      score:
        0.4 / (60 + lexicalRanks.get(item.entry.id)!) +
        0.35 / (60 + semanticRanks.get(item.entry.id)!) +
        0.15 / (60 + graphRanks.get(item.entry.id)!) +
        0.1 / (60 + importanceRanks.get(item.entry.id)!) +
        // RRF 保证多路稳定融合；原始相关度作为强精确命中的破平项，避免百章同权重时被时间顺序淹没。
        item.lexical * 0.02 + item.semantic * 0.005 + item.graph * 0.01,
      lexicalScore: item.lexical, semanticScore: item.semantic, graphScore: item.graph,
      evidence: item.entry.evidence.map(evidenceRecord),
    }))
    .filter((item) => item.lexicalScore > 0 || item.semanticScore > 0.15 || item.graphScore > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 8)
}

export async function enqueueChapterMemoryExtraction(input: {
  novelId: string; chapterId: string; chapterRevision: number; before: string; after: string
}, transaction?: Prisma.TransactionClient) {
  const job = await (transaction ?? prisma).memoryExtractionJob.upsert({
    where: { idempotencyKey: `${input.chapterId}:${input.chapterRevision}` },
    create: {
      novelId: input.novelId, chapterId: input.chapterId, chapterRevision: input.chapterRevision,
      idempotencyKey: `${input.chapterId}:${input.chapterRevision}`,
      diff: { beforeHash: createHash('sha256').update(input.before).digest('hex'), after: input.after },
    },
    update: {},
  })
  // A transaction caller must schedule after commit, never before its revision is visible.
  if (!transaction) queueMicrotask(() => void processMemoryExtractionJob(job.id).catch(() => {}))
  return job.id
}

export async function processMemoryExtractionJob(jobId: string): Promise<void> {
  let claimed = false
  try {
    await prisma.$transaction(async tx => {
      const owner = await tx.memoryExtractionJob.findUnique({ where: { id: jobId }, select: { novelId: true } })
      if (!owner) return
      await lockNovelActiveScope(tx, owner.novelId)
      await tx.$queryRaw`SELECT id FROM memory_extraction_jobs WHERE id = ${jobId} FOR UPDATE`
      const job = await tx.memoryExtractionJob.findUnique({ where: { id: jobId } })
      if (!job || job.diff && typeof job.diff === 'object' && !Array.isArray(job.diff) && job.diff.durableTaskRootId) return
      const claim = await tx.memoryExtractionJob.updateMany({
        where: { id: jobId, OR: [{ status: 'pending' }, { status: 'failed', leaseUntil: { lt: new Date() } }] },
        data: { status: 'processing', leaseUntil: new Date(Date.now() + 60_000), attempts: { increment: 1 }, errorMessage: null },
      })
      if (!claim.count) return
      claimed = true
      await applyMemoryExtractionJob(tx, jobId)
    }, { timeout: 10000 })
  } catch (error) {
    if (claimed) await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM memory_extraction_jobs WHERE id = ${jobId} FOR UPDATE`
      const job = await tx.memoryExtractionJob.findUnique({ where: { id: jobId } })
      if (!job || job.status === 'completed' || job.diff && typeof job.diff === 'object' && !Array.isArray(job.diff) && job.diff.durableTaskRootId) return
      await tx.memoryExtractionJob.update({ where: { id: jobId }, data: { status: 'failed',
        attempts: { increment: 1 }, leaseUntil: new Date(Date.now() + 30_000), errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'unknown_error' } })
    }).catch(() => {})
    throw error
  }
}

/** DB-only derived writes. Caller owns the transaction and, for durable work,
 * holds the task lease for the whole application and receipt commit. */
export async function applyMemoryExtractionJob(tx: Prisma.TransactionClient, jobId: string, scope?: { userId: string; novelId: string; runId: string; taskRootId: string }): Promise<{ status: 'applied' | 'stale'; memoryIds: string[] }> {
    const job = await tx.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })
    if (scope && job.novelId !== scope.novelId || job.diff && typeof job.diff === 'object' && !Array.isArray(job.diff)
      && job.diff.durableTaskRootId && job.diff.durableTaskRootId !== scope?.taskRootId) throw new DataAccessError(409, 'MEMORY_JOB_SOURCE_MISMATCH', '记忆任务需要原持久任务控制权。')
    await lockNovelActiveScope(tx, job.novelId)
    const chapter = await tx.chapter.findFirst({
      where: { id: job.chapterId, ...activeChapterScope(job.novelId) }, include: { novel: { select: { authorId: true } }, volume: { select: { id: true, title: true, revision: true } } },
    })
    if (!chapter || chapter.revision !== job.chapterRevision) {
      await tx.memoryExtractionJob.update({ where: { id: jobId }, data: { status: 'completed', errorMessage: 'stale_revision_skipped', leaseUntil: null } })
      return { status: 'stale', memoryIds: [] }
    }
    if (scope && (job.novelId !== scope.novelId || chapter.novelId !== scope.novelId || chapter.novel.authorId !== scope.userId
      || !job.diff || typeof job.diff !== 'object' || Array.isArray(job.diff) || job.diff.after !== chapter.content)) {
      throw new DataAccessError(409, 'MEMORY_JOB_SOURCE_MISMATCH', '记忆任务与原正文来源不一致。')
    }
    const clean = chapter.content.replace(/\s+/g, ' ').trim()
    const summary = clean.length <= 360 ? clean : `${clean.slice(0, 240)}……${clean.slice(-100)}`
    const chapterMemory = await saveStoryMemory({
      userId: chapter.novel.authorId, novelId: chapter.novelId, runId: scope?.runId, sourceChapterId: chapter.id,
      memoryType: 'chapterSummary', layer: 'L2', title: `章节:${chapter.id}`, content: `${chapter.title}：${summary || '暂无正文'}`,
      importance: 65, confidence: 0.98, status: 'inferred', systemDerived: true,
      evidence: { sourceType: 'chapter', sourceId: chapter.id, revision: chapter.revision, span: { start: 0, end: chapter.content.length, quoteHash: createHash('sha256').update(chapter.content).digest('hex') }, confidence: 1 },
    }, tx)
    const volumeMemories = await tx.projectMemoryEntry.findMany({
      where: { novelId: chapter.novelId, memoryType: 'chapterSummary', status: { in: ['confirmed', 'inferred'] }, reviewStatus: { in: ['none', 'accepted'] }, sourceChapter: { volumeId: chapter.volumeId, ...activeChapterScope(chapter.novelId) } },
      orderBy: { sourceChapter: { orderInVolume: 'asc' } }, take: 100, select: { content: true },
    })
    const volumeMemory = await saveStoryMemory({
      userId: chapter.novel.authorId, novelId: chapter.novelId, runId: scope?.runId, memoryType: 'volumeSummary', layer: 'L2',
      title: `卷:${chapter.volumeId}`, content: `${chapter.volume.title}：${volumeMemories.map((item) => item.content).join('；').slice(0, 4000)}`,
      importance: 75, confidence: 0.9, status: 'inferred', systemDerived: true,
      evidence: { sourceType: 'volume', sourceId: chapter.volumeId, revision: chapter.volume.revision, confidence: 0.9 },
    }, tx)
    const coreMemories = await tx.projectMemoryEntry.findMany({
      where: {
        novelId: chapter.novelId, status: 'confirmed', reviewStatus: { in: ['none', 'accepted'] },
        memoryType: { in: ['worldbuilding', 'characterCard', 'timelineEvent', 'foreshadowing', 'continuityRule', 'relationshipState'] },
      },
      orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }], take: 40,
      select: { memoryType: true, title: true, content: true },
    })
    const memoryIds = [chapterMemory.id, volumeMemory.id]
    if (coreMemories.length > 0) {
      const bible = await saveStoryMemory({
        userId: chapter.novel.authorId, novelId: chapter.novelId, runId: scope?.runId, memoryType: 'storyBible', layer: 'L3',
        title: '故事圣经（系统增量）',
        content: coreMemories.map((item) => `[${item.memoryType}] ${item.title}：${item.content}`).join('\n').slice(0, 12000),
        importance: 95, confidence: 1, status: 'inferred', systemDerived: true,
        evidence: { sourceType: 'artifact', sourceId: `story-bible:${chapter.novelId}`, confidence: 1 },
      }, tx)
      memoryIds.push(bible.id)
    }
    await tx.memoryExtractionJob.update({ where: { id: jobId }, data: { status: 'completed', leaseUntil: null, errorMessage: `memory:${chapterMemory.id}` } })
    return { status: 'applied', memoryIds }
}

const MEMORY_GRAPH_REFRESH_COOLDOWN_MS = 10 * 60 * 1000
const AI_GRAPH_DESCRIPTION_PREFIX = '[AI关系网] '
const AI_GRAPH_CHUNK_CHARS = 16_000
const AI_GRAPH_MAX_CHUNK_CONCURRENCY = 3
const AI_GRAPH_CHAPTER_WINDOW_CHARS = 12_000
const AI_GRAPH_MAX_CHAPTERS = 400

const aiGraphEnvelopeSchema = z.object({
  entities: z.array(z.object({
    type: z.enum(['character', 'location', 'organization', 'item', 'event', 'concept']),
    name: z.string().min(1).max(128),
    aliases: z.array(z.string().min(1).max(128)).max(12).default([]),
    description: z.string().max(1200).default(''),
  })).max(80),
  relations: z.array(z.object({
    from: z.string().min(1).max(128),
    to: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    state: z.string().max(800).default(''),
    confidence: z.number().min(0).max(1).default(0.8),
  })).max(180),
})

function parseJsonObject(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1] ?? raw
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  return JSON.parse(start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced)
}

function normalizedEntityKey(value: string) {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s·•._—-]+/g, '').replace(/[「」“”'‘’（）()]/g, '')
}

function isUsefulEntityName(type: string, value: string) {
  const name = value.trim()
  if (!name || name.length > 128) return false
  if (type === 'character' && /^(他|她|它|那人|此人|有人|男人|女人|少年|少女|老人|老者|主角|配角|路人|众人|对方|自己|我|你|您|他们|她们)$/.test(name)) return false
  return !/^(这里|那里|此处|某处|东西|物品|事件|地点|组织|未知|暂无|无)$/.test(name)
}

/**
 * 各块之间的局部关系网合并去重，并把别名/规范名统一索引到同一实体。
 */
type MergedGraphEntity = { name: string; type: string; aliases: Set<string>; description: string }
type MergedGraphRelation = { from: string; to: string; type: string; state: string; confidence: number }
type MergedGraph = { entities: MergedGraphEntity[]; relations: MergedGraphRelation[] }

function mergeGraphEnvelopes(envelopes: Array<z.infer<typeof aiGraphEnvelopeSchema>>): MergedGraph {
  const entityByKey = new Map<string, MergedGraphEntity>()
  const aliasToKey = new Map<string, string>()
  const relations = new Map<string, MergedGraphRelation>()
  const indexAlias = (key: string, names: string[]) => {
    for (const name of names) {
      const aliasKey = normalizedEntityKey(name)
      if (aliasKey && !aliasToKey.has(aliasKey)) aliasToKey.set(aliasKey, key)
    }
  }
  for (const envelope of envelopes) {
    for (const entity of envelope.entities) {
      if (!isUsefulEntityName(entity.type, entity.name)) continue
      const key = normalizedEntityKey(entity.name)
      const existing = entityByKey.get(key)
      if (existing) {
        for (const alias of [...new Set([entity.name, ...entity.aliases.map((item) => item.trim())])].filter(Boolean)) existing.aliases.add(alias)
        indexAlias(key, [entity.name, ...existing.aliases])
        if (!existing.description && entity.description) existing.description = entity.description
      } else {
        const record: MergedGraphEntity = { name: entity.name, type: entity.type, aliases: new Set([entity.name, ...entity.aliases.map((item) => item.trim())].filter(Boolean)), description: entity.description }
        entityByKey.set(key, record)
        indexAlias(key, [...record.aliases])
      }
    }
  }
  for (const envelope of envelopes) {
    for (const relation of envelope.relations) {
      const fromKey = aliasToKey.get(normalizedEntityKey(relation.from))
      const toKey = aliasToKey.get(normalizedEntityKey(relation.to))
      if (!fromKey || !toKey || fromKey === toKey) continue
      const rk = `${fromKey}|${toKey}|${relation.type.trim()}`
      if (!relations.has(rk)) relations.set(rk, { from: entityByKey.get(fromKey)!.name, to: entityByKey.get(toKey)!.name, type: relation.type.trim(), state: relation.state, confidence: relation.confidence })
    }
  }
  return { entities: [...entityByKey.values()], relations: [...relations.values()] }
}

/** 合并后的图按“替换旧 AI 图”语义写库：清旧 AI 实体/关系，再 upsert 实体、别名与关系。 */
async function persistMemoryGraph(tx: Prisma.TransactionClient, novelId: string, merged: MergedGraph, sourceId: string) {
  const stale = await tx.storyEntity.findMany({ where: { novelId, status: 'inferred', description: { startsWith: AI_GRAPH_DESCRIPTION_PREFIX } }, select: { id: true } })
  if (stale.length > 0) await tx.storyEntity.deleteMany({ where: { id: { in: stale.map((item) => item.id) } } })
  await tx.entityRelation.deleteMany({ where: { fromEntity: { novelId }, sourceId: { startsWith: 'ai-graph:' } } })

  const entityByKey = new Map<string, { id: string; canonicalName: string }>()
  for (const item of merged.entities) {
    const canonicalName = item.name.trim()
    // A verified rebuild may revive only this invalidated AI projection, never
    // downgrade an independently confirmed/manual entity's status.
    await tx.storyEntity.updateMany({ where: { novelId, entityType: item.type, canonicalName, status: 'invalid',
      description: { startsWith: AI_GRAPH_DESCRIPTION_PREFIX } }, data: { status: 'inferred' } })
    const entity = await tx.storyEntity.upsert({
      where: { novelId_entityType_canonicalName: { novelId, entityType: item.type, canonicalName } },
      create: { novelId, entityType: item.type, canonicalName, description: `${AI_GRAPH_DESCRIPTION_PREFIX}${item.description}`.trim(), status: 'inferred' },
      update: { description: `${AI_GRAPH_DESCRIPTION_PREFIX}${item.description}`.trim() },
      select: { id: true, canonicalName: true },
    })
    entityByKey.set(normalizedEntityKey(canonicalName), entity)
    for (const alias of [...item.aliases].filter(Boolean)) {
      entityByKey.set(normalizedEntityKey(alias), entity)
      await tx.entityAlias.upsert({ where: { entityId_alias: { entityId: entity.id, alias } }, create: { entityId: entity.id, alias, sourceId }, update: { sourceId } })
    }
  }

  let relationCount = 0
  for (const relation of merged.relations) {
    const from = entityByKey.get(normalizedEntityKey(relation.from))
    const to = entityByKey.get(normalizedEntityKey(relation.to))
    if (!from || !to || from.id === to.id) continue
    const relationType = relation.type.trim()
    const existing = await tx.entityRelation.findFirst({ where: { fromEntityId: from.id, toEntityId: to.id, relationType, validFrom: null }, select: { id: true } })
    if (existing) {
      await tx.entityRelation.update({ where: { id: existing.id }, data: { state: relation.state.trim(), confidence: relation.confidence, sourceId, revision: null } })
    } else {
      await tx.entityRelation.create({ data: { fromEntityId: from.id, toEntityId: to.id, relationType, state: relation.state.trim(), confidence: relation.confidence, sourceId } })
    }
    relationCount += 1
  }
  return relationCount
}

/** 按字符预算把全书正文切块，让每块单次 AI 上下文可控，才能覆盖整个作品且不至于超时。 */
function chunkChapters(chapters: { id: string; title: string; content: string; revision: number; orderIndex: number }[]) {
  const chunks: { context: string }[] = []
  let current: string[] = []
  let currentChars = 0
  for (const chapter of chapters) {
    const text = `【第${chapter.orderIndex}章 ${chapter.title}】\n${chapter.content.slice(0, AI_GRAPH_CHAPTER_WINDOW_CHARS)}`
    if (current.length > 0 && currentChars + text.length > AI_GRAPH_CHUNK_CHARS) {
      chunks.push({ context: current.join('\n\n') })
      current = []
      currentChars = 0
    }
    current.push(text)
    currentChars += text.length
  }
  if (current.length > 0) chunks.push({ context: current.join('\n\n') })
  return chunks
}

function graphChunkPrompt(chunkContext: string, novelContext: string) {
  return {
    system: '你是中文长篇小说的关系网编辑。请从正文建立知识关系网，不只抽人物。实体类型只能是 character/location/organization/item/event/concept。\n严格规则：\n1. 合并同一实体的全名、简称、称谓和错别字到 aliases，禁止把“他/她/那人/众人/主角”等代词或泛称建成实体；禁止把残句、动作和形容词当名字。\n2. 关系必须有正文依据，使用具体中文关系词（亲属、同盟、敌对、隶属、位于、持有、参与、导致、知晓、追求等），不要用“同章出现”。\n3. description/state 只写已发生或明确设定，不推测后续剧情。\n4. 控制密度：只保留影响主线、人物行动、世界规则和伏笔的实体，本块最多 30 个实体、60 条关系。\n只输出 JSON：{"entities":[{"type":"character|location|organization|item|event|concept","name":"规范名","aliases":["别名"],"description":"简洁事实"}],"relations":[{"from":"规范名或别名","to":"规范名或别名","type":"关系","state":"当前状态/依据","confidence":0.0}]}',
    user: `${novelContext}\n\n${chunkContext}`,
  }
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++
      results[index] = await tasks[index]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
  return results
}

/**
 * 分块并发地从全部正文重建整部小说关系网：
 * - 覆盖整个作品（章节不设旧 120 上限、每章窗口放宽到 AI_GRAPH_CHAPTER_WINDOW_CHARS）
 * - 按字符预算切块 + 并发，单次 AI 上下文小，总耗时明显低于旧的单次超大 prompt
 * - onProgress 用于异步任务回写进度
 */
async function buildMemoryGraphOnce(
  userId: string,
  novelId: string,
  force: boolean,
  onProgress?: (done: number, total: number) => void,
) {
  const novel = await prisma.novel.findFirst({
    where: { id: novelId, authorId: userId },
    select: { id: true, title: true, summary: true, categoryName: true, tagNames: true, manuscriptRevision: true },
  })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权更新关系网。')

  // 清理旧规则投影伪实体，避免“林舟知道”被截成“林舟知”等残名残留图上；
  // 若仍有人工/工具确认实体就直接复用；若因此变成空图，才进入一次 AI 重建。
  await prisma.storyEntity.deleteMany({ where: { novelId, status: 'inferred', description: { startsWith: '从正文中自动识别' } } })
  const existingEntityCount = await prisma.storyEntity.count({ where: { novelId } })
  if (!force && existingEntityCount > 0) {
    return { chapterCount: 0, jobCount: 0, entityCount: existingEntityCount, relationCount: await prisma.entityRelation.count({ where: { fromEntity: { novelId } } }), reused: true }
  }
  if (force) {
    const latest = await prisma.aiUsageLog.findFirst({ where: { userId, novelId, action: 'agentMemoryGraphBuild' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
    if (latest && Date.now() - latest.createdAt.getTime() < MEMORY_GRAPH_REFRESH_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((MEMORY_GRAPH_REFRESH_COOLDOWN_MS - (Date.now() - latest.createdAt.getTime())) / 1000)
      throw new DataAccessError(429, 'MEMORY_GRAPH_RATE_LIMITED', `关系网刚刚更新过，请 ${Math.ceil(waitSeconds / 60)} 分钟后再试。`)
    }
  }

  const chapters = await prisma.chapter.findMany({
    where: { ...activeChapterScope(novelId), content: { not: '' } }, orderBy: { orderIndex: 'asc' },
    select: { id: true, title: true, content: true, revision: true, orderIndex: true }, take: AI_GRAPH_MAX_CHAPTERS,
  })
  if (chapters.length === 0) return { chapterCount: 0, jobCount: 0, entityCount: existingEntityCount, relationCount: 0, reused: true }

  const novelContext = `作品：${novel.title}\n简介：${novel.summary || '无'}\n分类：${novel.categoryName || '未设置'}\n标签：${novel.tagNames.join('、') || '无'}`
  const sourceId = `ai-graph:${createHash('sha256').update(chapters.map((chapter) => `${chapter.id}:${chapter.revision}`).join('|')).digest('hex').slice(0, 24)}`
  const chunks = chunkChapters(chapters)
  const modelRuntime = await getAuxiliaryModelRuntime(userId)
  const total = chunks.length
  let done = 0
  onProgress?.(done, total)
  const envelopes = await runWithConcurrency(
    chunks.map((chunk) => async () => {
      try {
        const { system, user } = graphChunkPrompt(chunk.context, novelContext)
        const raw = await generateTextCompletion(
          system,
          user,
          { modelRuntime, userId, novelId, action: 'agentMemoryGraphBuild', targetType: 'novel', targetId: novelId, temperature: 0.1, reasoningEffort: 'low' },
        )
        return aiGraphEnvelopeSchema.parse(parseJsonObject(raw))
      } catch (error) {
        void error
        return null
      } finally {
        done += 1
        onProgress?.(done, total)
      }
    }),
    AI_GRAPH_MAX_CHUNK_CONCURRENCY,
  )
  const valid = envelopes.filter((envelope): envelope is z.infer<typeof aiGraphEnvelopeSchema> => envelope !== null)
  if (valid.length === 0) throw new DataAccessError(502, 'AI_PROVIDER_EMPTY_RESPONSE', '关系网抽取未识别到有效内容，请稍后重试。')

  const merged = mergeGraphEnvelopes(valid)
  const relationCount = await prisma.$transaction(async tx => {
    await lockNovelActiveScope(tx, novelId)
    const current = await tx.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { manuscriptRevision: true } })
    const unchanged = await tx.chapter.count({ where: { ...activeChapterScope(novelId), OR: chapters.map(chapter => ({ id: chapter.id, revision: chapter.revision })) } })
    if (!current || current.manuscriptRevision !== novel.manuscriptRevision || unchanged !== chapters.length) {
      throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '关系网生成期间稿件已导入、恢复或修改，未应用旧模型结果。')
    }
    return persistMemoryGraph(tx, novelId, merged, sourceId)
  })
  return { chapterCount: chapters.length, jobCount: 0, entityCount: merged.entities.length, relationCount, reused: false }
}

/**
 * 手动刷新用的异步任务：启动后立即返回 jobId，前端轮询进度，绝不会让前端等 AI 重建到超时。
 */
type GraphJob = { id: string; novelId: string; status: 'running' | 'completed' | 'failed'; totalChunks: number; doneChunks: number; error?: string }
const memoryGraphJobs = new Map<string, GraphJob>()

export async function startMemoryGraphJob(userId: string, novelId: string, force: boolean): Promise<{ jobId: string; status: GraphJob['status'] }> {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权刷新关系网。')
  for (const job of memoryGraphJobs.values()) {
    if (job.novelId === novelId && job.status === 'running') return { jobId: job.id, status: job.status }
  }
  const job: GraphJob = { id: `${novelId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, novelId, status: 'running', totalChunks: 0, doneChunks: 0 }
  memoryGraphJobs.set(job.id, job)
  void runMemoryGraphJob(job.id, userId, novelId, force)
    .then(() => { const state = memoryGraphJobs.get(job.id); if (state) { state.status = 'completed'; state.doneChunks = state.totalChunks } })
    .catch((error) => { const state = memoryGraphJobs.get(job.id); if (state) { state.status = 'failed'; state.error = error instanceof Error ? error.message.slice(0, 1000) : String(error) } })
  return { jobId: job.id, status: job.status }
}

async function runMemoryGraphJob(jobId: string, userId: string, novelId: string, force: boolean) {
  await buildMemoryGraphOnce(userId, novelId, force, (done, total) => {
    const state = memoryGraphJobs.get(jobId)
    if (state) { state.totalChunks = total; state.doneChunks = done }
  })
}

export async function getMemoryGraphJob(userId: string, novelId: string, jobId: string) {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权查看关系网任务。')
  const job = memoryGraphJobs.get(jobId)
  if (!job || job.novelId !== novelId) {
    return { jobId, novelId, status: 'failed' as const, totalChunks: 0, doneChunks: 0, error: '任务不存在或已过期，请重新刷新。' }
  }
  return { jobId: job.id, novelId, status: job.status, totalChunks: job.totalChunks, doneChunks: job.doneChunks, error: job.error ?? null }
}

/** 同一作品的桌面/手机隐藏视图可能同时请求同步；服务端合并为一条事务链，避免重复重建关系。 */
const memoryGraphBuildInFlight = new Map<string, Promise<Awaited<ReturnType<typeof buildMemoryGraphOnce>>>>()
export function syncNovelMemoryProjection(userId: string, novelId: string, options: { force?: boolean } = {}) {
  const key = `${userId}:${novelId}:${options.force ? 'force' : 'auto'}`
  const running = memoryGraphBuildInFlight.get(key)
  if (running) return running
  const task = buildMemoryGraphOnce(userId, novelId, options.force === true)
  memoryGraphBuildInFlight.set(key, task)
  const release = () => {
    if (memoryGraphBuildInFlight.get(key) === task) memoryGraphBuildInFlight.delete(key)
  }
  void task.then(release, release)
  return task
}

export async function listMemoryReviewInbox(userId: string, novelId: string, db: Prisma.TransactionClient = prisma) {
  const novel = await db.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权查看记忆。')
  return db.projectMemoryEntry.findMany({
    where: { novelId, OR: [{ reviewStatus: 'pending' }, { status: 'conflicted' }] },
    include: { evidence: true }, orderBy: { updatedAt: 'desc' },
  })
}

export async function getMemoryGraph(userId: string, novelId: string): Promise<MemoryGraph> {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权查看记忆。')

  const entities = await prisma.storyEntity.findMany({
    where: { novelId, status: { in: ['confirmed', 'inferred', 'conflicted'] } },
    include: { aliases: { orderBy: { alias: 'asc' } }, relationsFrom: { where: { OR: [{ revision: null }, { revision: { gte: 0 } }] } } },
    orderBy: [{ updatedAt: 'desc' }, { canonicalName: 'asc' }],
    take: 240,
  })
  const nodeIds = new Set(entities.map((entity) => entity.id))
  const edges = entities
    .flatMap((entity) => entity.relationsFrom)
    .filter((relation) => (relation.revision === null || relation.revision >= 0) && nodeIds.has(relation.toEntityId))
    .slice(0, 600)
  const latestEntityAt = entities[0]?.updatedAt ?? new Date(0)
  const version = createHash('sha256')
    .update([
      ...entities.map((entity) => `${entity.id}:${entity.updatedAt.toISOString()}`),
      ...edges.map((edge) => `${edge.id}:${edge.state ?? ''}:${edge.confidence}`),
    ].join('|'))
    .digest('hex')
    .slice(0, 16)

  return {
    novelId,
    version: version || 'empty',
    updatedAt: latestEntityAt.toISOString(),
    nodes: entities.map((entity) => ({
      id: entity.id,
      type: entity.entityType,
      label: entity.canonicalName,
      description: entity.description,
      status: entity.status,
      aliases: entity.aliases.map((alias) => alias.alias),
      updatedAt: entity.updatedAt.toISOString(),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.fromEntityId,
      target: edge.toEntityId,
      type: edge.relationType,
      state: edge.state,
      confidence: edge.confidence,
      sourceId: edge.sourceId,
    })),
  }
}

export async function resolveMemoryReview(userId: string, memoryId: string, accepted: boolean) {
  return prisma.$transaction(async tx => {
    const owner = await tx.projectMemoryEntry.findFirst({ where: { id: memoryId, novel: { authorId: userId } }, select: { novelId: true } })
    if (!owner) throw new DataAccessError(404, 'MEMORY_NOT_FOUND', '记忆候选不存在。')
    await lockNovelActiveScope(tx, owner.novelId)
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:${owner.novelId}`}, 0))::text`
    const memory = await tx.projectMemoryEntry.findUniqueOrThrow({ where: { id: memoryId } })
    if (memory.reviewStatus !== 'pending' || ['invalid', 'superseded'].includes(memory.status)) throw new DataAccessError(409, 'MEMORY_REVIEW_STALE', '此卡片已处理或删除，请刷新审核列表。')
    const deleted = await tx.projectMemoryEntry.findFirst({ where: { novelId: owner.novelId, title: memory.title,
      memoryType: memory.memoryType, status: 'invalid', revisions: { some: { reason: 'author_delete' } } } })
    if (accepted && deleted) throw new DataAccessError(409, 'MEMORY_DELETED', '作者已删除此设定，旧候选不能重新启用。')
    if (accepted) await assertMemoryProposalCurrent(tx, memory.id, memory.novelId)
    await tx.memoryRevision.create({ data: { memoryId, before: memory.content, after: memory.content, reason: accepted ? 'author_edit' : 'author_reject' } })
    const updated = await tx.projectMemoryEntry.update({
      where: { id: memory.id },
      data: { reviewStatus: accepted ? 'accepted' : 'rejected', status: accepted ? 'confirmed' : 'invalid', confidence: accepted ? 1 : memory.confidence, version: { increment: 1 } },
    })
    // 接受候选即代表新事实生效：同名单卡旧版本一律 superseded，避免新旧设定同时参与检索造成混乱
    if (accepted) {
      await projectReviewedMemoryGraph(tx, updated, memory.title)
      await invalidateDerivedMemory(tx, memory.novelId)
      await tx.projectMemoryEntry.updateMany({
        where: {
          novelId: memory.novelId, memoryType: memory.memoryType, title: memory.title, id: { not: memory.id },
          status: { notIn: ['superseded', 'invalid'] },
        },
        data: { status: 'superseded', reviewStatus: 'none', version: { increment: 1 } },
      })
      if (memory.memoryType === 'characterCard') await tx.storyEntity.upsert({
        where: { novelId_entityType_canonicalName: { novelId: memory.novelId, entityType: 'character', canonicalName: memory.title } },
        create: { novelId: memory.novelId, entityType: 'character', canonicalName: memory.title, description: memory.content, status: 'confirmed' },
        update: { description: memory.content, status: 'confirmed' },
      })
    }
    return [updated]
  })
}

/** 创作记忆卡片列表（记忆中心可视化用）：只返回生效中的卡片，按更新时间倒序分页 */
export async function listStoryMemories(userId: string, novelId: string, input: { memoryType?: ProjectMemoryType; title?: string; page: number; pageSize: number }) {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权查看记忆。')
  const where = {
    novelId,
    status: { in: ['confirmed', 'inferred'] as StoryMemoryStatus[] },
    reviewStatus: { not: 'rejected' as const },
    ...(input.memoryType ? { memoryType: input.memoryType } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
  }
  const [total, rows, typeGroups, chapterRows, volumeRows] = await Promise.all([
    prisma.projectMemoryEntry.count({ where }),
    prisma.projectMemoryEntry.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
    prisma.projectMemoryEntry.groupBy({ by: ['memoryType'], where: { novelId, status: { in: ['confirmed', 'inferred'] }, reviewStatus: { not: 'rejected' } }, _count: { _all: true } }),
    prisma.chapter.findMany({ where: { novelId }, select: { id: true, title: true } }),
    prisma.volume.findMany({ where: { novelId }, select: { id: true, title: true } }),
  ])
  const chapterTitles = new Map(chapterRows.map((item) => [item.id, item.title]))
  const volumeTitles = new Map(volumeRows.map((item) => [item.id, item.title]))
  return {
    total,
    items: rows.map((item) => ({
      id: item.id,
      memoryType: item.memoryType,
      layer: item.layer,
      title: displayMemoryTitle(item.title, chapterTitles, volumeTitles),
      content: item.content,
      importance: item.importance,
      status: item.status,
      reviewStatus: item.reviewStatus,
      version: item.version,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    typeCounts: typeGroups.reduce<Record<string, number>>((acc, group) => {
      acc[group.memoryType] = group._count._all
      return acc
    }, {}),
  }
}

/** 记忆卡片集封面墙：每类型一叠牌的数量/最近更新/前两张标题预览，单查询聚合避免 N+1 */
export async function listStoryMemorySets(userId: string, novelId: string) {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权查看记忆。')
  const [rows, chapterRows, volumeRows] = await Promise.all([
    prisma.projectMemoryEntry.findMany({
      where: { novelId, status: { in: ['confirmed', 'inferred'] as StoryMemoryStatus[] }, reviewStatus: { not: 'rejected' as const } },
      orderBy: { updatedAt: 'desc' },
      select: { memoryType: true, title: true, updatedAt: true },
    }),
    prisma.chapter.findMany({ where: { novelId }, select: { id: true, title: true } }),
    prisma.volume.findMany({ where: { novelId }, select: { id: true, title: true } }),
  ])
  const chapterTitles = new Map(chapterRows.map((item) => [item.id, item.title]))
  const volumeTitles = new Map(volumeRows.map((item) => [item.id, item.title]))
  const order: string[] = []
  const aggregated = new Map<string, { count: number; latestUpdatedAt: Date; previews: string[] }>()
  for (const row of rows) {
    let current = aggregated.get(row.memoryType)
    if (!current) {
      current = { count: 0, latestUpdatedAt: row.updatedAt, previews: [] }
      aggregated.set(row.memoryType, current)
      order.push(row.memoryType)
    }
    current.count += 1
    if (current.previews.length < 2) current.previews.push(displayMemoryTitle(row.title, chapterTitles, volumeTitles))
  }
  return {
    sets: order.map((memoryType) => {
      const item = aggregated.get(memoryType)!
      return { memoryType, count: item.count, latestUpdatedAt: item.latestUpdatedAt.toISOString(), previews: item.previews }
    }),
  }
}

/** 作者在记忆中心直接编辑卡片：就地更新并记录修订历史，保证后续写作按最新设定召回 */
export async function updateStoryMemoryEntry(userId: string, memoryId: string, patch: { title?: string; content?: string; importance?: number; expectedVersion: number }) {
  const updated = await prisma.$transaction(async tx => {
    const owner = await tx.projectMemoryEntry.findFirst({ where: { id: memoryId, novel: { authorId: userId } }, select: { novelId: true } })
    if (!owner) throw new DataAccessError(404, 'MEMORY_NOT_FOUND', '记忆卡片不存在。')
    await lockNovelActiveScope(tx, owner.novelId)
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:${owner.novelId}`}, 0))::text`
    const memory = await tx.projectMemoryEntry.findFirst({ where: { id: memoryId, status: { notIn: ['invalid', 'superseded'] } } })
    if (!memory) throw new DataAccessError(404, 'MEMORY_NOT_FOUND', '记忆卡片不存在。')
    if (memory.version !== patch.expectedVersion) throw new DataAccessError(409, 'MEMORY_VERSION_CONFLICT', '卡片已被其他操作更新。你的草稿仍保留，请重新打开最新卡片后核对修改。')
    if (memory.reviewStatus === 'pending') await assertMemoryProposalCurrent(tx, memory.id, memory.novelId)
    const title = (patch.title ?? memory.title).trim().slice(0, 160)
    const content = (patch.content ?? memory.content).trim()
    if (!title || !content) throw new DataAccessError(400, 'MEMORY_INVALID_PATCH', '标题与内容不能为空。')
    const importance = patch.importance === undefined ? memory.importance : Math.min(100, Math.max(1, Math.round(patch.importance)))
    const changed = title !== memory.title || content !== memory.content || importance !== memory.importance || memory.reviewStatus === 'pending'
    if (changed) {
      await invalidateDerivedMemory(tx, memory.novelId, memory.id)
      await tx.memoryRevision.create({ data: { memoryId: memory.id, before: memory.content, after: content, reason: 'author_edit' } })
      await tx.projectMemoryEntry.update({
          where: { id: memory.id },
          data: { title, content, importance, status: 'confirmed', reviewStatus: 'accepted', confidence: 1, version: { increment: 1 }, embedding: hashVector(`${title}\n${content}`) },
      })
      await projectReviewedMemoryGraph(tx, { ...memory, title, content }, memory.reviewStatus === 'pending' ? memory.title : undefined)
      if (memory.reviewStatus === 'pending') await tx.projectMemoryEntry.updateMany({ where: { novelId: memory.novelId,
        memoryType: memory.memoryType, title: memory.title, id: { not: memory.id }, status: { notIn: ['invalid', 'superseded'] } },
        data: { status: 'superseded', reviewStatus: 'none', version: { increment: 1 } } })
      // 角色卡同步人物图谱描述，避免记忆中心与关系网展示两份设定
      if (memory.memoryType === 'characterCard') {
        if (title !== memory.title) await tx.storyEntity.updateMany({ where: { novelId: memory.novelId, entityType: 'character', canonicalName: memory.title }, data: { status: 'superseded' } })
        await tx.storyEntity.upsert({ where: { novelId_entityType_canonicalName: { novelId: memory.novelId, entityType: 'character', canonicalName: title } },
          create: { novelId: memory.novelId, entityType: 'character', canonicalName: title, description: content, status: 'confirmed' }, update: { description: content, status: 'confirmed' } })
      }
    }
    return tx.projectMemoryEntry.findUniqueOrThrow({ where: { id: memory.id } })
  })
  const [chapterRows, volumeRows] = await Promise.all([
    prisma.chapter.findMany({ where: { novelId: updated.novelId }, select: { id: true, title: true } }),
    prisma.volume.findMany({ where: { novelId: updated.novelId }, select: { id: true, title: true } }),
  ])
  const chapterTitles = new Map(chapterRows.map((item) => [item.id, item.title]))
  const volumeTitles = new Map(volumeRows.map((item) => [item.id, item.title]))
  return {
    id: updated.id,
    memoryType: updated.memoryType,
    layer: updated.layer,
    title: displayMemoryTitle(updated.title, chapterTitles, volumeTitles),
    content: updated.content,
    importance: updated.importance,
    status: updated.status,
    reviewStatus: updated.reviewStatus,
    version: updated.version,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  }
}

async function assertMemoryProposalCurrent(tx: Prisma.TransactionClient, memoryId: string, novelId: string) {
  const proposal = await tx.projectMemoryEntry.findUniqueOrThrow({ where: { id: memoryId } })
  const deleted = await tx.projectMemoryEntry.findFirst({ where: { novelId, title: proposal.title, memoryType: proposal.memoryType,
    status: 'invalid', revisions: { some: { reason: 'author_delete' } } } })
  if (deleted) throw new DataAccessError(409, 'MEMORY_DELETED', '作者已删除此设定，旧候选不能重新启用。')
  const link = await tx.memoryRevision.findFirst({ where: { memoryId, reason: { startsWith: 'agent_proposal@' } }, orderBy: { createdAt: 'desc' } })
  if (link?.supersededBy) {
    const target = await tx.projectMemoryEntry.findFirst({ where: { id: link.supersededBy, novelId } })
    if (!target || target.version !== Number(link.reason.split('@')[1]) || ['invalid', 'superseded'].includes(target.status)) {
      throw new DataAccessError(409, 'MEMORY_PROPOSAL_STALE', '原设定已变更或删除，此候选不能覆盖新版。请拒绝旧候选，再基于最新卡片修订。')
    }
  }
  const evidence = await tx.memoryEvidence.findMany({ where: { memoryId, sourceType: { in: ['chapter', 'volume'] } } })
  for (const source of evidence) {
    const record = source.sourceType === 'volume'
      ? await tx.volume.findFirst({ where: { id: source.sourceId, novelId, ...activeVolumeWhere }, select: { revision: true } })
      : await tx.chapter.findFirst({ where: { id: source.sourceId, ...activeChapterScope(novelId) }, select: { revision: true } })
    if (!record || (source.revision !== null && record.revision !== source.revision)) throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '候选来源卷章已变更，请核对当前原文后重新提交候选。')
  }
}

async function invalidateDerivedMemory(tx: Prisma.TransactionClient, novelId: string, exceptId?: string) {
  // Aggregates contain copied facts: an edited/deleted source must not survive through an old aggregate.
  await tx.projectMemoryEntry.updateMany({ where: { novelId, id: { not: exceptId }, reviewStatus: 'none',
    status: { in: ['confirmed', 'inferred'] }, OR: [
      { memoryType: 'storyBible', title: '故事圣经（系统增量）' },
      { memoryType: 'volumeSummary', title: { startsWith: '卷:' } },
    ] }, data: { status: 'superseded', version: { increment: 1 } } })
}

/** Logical deletion preserves audit history and fences subsequent automated writes. */
export async function deleteStoryMemoryEntry(userId: string, memoryId: string, expectedVersion: number) {
  return prisma.$transaction(async tx => {
    const owner = await tx.projectMemoryEntry.findFirst({ where: { id: memoryId, novel: { authorId: userId } }, select: { novelId: true } })
    if (!owner) throw new DataAccessError(404, 'MEMORY_NOT_FOUND', '记忆卡片不存在。')
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:${owner.novelId}`}, 0))::text`
    const memory = await tx.projectMemoryEntry.findUniqueOrThrow({ where: { id: memoryId }, include: { evidence: true, revisions: { where: { reason: 'author_delete' }, take: 1 } } })
    if (memory.revisions.length) return { id: memoryId, deleted: true }
    if (memory.version !== expectedVersion) throw new DataAccessError(409, 'MEMORY_VERSION_CONFLICT', '卡片已更新，请重新查看后确认删除。')
    await invalidateDerivedMemory(tx, memory.novelId, memory.id)
    await tx.memoryRevision.create({ data: { memoryId, before: memory.content, after: '', reason: 'author_delete' } })
    await tx.projectMemoryEntry.update({ where: { id: memoryId }, data: { status: 'invalid', reviewStatus: 'rejected', embedding: [], version: { increment: 1 } } })
    if (memory.memoryType === 'characterCard') await tx.storyEntity.updateMany({ where: { novelId: memory.novelId, entityType: 'character', canonicalName: memory.title, description: memory.content }, data: { status: 'invalid' } })
    const sourceIds = [memory.id, ...memory.evidence.map(item => item.sourceId)]
    if (memory.memoryType === 'timelineEvent') await tx.storyEvent.updateMany({ where: { novelId: memory.novelId, title: memory.title, sourceId: { in: sourceIds } }, data: { status: 'invalid' } })
    if (memory.memoryType === 'relationshipState') {
      const relations = await tx.entityRelation.findMany({ where: { fromEntity: { novelId: memory.novelId }, sourceId: { in: sourceIds } }, include: { fromEntity: true, toEntity: true } })
      const ids = relations.filter(item => item.sourceId === memory.id || `${item.fromEntity.canonicalName}→${item.toEntity.canonicalName}:${item.relationType}` === memory.title).map(item => item.id)
      if (ids.length) await tx.entityRelation.deleteMany({ where: { id: { in: ids } } })
    }
    return { id: memoryId, deleted: true }
  })
}

export async function saveEntityRelation(input: {
  userId: string; novelId: string; fromName: string; toName: string; relationType: string; state?: string
  validFrom?: number; validTo?: number; sourceId: string; revision?: number; confidence: number
}, transaction?: Prisma.TransactionClient): Promise<EntityRelation & { savedMemoryId: string }> {
  if (!transaction) return prisma.$transaction(tx => saveEntityRelation(input, tx))
  const db = transaction
  const novel = await db.novel.findFirst({ where: { id: input.novelId, authorId: input.userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权写入关系。')
  const [from, to] = await Promise.all([
    db.storyEntity.upsert({
      where: { novelId_entityType_canonicalName: { novelId: input.novelId, entityType: 'character', canonicalName: input.fromName.trim() } },
      create: { novelId: input.novelId, entityType: 'character', canonicalName: input.fromName.trim(), status: 'inferred' }, update: {},
    }),
    db.storyEntity.upsert({
      where: { novelId_entityType_canonicalName: { novelId: input.novelId, entityType: 'character', canonicalName: input.toName.trim() } },
      create: { novelId: input.novelId, entityType: 'character', canonicalName: input.toName.trim(), status: 'inferred' }, update: {},
    }),
  ])
  const existing = await db.entityRelation.findFirst({
    where: { fromEntityId: from.id, toEntityId: to.id, relationType: input.relationType, validFrom: input.validFrom ?? null },
  })
  const relation = existing
    ? await db.entityRelation.update({
        where: { id: existing.id },
        data: { state: input.state, validTo: input.validTo, confidence: input.confidence, sourceId: input.sourceId, revision: input.revision },
      })
    : await db.entityRelation.create({
        data: {
          fromEntityId: from.id, toEntityId: to.id, relationType: input.relationType,
          state: input.state, validFrom: input.validFrom, validTo: input.validTo,
          confidence: input.confidence, sourceId: input.sourceId, revision: input.revision,
        },
      })
  const memory = await saveStoryMemory({
    userId: input.userId, novelId: input.novelId, memoryType: 'relationshipState', layer: 'L2',
    title: `${input.fromName}→${input.toName}:${input.relationType}`,
    content: `${input.fromName}与${input.toName}的关系为${input.relationType}${input.state ? `，当前状态：${input.state}` : ''}`,
    importance: 75, confidence: input.confidence, status: input.confidence >= 0.95 ? 'confirmed' : 'inferred',
    evidence: { sourceType: input.revision !== undefined ? 'chapter' : 'author_input', sourceId: input.sourceId, revision: input.revision, confidence: input.confidence },
  }, db)
  return { ...relation, savedMemoryId: memory.id }
}

export async function saveStoryEvent(input: {
  userId: string; novelId: string; title: string; description: string; storyTime?: string; location?: string
  participants: string[]; causes: string[]; effects: string[]; sourceId: string; revision?: number; confidence: number
}, transaction?: Prisma.TransactionClient): Promise<StoryEvent & { savedMemoryId: string }> {
  if (!transaction) return prisma.$transaction(tx => saveStoryEvent(input, tx))
  const db = transaction
  const novel = await db.novel.findFirst({ where: { id: input.novelId, authorId: input.userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权写入事件。')
  const event = await db.storyEvent.create({
    data: {
      novelId: input.novelId, title: input.title.trim(), description: input.description.trim(),
      storyTime: input.storyTime, location: input.location, participants: input.participants,
      causes: input.causes, effects: input.effects, sourceId: input.sourceId, revision: input.revision,
      status: input.confidence >= 0.95 ? 'confirmed' : 'inferred',
    },
  })
  const memory = await saveStoryMemory({
    userId: input.userId, novelId: input.novelId, memoryType: 'timelineEvent', layer: 'L1',
    title: input.title, content: `${input.storyTime ? `时间：${input.storyTime}；` : ''}${input.location ? `地点：${input.location}；` : ''}${input.description}`,
    importance: 75, confidence: input.confidence, status: input.confidence >= 0.95 ? 'confirmed' : 'inferred',
    evidence: { sourceType: input.revision !== undefined ? 'chapter' : 'author_input', sourceId: input.sourceId, revision: input.revision, confidence: input.confidence },
  }, db)
  return { ...event, savedMemoryId: memory.id }
}
