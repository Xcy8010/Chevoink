import { z } from 'zod'
import { recordPlanContentHash } from './plan-observation.js'
import { createHash } from 'node:crypto'

import { prisma } from '../../prisma.js'
import { activeChapterScope, activeVolumeWhere } from '../../data/internal.js'
import { searchStoryMemory } from '../story-memory.js'
import { recordChapterBaseline } from '../baseline.js'
import { defineTool, type ToolResult } from './types.js'
import { executeDurableRead } from './durable-read.js'
import { planTargetHash } from './durable-plan.js'
import { novelMetadataHash } from './durable-metadata.js'

const READ_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function parseChapterNumber(raw: string): number | null {
  if (/^[0-9０-９]+$/.test(raw)) {
    const normalized = raw.replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10))
    return Number(normalized)
  }
  // 中文数字支持到千位，章节序号场景够用
  let total = 0
  let current = 0
  for (const ch of raw) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]
    } else if (ch === '十') {
      total += (current || 1) * 10
      current = 0
    } else if (ch === '百') {
      total += (current || 1) * 100
      current = 0
    } else if (ch === '千') {
      total += (current || 1) * 1000
      current = 0
    } else {
      return null
    }
  }
  const value = total + current
  return value > 0 ? value : null
}

/** 从章节标题提取作者自带的「第N章」序号，用于和实际排位比对，
 * 揭示「作者删过章导致排位与标题错位」的情况 */
function extractTitleChapterNumber(title: string): number | null {
  const match = /^第\s*([0-9０-９零一二两三四五六七八九十百千]+)\s*[章回节]/.exec(title.trim())
  return match ? parseChapterNumber(match[1]) : null
}

