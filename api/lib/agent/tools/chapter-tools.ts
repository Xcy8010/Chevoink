import { readSemanticStructureHash } from '../semantic-progress.js'
import { assertWritingTarget, bindWritingChapter, readWritingScope, resolveWritingCreateTarget } from '../writing-scope.js'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'

import { DataAccessError, prisma } from '../../prisma.js'
import { getChapterBaseline, getCreatedChapter, getLastTouchedChapter, recordChapterBaseline, recordCreatedChapter } from '../baseline.js'
import { activeChapterScope, recalculateNovelStats } from '../../data/internal.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import { assertChapterReviewRevision, type ChapterReviewRevisionOptions } from '../chapter-review-guard.js'
import { defineTool, type ToolContext, type ToolResult } from './types.js'
import { placeCreatedChapter, resolveChapterPlacement } from '../../data/volume.js'
import { enqueueChapterMemoryExtraction } from '../story-memory.js'
import { isAgent2FeatureEnabled } from '../../agent2-feature-flags.js'
import { resolveAgentChapterVolumeId } from './chapter-placement.js'
import { recordStoryCompilerWrite } from '../story-compiler.js'
import { assertCraftOutputSafe } from '../craft-library.js'
import { executeDurableChapter } from './durable-chapter.js'
import { executeDurableCreate } from './durable-create.js'
import { chapterWriteArguments, chapterAppendArguments, chapterEditArguments } from './chapter-arguments.js'
import { composeChapterEdit } from './chapter-patches.js'

/**
 * 章节写工具集（自 write-tools.ts 模块级拆分而来，工具定义逐字保留）：
 * 新建/覆盖/追加/区间改写/重命名，统一走基线冲突检测与作品统计重算。
 */

const WRITE_PERMISSION = { plan: 'deny', build: 'allow', review: 'deny' } as const

async function findOwnedChapter(ctx: ToolContext, chapterId: string) {
  return (ctx.transaction ?? prisma).chapter.findFirst({
    where: { id: chapterId, ...activeChapterScope(ctx.novelId), authorId: ctx.userId },
  })
}

/** chapterId 兜底：模型写长正文时经常漏传 chapterId，与其打回重试（重发整章又贵又易错），
 * 不如服务端直接补：优先本 run 最近读/写过的章节，其次作者当前打开的章节 */
function resolveChapterId(ctx: ToolContext, chapterId: string | undefined): string | null {
  const trimmed = chapterId?.trim()
  if (trimmed) {
    return trimmed
  }
  return ctx.durableContent?.chapterId ?? getLastTouchedChapter(ctx.runId) ?? ctx.chapterId
}

const MISSING_CHAPTER_HINT =
  '未传 chapterId 且当前没有正在编辑的章节。请先用 novel_get_context 查看章节列表拿到 chapterId，或用 chapter_create 新建章节。'

/** 章节不存在时附带当前章节提示，帮模型一次性纠错而不是盲猜 */
function buildChapterNotFound(ctx: ToolContext, chapterId: string): ToolResult {
  const hint = ctx.chapterId && ctx.chapterId !== chapterId ? `作者当前打开的章节是 chapterId=${ctx.chapterId}。` : ''
  return {
    outcome: 'failed',
    output: `章节 ${chapterId} 已归档、不存在或不属于当前作品。${hint}请用 novel_get_context 查看当前章节列表；不要按同序号替换旧章节 ID。`,
  }
}

/** 基线冲突检测：用户在 Agent 运行期间改过章节时不盲写 */
function buildConflictResult(chapterTitle: string): ToolResult {
  return {
    outcome: 'failed',
    output: `冲突：章节《${chapterTitle}》在你上次读取后已被修改或归档。请先用 chapter_read 重新读取当前内容，再决定如何写入，避免覆盖用户的修改。`,
    summary: `《${chapterTitle}》存在编辑冲突，已阻止写入`,
  }
}

