import { prepareWritingPlanContext, assertWritingPlanContextCurrent, tryBindFutureWritingPlan, renderWritingPlanContext } from './writing-plan-context.js'

import { assertWritingTarget, readWritingScope, lockWritingRunLineage } from './writing-scope.js'
import { createHash } from 'node:crypto'

import { Prisma, type StoryCompilationStage, type StoryCharter, type ReaderPromise, type SceneTask } from '@prisma/client'

import type { ReaderPromiseInput, SceneTaskInput, StoryCharterSaveInput, StoryCompilerMode, StoryState } from '../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../prisma.js'
import { activeChapterScope, activeVolumeWhere } from '../data/internal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { requiresNextChapterDelivery } from './completion-guard.js'
import { taskSpecSchema, sceneTaskInputSchema, storyCharterInputSchema } from '../../../shared/contracts/index.js'
import { runtimeJson } from './runtime-common.js'
import type { WritingWorkflowMilestone } from './semantic-progress.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { readWritingVolumeContext, assertWritingVolumeBoundary, isWritingVolumeTargetOrderIndex } from './writing-volume.js'
import { writingVolumeDecisionSchema, type WritingVolumeDecision } from '../../../shared/contracts/writing-volume-contracts.js'
import { readReviewCycle } from './review-cycle.js'
import { saveStoryMemory } from './story-memory.js'
import { readWritingContinuityReference, type WritingContinuityReference } from './writing-continuity-reference.js'