/** 小说全局上下文：信息/章节列表/状态 */
export const novelGetContextTool = defineTool({
  name: 'novel_get_context',
  title: '读取作品上下文',
  description:
    '获取当前作品的整体信息：标题、简介、题材标签、状态、章节列表（含每章标题/字数/状态/是否有摘要）。在规划或写作前先调用它了解全局。',
  parameters: z.object({}),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx): Promise<ToolResult> {
    if (ctx.durableRead) {
      const captured = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), durableRead: { ...ctx.durableRead, lease: { ...ctx.durableRead.lease }, cursor: { ...ctx.durableRead.cursor } } }
      return executeDurableRead(captured, 'novel_get_context', {}, raw => novelGetContextTool.parameters.parse(raw),
        tx => novelGetContextTool.execute({ ...captured, durableRead: undefined, transaction: tx }, {}))
    }
    const db = ctx.transaction ?? prisma
    const novel = await db.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: {
        title: true,
        displayTitle: true,
        summary: true,
        tagNames: true,
        categoryName: true,
        status: true,
        wordCount: true,
        chapterCount: true,
        coverPrompt: true,
        coverAsset: { select: { imageUrl: true } },
      },
    })

    if (!novel) {
      return { outcome: 'failed', output: '未找到当前作品，可能已被删除。' }
    }

    const volumes = await db.volume.findMany({
      where: { novelId: ctx.novelId, ...activeVolumeWhere },
      orderBy: { orderIndex: 'asc' },
      include: {
        chapters: {
          where: activeChapterScope(ctx.novelId),
          orderBy: { orderInVolume: 'asc' },
          select: { id: true, title: true, orderIndex: true, orderInVolume: true, wordCount: true, status: true, summary: true },
        },
      },
    })
    const chapters = volumes.flatMap((volume) => volume.chapters)

    const volumeLines = volumes.map((volume) => {
      const chapterLines = volume.chapters.map((chapter) => {
        const titleNumber = extractTitleChapterNumber(chapter.title)
        const mismatched = titleNumber !== null && titleNumber !== chapter.orderInVolume
        return `  - [${chapter.id}] 卷内第${chapter.orderInVolume}章（全书第${chapter.orderIndex}章）《${chapter.title}》 ${chapter.wordCount}字 ${chapter.status === 'published' ? '已发布' : '草稿'}${chapter.summary ? ' 有摘要' : ''}${chapter.id === ctx.chapterId ? '（当前章节）' : ''}${mismatched ? ` 【注意：标题自称第${titleNumber}章，但卷内实际排在第${chapter.orderInVolume}位】` : ''}`
      })
      return `- 第${volume.orderIndex}卷《${volume.title}》 volumeId=${volume.id}${volume.summary ? ` 摘要：${clip(volume.summary, 120)}` : ''}\n${chapterLines.length ? chapterLines.join('\n') : '  （空卷）'}`
    })
    const hasMismatch = chapters.some((chapter) => {
      const titleNumber = extractTitleChapterNumber(chapter.title)
      return titleNumber !== null && titleNumber !== chapter.orderInVolume
    })

    const output = [
      `作品：《${novel.displayTitle ?? novel.title}》 状态：${novel.status} 总字数：${novel.wordCount} 章节数：${novel.chapterCount}`,
      `简介：${ctx.transaction ? novel.summary : clip(novel.summary, 400)}`,
      novel.tagNames.length ? `标签：${novel.tagNames.join('、')}${novel.categoryName ? ` 分类：${novel.categoryName}` : ''}` : '',
      novel.coverPrompt ? `封面提示词：${ctx.transaction ? novel.coverPrompt : clip(novel.coverPrompt, 160)}` : '',
      novel.coverAsset?.imageUrl
        ? `正式封面地址：${novel.coverAsset.imageUrl}（调用 view_image 即可查看当前封面画面效果）`
        : '正式封面：暂无',
      volumes.length ? `卷章结构：\n${volumeLines.join('\n')}` : '卷章结构：暂无。',
      hasMismatch
        ? '提醒：存在标题序号与卷内排位不一致的章节。作者要求写「第N章」时，先确认所属卷和目标章节；结构调整应使用 chapter_move / chapter_move_to_volume，完成后调用 structure_outline 校验。'
        : '',
    ]
      .filter(Boolean)
      .join('\n')

    return { output, summary: `读取《${novel.displayTitle ?? novel.title}》上下文 · ${chapters.length} 章`,
      ...(ctx.transaction ? { observedState: { kind: 'novel' as const, id: ctx.novelId, hash: novelMetadataHash(novel) } } : {}) }
  },
})