function assertChapterMutable(ctx: ToolContext, chapter: { id: string; title: string }) {
  if (ctx.protectedChapterIds?.has(chapter.id)) {
    throw new DataAccessError(
      409,
      'AUTHOR_SCOPE_PROTECTED',
      `作者明确要求前文保持不变，章节《${chapter.title}》属于本轮开始前已有内容，禁止写入、改名或改动结构。请只操作本轮新建章节。`,
    )
  }
}

/** 把“读当前版本 → 写入”收敛为单条带 revision 条件的原子更新。 */
async function updateOwnedChapterAtRevision(
  ctx: ToolContext,
  chapter: { id: string; revision: number; content?: string },
  data: Prisma.ChapterUpdateManyMutationInput,
  mutation?: ChapterReviewRevisionOptions['mutation'],
  mergedBatch = false,
  review?: Pick<ChapterReviewRevisionOptions, 'retainedFindings' | 'editRanges'>,
) {
  const apply = async (tx: Prisma.TransactionClient) => {
    await assertAgentManuscriptCurrent(tx, ctx)
    await assertWritingTarget(tx, ctx, { chapterId: chapter.id })
    if (typeof data.content === 'string' && data.content === chapter.content) {
      if (review?.retainedFindings?.length) await assertChapterReviewRevision(tx, ctx, chapter, { mutation, mergedBatch, ...review, after: data.content })
      // Authenticate the still-active revision inside the transaction even for
      // a no-op. It must spend neither a manuscript CAS nor a merged correction.
      return tx.chapter.findFirst({ where: { id: chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId, revision: chapter.revision } })
    }
    const consumeReviewRevision = data.content !== undefined ? await assertChapterReviewRevision(tx, ctx, chapter, { mutation, mergedBatch, ...review,
      ...(typeof data.content === 'string' ? { after: data.content } : {}) }) : undefined
    const result = await tx.chapter.updateMany({
      where: {
        id: chapter.id,
        ...activeChapterScope(ctx.novelId),
        authorId: ctx.userId,
        revision: chapter.revision,
      },
      data: { ...data, revision: { increment: 1 } },
    })
    if (result.count !== 1) return null
    await consumeReviewRevision?.()
    // Keep the returned revision/body bound to our CAS while its row lock is
    // held, rather than observing a subsequent writer through the global client.
    const updated = await tx.chapter.findFirst({ where: {
      id: chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId, revision: chapter.revision + 1,
    } })
    if (!updated) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '写入后的章节作用域已变化，本次事务需要回滚。')
    return updated
  }
  return ctx.transaction ? apply(ctx.transaction) : prisma.$transaction(apply)
}

async function writeChapterContent(
  ctx: ToolContext,
  chapterId: string,
  buildNextContent: (current: string) => string,
  actionLabel: string,
  leakageCandidate: string,
  mutation: 'replace' | 'append',
  retainedFindings?: ChapterReviewRevisionOptions['retainedFindings'],
): Promise<ToolResult> {
  const chapter = await findOwnedChapter(ctx, chapterId)

  if (!chapter) {
    return buildChapterNotFound(ctx, chapterId)
  }
  assertChapterMutable(ctx, chapter)

  const baseline = getChapterBaseline(ctx.runId, chapter.id)
  if (baseline !== null && baseline !== chapter.revision) {
    return buildConflictResult(chapter.title)
  }

  const before = chapter.content
  const after = buildNextContent(before)

  if (isAgent2FeatureEnabled('craftLibrary', ctx.userId) && leakageCandidate.trim().length >= 80) {
    await assertCraftOutputSafe({
      userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: chapter.id, content: leakageCandidate,
    })
  }

  const updated = await updateOwnedChapterAtRevision(ctx, chapter, {
    content: after,
    wordCount: after.length,
  }, mutation, false, { retainedFindings })
  if (!updated) {
    return buildConflictResult(chapter.title)
  }
  if (after === before) return unchangedChapterResult(chapter)
  await recalculateNovelStats(ctx.transaction ?? prisma, ctx.novelId)
  if (!ctx.transaction) recordChapterBaseline(ctx.runId, chapter.id, updated.revision)
  if (isAgent2FeatureEnabled('memory2', ctx.userId)) {
    await enqueueChapterMemoryExtraction({
      novelId: ctx.novelId, chapterId: chapter.id, chapterRevision: updated.revision, before, after,
    }, ctx.transaction)
  }
  if (isAgent2FeatureEnabled('storyCompiler', ctx.userId)) {
    await recordStoryCompilerWrite({
      userId: ctx.userId,
      novelId: ctx.novelId,
      runId: ctx.runId,
      chapterId: updated.id,
      chapterOrderIndex: updated.orderIndex,
      chapterRevision: updated.revision,
    }, ctx.transaction)
  }

  return {
    output: `已${actionLabel}章节《${chapter.title}》，当前正文 ${after.length} 字。`,
    summary: `${actionLabel}《${chapter.title}》 · ${after.length} 字`,
    display: {
      kind: 'chapterDiff',
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      before,
      after,
      appliedDirectly: true,
      revision: updated.revision,
    },
    snapshot: { target: 'chapter', targetId: chapter.id, field: 'content', previousValue: before },
  }
}