type PreparedBridge = {
  lastUnfinishedAction: string
  location: string
  storyTime: string
  knowledgeState: string[]
  bodyState: string[]
  objectState: string[]
  relationshipState: string[]
  emotionAftermath: string[]
  hookDecision: string
  delayedHookReason: string
  recentOpenings: string[]
  recentEndings: string[]
  openLoops: string[]
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`

export const MAX_CONTINUITY_AUTO_REPAIRS = 1

/** Historical threshold retained for receipt compatibility, not a dispatch cap. */
export const MAX_CONTINUITY_CHECKS = 3

export function continuityRepairRounds(validation: unknown): number {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return 0
  const value = (validation as Record<string, unknown>).autoRepairRounds
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function continuityCheckRounds(validation: unknown): number {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return 0
  const value = (validation as Record<string, unknown>).checkRounds
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Canonical writes never turn a malformed historical counter into zero. */
export function validatedContinuityCheckRounds(validation: unknown, increment = false): number {
  const previous = validation && typeof validation === 'object' && !Array.isArray(validation) ? validation as Record<string, unknown> : {}
  if ('checkRounds' in previous && (typeof previous.checkRounds !== 'number' || !Number.isSafeInteger(previous.checkRounds)
    || previous.checkRounds < 0 || increment && previous.checkRounds === Number.MAX_SAFE_INTEGER)) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '连续性检查历史计数无法核实，未重置记录或派发检查。')
  }
  return continuityCheckRounds(previous)
}

const promptHash = (value: string): string =>
  createHash('sha256').update(value.trim()).digest('hex')

function firstParagraph(content: string): string {
  return clip(content.split(/\n\s*\n/).map((item) => item.trim()).find(Boolean) ?? '', 180)
}

function lastParagraph(content: string): string {
  const paragraphs = content.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)
  return clip(paragraphs.at(-1) ?? '', 180)
}

async function assertOwnedNovel(userId: string, novelId: string, db: Prisma.TransactionClient = prisma) {
  const novel = await db.novel.findFirst({
    where: { id: novelId, authorId: userId },
    select: { id: true, chapterCount: true },
  })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权使用 Story Compiler。')
  return novel
}

export async function getStoryCharterBundle(userId: string, novelId: string, db: Prisma.TransactionClient = prisma, includeClosed = false) {
  await assertOwnedNovel(userId, novelId, db)
  const [charter, promises] = await Promise.all([
    db.storyCharter.findFirst({ where: { userId, novelId } }),
    db.readerPromise.findMany({
      where: { userId, novelId, ...(includeClosed ? {} : { status: { in: ['open', 'deferred'] } }) },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
  ])
  return { charter, promises }
}

export async function upsertStoryCharter(userId: string, novelId: string, input: StoryCharterSaveInput, db: Prisma.TransactionClient = prisma) {
  await assertOwnedNovel(userId, novelId, db)
  const existing = await db.storyCharter.findUnique({ where: { novelId } })
  const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  if (existing) {
    // Omitted fields and creation defaults never replace existing author data.
    if (Object.entries(patch).every(([key, value]) =>
      JSON.stringify(existing[key as keyof typeof existing]) === JSON.stringify(value))) return existing
    return db.storyCharter.update({ where: { novelId }, data: { ...patch, revision: { increment: 1 } } })
  }
  const complete = storyCharterInputSchema.safeParse(input)
  if (!complete.success) throw new DataAccessError(400, 'INVALID_ARGUMENTS',
    `首次创建创作宪章需要完整字段：${complete.error.issues.map(issue => issue.path.join('.')).join('、')}；未创建宪章。`)
  return db.storyCharter.upsert({
    where: { novelId },
    create: { userId, novelId, ...complete.data },
    update: { ...complete.data, revision: { increment: 1 } },
  })
}

export async function saveReaderPromise(userId: string, novelId: string, input: ReaderPromiseInput, db: Prisma.TransactionClient = prisma) {
  await assertOwnedNovel(userId, novelId, db)
  const existing = await db.readerPromise.findFirst({
    where: { userId, novelId, title: input.title, status: { in: ['open', 'deferred'] } },
  })
  return existing
    ? db.readerPromise.update({ where: { id: existing.id }, data: { ...input, status: 'open', paidAtChapter: null } })
    : db.readerPromise.create({ data: { userId, novelId, ...input } })
}

export async function updateReaderPromise(input: {
  userId: string
  novelId: string
  promiseId: string
  status: 'open' | 'paid' | 'deferred' | 'abandoned'
  paidAtChapter?: number
}, db: Prisma.TransactionClient = prisma) {
  const promise = await db.readerPromise.findFirst({
    where: { id: input.promiseId, userId: input.userId, novelId: input.novelId },
  })
  if (!promise) throw new DataAccessError(404, 'READER_PROMISE_NOT_FOUND', '读者承诺不存在或不属于当前作品。')
  if (input.status === 'paid' && input.paidAtChapter === undefined) {
    throw new DataAccessError(400, 'PAYOFF_CHAPTER_REQUIRED', '标记已兑现时必须记录兑现章节序号。')
  }
  if (input.status === 'paid') {
    const chapter = await db.chapter.findFirst({ where: { ...activeChapterScope(input.novelId), authorId: input.userId, orderIndex: input.paidAtChapter }, select: { content: true } })
    if (!chapter?.content.trim()) throw new DataAccessError(400, 'PAYOFF_CHAPTER_REQUIRED', '兑现章节不存在或正文为空，不能标记已兑现。')
  }
  if (promise.status === input.status && promise.paidAtChapter === (input.status === 'paid' ? input.paidAtChapter : null)) return promise
  return db.readerPromise.update({
    where: { id: promise.id },
    data: { status: input.status, paidAtChapter: input.status === 'paid' ? input.paidAtChapter : null },
  })
}

async function resolveTarget(userId: string, novelId: string, chapterId: string | undefined, targetOrderIndex: number | undefined, db: Prisma.TransactionClient) {
  const chapter = chapterId
    ? await db.chapter.findFirst({
        where: { id: chapterId, ...activeChapterScope(novelId), authorId: userId },
        select: { id: true, title: true, orderIndex: true, revision: true, content: true },
      })
    : targetOrderIndex
      ? await db.chapter.findFirst({
          where: { ...activeChapterScope(novelId), authorId: userId, orderIndex: targetOrderIndex },
          select: { id: true, title: true, orderIndex: true, revision: true, content: true },
        })
      : null
  if (chapterId && !chapter) {
    throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '目标章节不存在或不属于当前作品。')
  }
  const last = await db.chapter.findFirst({
    where: { ...activeChapterScope(novelId), authorId: userId },
    orderBy: { orderIndex: 'desc' },
    select: { orderIndex: true },
  })
  if (targetOrderIndex !== undefined && targetOrderIndex > (last?.orderIndex ?? 0) + 1) {
    throw new DataAccessError(400, 'TARGET_CHAPTER_GAP', `目标第 ${targetOrderIndex} 章越过了当前末章，最多只能准备第 ${(last?.orderIndex ?? 0) + 1} 章。`)
  }
  return {
    chapter,
    targetOrderIndex: chapter?.orderIndex ?? targetOrderIndex ?? (last?.orderIndex ?? 0) + 1,
  }
}

export async function prepareStoryCompilation(input: {
  userId: string
  novelId: string
  runId: string
  chapterId?: string
  fallbackChapterId?: string
  targetOrderIndex?: number
  mode: StoryCompilerMode
  intentSummary: string
  detailPlanId?: string
  volumeDecision?: WritingVolumeDecision
}, transaction?: Prisma.TransactionClient): Promise<{ compilation: Prisma.StoryCompilationGetPayload<{ include: { bridge: true } }>; charter: StoryCharter | null; promises: ReaderPromise[]; bridge: PreparedBridge; preparedFirstForTarget: boolean; continuityReference: WritingContinuityReference | null }> {
  if (!transaction) return prisma.$transaction(tx => prepareStoryCompilation(input, tx))
  const db = transaction
  await lockNovelActiveScope(db, input.novelId)
  const scope = await compilationRunScope(db, input)
  await assertOwnedNovel(input.userId, input.novelId, db)
  const continuing = !input.chapterId && input.targetOrderIndex === undefined && !input.fallbackChapterId
    ? await db.storyCompilation.findFirst({ where: { userId: input.userId, novelId: input.novelId, ...scope, status: 'active' }, orderBy: { updatedAt: 'desc' }, select: { chapterId: true, targetOrderIndex: true } }) : null
  const writing = await readWritingScope(db, input)
  const slot = writing.writing?.kind === 'bounded' ? writing.writing.targets.find(item => input.chapterId ? item.chapterId === input.chapterId
    || writing.bindings?.targets.some(binding => binding.orderIndex === item.orderIndex && binding.chapterId === input.chapterId)
    : input.targetOrderIndex === undefined || item.orderIndex === input.targetOrderIndex) : null
  const boundId = slot?.chapterId ?? writing.bindings?.targets.find(item => item.orderIndex === slot?.orderIndex)?.chapterId
  const target = await resolveTarget(input.userId, input.novelId, input.chapterId ?? boundId ?? continuing?.chapterId ?? (!slot ? input.fallbackChapterId : undefined), input.targetOrderIndex ?? slot?.orderIndex ?? continuing?.targetOrderIndex, db)
  await assertWritingTarget(db, input, target.chapter ? { chapterId: target.chapter.id } : { orderIndex: target.targetOrderIndex })
  const planContext = await prepareWritingPlanContext(db, { userId: input.userId, novelId: input.novelId }, target, input.detailPlanId)
  const [bundle, previousChapter, recentChapters] = await Promise.all([
    getStoryCharterBundle(input.userId, input.novelId, db),
    db.chapter.findFirst({
      where: { ...activeChapterScope(input.novelId), authorId: input.userId, orderIndex: { lt: target.targetOrderIndex } },
      orderBy: { orderIndex: 'desc' },
      select: { id: true, title: true, orderIndex: true, revision: true, content: true },
    }),
    db.chapter.findMany({
      where: { ...activeChapterScope(input.novelId), authorId: input.userId, orderIndex: { lt: target.targetOrderIndex } },
      orderBy: { orderIndex: 'desc' },
      take: 2,
      select: { title: true, content: true },
    }),
  ])
  const continuityReference = await readWritingContinuityReference(db, input, target.targetOrderIndex, previousChapter)
  const volumeContext = previousChapter ? await readWritingVolumeContext(db, input, target.targetOrderIndex) : null
  const volumeDecision = input.volumeDecision ? writingVolumeDecisionSchema.parse(input.volumeDecision)
    : { kind: 'continue' as const, reason: target.chapter ? '原目标章已创建，保持其所在卷；本次审视不迁移既有章。' : '尚无本卷主困局已收束的真实原文依据，先延续当前卷；本章必须推进原目标，章数不能代替边界判断。' }
  if (volumeDecision.kind === 'new_volume') await assertWritingVolumeBoundary(db, input, target.targetOrderIndex, volumeDecision.newVolume)
  const memory = await db.projectMemoryEntry.findMany({
    where: {
      novelId: input.novelId,
      status: { in: ['confirmed', 'inferred'] },
      reviewStatus: { in: ['none', 'accepted'] },
      memoryType: { in: ['sceneState', 'relationshipState', 'timelineEvent', 'foreshadowing'] },
    },
    orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
    take: 16,
    select: { memoryType: true, title: true, content: true, confidence: true },
  })

  const bridge: PreparedBridge = {
    lastUnfinishedAction: '',
    location: '',
    storyTime: '',
    knowledgeState: [],
    bodyState: [],
    objectState: [],
    relationshipState: [],
    emotionAftermath: [],
    hookDecision: '',
    delayedHookReason: '',
    recentOpenings: recentChapters.map((chapter) => `${chapter.title}：${firstParagraph(chapter.content)}`).filter((item) => !item.endsWith('：')),
    recentEndings: recentChapters.map((chapter) => `${chapter.title}：${lastParagraph(chapter.content)}`).filter((item) => !item.endsWith('：')),
    openLoops: memory.filter((item) => item.memoryType === 'foreshadowing').map((item) => `${item.title}：${clip(item.content, 240)}`),
  }

  const originalRunIds = await (await import('./original-request.js')).originalTaskRunIds(db, input, writing)
  await db.$queryRaw(Prisma.sql`SELECT id FROM story_compilations WHERE user_id = ${input.userId}
    AND novel_id = ${input.novelId} AND run_id IN (${Prisma.join(originalRunIds)}) AND target_order_index = ${target.targetOrderIndex} ORDER BY id FOR UPDATE`)
  const priorRepairStates = await db.storyCompilation.findMany({
    where: { userId: input.userId, novelId: input.novelId, runId: { in: originalRunIds }, targetOrderIndex: target.targetOrderIndex },
    select: { validation: true, preparedContext: true, chapterId: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  // A repeated PREPARE must retain the volume already created for this same
  // original task/target. A changed proposal cannot mint a replacement volume.
  const priorVolumes = !target.chapter ? priorRepairStates.flatMap(item => {
    const prepared = item.preparedContext as Record<string, unknown> | null
    return prepared?.createdTailVolume ? [{ prepared, binding: prepared.createdTailVolume as { id?: string; proposalHash?: string; targetOrderIndex?: number } }] : []
  }) : []
  const createdTailVolume = priorVolumes[0]?.binding
  for (const { prepared, binding } of priorVolumes) {
    const priorPrevious = prepared.previousChapter as { id?: string; revision?: number } | null
    const capability = writing.writing?.tailVolume
    const priorDecision = prepared.volumeDecision as { kind?: string; newVolume?: unknown } | undefined
    if (volumeDecision.kind !== 'new_volume' || capability?.creationProtocol !== 2 || !binding.id
      || binding.id !== createdTailVolume?.id || binding.targetOrderIndex !== target.targetOrderIndex
      || binding.proposalHash !== runtimeJson(volumeDecision.newVolume).hash
      || priorDecision?.kind !== 'new_volume' || !priorDecision.newVolume || runtimeJson(priorDecision.newVolume).hash !== binding.proposalHash
      || previousChapter?.id !== capability.previousChapterId || previousChapter.revision !== capability.previousRevision
      || priorPrevious?.id !== previousChapter.id || priorPrevious.revision !== previousChapter.revision
      || !await db.volume.findFirst({ where: { id: binding.id, novelId: input.novelId, ...activeVolumeWhere }, select: { id: true } })) {
      throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '本任务已创建尾卷，但原目标、收束决定、前章版本或真实卷身份已变化；未重新准备或创建替代卷。')
    }
  }
  const priorCycle = target.chapter ? priorRepairStates.map(item => readReviewCycle(item.preparedContext, {
    taskId: writing.taskId, userId: input.userId, novelId: input.novelId, chapterId: target.chapter!.id,
  })).find(Boolean) : null
  await db.storyCompilation.updateMany({
    where: { userId: input.userId, novelId: input.novelId, ...scope, status: 'active' },
    data: { status: 'abandoned' },
  })
  const preparedContext = {
    ...(createdTailVolume ? { createdTailVolume } : {}),
    ...(planContext ? { planContext } : {}),
    ...(continuityReference ? { writingContinuityReference: continuityReference } : {}),
    ...(priorCycle ? { reviewCycle: priorCycle } : {}),
    volumeContext, volumeDecision,
    charterRevision: bundle.charter?.revision ?? null,
    charterPromise: bundle.charter?.oneLinePromise ?? null,
    readerPromises: bundle.promises.map((item) => ({ id: item.id, title: item.title, promise: item.promise, payoffHorizon: item.payoffHorizon })),
    previousChapter: previousChapter
      ? { id: previousChapter.id, title: previousChapter.title, orderIndex: previousChapter.orderIndex, revision: previousChapter.revision, ending: lastParagraph(previousChapter.content) }
      : null,
    memory: memory.map((item) => ({ type: item.memoryType, title: item.title, content: clip(item.content, 300), confidence: item.confidence })),
  }
  const compilation = await db.storyCompilation.create({
    data: {
      userId: input.userId,
      novelId: input.novelId,
      runId: input.runId,
      chapterId: target.chapter?.id,
      targetOrderIndex: target.targetOrderIndex,
      mode: input.mode,
      sourcePromptHash: promptHash(input.intentSummary),
      preparedContext: preparedContext as Prisma.InputJsonValue,
      bridge: {
        create: {
          userId: input.userId,
          novelId: input.novelId,
          fromChapterId: previousChapter?.id,
          toChapterId: target.chapter?.id,
          targetOrderIndex: target.targetOrderIndex,
          sourceRevision: previousChapter?.revision,
          lastUnfinishedAction: bridge.lastUnfinishedAction,
          location: bridge.location,
          storyTime: bridge.storyTime,
          knowledgeState: bridge.knowledgeState,
          bodyState: bridge.bodyState,
          objectState: bridge.objectState,
          relationshipState: bridge.relationshipState,
          emotionAftermath: bridge.emotionAftermath,
          hookDecision: bridge.hookDecision,
          delayedHookReason: bridge.delayedHookReason,
          recentOpenings: bridge.recentOpenings,
          recentEndings: bridge.recentEndings,
          openLoops: bridge.openLoops,
        },
      },
    },
    include: { bridge: true },
  })
  return { compilation, charter: bundle.charter, promises: bundle.promises, bridge, preparedFirstForTarget: priorRepairStates.length === 0, continuityReference }
}

export async function saveSceneTasks(input: {
  userId: string
  novelId: string
  compilationId: string
  tasks: SceneTaskInput[]
  alternatives?: Array<{ label: string; tradeoff: string; rejectedReason: string }>
}, transaction?: Prisma.TransactionClient): Promise<SceneTask[]> {
  if (!transaction) return prisma.$transaction(tx => saveSceneTasks(input, tx))
  const tx = transaction
  await lockNovelActiveScope(tx, input.novelId)
  if (input.tasks.length < 1) {
    throw new DataAccessError(400, 'SCENE_TASK_COUNT_INVALID', '场景列表不能为空。')
  }
  await tx.$queryRaw`SELECT id FROM story_compilations WHERE id = ${input.compilationId} AND user_id = ${input.userId} AND novel_id = ${input.novelId} FOR UPDATE`
  const compilation = await tx.storyCompilation.findFirst({
    where: { id: input.compilationId, userId: input.userId, novelId: input.novelId, status: 'active' },
  })
  if (!compilation) throw new DataAccessError(404, 'COMPILATION_NOT_FOUND', '写作编译任务不存在、已结束或不属于当前作品。')
  const beatCandidates = normalizeBeatCandidates(input.tasks, input.alternatives)
  await tx.sceneTask.deleteMany({ where: { compilationId: compilation.id } })
  await tx.sceneTask.createMany({
    data: input.tasks.map((task, index) => ({
      userId: input.userId,
      novelId: input.novelId,
      compilationId: compilation.id,
      chapterId: compilation.chapterId,
      ordinal: index + 1,
      purpose: task.purpose,
      entryState: task.entryState as Prisma.InputJsonValue,
      goal: task.goal,
      obstacle: task.obstacle,
      choice: task.choice,
      cost: task.cost,
      turn: task.turn,
      exitState: task.exitState as Prisma.InputJsonValue,
      styleBudget: task.styleBudget as Prisma.InputJsonValue,
    })),
  })
  const context = compilation.preparedContext && typeof compilation.preparedContext === 'object' && !Array.isArray(compilation.preparedContext)
    ? compilation.preparedContext as Record<string, unknown>
    : {}
  await tx.storyCompilation.update({
    where: { id: compilation.id },
    data: {
      stage: ['prepare', 'beat'].includes(compilation.stage) ? 'beat' : compilation.stage,
      preparedContext: { ...context, beatCandidates } as Prisma.InputJsonValue,
    },
  })
  return tx.sceneTask.findMany({ where: { compilationId: compilation.id }, orderBy: { ordinal: 'asc' } })
}

/** A bounded workflow observation, separate from authored-body progress. The
 * novel lock serializes PREPARE and all scene writes; abandoned attempts and
 * the original task's resumed runs keep the first-step opportunity consumed. */
export async function saveSceneTasksWithMilestone(input: Parameters<typeof saveSceneTasks>[0] & { runId: string },
  transaction?: Prisma.TransactionClient): Promise<{ tasks: SceneTask[]; scenesFirstForTarget: boolean; targetOrderIndex: number }> {
  if (!transaction) return prisma.$transaction(tx => saveSceneTasksWithMilestone(input, tx))
  await lockNovelActiveScope(transaction, input.novelId)
  const scope = await compilationRunScope(transaction, input)
  const compilation = await transaction.storyCompilation.findFirst({ where: { id: input.compilationId, userId: input.userId,
    novelId: input.novelId, status: 'active', ...scope }, select: { targetOrderIndex: true } })
  if (!compilation) throw new DataAccessError(404, 'COMPILATION_NOT_FOUND', '场景编译不属于当前原任务，未保存场景。')
  const original = await readWritingScope(transaction, input)
  const runIds = await (await import('./original-request.js')).originalTaskRunIds(transaction, input, original)
  const priorScene = await transaction.sceneTask.findFirst({ where: { userId: input.userId, novelId: input.novelId,
    compilation: { userId: input.userId, novelId: input.novelId, runId: { in: runIds }, targetOrderIndex: compilation.targetOrderIndex } }, select: { id: true } })
  const tasks = await saveSceneTasks(input, transaction)
  return { tasks, scenesFirstForTarget: !priorScene && tasks.length > 0, targetOrderIndex: compilation.targetOrderIndex }
}

/** Only durable identity or a validated legacy task contract joins runs.
 * A next-chapter contract cannot inherit an older chapter even if a historical
 * bug already attached a compilation for that chapter to this same contract. */
export async function readCompilerTaskIdentity(db: Prisma.TransactionClient, input: { userId: string; novelId: string; runId: string }) {
  const run = await db.agentRun.findFirst({ where: { id: input.runId, userId: input.userId, novelId: input.novelId }, select: { taskRootId: true, runtimeProtocolVersion: true, taskSpec: true, sessionId: true } })
  if (!run) throw new DataAccessError(404, 'RUN_NOT_FOUND', '章节编译运行不存在或不属于当前任务。')
  if (run.runtimeProtocolVersion > 0 && !run.taskRootId) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '持久运行缺少原任务身份。')
  const parsed = taskSpecSchema.safeParse(run.taskSpec)
  if (!parsed.success || !parsed.data.runId || parsed.data.scope.novelId !== input.novelId) return { run, task: null }
  const task = parsed.data
  if (task.runId !== input.runId) {
    // Historical goal admission copied the original run binding. Only the exact
    // owned, interrupted origin with an unchanged contract proves continuation.
    // A session, matching chapter, or task-id string alone is insufficient.
    const origin = run.runtimeProtocolVersion === 0 && !run.taskRootId && task.runId
      ? await db.agentRun.findFirst({ where: { id: task.runId, userId: input.userId, novelId: input.novelId, sessionId: run.sessionId,
          runtimeProtocolVersion: 0, taskRootId: null, status: { in: ['paused', 'failed'] } }, select: { id: true, taskSpec: true } }) : null
    const original = taskSpecSchema.safeParse(origin?.taskSpec)
    if (!origin || !original.success || original.data.runId !== origin.id
      || runtimeJson(JSON.parse(JSON.stringify({ ...original.data, runId: input.runId }))).hash
        !== runtimeJson(JSON.parse(JSON.stringify({ ...task, runId: input.runId }))).hash) {
      throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '原任务合同与恢复运行身份无法核实，未接管历史编译。')
    }
  }
  return { run, task: { ...task, runId: input.runId } }
}

export async function compilationRunScope(db: Prisma.TransactionClient, input: { userId: string; novelId: string; runId: string }): Promise<Prisma.StoryCompilationWhereInput> {
  const { run, task } = await readCompilerTaskIdentity(db, input)
  const validTask = !!task
  const runWhere: Prisma.AgentRunWhereInput = run.taskRootId
    ? { userId: input.userId, novelId: input.novelId, taskRootId: run.taskRootId }
    : run.runtimeProtocolVersion === 0 && validTask
      ? { userId: input.userId, novelId: input.novelId, sessionId: run.sessionId, runtimeProtocolVersion: 0, taskRootId: null, taskSpec: { path: ['id'], equals: task.id } }
      : { id: input.runId, userId: input.userId, novelId: input.novelId }
  const scope: Prisma.StoryCompilationWhereInput = { run: runWhere }
  if (task && requiresNextChapterDelivery(task.goals)) {
    const firstRun = await db.agentRun.findFirst({ where: runWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
    if (!firstRun) throw new DataAccessError(404, 'RUN_NOT_FOUND', '章节编译原任务不存在。')
    scope.AND = [{ OR: [{ chapterId: null }, { chapter: { createdAt: { gte: firstRun.createdAt } } }] }]
  }
  return scope
}

/** Legacy compatibility only: read authentic saved prerequisites before the
 * first resumed provider turn. Stable task/target/phase deduplication belongs
 * to the checkpoint consumer; this never writes content, budgets or receipts. */
export async function readPersistedWritingWorkflowMilestones(input: {
  userId: string; novelId: string; runId: string; taskSpec: unknown
}, transaction?: Prisma.TransactionClient): Promise<WritingWorkflowMilestone[]> {
  if (!transaction) return prisma.$transaction(tx => readPersistedWritingWorkflowMilestones(input, tx))
  const db = transaction
  const parsed = taskSpecSchema.safeParse(input.taskSpec)
  if (!parsed.success || parsed.data.runId !== input.runId || parsed.data.scope.novelId !== input.novelId
    || !['write', 'revise'].includes(parsed.data.intent) || parsed.data.scope.selection
    || ['proposal_only', 'conversation_only'].includes(parsed.data.writingPacing ?? '')
    || parsed.data.scope.writing?.kind !== 'bounded' && parsed.data.scope.writingClarificationProtocol === undefined) return []
  const main = { userId: input.userId, novelId: input.novelId, runtimeProtocolVersion: 0, taskRootId: null,
    incomingChildGrant: null, session: { userId: input.userId, novelId: input.novelId, spawnedFromRunId: null, spawnedFromSessionId: null } }
  const current = await db.agentRun.findFirst({ where: { ...main, id: input.runId, status: { in: ['queued', 'running', 'awaiting_approval'] } } })
  if (!current) return []
  if (!await db.novel.findFirst({ where: { id: input.novelId, authorId: input.userId }, select: { id: true } })) return []
  const contractHash = (spec: unknown) => {
    const task = taskSpecSchema.safeParse(spec)
    return task.success ? runtimeJson(JSON.parse(JSON.stringify({ ...task.data, runId: input.runId }))).hash : null
  }
  const expectedHash = contractHash(parsed.data)
  if (contractHash(current.taskSpec) !== expectedHash) return []
  const original = await readWritingScope(db, input)
  if (original.parentRunId || original.taskId !== parsed.data.id || contractHash(original.spec) !== expectedHash
    || original.writing?.kind !== 'bounded') return []
  const runs = await db.agentRun.findMany({ where: { ...main, sessionId: current.sessionId,
    taskSpec: { path: ['id'], equals: parsed.data.id } } })
  const runIds: string[] = []
  for (const run of runs) {
    if (contractHash(run.taskSpec) !== expectedHash) continue
    const identity = await readCompilerTaskIdentity(db, { ...input, runId: run.id })
    if (identity.task && contractHash(identity.task) === expectedHash) runIds.push(run.id)
  }
  if (!runIds.includes(input.runId) || !runIds.includes(original.sourceRunId)) return []
  const compilations = await db.storyCompilation.findMany({ where: { userId: input.userId, novelId: input.novelId,
    runId: { in: runIds }, status: 'active', targetOrderIndex: { in: original.writing.targets.map(target => target.orderIndex) } },
    include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const milestones: WritingWorkflowMilestone[] = []
  for (const compilation of compilations) {
    const target = original.writing.targets.find(item => item.orderIndex === compilation.targetOrderIndex)!
    const chapterId = target.chapterId ?? original.bindings?.targets.find(item => item.orderIndex === target.orderIndex)?.chapterId ?? null
    const bridge = compilation.bridge
    if (compilations.filter(item => item.targetOrderIndex === target.orderIndex).length !== 1
      || compilation.chapterId !== chapterId || !bridge || bridge.userId !== input.userId || bridge.novelId !== input.novelId
      || bridge.compilationId !== compilation.id || bridge.targetOrderIndex !== target.orderIndex || bridge.toChapterId !== chapterId
      || bridge.committedAt || !['prepare', 'beat', 'write', 'check', 'repair'].includes(compilation.stage)) continue
    if (chapterId && (!compilation.chapter || compilation.chapter.authorId !== input.userId || compilation.chapter.novelId !== input.novelId
      || compilation.chapter.orderIndex !== target.orderIndex || compilation.chapter.archivedAt
      || !await db.chapter.findFirst({ where: { id: chapterId, authorId: input.userId, ...activeChapterScope(input.novelId) }, select: { id: true } }))) continue
    const milestone = { version: 1 as const, userId: input.userId, novelId: input.novelId, runId: input.runId, targetOrderIndex: target.orderIndex }
    milestones.push({ ...milestone, phase: 'prepare' })
    if (compilation.sceneTasks.length > 0 && compilation.sceneTasks.length <= 4 && compilation.stage !== 'prepare'
      && compilation.sceneTasks.every((scene, index) => scene.userId === input.userId && scene.novelId === input.novelId
        && scene.compilationId === compilation.id && scene.chapterId === chapterId && scene.ordinal === index + 1
        && sceneTaskInputSchema.safeParse(scene).success)) milestones.push({ ...milestone, phase: 'scenes' })
  }
  return milestones
}

/** A chapter-only CHECK can inherit only the original writing task's prepared
 * compiler. Review contracts and malformed legacy identities remain standalone. */
export async function isWritingTaskContinuityCompiler(db: Prisma.TransactionClient, input: {
  userId: string; novelId: string; runId: string; compilationId: string; chapterId: string
}): Promise<boolean> {
  const { task } = await readCompilerTaskIdentity(db, input)
  if (!task || task.intent !== 'write' || task.scope.selection
    || task.writingPacing === 'proposal_only' || task.writingPacing === 'conversation_only') return false
  if (task.scope.chapterIds?.length && !task.scope.chapterIds.includes(input.chapterId) && !requiresNextChapterDelivery(task.goals)) return false
  const scope = await compilationRunScope(db, input)
  const candidate = await db.storyCompilation.findFirst({ where: { id: input.compilationId, userId: input.userId, novelId: input.novelId,
    chapterId: input.chapterId, status: { in: ['active', 'completed'] }, ...scope }, select: { id: true } })
  return !!candidate && !!await db.chapter.findFirst({ where: { id: input.chapterId, authorId: input.userId, ...activeChapterScope(input.novelId) }, select: { id: true } })
}

/**
 * 精品候选属于可审计的流程元数据，不应成为模型调用的硬失败点。
 * 模型提供完整取舍时原样保留；缺失或结构不全时依据已通过严格校验的
 * Scene Task 生成两个短候选，不新增模型调用，也不削弱场景任务本身的约束。
 */
export function normalizeBeatCandidates(
  tasks: SceneTaskInput[],
  alternatives?: Array<{ label: string; tradeoff: string; rejectedReason: string }>,
) {
  const supplied = (alternatives ?? [])
    .filter((item) => item.label.trim() && item.tradeoff.trim() && item.rejectedReason.trim())
    .slice(0, 3)
  if (supplied.length >= 2) return supplied

  const first = tasks[0]
  const last = tasks.at(-1) ?? first
  const taskChain = tasks.map((task) => task.purpose).join('→').slice(0, 360)
  return [
    {
      label: '当前 Scene Task 链',
      tradeoff: `保留目标、阻力、选择、代价与转折的完整链条：${taskChain}`.slice(0, 500),
      rejectedReason: `未淘汰；当前方案能落实“${last.turn}”这一可观测转折。`.slice(0, 500),
    },
    {
      label: '压缩为单场推进',
      tradeoff: `以“${first.goal}”为唯一目标，可缩短篇幅，但会压低“${first.cost}”的过程重量。`.slice(0, 500),
      rejectedReason: `当前章节需要保留人物选择与代价的递进，因此采用 ${tasks.length} 个 Scene Task。`.slice(0, 500),
    },
  ]
}

export async function recordStoryCompilerWrite(input: {
  userId: string
  novelId: string
  runId: string
  chapterId: string
  chapterOrderIndex: number
  chapterRevision: number
}, transaction?: Prisma.TransactionClient): Promise<{ compilationId: string; stage: StoryCompilationStage } | null> {
  if (!transaction) return prisma.$transaction(tx => recordStoryCompilerWrite(input, tx))
  await lockNovelActiveScope(transaction, input.novelId)
  if (!await transaction.chapter.findFirst({ where: { id: input.chapterId, revision: input.chapterRevision,
    authorId: input.userId, ...activeChapterScope(input.novelId) }, select: { id: true } })) {
    throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '编译写入回执必须对应当前正文版本，旧回执不能回退章节桥。')
  }
  const scope = await compilationRunScope(transaction, input)
  const compilation = await transaction.storyCompilation.findFirst({
    where: {
      userId: input.userId,
      novelId: input.novelId,
      ...scope,
      status: { in: ['active', 'completed'] },
      OR: [{ chapterId: input.chapterId }, { chapterId: null, targetOrderIndex: input.chapterOrderIndex }],
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!compilation) return null
  if (!await tryBindFutureWritingPlan(transaction, { userId: input.userId, novelId: input.novelId }, compilation, { id: input.chapterId, orderIndex: input.chapterOrderIndex })) return null
  const stage: StoryCompilationStage = ['check', 'repair', 'commit'].includes(compilation.stage) ? 'repair' : 'write'
  await transaction.storyCompilation.update({
      where: { id: compilation.id },
      data: { chapterId: input.chapterId, stage, status: 'active', completedAt: null },
    })
  await transaction.sceneTask.updateMany({
      where: { compilationId: compilation.id },
      data: { chapterId: input.chapterId, status: 'writing' },
    })
  await transaction.chapterBridge.update({
      where: { compilationId: compilation.id },
      data: { toChapterId: input.chapterId, targetRevision: input.chapterRevision, committedAt: null },
    })
  return { compilationId: compilation.id, stage }
}

export async function commitChapterBridge(input: {
  userId: string
  novelId: string
  /** Current authorized attempt; compilation.runId remains its original owner. */
  runId?: string
  compilationId: string
  chapterSummary: string
  exitState: StoryState
  lastUnfinishedAction: string
  hookDecision: string
  delayedHookReason: string
  openingStructure: string
  endingStructure: string
  expectedChapterRevision?: number
  expectedContentHash?: string
  retainedFindings?: import('./chapter-review-guard.js').RetainedChapterReviewDecision[]
  decisionOnly?: true
  requireQuality?: boolean
  qualityReportId?: string
  terminalDraftScope?: import('./terminal-draft-authority.js').TerminalDraftReadScope
}, transaction?: Prisma.TransactionClient, sourceReadScope?: import('./chapter-review-guard.js').ChapterReviewReadScope): Promise<{ compilationId: string; chapterId: string; chapterRevision: number; skippedMemoryCount: number; retainedIssueCount: number; decisionOnly?: true; decisionChanged?: boolean; decisionProgress?: { targetId: string; beforeHash: string; afterHash: string } }> {
  if (!transaction) return prisma.$transaction(tx => commitChapterBridge(input, tx), { timeout: 20000 })
  void sourceReadScope
  const db = transaction
  await lockNovelActiveScope(db, input.novelId)
  if (input.runId) { await assertAgentManuscriptCurrent(db, { ...input, runId: input.runId }); await lockWritingRunLineage(db, { ...input, runId: input.runId }) }
  const scope = input.runId ? await compilationRunScope(db, { ...input, runId: input.runId }) : {}
  await db.$queryRaw`SELECT id FROM story_compilations WHERE id = ${input.compilationId} AND user_id = ${input.userId} AND novel_id = ${input.novelId} FOR UPDATE`
  const compilation = await db.storyCompilation.findFirst({ where: { id: input.compilationId, userId: input.userId, novelId: input.novelId, ...scope },
    include: { bridge: true, chapter: true } })
  if (!compilation?.chapter || !compilation.bridge) throw new DataAccessError(404, 'COMPILATION_NOT_FOUND', '没有当前任务可提交的正文。')
  const runId = input.runId ?? compilation.runId
  if (!runId) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '提交缺少原任务归属。')
  const run = await db.agentRun.findFirst({ where: { id: runId, userId: input.userId, novelId: input.novelId, status: { in: ['queued','running','awaiting_approval'] } } })
  if (!run) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前执行已停止，正文未提交。')
  if (compilation.status === 'active' && await db.storyCompilation.findFirst({ where: { userId: input.userId, novelId: input.novelId,
    ...(input.runId ? scope : await compilationRunScope(db, { ...input, runId })), chapterId: compilation.chapterId,
    createdAt: { gt: compilation.createdAt } }, select: { id: true } }))
    throw new DataAccessError(409, 'COMPILATION_STAGE_CONFLICT', '该章已有本任务后续准备的编译，旧编译未覆盖当前身份。')
  await assertWritingTarget(db, { ...input, runId }, { chapterId: compilation.chapter.id })
  await db.$queryRaw`SELECT id FROM chapters WHERE id = ${compilation.chapter.id} FOR UPDATE`
  const chapter = await db.chapter.findFirst({ where: { id: compilation.chapter.id, authorId: input.userId, ...activeChapterScope(input.novelId) } })
  if (!chapter?.content.trim() || input.expectedChapterRevision !== undefined && chapter.revision !== input.expectedChapterRevision
    || input.expectedContentHash !== undefined && runtimeJson({ content: chapter.content }).hash !== input.expectedContentHash)
    throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '正文已变化，未提交旧版本。')
  const { readChapterReviewReadiness, readAdvisoryChapterReviewReadiness, recordChapterReviewDecisions } = await import('./chapter-review-guard.js')
  let readiness = await (input.retainedFindings?.length ? readChapterReviewReadiness : readAdvisoryChapterReviewReadiness)(db, { ...input, runId }, compilation.id)
  if (input.retainedFindings?.length && readiness) {
    await recordChapterReviewDecisions(db, { ...input, runId }, readiness, input.retainedFindings)
    readiness = await readChapterReviewReadiness(db, { ...input, runId }, compilation.id)
  }
  // Saving the current chapter is independent of advisory report readiness.
  // Keep each report's real state; commit neither certifies it nor retries a
  // model request. Current manuscript identity/revision is checked above.
  const hash = runtimeJson({ content: chapter.content }).hash
  const prepared = compilation.preparedContext && typeof compilation.preparedContext === 'object' && !Array.isArray(compilation.preparedContext) ? compilation.preparedContext : {}
  if (compilation.bridge.committedAt && compilation.bridge.targetRevision === chapter.revision && prepared.terminalContentHash === hash)
    return { compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, skippedMemoryCount: 0, retainedIssueCount: readiness?.retainedDecisions?.length ?? 0 }
  const now = new Date()
  const source = compilation.bridge.fromChapterId ? await db.chapter.findFirst({ where: { id: compilation.bridge.fromChapterId,
    authorId: input.userId, ...activeChapterScope(input.novelId) }, select: { revision: true } }) : null
  if (compilation.bridge.fromChapterId && !source) throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '衔接来源已归档，章节未提交。')
  // Commit manuscript delivery. Keep historical fact ledgers/proofs and
  // original bridge facts; report advice never becomes a supported fact.
  await db.chapterBridge.update({ where: { id: compilation.bridge.id }, data: { targetRevision: chapter.revision, committedAt: now,
    ...(source ? { sourceRevision: source.revision } : {}),
    recentOpenings: [...asStringArray(compilation.bridge.recentOpenings), input.openingStructure].filter(Boolean).slice(-3),
    recentEndings: [...asStringArray(compilation.bridge.recentEndings), input.endingStructure].filter(Boolean).slice(-3) } })
  await db.sceneTask.updateMany({ where: { compilationId: compilation.id }, data: { status: 'completed' } })
  await db.storyCompilation.update({ where: { id: compilation.id }, data: { stage: 'commit', status: 'completed', completedAt: now,
    preparedContext: runtimeJson({ ...prepared, terminalContentHash: hash }).value } })
  // These are the existing editorial memory proposals, not certified facts.
  // Keep the author's tombstones and the exact source revision while allowing
  // delivery independently of whether a proposal is later accepted.
  let skippedMemoryCount = 0
  const saveProposal = async (memory: Parameters<typeof saveStoryMemory>[0]) => {
    try { await saveStoryMemory({ ...memory, agentGenerated: true }, db) }
    catch (error) {
      if (!(error instanceof DataAccessError) || error.code !== 'MEMORY_DELETED') throw error
      skippedMemoryCount++
    }
  }
  const evidence = { sourceType: 'chapter' as const, sourceId: chapter.id, revision: chapter.revision, confidence: 1 }
  await saveProposal({ userId: input.userId, novelId: input.novelId, runId, sourceChapterId: chapter.id,
    memoryType: 'chapterSummary', layer: 'L2', title: chapter.title, content: input.chapterSummary,
    importance: 75, confidence: 1, status: 'inferred', evidence })
  await saveProposal({ userId: input.userId, novelId: input.novelId, runId, sourceChapterId: chapter.id,
    memoryType: 'sceneState', layer: 'L2', title: `${chapter.title}终态`,
    content: [input.exitState.action, input.exitState.location, input.exitState.storyTime, input.lastUnfinishedAction,
      ...input.exitState.knowledge, ...input.exitState.emotion, ...input.exitState.body, ...input.exitState.objects,
      ...input.exitState.relationships, ...input.exitState.openLoops, input.hookDecision, input.delayedHookReason].filter(Boolean).join('；') || lastParagraph(chapter.content),
    importance: 80, confidence: 1, status: 'inferred', evidence })
  return { compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, skippedMemoryCount, retainedIssueCount: readiness?.retainedDecisions?.length ?? 0 }
}

export async function buildStoryCompilerDigest(userId: string, novelId: string, _chapterId: string | null, runId?: string) {
  const scope = runId ? await compilationRunScope(prisma, { userId, novelId, runId }) : null
  const [bundle, active, latestBridge] = await Promise.all([
    getStoryCharterBundle(userId, novelId),
    scope ? prisma.storyCompilation.findFirst({
      where: { userId, novelId, ...scope, status: { in: ['active', 'completed'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { sceneTasks: { orderBy: { ordinal: 'asc' } }, bridge: true,
        qualityReports: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, chapterRevision: true, status: true } } },
    }) : Promise.resolve(null),
    prisma.chapterBridge.findFirst({
      where: { userId, novelId, committedAt: { not: null } },
      orderBy: { committedAt: 'desc' },
      include: { toChapter: { select: { title: true, orderIndex: true, revision: true } } },
    }),
  ])
  if (!scope && !bundle.charter && !active && !latestBridge) return null
  const chapter = active?.chapterId ? await prisma.chapter.findFirst({ where: { id: active.chapterId, authorId: userId, ...activeChapterScope(novelId) },
    select: { id: true, revision: true, content: true } }) : null
  const hasBody = !!chapter?.content.trim()
  const terminalContext = active?.preparedContext && typeof active.preparedContext === 'object' && !Array.isArray(active.preparedContext) ? active.preparedContext : null
  const targetOrderIndex = runId && scope
    ? active?.targetOrderIndex ?? (await readWritingScope(prisma, { userId, novelId, runId })).writing?.targets[0]?.orderIndex
    : undefined
  const volumeContext = runId && scope && isWritingVolumeTargetOrderIndex(targetOrderIndex)
    ? await readWritingVolumeContext(prisma, { userId, novelId, runId }, targetOrderIndex)
    : null
  let planNeedsReview = false
  let review: import('./chapter-review-guard.js').ChapterReviewReadiness | null = null
  try {
    if (runId && active && hasBody) review = await (await import('./chapter-review-guard.js')).readChapterReviewReadiness(prisma, { userId, novelId, runId }, active.id)
    else if (active) await assertWritingPlanContextCurrent(prisma, { userId, novelId }, active.preparedContext)
  } catch (error) {
    if (!(error instanceof DataAccessError) || error.code !== 'PLAN_CONTEXT_STALE') throw error
    planNeedsReview = true
  }
  const committed = !planNeedsReview && !!active && hasBody && active.status === 'completed' && active.stage === 'commit'
    && !!active.bridge && active.bridge.toChapterId === chapter?.id && !!active.bridge.committedAt && active.bridge.targetRevision === chapter?.revision
    && terminalContext?.terminalContentHash === runtimeJson({ content: chapter?.content }).hash
  const resume = !active ? '' : planNeedsReview
    ? '冻结的大纲或细纲已变化，旧编译不能认证新版。可读取当前计划；普通正文工具仍可按原请求使用。'
    : committed ? '本章已有与当前正文 revision/hash 匹配的提交；复用已完成结果，避免重复写入。'
      : !hasBody ? '目标尚无非空正文。根据原请求选择创建或写入；场景与编译为可选协作记录。'
        : '已有非空正文。根据原请求选择继续修改、检查或提交；没有固定步骤顺序，保存不等于报告通过。'
  const historicalValidation = active?.validation && typeof active.validation === 'object' && !Array.isArray(active.validation) ? active.validation : {}
  const latestQuality = active?.qualityReports[0]
  const lines = [
    'Story Compiler 3.0 状态：',
    active ? renderWritingPlanContext(active.preparedContext) : '',
    volumeContext ? `当前卷《${volumeContext.volumeTitle}》共 ${volumeContext.chapterCount} 章；卷目标：${volumeContext.summary || '未保存'}；${volumeContext.planStatus}。前章 ${volumeContext.previousChapter.id} r${volumeContext.previousChapter.revision}，末尾：${volumeContext.previousChapter.ending}。计划：${JSON.stringify(volumeContext.plans)}。按作者请求和真实剧情决定卷安排，章数不是自动切卷阈值。` : '',
    bundle.charter ? `创作宪章 r${bundle.charter.revision}：${clip(bundle.charter.oneLinePromise, 240)}` : '创作宪章：尚未建立',
    bundle.promises.length ? `待兑现读者承诺：${bundle.promises.slice(0, 5).map((item) => `${item.title}（${item.payoffHorizon}）`).join('；')}` : '待兑现读者承诺：无',
    active ? `本任务编译：${active.id}，chapterId=${active.chapterId ?? '尚未创建'}，目标第 ${active.targetOrderIndex} 章，阶段 ${active.stage}，状态 ${active.status}，Scene Task ${active.sceneTasks.length} 个。${resume}` : '本任务没有编译记录。可直接使用普通正文工具，按需要准备上下文或记录场景。',
    chapter ? `当前正文 r${chapter.revision}，${hasBody ? `非空 ${chapter.content.trim().length} 字` : '正文为空，未写完'}；提纲一致性=${planNeedsReview ? 'needs-review' : review?.planAlignment ?? '未绑定提纲'}；当前连续性报告=${review?.continuity ?? 'missing'}，人类感质量报告=${review?.quality ?? 'missing'}；报告剩余意见=${review?.decisionEntries?.length ?? 0}，已明确保留=${review?.retainedDecisions?.length ?? 0}。报告完成、意见已修复、明确保留和章节已提交分别说明。${review?.requiredTools.length ? `当前尚无有效报告的检查：${review.requiredTools.map(tool => tool.name).join('、')}。` : ''}` : '',
    active && chapter ? `当前有效质量报告编号=${review?.qualityReportId ?? '无'}；最近已存质量报告=${latestQuality ? `${latestQuality.id}（revision=${latestQuality.chapterRevision}，${latestQuality.status}）` : '无'}；历史连续性记录 revision=${historicalValidation.checkedRevision ?? '未知'}。历史或独立报告不能代替当前编译与最终正文绑定的必要检查；缺失或旧版本报告不代表通过。` : '',
    active ? '初稿流程：本任务冻结的新建目标章可在原写作权限内持续修订。先核对对象身份与原文证据，仅将同一对象同一维度的互斥事实视为冲突，不照 suggestion 机械改剧情。相关修法优先合并为 chapter_edit_range patches（每次最多8处），也可连续单片段替换或 chapter_write；不硬性限定一次调用。每次使用当前正文与版本，不要求每次覆盖全部意见；全部修改后复核最终版本。已有章节与明确禁止修改的请求仍按原权限处理。自动局部修订后复查最终版本，原用量或费用未知时先核对，不为清零警告循环改写，剩余意见保留真实状态。' : '',
    latestBridge?.toChapter ? `最近已提交桥（仅作背景，不证明本任务完成）：第 ${latestBridge.toChapter.orderIndex} 章《${latestBridge.toChapter.title}》，提交 r${latestBridge.targetRevision ?? '未知'}，当前 r${latestBridge.toChapter.revision}；未完成动作：${latestBridge.lastUnfinishedAction || '无'}；开放钩子：${asStringArray(latestBridge.openLoops).slice(0, 4).join('、') || '无'}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}