/** 读章节正文（支持 range 防爆上下文） */
export const chapterReadTool = defineTool({
  name: 'chapter_read',
  title: '读取章节正文',
  description:
    '读取指定章节的正文。已知全书第N章可直接传 chapterOrder=N，无需猜测ID；卷内序号不能当全书序号。chapterId只能来自已返回的当前作品目录，不可与首次 novel_get_context 同批猜测ID。支持 offset/limit 按字符分段读取（正文超过6000字时建议分段）。写作或改写前先读相关章节，禁止盲写。',
  parameters: z.object({
    chapterId: z.string().optional().describe('章节 ID，可从 novel_get_context 的章节列表获取；缺省时默认读当前正在编辑的章节'),
    chapterOrder: z.number().int().positive().optional().describe('全书章节序号（不是卷内序号）；知道第N章时直接用它定位。与chapterId同时提供时必须指向同一章'),
    offset: z.number().int().min(0).optional().describe('起始字符位置，默认 0'),
    limit: z.number().int().min(1).max(12000).optional().describe('读取字符数，默认 6000'),
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args): Promise<ToolResult> {
    // 缺省兜底：模型漏传 chapterId 时默认读作者当前打开的章节，避免白白打回一轮
    if (ctx.durableRead) {
      const captured = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), durableRead: { ...ctx.durableRead, lease: { ...ctx.durableRead.lease }, cursor: { ...ctx.durableRead.cursor } } }
      const effective = Object.fromEntries(Object.entries({ ...args }).filter(([, value]) => value !== undefined))
      return executeDurableRead(captured, 'chapter_read', effective,
        raw => Object.fromEntries(Object.entries(chapterReadTool.parameters.parse(raw)).filter(([, value]) => value !== undefined)),
        tx => chapterReadTool.execute({ ...captured, durableRead: undefined, transaction: tx }, effective))
    }
    const db = ctx.transaction ?? prisma
    const chapterId = args.chapterId?.trim() || (args.chapterOrder ? undefined : ctx.chapterId)
    if (!chapterId && !args.chapterOrder) {
      return { outcome: 'failed', summary: '未指定要读取的章节', output: '未传 chapterId/chapterOrder 且当前没有正在编辑的章节。知道全书第N章可直接传 chapterOrder=N；否则先用 novel_get_context 查看章节列表。' }
    }
    const matches = await db.chapter.findMany({
      where: { ...(chapterId ? { id: chapterId } : {}), ...(args.chapterOrder ? { orderIndex: args.chapterOrder } : {}), ...activeChapterScope(ctx.novelId), authorId: ctx.userId },
      select: { id: true, title: true, content: true, wordCount: true, summary: true, revision: true },
      take: 2,
    })
    if (matches.length !== 1) {
      return { outcome: 'failed', summary: matches.length ? '章节序号不唯一' : '章节标识已失效或不匹配',
        output: '当前作品中未找到唯一匹配的章节，未读取其他章节，也未建立写入基线。请使用 novel_get_context 返回的当前目录核对 chapterId；已知全书序号时可只传 chapterOrder。不要重复发送旧ID，不能以编辑器当前章节替代目标。' }
    }
    const chapter = matches[0]

    // 读取即记录写入基线：后续写入前校验 revision，防止同毫秒写入或时钟精度导致漏判冲突
    if (!ctx.transaction) recordChapterBaseline(ctx.runId, chapter.id, chapter.revision)

    const offset = args.offset ?? 0
    const limit = args.limit ?? 6000
    const slice = chapter.content.slice(offset, offset + limit)
    const hasMore = offset + limit < chapter.content.length

    const output = [
      `《${chapter.title}》 总长 ${chapter.content.length} 字，当前返回 [${offset}, ${offset + slice.length})${hasMore ? '，后续还有内容，可继续用 offset 分段读取' : '（已到结尾）'}`,
      chapter.summary ? `本章摘要：${chapter.summary}` : '',
      '正文：',
      slice || '（本章暂无正文）',
    ]
      .filter(Boolean)
      .join('\n')

    return {
      output,
      summary: `读取《${chapter.title}》 ${offset}-${offset + slice.length} 字`,
      observedState: { kind: 'chapter', id: chapter.id, revision: chapter.revision },
    }
  },
})