function unchangedChapterResult(chapter: { id: string; title: string; content: string; revision: number }): ToolResult {
  return { output: `章节《${chapter.title}》正文未变化。`, summary: `未变化《${chapter.title}》 · ${chapter.content.length} 字`,
    display: { kind: 'chapterDiff', chapterId: chapter.id, chapterTitle: chapter.title, before: chapter.content, after: chapter.content,
      appliedDirectly: true, revision: chapter.revision } }
}

export const chapterCreateTool = defineTool({
  name: 'chapter_create',
  title: '新建章节',
  description:
    '在当前作品原子创建一个新章节。作者说“全书第 N 章”时只传 position=N；作者说“第 M 卷第 N 章/卷内第 N 章”时必须传 volumeOrder=M（或 volumeId）与 positionInVolume=N，严禁改用全书 position，严禁先建到错误卷再移动。未指定位置时紧接全书最后一个已有章节。仅用于新增章节；重写已有章节必须用 chapter_write。创建成功后必须复用返回的 chapterId 写正文，绝不要重复创建同名章。',
  parameters: z.object({
    title: z.string().min(1).max(120).describe('章节标题'),
    content: z.string().optional().describe('章节正文，可留空'),
    position: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('全书插入位置（仅“全书第 N 章”使用）。不得与 volumeId/volumeOrder/positionInVolume 混用'),
    volumeId: z.string().min(1).optional().describe('目标卷 ID；缺省时使用全书最后一个已有章节所在卷，而不是后方空卷'),
    volumeOrder: z.number().int().min(1).optional().describe('目标卷显示序号，例如“第二卷”传 2；与 volumeId 二选一'),
    positionInVolume: z.number().int().min(1).optional().describe('目标卷内位置；必须同时传 volumeId 或 volumeOrder'),
  }).superRefine((args, refinement) => {
    const hasExplicitVolume = Boolean(args.volumeId) || args.volumeOrder !== undefined
    if (args.volumeId && args.volumeOrder !== undefined) {
      refinement.addIssue({ code: 'custom', path: ['volumeOrder'], message: 'volumeId 与 volumeOrder 只能传一个' })
    }
    if (args.positionInVolume !== undefined && !hasExplicitVolume) {
      refinement.addIssue({ code: 'custom', path: ['positionInVolume'], message: '卷内位置必须同时指定 volumeId 或 volumeOrder' })
    }
    if (args.position !== undefined && (hasExplicitVolume || args.positionInVolume !== undefined)) {
      refinement.addIssue({ code: 'custom', path: ['position'], message: '全书位置不得与卷内位置混用；第 M 卷第 N 章请只传 volumeOrder/volumeId + positionInVolume' })
    }
  }),
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args): Promise<ToolResult> {
    const content = args.content ?? ''
    if (!ctx.transaction && isAgent2FeatureEnabled('craftLibrary', ctx.userId) && content.trim().length >= 80) {
      await assertCraftOutputSafe({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, content })
    }
    if (ctx.durableCreate) {
      const captured = { ...ctx, protectedChapterIds: new Set(ctx.protectedChapterIds), toolAuthority: new Map(ctx.toolAuthority), durableCreate: { ...ctx.durableCreate, lease: { ...ctx.durableCreate.lease }, cursor: { ...ctx.durableCreate.cursor } } }
      const normalize = (raw: unknown) => {
        const parsed = chapterCreateTool.parameters.parse(raw)
        return Object.fromEntries(Object.entries({ ...parsed, title: parsed.title.trim() }).filter(([, value]) => value !== undefined))
      }
      const effective = chapterCreateTool.parameters.parse(normalize(args))
      return executeDurableCreate(captured, effective, normalize, tx => chapterCreateTool.execute({ ...captured, durableCreate: undefined, transaction: tx }, effective))
    }
    const alreadyCreatedId = ctx.transaction ? undefined : getCreatedChapter(ctx.runId, args.title) ?? undefined
    if (alreadyCreatedId && !await findOwnedChapter(ctx, alreadyCreatedId)) return buildChapterNotFound(ctx, alreadyCreatedId)
    let semanticTransition: ToolResult['semanticTransition']
    const create = async (tx: Prisma.TransactionClient) => {
      ctx.signal.throwIfAborted()
      await assertAgentManuscriptCurrent(tx, ctx)
      const { slot, volumeId: requestedVolumeId, chapters } = await resolveWritingCreateTarget(tx, ctx, args, alreadyCreatedId)
      const frozen = await readWritingScope(tx, ctx)
      {
        const boundId = slot?.chapterId ?? frozen.bindings?.targets.find(item => item.orderIndex === slot?.orderIndex)?.chapterId ?? alreadyCreatedId
        if (boundId) {
          const existing = await tx.chapter.findFirst({ where: { id: boundId, authorId: ctx.userId, ...activeChapterScope(ctx.novelId) }, include: { volume: { select: { title: true, orderIndex: true } } } })
          if (!existing) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '原目标章节已归档或消失，不能创建替代身份。')
          ctx.signal.throwIfAborted()
          return { ...existing, scopeReused: true }
        }
      }
      const beforeHash = await readSemanticStructureHash(tx, ctx.novelId)
      const effectivePosition = slot?.orderIndex ?? args.position
      const globalTarget = effectivePosition
        ? await tx.chapter.findFirst({ where: { ...activeChapterScope(ctx.novelId), orderIndex: effectivePosition } })
        : null
      const lastExisting = await tx.chapter.findFirst({
        where: activeChapterScope(ctx.novelId),
        orderBy: { orderIndex: 'desc' },
        select: { volumeId: true },
      })
      const placement = await resolveChapterPlacement(
        tx,
        ctx.novelId,
        resolveAgentChapterVolumeId({
          requestedVolumeId: slot?.volumeId ?? requestedVolumeId,
          globalTargetVolumeId: globalTarget?.volumeId,
          lastExistingVolumeId: lastExisting?.volumeId,
        }),
        slot?.positionInVolume ?? args.positionInVolume ?? globalTarget?.orderInVolume,
      )
      // The placement API clamps positions. Frozen slots must match the actual
      // insertion, never the unclamped request that happened to name a slot.
      const resolvedOrder = slot ? chapters.filter(item => item.volume.orderIndex < placement.volume.orderIndex).length + placement.position + 1 : null
      if (slot && (resolvedOrder !== slot.orderIndex || slot.volumeId && placement.volume.id !== slot.volumeId
        || slot.positionInVolume !== undefined && placement.position + 1 !== slot.positionInVolume)) {
        throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '实际创建位置不匹配原始请求的冻结章节目标，本次未创建章节。')
      }
      const chapterCount = await tx.chapter.count({ where: activeChapterScope(ctx.novelId) })
      ctx.signal.throwIfAborted()
      const created = await tx.chapter.create({
        data: {
          novelId: ctx.novelId,
          authorId: ctx.userId,
          title: args.title.trim(),
          content,
          volumeId: placement.volume.id,
          orderInVolume: -(placement.count + 1),
          orderIndex: -(chapterCount + 1),
          wordCount: content.length,
          status: 'draft',
          visibility: 'public',
        },
      })
      await placeCreatedChapter(tx, ctx.novelId, created, placement.volume.id, placement.position)
      const result = await tx.chapter.findFirstOrThrow({
        where: { id: created.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId },
        include: { volume: { select: { title: true, orderIndex: true } } },
      })
      if (slot && (result.orderIndex !== slot.orderIndex || result.volumeId !== placement.volume.id || result.orderInVolume !== placement.position + 1
        || slot.volumeId && result.volumeId !== slot.volumeId || slot.positionInVolume !== undefined && result.orderInVolume !== slot.positionInVolume)) {
        throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '创建后的章节位置与冻结目标不一致，本次事务需要回滚。')
      }
      if (slot) await bindWritingChapter(tx, ctx, slot.orderIndex, result.id)
      semanticTransition = { targetId: ctx.novelId, beforeHash, afterHash: await readSemanticStructureHash(tx, ctx.novelId) }
      return { ...result, scopeReused: false }
    }
    const chapter = ctx.transaction ? await create(ctx.transaction) : await prisma.$transaction(create)
    if (!chapter.scopeReused) await recalculateNovelStats(ctx.transaction ?? prisma, ctx.novelId)
    if (!ctx.transaction) {
      recordChapterBaseline(ctx.runId, chapter.id, chapter.revision)
      if (!chapter.scopeReused) recordCreatedChapter(ctx.runId, chapter.title, chapter.id)
    }
    if (!chapter.scopeReused && content && isAgent2FeatureEnabled('memory2', ctx.userId)) {
      await enqueueChapterMemoryExtraction({
        novelId: ctx.novelId, chapterId: chapter.id, chapterRevision: chapter.revision, before: '', after: content,
      }, ctx.transaction)
    }
    if (!chapter.scopeReused && content && isAgent2FeatureEnabled('storyCompiler', ctx.userId)) {
      await recordStoryCompilerWrite({
        userId: ctx.userId,
        novelId: ctx.novelId,
        runId: ctx.runId,
        chapterId: chapter.id,
        chapterOrderIndex: chapter.orderIndex,
        chapterRevision: chapter.revision,
      }, ctx.transaction)
    }

    return {
      output: `${chapter.scopeReused ? '复用原请求已绑定的' : '已原子创建'}全书第 ${chapter.orderIndex} 章《${chapter.title}》，位于第 ${chapter.volume.orderIndex} 卷《${chapter.volume.title}》卷内第 ${chapter.orderInVolume} 章，chapterId=${chapter.id}${!chapter.scopeReused && (args.position || args.positionInVolume) ? '，后续章节顺序已自动校正' : ''}${chapter.content ? `，当前正文 ${chapter.content.length} 字` : '（暂无正文）'}。${chapter.scopeReused ? '本次未创建、改名或写入章节。' : '创建已成功。'}后续必须复用该 chapterId，禁止重建同名章。`,
      ...(semanticTransition ? { semanticTransition } : {}),
      observedState: { kind: 'chapter', id: chapter.id, revision: chapter.revision },
      ...(chapter.scopeReused ? { chapterCreateReuse: { version: 1 as const, userId: ctx.userId, novelId: ctx.novelId, chapterId: chapter.id, revision: chapter.revision } } : {}),
      summary: `${chapter.scopeReused ? '复用' : '新建'}第 ${chapter.orderIndex} 章《${chapter.title}》 · ${chapter.volume.title}${chapter.scopeReused ? '（未创建）' : ''}`,
      // 带正文创建时返回 chapterDiff（空基线→全绿新增），前端才能挂上绿增红减的审查条；空章节仍用 chapterRef
      display: !chapter.scopeReused && chapter.content
        ? {
            kind: 'chapterDiff',
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            before: '',
            after: chapter.content,
            appliedDirectly: true,
            revision: chapter.revision,
          }
        : { kind: 'chapterRef', chapterId: chapter.id, title: chapter.title, wordCount: chapter.wordCount },
      ...(!chapter.scopeReused && content
        ? { snapshot: { target: 'chapter' as const, targetId: chapter.id, field: 'content', previousValue: '' } }
        : {}),
    }
  },
})

