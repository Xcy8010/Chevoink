import { createHash } from 'node:crypto'

import type { Prisma, StoryCompilationStage, StoryCharter, ReaderPromise, SceneTask } from '@prisma/client'

import type {
  ContinuityFindingInput,
  ReaderPromiseInput,
  SceneTaskInput,
  StoryCharterInput,
  StoryCompilerMode,
  StoryState,
} from '../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { saveStoryMemory } from './story-memory.js'
import { qualityReportMatchesContent } from './quality-report-contract.js'

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

export function continuityRepairRounds(validation: unknown): number {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return 0
  const value = (validation as Record<string, unknown>).autoRepairRounds
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Reserve before dispatch, so crashes/resumes cannot restart an automatic repair loop. */
export async function reserveContinuityRepair(userId: string, novelId: string, compilationId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM story_compilations WHERE id = ${compilationId} AND user_id = ${userId} AND novel_id = ${novelId} FOR UPDATE`
    const compilation = await tx.storyCompilation.findFirst({ where: { id: compilationId, userId, novelId, status: 'active' } })
    if (!compilation || continuityRepairRounds(compilation.validation) >= MAX_CONTINUITY_AUTO_REPAIRS) return false
    const previous = compilation.validation && typeof compilation.validation === 'object' && !Array.isArray(compilation.validation) ? compilation.validation : {}
    await tx.storyCompilation.update({ where: { id: compilationId }, data: {
      validation: { ...previous, autoRepairRounds: continuityRepairRounds(previous) + 1 } as Prisma.InputJsonValue,
    } })
    return true
  })
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

export async function upsertStoryCharter(userId: string, novelId: string, input: StoryCharterInput, db: Prisma.TransactionClient = prisma) {
  await assertOwnedNovel(userId, novelId, db)
  const data = {
    ...input,
    genreRules: input.genreRules as Prisma.InputJsonValue,
    abilityCosts: input.abilityCosts as Prisma.InputJsonValue,
    realityBoundaries: input.realityBoundaries as Prisma.InputJsonValue,
    styleDna: input.styleDna as Prisma.InputJsonValue,
    forbiddenZones: input.forbiddenZones as Prisma.InputJsonValue,
    antiExamples: input.antiExamples as Prisma.InputJsonValue,
  }
  const existing = await db.storyCharter.findUnique({ where: { novelId } })
  // A repeated identical save is not a new revision or new writing progress.
  if (existing && Object.entries(data).every(([key, value]) =>
    JSON.stringify(existing[key as keyof typeof existing]) === JSON.stringify(value))) return existing
  return db.storyCharter.upsert({
    where: { novelId },
    create: { userId, novelId, ...data },
    update: { ...data, revision: { increment: 1 } },
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
  targetOrderIndex?: number
  mode: StoryCompilerMode
  intentSummary: string
}, transaction?: Prisma.TransactionClient): Promise<{ compilation: Prisma.StoryCompilationGetPayload<{ include: { bridge: true } }>; charter: StoryCharter | null; promises: ReaderPromise[]; bridge: PreparedBridge }> {
  if (!transaction) return prisma.$transaction(tx => prepareStoryCompilation(input, tx))
  const db = transaction
  await lockNovelActiveScope(db, input.novelId)
  const scope = await compilationRunScope(db, input)
  await assertOwnedNovel(input.userId, input.novelId, db)
  const target = await resolveTarget(input.userId, input.novelId, input.chapterId, input.targetOrderIndex, db)
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
  const priorBridge = previousChapter
    ? await db.chapterBridge.findFirst({
        where: { userId: input.userId, novelId: input.novelId, toChapterId: previousChapter.id, committedAt: { not: null } },
        orderBy: { committedAt: 'desc' },
      })
    : null
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
    lastUnfinishedAction: priorBridge?.lastUnfinishedAction ?? '',
    location: priorBridge?.location ?? '',
    storyTime: priorBridge?.storyTime ?? '',
    knowledgeState: asStringArray(priorBridge?.knowledgeState),
    bodyState: asStringArray(priorBridge?.bodyState),
    objectState: asStringArray(priorBridge?.objectState),
    relationshipState: asStringArray(priorBridge?.relationshipState),
    emotionAftermath: asStringArray(priorBridge?.emotionAftermath),
    hookDecision: priorBridge?.hookDecision ?? '',
    delayedHookReason: priorBridge?.delayedHookReason ?? '',
    recentOpenings: recentChapters.map((chapter) => `${chapter.title}：${firstParagraph(chapter.content)}`).filter((item) => !item.endsWith('：')),
    recentEndings: recentChapters.map((chapter) => `${chapter.title}：${lastParagraph(chapter.content)}`).filter((item) => !item.endsWith('：')),
    openLoops: priorBridge ? asStringArray(priorBridge.openLoops) : memory.filter((item) => item.memoryType === 'foreshadowing').map((item) => `${item.title}：${clip(item.content, 240)}`),
  }

  const priorRepairStates = await db.storyCompilation.findMany({
    where: { userId: input.userId, novelId: input.novelId, ...scope, targetOrderIndex: target.targetOrderIndex },
    select: { validation: true },
  })
  const autoRepairRounds = Math.max(0, ...priorRepairStates.map(item => continuityRepairRounds(item.validation)))
  await db.storyCompilation.updateMany({
    where: { userId: input.userId, novelId: input.novelId, ...scope, status: 'active' },
    data: { status: 'abandoned' },
  })
  const preparedContext = {
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
      ...(autoRepairRounds > 0 ? { validation: { autoRepairRounds } } : {}),
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
  return { compilation, charter: bundle.charter, promises: bundle.promises, bridge }
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
  if (input.tasks.length < 1 || input.tasks.length > 4) {
    throw new DataAccessError(400, 'SCENE_TASK_COUNT_INVALID', '每章必须建立 1–4 个 Scene Task。')
  }
  await tx.$queryRaw`SELECT id FROM story_compilations WHERE id = ${input.compilationId} AND user_id = ${input.userId} AND novel_id = ${input.novelId} FOR UPDATE`
  const compilation = await tx.storyCompilation.findFirst({
    where: { id: input.compilationId, userId: input.userId, novelId: input.novelId, status: 'active' },
  })
  if (!compilation) throw new DataAccessError(404, 'COMPILATION_NOT_FOUND', '写作编译任务不存在、已结束或不属于当前作品。')
  if (!['prepare', 'beat'].includes(compilation.stage)) {
    throw new DataAccessError(409, 'COMPILATION_STAGE_CONFLICT', `当前已进入 ${compilation.stage} 阶段，不能覆盖场景任务。`)
  }
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
      stage: 'beat',
      preparedContext: { ...context, beatCandidates } as Prisma.InputJsonValue,
    },
  })
  return tx.sceneTask.findMany({ where: { compilationId: compilation.id }, orderBy: { ordinal: 'asc' } })
}

/** Only explicit durable identity joins runs; historical conversation is not authority. */
async function compilationRunScope(db: Prisma.TransactionClient, input: { userId: string; novelId: string; runId: string }): Promise<Prisma.StoryCompilationWhereInput> {
  const run = await db.agentRun.findFirst({ where: { id: input.runId, userId: input.userId, novelId: input.novelId }, select: { taskRootId: true, runtimeProtocolVersion: true } })
  if (!run) throw new DataAccessError(404, 'RUN_NOT_FOUND', '章节编译运行不存在或不属于当前任务。')
  if (run.runtimeProtocolVersion > 0 && !run.taskRootId) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '持久运行缺少原任务身份。')
  return run.taskRootId ? { run: { taskRootId: run.taskRootId } } : { runId: input.runId }
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
  const scope = await compilationRunScope(transaction, input)
  const compilation = await transaction.storyCompilation.findFirst({
    where: {
      userId: input.userId,
      novelId: input.novelId,
      ...scope,
      status: 'active',
      OR: [{ chapterId: input.chapterId }, { chapterId: null, targetOrderIndex: input.chapterOrderIndex }],
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!compilation) return null
  const stage: StoryCompilationStage = compilation.stage === 'check' ? 'repair' : 'write'
  await transaction.storyCompilation.update({
      where: { id: compilation.id },
      data: { chapterId: input.chapterId, stage },
    })
  await transaction.sceneTask.updateMany({
      where: { compilationId: compilation.id },
      data: { chapterId: input.chapterId, status: 'writing' },
    })
  await transaction.chapterBridge.update({
      where: { compilationId: compilation.id },
      data: { toChapterId: input.chapterId, targetRevision: input.chapterRevision },
    })
  return { compilationId: compilation.id, stage }
}

export async function validateStoryContinuity(input: {
  userId: string
  novelId: string
  compilationId: string
  findings: ContinuityFindingInput[]
  expectedChapterRevision?: number
  independentCheck?: 'complete' | 'unavailable'
  coverage?: { version: 1; contentHash: string; charCount: number; sourceHash: string | null }
}, transaction?: Prisma.TransactionClient): Promise<{ checkedChapterId: string; checkedRevision: number; checkedAt: string; independentCheck: 'complete' | 'unavailable'; findings: ContinuityFindingInput[]; errorCount: number; warningCount: number }> {
  if (!transaction) return prisma.$transaction(tx => validateStoryContinuity(input, tx))
  const db = transaction
  await lockNovelActiveScope(db, input.novelId)
  await db.$queryRaw`SELECT id FROM story_compilations WHERE id = ${input.compilationId} AND user_id = ${input.userId} AND novel_id = ${input.novelId} FOR UPDATE`
  const compilation = await db.storyCompilation.findFirst({
    where: { id: input.compilationId, userId: input.userId, novelId: input.novelId, status: 'active' },
    include: { bridge: true, sceneTasks: true, chapter: { select: { id: true, revision: true, content: true, orderIndex: true } } },
  })
  if (!compilation) throw new DataAccessError(404, 'COMPILATION_NOT_FOUND', '写作编译任务不存在、已结束或不属于当前作品。')
  if (!compilation.chapter || !compilation.bridge) {
    throw new DataAccessError(409, 'COMPILATION_NOT_WRITTEN', '目标章节尚未完成写入，不能进入连续性检查。')
  }
  if (!await db.chapter.findFirst({ where: { id: compilation.chapter.id, authorId: input.userId, ...activeChapterScope(input.novelId) }, select: { id: true } })) {
    throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '目标章节已归档，旧检查不能作用于当前稿件。')
  }
  if (input.expectedChapterRevision !== undefined && compilation.chapter.revision !== input.expectedChapterRevision) {
    throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '独立检查期间正文已变化，旧结果不能验证新revision。请重新检查当前正文。')
  }
  const deterministic: ContinuityFindingInput[] = []
  if (compilation.sceneTasks.length < 1 || compilation.sceneTasks.length > 4) {
    deterministic.push({ signal: 'structure', severity: 'error', evidence: `场景任务数量为 ${compilation.sceneTasks.length}，要求 1–4 个。`, suggestion: '先补齐或收敛 Scene Task 再检查正文。' })
  }
  if (compilation.chapter.orderIndex !== compilation.targetOrderIndex) {
    deterministic.push({ signal: 'structure', severity: 'error', evidence: `目标为全书第 ${compilation.targetOrderIndex} 章，实际写入第 ${compilation.chapter.orderIndex} 章。`, suggestion: '停止提交并核对卷章位置。' })
  }
  if (!compilation.chapter.content.trim()) {
    deterministic.push({ signal: 'structure', severity: 'error', evidence: '目标章节正文为空。', suggestion: '完成正文后再提交章节桥。' })
  }
  if (compilation.bridge.fromChapterId && compilation.bridge.sourceRevision !== null) {
    const source = await db.chapter.findFirst({
      where: { id: compilation.bridge.fromChapterId, ...activeChapterScope(input.novelId) },
      select: { revision: true, title: true },
    })
    if (!source || source.revision !== compilation.bridge.sourceRevision) {
      deterministic.push({ signal: 'structure', severity: 'error', evidence: source ? `桥接来源《${source.title}》已从 r${compilation.bridge.sourceRevision} 变为 r${source.revision}。` : '桥接来源章节已不存在。', suggestion: '重新执行 story_compiler_prepare，基于最新前章生成桥接。' })
    }
  }
  const findings = [...deterministic, ...input.findings]
  const validation = {
    autoRepairRounds: continuityRepairRounds(compilation.validation),
    checkedChapterId: compilation.chapter.id,
    checkedRevision: compilation.chapter.revision,
    checkedAt: new Date().toISOString(),
    independentCheck: input.independentCheck ?? 'unavailable' as const,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    findings,
    errorCount: findings.filter((item) => item.severity === 'error').length,
    warningCount: findings.filter((item) => item.severity === 'warning').length,
  }
  await db.storyCompilation.update({
    where: { id: compilation.id },
    data: { stage: 'check', validation: validation as Prisma.InputJsonValue },
  })
  return validation
}

export async function commitChapterBridge(input: {
  userId: string
  novelId: string
  compilationId: string
  chapterSummary: string
  exitState: StoryState
  lastUnfinishedAction: string
  hookDecision: string
  delayedHookReason: string
  openingStructure: string
  endingStructure: string
  requireQuality?: boolean
  qualityReportId?: string
}, transaction?: Prisma.TransactionClient): Promise<{ compilationId: string; chapterId: string; chapterRevision: number; skippedMemoryCount: number }> {
  if (!transaction) return prisma.$transaction(tx => commitChapterBridge(input, tx))
  const db = transaction
  await lockNovelActiveScope(db, input.novelId)
  await db.$queryRaw`SELECT id FROM story_compilations WHERE id = ${input.compilationId} AND user_id = ${input.userId} AND novel_id = ${input.novelId} FOR UPDATE`
  const compilation = await db.storyCompilation.findFirst({
    where: { id: input.compilationId, userId: input.userId, novelId: input.novelId, status: 'active' },
    include: { bridge: true, sceneTasks: true, chapter: true },
  })
  if (!compilation?.chapter || !compilation.bridge) {
    throw new DataAccessError(404, 'COMPILATION_NOT_FOUND', '写作编译任务不存在、未写入章节或不属于当前作品。')
  }
  await db.$queryRaw`SELECT id FROM chapters WHERE id = ${compilation.chapter.id} FOR UPDATE`
  const chapter = await db.chapter.findFirst({ where: { id: compilation.chapter.id, authorId: input.userId, ...activeChapterScope(input.novelId) }, select: { revision: true, content: true } })
  if (!chapter) throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '目标章节已归档，不能提交旧章节桥。')
  const validation = compilation.validation as { checkedRevision?: number; errorCount?: number; independentCheck?: string } | null
  if (chapter.revision !== compilation.chapter.revision || chapter.content !== compilation.chapter.content || validation?.independentCheck !== 'complete') {
    throw new DataAccessError(409, 'CONTINUITY_CHECK_REQUIRED', '当前章节尚未完成独立连续性复核，不能把确定性兜底或旧报告当作通过。')
  }
  if (!validation || validation.checkedRevision !== compilation.chapter.revision) {
    throw new DataAccessError(409, 'CONTINUITY_CHECK_REQUIRED', '必须先对当前章节最新 revision 执行 continuity_validate。')
  }
  if ((validation.errorCount ?? 0) > 0) {
    throw new DataAccessError(409, 'CONTINUITY_ERRORS_REMAIN', `仍有 ${validation.errorCount} 个连续性错误，修复并重新检查后才能提交章节桥。`)
  }
  if (input.requireQuality) {
    const report = input.qualityReportId ? await db.chapterQualityReport.findFirst({ where: { id: input.qualityReportId, userId: input.userId, novelId: input.novelId,
      chapterId: compilation.chapter.id, chapterRevision: chapter.revision }, include: { findings: true } }) : null
    if (!report || !qualityReportMatchesContent(report, chapter.revision, chapter.content)
      || report.compilationId && report.compilationId !== compilation.id
      || report.findings.some(finding => finding.severity === 'error' && finding.disposition !== 'repaired')) {
      throw new DataAccessError(409, 'QUALITY_CHECK_REQUIRED', '当前正文没有完整且匹配的独立质量检查，不能使用失败、旧版或其他编译的报告提交。')
    }
  }
  if (compilation.bridge.fromChapterId) {
    await db.$queryRaw`SELECT id FROM chapters WHERE id = ${compilation.bridge.fromChapterId} FOR SHARE`
    const source = await db.chapter.findFirst({ where: { id: compilation.bridge.fromChapterId, ...activeChapterScope(input.novelId) }, select: { revision: true } })
    if (!source || source.revision !== compilation.bridge.sourceRevision) throw new DataAccessError(409, 'CONTINUITY_CHECK_REQUIRED', '桥接来源章节已变化，请重新准备并检查，不沿用旧桥提交。')
  }
  const now = new Date()
  await Promise.all([
    db.chapterBridge.update({
      where: { id: compilation.bridge.id },
      data: {
        targetRevision: compilation.chapter.revision,
        lastUnfinishedAction: input.lastUnfinishedAction,
        location: input.exitState.location ?? '',
        storyTime: input.exitState.storyTime ?? '',
        knowledgeState: input.exitState.knowledge,
        bodyState: input.exitState.body,
        objectState: input.exitState.objects,
        relationshipState: input.exitState.relationships,
        emotionAftermath: input.exitState.emotion,
        hookDecision: input.hookDecision,
        delayedHookReason: input.delayedHookReason,
        recentOpenings: [...asStringArray(compilation.bridge.recentOpenings), input.openingStructure].filter(Boolean).slice(-3),
        recentEndings: [...asStringArray(compilation.bridge.recentEndings), input.endingStructure].filter(Boolean).slice(-3),
        openLoops: input.exitState.openLoops,
        committedAt: now,
      },
    }),
    db.sceneTask.updateMany({ where: { compilationId: compilation.id }, data: { status: 'completed' } }),
    db.storyCompilation.update({
      where: { id: compilation.id },
      data: { stage: 'commit', status: 'completed', completedAt: now },
    }),
  ])
  // Optional memory proposals must respect author tombstones without rolling
  // back an independently validated chapter. All other errors still roll back.
  let skippedMemoryCount = 0
  const saveProposal = async (memory: Parameters<typeof saveStoryMemory>[0]) => {
    try { await saveStoryMemory({ ...memory, agentGenerated: true }, db) }
    catch (error) {
      if (!(error instanceof DataAccessError) || error.code !== 'MEMORY_DELETED') throw error
      skippedMemoryCount += 1
    }
  }
  await Promise.all([
    saveProposal({
      userId: input.userId,
      novelId: input.novelId,
      runId: compilation.runId,
      sourceChapterId: compilation.chapter.id,
      memoryType: 'chapterSummary',
      layer: 'L2',
      title: compilation.chapter.title,
      content: input.chapterSummary,
      importance: 75,
      confidence: 1,
      status: 'confirmed',
      evidence: { sourceType: 'chapter', sourceId: compilation.chapter.id, revision: compilation.chapter.revision, confidence: 1 },
    }),
    saveProposal({
      userId: input.userId,
      novelId: input.novelId,
      runId: compilation.runId,
      sourceChapterId: compilation.chapter.id,
      memoryType: 'sceneState',
      layer: 'L2',
      title: `${compilation.chapter.title}终态`,
      content: [input.exitState.action, input.exitState.location, input.exitState.storyTime, ...input.exitState.openLoops].filter(Boolean).join('；') || input.chapterSummary,
      importance: 80,
      confidence: 1,
      status: 'confirmed',
      evidence: { sourceType: 'chapter', sourceId: compilation.chapter.id, revision: compilation.chapter.revision, confidence: 1 },
    }),
  ])
  return { compilationId: compilation.id, chapterId: compilation.chapter.id, chapterRevision: compilation.chapter.revision, skippedMemoryCount }
}

export async function buildStoryCompilerDigest(userId: string, novelId: string, chapterId: string | null) {
  const [bundle, active, latestBridge] = await Promise.all([
    getStoryCharterBundle(userId, novelId),
    prisma.storyCompilation.findFirst({
      where: { userId, novelId, status: 'active', ...(chapterId ? { OR: [{ chapterId }, { chapterId: null }] } : {}) },
      orderBy: { updatedAt: 'desc' },
      include: { sceneTasks: { orderBy: { ordinal: 'asc' } }, bridge: true },
    }),
    prisma.chapterBridge.findFirst({
      where: { userId, novelId, committedAt: { not: null } },
      orderBy: { committedAt: 'desc' },
      include: { toChapter: { select: { title: true, orderIndex: true, revision: true } } },
    }),
  ])
  if (!bundle.charter && !active && !latestBridge) return null
  const lines = [
    'Story Compiler 3.0 状态：',
    bundle.charter ? `创作宪章 r${bundle.charter.revision}：${clip(bundle.charter.oneLinePromise, 240)}` : '创作宪章：尚未建立（新书长纲前应先建立）',
    bundle.promises.length ? `待兑现读者承诺：${bundle.promises.slice(0, 5).map((item) => `${item.title}（${item.payoffHorizon}）`).join('；')}` : '待兑现读者承诺：无',
    active ? `当前编译：${active.id}，目标第 ${active.targetOrderIndex} 章，阶段 ${active.stage}，Scene Task ${active.sceneTasks.length} 个` : '',
    latestBridge?.toChapter ? `最近已提交桥：第 ${latestBridge.toChapter.orderIndex} 章《${latestBridge.toChapter.title}》r${latestBridge.toChapter.revision}；未完成动作：${latestBridge.lastUnfinishedAction || '无'}；开放钩子：${asStringArray(latestBridge.openLoops).slice(0, 4).join('、') || '无'}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}