/** 邻近章节摘要批量读取 */
export const chapterListSummariesTool = defineTool({
  name: 'chapter_list_summaries',
  title: '读取章节摘要',
  description: '批量读取章节摘要（无摘要的章节返回开头片段），用于快速了解前情脉络，比逐章读正文省得多。',
  parameters: z.object({
    aroundChapterId: z.string().optional().describe('以该章节为中心取邻近章节；缺省则取最近的章节'),
    count: z.number().int().min(1).max(20).optional().describe('返回章节数，默认 6'),
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args): Promise<ToolResult> {
    if (ctx.durableRead) {
      const captured = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), durableRead: { ...ctx.durableRead, lease: { ...ctx.durableRead.lease }, cursor: { ...ctx.durableRead.cursor } } }
      const normalize = (raw: unknown) => Object.fromEntries(Object.entries(chapterListSummariesTool.parameters.parse(raw)).filter(([, value]) => value !== undefined))
      const effective = chapterListSummariesTool.parameters.parse(normalize(args))
      return executeDurableRead(captured, 'chapter_list_summaries', normalize(effective), normalize,
        tx => chapterListSummariesTool.execute({ ...captured, durableRead: undefined, transaction: tx }, effective))
    }
    const db = ctx.transaction ?? prisma
    const chapters = await db.chapter.findMany({
      where: { ...activeChapterScope(ctx.novelId), authorId: ctx.userId },
      orderBy: { orderIndex: 'asc' },
      select: { id: true, title: true, orderIndex: true, summary: true, content: true },
    })

    if (chapters.length === 0) {
      return { output: '当前作品还没有章节。' }
    }

    const count = args.count ?? 6
    const centerIndex = args.aroundChapterId
      ? Math.max(0, chapters.findIndex((chapter) => chapter.id === args.aroundChapterId))
      : chapters.length - 1
    const start = Math.max(0, centerIndex - Math.floor(count / 2))
    const picked = chapters.slice(start, start + count)

    const lines = picked.map((chapter) => {
      const digest = chapter.summary?.trim() || `（无摘要，开头：${clip(chapter.content.replace(/\s+/g, ' '), 120)}）`
      return `第${chapter.orderIndex}章《${chapter.title}》[${chapter.id}]：${clip(digest, 300)}`
    })

    return {
      output: lines.join('\n'),
      summary: `读取 ${picked.length} 章摘要`,
    }
  },
})

/** 检索项目记忆（角色/设定/时间线/伏笔/章节摘要） */
export const memorySearchTool = defineTool({
  name: 'memory_search',
  title: '检索创作记忆',
  description:
    '按关键词检索本作品沉淀的创作记忆：角色卡、世界观设定、时间线事件、伏笔、章节摘要、风格偏好等。写作前校对人名/设定时使用。',
  parameters: z.object({
    query: z.string().min(1).describe('检索关键词（人名、地名、设定名等）'),
    memoryType: z
      .enum([
        'novelSummary',
        'worldbuilding',
        'characterCard',
        'chapterSummary',
        'timelineEvent',
        'foreshadowing',
        'stylePreference',
        'continuityRule',
        'volumeSummary',
        'storyArc',
        'sceneState',
        'relationshipState',
        'storyBible',
        'authorProfile',
      ])
      .optional()
      .describe('限定记忆类型，缺省为全部'),
    limit: z.number().int().min(1).max(20).optional().describe('返回条数，默认 8'),
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args): Promise<ToolResult> {
    if (ctx.durableRead) {
      const captured = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), durableRead: { ...ctx.durableRead, lease: { ...ctx.durableRead.lease }, cursor: { ...ctx.durableRead.cursor } } }
      const normalize = (raw: unknown) => Object.fromEntries(Object.entries(memorySearchTool.parameters.parse(raw)).filter(([, value]) => value !== undefined))
      const effective = memorySearchTool.parameters.parse(normalize(args))
      return executeDurableRead(captured, 'memory_search', normalize(effective), normalize,
        tx => memorySearchTool.execute({ ...captured, durableRead: undefined, transaction: tx }, effective))
    }
    const entries = await searchStoryMemory({
      userId: ctx.userId, novelId: ctx.novelId, query: args.query,
      memoryType: args.memoryType, limit: args.limit ?? 8,
    }, ctx.transaction)

    if (entries.length === 0) {
      return { output: `没有找到与"${args.query}"相关的记忆条目。` }
    }

    const lines = entries.map(
      (entry) => `[${entry.memoryType}/${entry.layer}/${entry.status}] ${entry.title}（ID：${entry.id}；融合分 ${entry.score.toFixed(4)}）：${ctx.transaction ? entry.content : clip(entry.content, 400)}\n  依据：${entry.evidence.map((item) => `${item.sourceType}:${item.sourceId}${item.revision ? `@r${item.revision}` : ''}`).join('、') || '无来源（仅作低可信参考）'}`,
    )

    return {
      output: lines.join('\n'),
      summary: `检索"${args.query}" · 命中 ${entries.length} 条`,
      ...(ctx.transaction ? { observedMemories: await Promise.all(entries.map(async entry => {
        const memory = await ctx.transaction!.projectMemoryEntry.findUniqueOrThrow({ where: { id: entry.id } })
        const { memoryTargetHash } = await import('../runtime-memory.js')
        return { kind: 'memory' as const, id: memory.id, hash: memoryTargetHash(memory) }
      })) } : {}),
    }
  },
})