export const chapterWriteTool = defineTool({
  name: 'chapter_write',
  title: '写入章节正文',
  description:
    '用新内容整体覆盖指定章节的正文。需要已存在的 chapterId（新章节请先 chapter_create）。覆盖前建议先 chapter_read 了解现有内容；如只是接着写请用 chapter_append。覆盖前必须确认该章节确实是作者所指：作者按「第N章」指称时，若该排位章节的标题序号对不上（作者删过章导致错位），不要覆盖，改用 chapter_create 传 position 在正确位置插入。',
  parameters: chapterWriteArguments,
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const chapterId = resolveChapterId(ctx, args.chapterId)
    if (!chapterId) {
      return { output: MISSING_CHAPTER_HINT }
    }
    if (ctx.durableContent) return executeDurableChapter(ctx, 'chapter_write', { ...args, chapterId })
    return writeChapterContent(ctx, chapterId, () => args.content, '覆盖写入', args.content, 'replace', args.retainedFindings)
  },
})

export const chapterAppendTool = defineTool({
  name: 'chapter_append',
  title: '追加章节正文',
  description: '把生成的内容追加到指定章节正文末尾（自动补一个空行分隔），用于续写场景。',
  parameters: chapterAppendArguments,
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const chapterId = resolveChapterId(ctx, args.chapterId)
    if (!chapterId) {
      return { output: MISSING_CHAPTER_HINT }
    }
    if (ctx.durableContent) return executeDurableChapter(ctx, 'chapter_append', { ...args, chapterId })
    return writeChapterContent(
      ctx,
      chapterId,
      (current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${args.content}` : args.content),
      '追加',
      args.content,
      'append',
    )
  },
})

export const chapterEditRangeTool = defineTool({
  name: 'chapter_edit_range',
  title: '改写章节片段',
  description:
    '按当前原文精确替换章节片段。多项修订用一次 patches（最多8处），所有 oldText 必须从同一次 chapter_read 逐字复制、唯一且不重叠；任一无效则全部不写入。单片段可用 oldText/newText；仅作者选区提供坐标时用 start/end。批量与单片段参数互斥，一次批量只占一次原子写入与授权修订。',
  parameters: chapterEditArguments,
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const chapterId = resolveChapterId(ctx, args.chapterId)
    if (!chapterId) {
      return { output: MISSING_CHAPTER_HINT }
    }
    if (ctx.durableContent) return executeDurableChapter(ctx, 'chapter_edit_range', { ...args, chapterId })
    const chapter = await findOwnedChapter(ctx, chapterId)

    if (!chapter) {
      return buildChapterNotFound(ctx, chapterId)
    }
    assertChapterMutable(ctx, chapter)

    const before = chapter.content

    let edit: ReturnType<typeof composeChapterEdit>
    try { edit = composeChapterEdit(before, args) } catch (error) {
      if (!(error instanceof DataAccessError)) throw error
      return { outcome: 'failed', failureCode: error.code, summary: '正文片段未改写', output: error.message }
    }

    const baseline = getChapterBaseline(ctx.runId, chapter.id)
    if (baseline !== null && baseline !== chapter.revision) {
      return buildConflictResult(chapter.title)
    }

    const after = edit.after
    const candidate = edit.ranges.map(range => range.newText).join('\n')

    if (isAgent2FeatureEnabled('craftLibrary', ctx.userId) && candidate.trim().length >= 80) {
      await assertCraftOutputSafe({
        userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: chapter.id, content: candidate,
      })
    }

    const updated = await updateOwnedChapterAtRevision(ctx, chapter, {
      content: after,
      wordCount: after.length,
    }, 'range', !!args.patches, { retainedFindings: args.retainedFindings, editRanges: edit.ranges })
    if (!updated) {
      return buildConflictResult(chapter.title)
    }
    if (after === before) return unchangedChapterResult(chapter)
    await recalculateNovelStats(ctx.transaction ?? prisma, ctx.novelId)
    if (!ctx.transaction) recordChapterBaseline(ctx.runId, chapter.id, updated.revision)
    if (isAgent2FeatureEnabled('memory2', ctx.userId)) {
      await enqueueChapterMemoryExtraction({
        novelId: ctx.novelId, chapterId: chapter.id, chapterRevision: updated.revision, before, after,
      }, ctx.transaction)
    }
    if (isAgent2FeatureEnabled('storyCompiler', ctx.userId)) {
      await recordStoryCompilerWrite({
        userId: ctx.userId,
        novelId: ctx.novelId,
        runId: ctx.runId,
        chapterId: updated.id,
        chapterOrderIndex: updated.orderIndex,
        chapterRevision: updated.revision,
      }, ctx.transaction)
    }

    return {
      output: `已一次合并改写《${chapter.title}》${edit.ranges.length} 处，当前正文 ${after.length} 字。写入回执仅证明实际文本变化，不代表全部意见已解决或新版已复核。`,
      summary: `改写《${chapter.title}》${edit.ranges.length} 处`,
      display: {
        kind: 'chapterDiff',
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        // 必须返回完整正文：前端审查态直接把 before/after 当整章内容构建 diff 视图与回滚快照，
        // 若只截片段会导致审查视图缺失未修改部分、撤销时整章被错误替换成片段
        before,
        after,
        appliedDirectly: true,
        revision: updated.revision,
      },
      snapshot: { target: 'chapter', targetId: chapter.id, field: 'content', previousValue: before },
    }
  },
})

export const chapterRenameTool = defineTool({
  name: 'chapter_rename',
  title: '重命名章节',
  description: '修改指定章节的标题。',
  parameters: z.object({
    chapterId: z.string().optional().describe('目标章节 ID；缺省时默认操作最近操作/当前正在编辑的章节'),
    title: z.string().min(1).max(120).describe('新的章节标题'),
  }),
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const chapterId = resolveChapterId(ctx, args.chapterId)
    if (!chapterId) {
      return { output: MISSING_CHAPTER_HINT }
    }
    const chapter = await findOwnedChapter(ctx, chapterId)

    if (!chapter) {
      return buildChapterNotFound(ctx, chapterId)
    }
    assertChapterMutable(ctx, chapter)

    const previousTitle = chapter.title
    const baseline = getChapterBaseline(ctx.runId, chapter.id)
    if (baseline !== null && baseline !== chapter.revision) {
      return buildConflictResult(chapter.title)
    }

    const updated = await updateOwnedChapterAtRevision(ctx, chapter, { title: args.title.trim() })
    if (!updated) {
      return buildConflictResult(chapter.title)
    }
    await recalculateNovelStats(ctx.transaction ?? prisma, ctx.novelId)
    if (!ctx.transaction) recordChapterBaseline(ctx.runId, chapter.id, updated.revision)

    return {
      output: `已把章节《${previousTitle}》重命名为《${args.title.trim()}》。`,
      summary: `章节改名《${args.title.trim()}》`,
      snapshot: { target: 'chapter', targetId: chapter.id, field: 'title', previousValue: previousTitle },
    }
  },
})
