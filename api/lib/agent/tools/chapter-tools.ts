import { z } from 'zod'
import type { Prisma } from '@prisma/client'

import { DataAccessError, prisma } from '../../prisma.js'
import { getChapterBaseline, getCreatedChapter, getLastTouchedChapter, recordChapterBaseline, recordCreatedChapter } from '../baseline.js'
import { activeChapterScope, activeVolumeWhere, recalculateNovelStats } from '../../data/internal.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
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
  chapter: { id: string; revision: number },
  data: Prisma.ChapterUpdateManyMutationInput,
) {
  const apply = async (tx: Prisma.TransactionClient) => {
    await assertAgentManuscriptCurrent(tx, ctx)
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
  })
  if (!updated) {
    return buildConflictResult(chapter.title)
  }
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
    const alreadyCreatedId = ctx.transaction ? null : getCreatedChapter(ctx.runId, args.title)
    if (alreadyCreatedId) {
      const existing = await findOwnedChapter(ctx, alreadyCreatedId)
      if (existing) {
        return {
          output: `本轮已经成功创建过《${existing.title}》，chapterId=${existing.id}。为防重复章节，本次未再次创建；请直接复用该 chapterId 写入或修订正文。`,
          summary: `复用已创建章节《${existing.title}》`,
          display: { kind: 'chapterRef', chapterId: existing.id, title: existing.title, wordCount: existing.wordCount },
        }
      }
      // A lost/archived cached identity is not permission to recreate the old
      // run's chapter in a replacement manuscript under a new ID.
      return buildChapterNotFound(ctx, alreadyCreatedId)
    }

    const create = async (tx: Prisma.TransactionClient) => {
      await assertAgentManuscriptCurrent(tx, ctx)
      const volumeByOrder = args.volumeOrder !== undefined
        ? await tx.volume.findFirst({ where: { novelId: ctx.novelId, ...activeVolumeWhere, orderIndex: args.volumeOrder } })
        : null
      if (args.volumeOrder !== undefined && !volumeByOrder) {
        throw new DataAccessError(400, 'VOLUME_NOT_FOUND', `第 ${args.volumeOrder} 卷不存在，请先用 volume_list 或 novel_get_context 核对卷结构。`)
      }
      const globalTarget = args.position
        ? await tx.chapter.findFirst({ where: { ...activeChapterScope(ctx.novelId), orderIndex: args.position } })
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
          requestedVolumeId: args.volumeId ?? volumeByOrder?.id,
          globalTargetVolumeId: globalTarget?.volumeId,
          lastExistingVolumeId: lastExisting?.volumeId,
        }),
        args.positionInVolume ?? globalTarget?.orderInVolume,
      )
      const chapterCount = await tx.chapter.count({ where: activeChapterScope(ctx.novelId) })
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
      return tx.chapter.findFirstOrThrow({
        where: { id: created.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId },
        include: { volume: { select: { title: true, orderIndex: true } } },
      })
    }
    const chapter = ctx.transaction ? await create(ctx.transaction) : await prisma.$transaction(create)
    await recalculateNovelStats(ctx.transaction ?? prisma, ctx.novelId)
    if (!ctx.transaction) {
      recordChapterBaseline(ctx.runId, chapter.id, chapter.revision)
      recordCreatedChapter(ctx.runId, chapter.title, chapter.id)
    }
    if (content && isAgent2FeatureEnabled('memory2', ctx.userId)) {
      await enqueueChapterMemoryExtraction({
        novelId: ctx.novelId, chapterId: chapter.id, chapterRevision: chapter.revision, before: '', after: content,
      }, ctx.transaction)
    }
    if (content && isAgent2FeatureEnabled('storyCompiler', ctx.userId)) {
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
      output: `已原子创建全书第 ${chapter.orderIndex} 章《${chapter.title}》，位于第 ${chapter.volume.orderIndex} 卷《${chapter.volume.title}》卷内第 ${chapter.orderInVolume} 章，chapterId=${chapter.id}${args.position || args.positionInVolume ? '，后续章节顺序已自动校正' : ''}${content ? `，写入 ${content.length} 字` : '（暂无正文）'}。创建已成功，后续必须复用该 chapterId，禁止重建同名章。`,
      observedState: { kind: 'chapter', id: chapter.id, revision: chapter.revision },
      summary: `新建第 ${chapter.orderIndex} 章《${chapter.title}》 · ${chapter.volume.title}`,
      // 带正文创建时返回 chapterDiff（空基线→全绿新增），前端才能挂上绿增红减的审查条；空章节仍用 chapterRef
      display: content
        ? {
            kind: 'chapterDiff',
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            before: '',
            after: content,
            appliedDirectly: true,
            revision: chapter.revision,
          }
        : { kind: 'chapterRef', chapterId: chapter.id, title: chapter.title, wordCount: 0 },
      ...(content
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
    return writeChapterContent(ctx, chapterId, () => args.content, '覆盖写入', args.content)
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
    )
  },
})

export const chapterEditRangeTool = defineTool({
  name: 'chapter_edit_range',
  title: '改写章节片段',
  description:
    '按原文锚点或字符区间替换章节正文的一个片段（选区级改写/润色），避免整章覆盖。推荐传 oldText（逐字拷贝要替换的原文片段，系统自动定位并计算下标，严禁自己数字数算下标）；start/end 字符下标（含头不含尾）仅在作者选区提供精确坐标时使用。',
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

    // 定位优先级：oldText 锚点（系统算下标，模型免数数）> 选区精确坐标 start/end
    let start: number
    let end: number
    if (args.oldText) {
      const first = before.indexOf(args.oldText)
      if (first === -1) {
        return { output: `oldText 未在正文中逐字匹配到（标点、换行须完全一致）。请先 chapter_read 逐字拷贝要替换的原文再传 oldText。` }
      }
      if (before.indexOf(args.oldText, first + args.oldText.length) !== -1) {
        return { output: `oldText 在正文中出现多次，无法唯一定位。请向两侧多拷几句上下文使其在正文中唯一。` }
      }
      start = first
      end = first + args.oldText.length
    } else if (args.start !== undefined && args.end !== undefined) {
      start = args.start
      end = args.end
    } else {
      return { output: `请提供 oldText（逐字拷贝原文片段定位，推荐）或 start/end 字符下标。` }
    }

    if (end < start || start > before.length) {
      return { output: `区间 [${start}, ${end}) 无效：章节正文总长 ${before.length} 字。请先 chapter_read 确认定位。` }
    }

    const baseline = getChapterBaseline(ctx.runId, chapter.id)
    if (baseline !== null && baseline !== chapter.revision) {
      return buildConflictResult(chapter.title)
    }

    const after = before.slice(0, start) + args.newText + before.slice(end)

    if (isAgent2FeatureEnabled('craftLibrary', ctx.userId) && args.newText.trim().length >= 80) {
      await assertCraftOutputSafe({
        userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: chapter.id, content: args.newText,
      })
    }

    const updated = await updateOwnedChapterAtRevision(ctx, chapter, {
      content: after,
      wordCount: after.length,
    })
    if (!updated) {
      return buildConflictResult(chapter.title)
    }
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
      output: `已改写《${chapter.title}》第 ${start}-${end} 字的片段（原 ${end - start} 字 → 新 ${args.newText.length} 字）。`,
      summary: `改写《${chapter.title}》片段 · ${args.newText.length} 字`,
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