/** 读取计划正文：回顾/修订既有计划前必须先读，禁止用 plan_save 凭记忆重写来“对齐” */
export const planReadTool = defineTool({
  name: 'plan_read',
  title: '读取计划',
  description:
    '只读查看「计划」文件夹里某份既有计划的完整正文。回顾整体规划、确认某章定位、修订计划前，都必须先用本工具读取；绝对禁止用 plan_save 重写一遍来代替读取。不传 planId 时返回最近更新的一份计划。',
  parameters: z.object({
    planId: z.string().optional().describe('计划 id（上下文的计划清单提供）；缺省返回最近更新的一份'),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('长计划分段读取的字符起点，默认0；追加前可读取尾部核对已保存小节'),
    limit: z.number().int().min(1).max(8000).optional().describe('本次最多读取字符数，默认8000'),
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args): Promise<ToolResult> {
    if (ctx.durableRead) {
      const captured = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), durableRead: { ...ctx.durableRead, lease: { ...ctx.durableRead.lease }, cursor: { ...ctx.durableRead.cursor } } }
      const effective = { ...args }
      return executeDurableRead(captured, 'plan_read', Object.fromEntries(Object.entries(effective).filter(([, value]) => value !== undefined)),
        raw => Object.fromEntries(Object.entries(planReadTool.parameters.parse(raw)).filter(([, value]) => value !== undefined)),
        tx => planReadTool.execute({ ...captured, durableRead: undefined, transaction: tx }, effective))
    }
    const db = ctx.transaction ?? prisma
    const plan = await db.agentArtifact.findFirst({
      where: {
        artifactType: 'chapterPlan',
        metadata: { path: ['savedAsPlan'], equals: true },
        run: { userId: ctx.userId, novelId: ctx.novelId },
        ...(args.planId ? { id: args.planId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, content: true, updatedAt: true, metadata: true },
    })

    if (!plan) {
      return {
        ...(args.planId ? { outcome: 'failed' as const } : {}),
        summary: args.planId ? '指定计划不存在' : '计划文件夹为空',
        output: args.planId
          ? `未找到 planId=${args.planId} 对应的计划，请核对上下文里的计划清单。`
          : '计划文件夹目前是空的，还没有任何计划。',
      }
    }

    const offset = Math.min(args.offset ?? 0, plan.content.length)
    // Durable reads feed the full result into the existing archived-output reader,
    // which verifies page coverage before granting a write baseline.
    const defaultLimit = ctx.transaction && args.offset === undefined && args.limit === undefined ? plan.content.length : 8000
    const end = Math.min(offset + (args.limit ?? defaultLimit), plan.content.length)
    recordPlanContentHash(ctx, plan.id, createHash('sha256').update(plan.content).digest('hex'))
    return {
      output: `《${plan.title}》（planId=${plan.id}，contentHash=${createHash('sha256').update(plan.content).digest('hex')}，${plan.content.length} 字，本次${offset}–${end}）：\n${plan.content.slice(offset, end)}${end < plan.content.length ? `\n[尚有后文；使用plan_read、同一planId和offset=${end}继续读取，不能把本段当全文]` : ''}`,
      summary: `读取计划《${plan.title}》`,
      ...(offset === 0 && end === plan.content.length ? { observedState: { kind: 'plan' as const, id: plan.id, hash: planTargetHash(plan) } } : {}),
    }
  },
})
