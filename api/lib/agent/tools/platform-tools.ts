import type { Prisma } from '@prisma/client'
import { z } from 'zod'

import { novelKeywordOr, searchableNovelWhere } from '../../data/search.js'
import { prisma } from '../../prisma.js'
import {
  consumePlatformReadBudget,
  consumePlatformSearchBudget,
  getCachedPlatformRead,
  setCachedPlatformRead,
} from '../permissions.js'
import type { ToolResult } from './types.js'
import { defineTool } from './types.js'
import { observePlatformNovel } from './platform-observation.js'

/**
 * 站内作品查看工具：按书名定位站内已上架作品（任何作者）与本作者未公开作品，
 * 读取介绍/分类/标签/章节列表/正文，用于参考站内作品二创、修改、写序章。
 * 可见性硬闸全部落在 DB where 子句，与作品详情页公开口径（getNovelDetailData）逐字一致：
 * - 他人作品：visibility='public' 且 status!=='draft'；章节限 published/public 且已到发布时间
 * - 本人作品（authorId === ctx.userId）：全状态可读（含草稿），输出标注「我的·未公开」
 */

const READ_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const

const SUMMARY_IN_OUTPUT = 400
const CHAPTER_LIST_IN_OUTPUT = 30

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** 展示状态：本人草稿标「我的·未公开」，避免模型把未公开内容误当公开素材引用 */
function novelStatusLabel(isOwn: boolean, status: string): string {
  if (status === 'draft') {
    return isOwn ? '我的·未公开' : '未公开'
  }
  if (status === 'archived') {
    return '已下架'
  }
  return '已上架'
}

const platformNovelSearchParameters = z.object({
  query: z
    .string()
    .min(1)
    .max(60)
    .describe('书名或标签/题材关键词（定位特定作品传书名中的词；找类似/同类作品传标签或题材特征词，如「仙侠」「悬疑」，禁止把书名逐字拆分穷举搜索）'),
})

export const platformNovelSearchTool = defineTool({
  name: 'platform_novel_search',
  title: '搜索站内作品',
  description:
    '按书名或标签/题材关键词在启创墨域站内定位作品：返回站内已上架作品（任何作者）与作者本人未公开的作品（含草稿），含 novelId/作者/状态/字数/标签。只知道书名想查看某作品时先用本工具定位，再用 platform_novel_read 传 novelId 深读；找类似/同类作品时先用 platform_novel_read 读参考作品的标签/分类/简介提炼特征词，再用特征词搜索并对比候选的标签与简介判断相似度，严禁把参考作品书名逐字拆分穷举搜索；站内没有合适候选时用 web_search 搜站外类似作品推荐。当前作品自身内容用 novel_get_context/chapter_read，不要用本工具。一次任务最多搜索 5 次。',
  parameters: platformNovelSearchParameters,
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    const search = async (): Promise<ToolResult> => {
      const client = ctx.transaction ?? prisma
      if (!ctx.transaction && !consumePlatformSearchBudget(ctx.runId)) {
        return {
          output:
            '本次任务的站内作品搜索次数已用完（每次任务最多 5 次）。请基于已获取的搜索结果与既有上下文完成任务，不要再搜索。',
          summary: '站内搜索预算已用尽',
        }
      }

      // 关键词匹配 OR 组（书名模糊 + 标签精确/部分匹配扩展），与全站搜索共用口径
      const keywordOr = novelKeywordOr(args.query)

      // 两路查询：① 本人作品任意状态；② 平台已上架池（与发现页口径一致）
      const [ownNovels, publicNovels] = await Promise.all([
        client.novel.findMany({
          where: { authorId: ctx.userId, OR: keywordOr },
          orderBy: { updatedAt: 'desc' },
          take: 5,
          select: {
            id: true,
            authorId: true,
            title: true,
            displayTitle: true,
            status: true,
            wordCount: true,
            tagNames: true,
            author: { select: { nickname: true } },
          },
        }),
        client.novel.findMany({
          where: { ...searchableNovelWhere, OR: keywordOr },
          orderBy: [{ viewCount: 'desc' }, { favoriteCount: 'desc' }, { lastPublishedAt: 'desc' }],
          take: 8,
          select: {
            id: true,
            authorId: true,
            title: true,
            displayTitle: true,
            status: true,
            wordCount: true,
            tagNames: true,
            author: { select: { nickname: true } },
          },
        }),
      ])

      // 合并去重：本人作品优先（同书在平台池也出现时以本人视角的状态为准）
      const merged = new Map<string, (typeof ownNovels)[number]>()
      for (const novel of publicNovels) {
        merged.set(novel.id, novel)
      }
      for (const novel of ownNovels) {
        merged.set(novel.id, novel)
      }
      const results = [...merged.values()]

      if (results.length === 0) {
        return {
          output: `站内搜索「${args.query}」没有找到匹配的作品。可换标签/题材特征词重试，或用 web_search 搜站外类似作品。`,
          summary: `已搜索作品「${args.query}」· 0 个结果`,
          display: { kind: 'platformNovelSearch', query: args.query, results: [] },
        }
      }

      const lines = results.map((novel, index) => {
        const isOwn = novel.authorId === ctx.userId
        const title = novel.displayTitle ?? novel.title
        const label = novelStatusLabel(isOwn, novel.status)
        const tags = novel.tagNames.length ? ` · 标签：${novel.tagNames.join('、')}` : ''
        return `[${index + 1}] novelId=${novel.id} 《${title}》 ${novel.author.nickname} · ${label} · ${novel.wordCount} 字${tags}`
      })

      return {
        output: `站内搜索「${args.query}」共 ${results.length} 个结果：\n${lines.join('\n')}\n要查看某部作品的介绍与章节，用 platform_novel_read 传对应 novelId；带 chapterId 可继续读章节正文。`,
        summary: `已搜索作品「${args.query}」· ${results.length} 个结果`,
        display: {
          kind: 'platformNovelSearch',
          query: args.query,
          results: results.map((novel) => ({
            id: novel.id,
            title: novel.displayTitle ?? novel.title,
            authorName: novel.author.nickname,
            isOwn: novel.authorId === ctx.userId,
            published: novel.status === 'published' || novel.status === 'completed',
            wordCount: novel.wordCount,
          })),
        },
      }
    }
    return ctx.transaction ? observePlatformNovel(ctx, 'platform_novel_search', args, search, ctx.transaction) : search()
  },
})

// ---------------------------------------------------------------------------
// platform_novel_read 站内作品深读：介绍/分类/标签/章节列表；带 chapterId 读正文
// ---------------------------------------------------------------------------

const platformNovelReadParameters = z.object({
  novelId: z.string().describe('作品 ID（来自 platform_novel_search 的结果）'),
  chapterId: z
    .string()
    .optional()
    .describe('章节 ID（来自本工具返回的章节列表）；缺省时返回作品介绍与章节列表'),
  offset: z.number().int().min(0).optional().describe('读正文时的起始字符位置，默认 0'),
  limit: z.number().int().min(1).max(12000).optional().describe('读正文时的字符数，默认 6000'),
})

export const platformNovelReadTool = defineTool({
  name: 'platform_novel_read',
  title: '查看站内作品',
  description:
    '查看站内作品的介绍、分类、标签、章节列表；带 chapterId 可读章节正文（支持 offset/limit 分段）。可看站内已上架的任何作者作品，也可看作者本人未公开的作品（含草稿）。参考他人作品二创/写序章前，先读其简介与相关章节，禁止盲写；引用他人作品仅限已上架内容。当前作品自身内容仍用 novel_get_context/chapter_read。一次任务最多读取 8 次。',
  parameters: platformNovelReadParameters,
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    const offset = args.offset ?? 0
    const limit = args.limit ?? 6000
    if (ctx.transaction) return observePlatformNovel(ctx, 'platform_novel_read', { novelId: args.novelId, chapterId: args.chapterId ?? null, offset, limit },
      () => readPlatformNovel(ctx.userId, args.novelId, args.chapterId, offset, limit, ctx.transaction), ctx.transaction)
    const cacheKey = `${args.novelId}|${args.chapterId ?? ''}|${offset}|${limit}`

    // 同 run 内相同入参去重：命中缓存直接返回，不扣深读预算
    const cached = getCachedPlatformRead(ctx.runId, cacheKey) as ToolResult | undefined
    if (cached) {
      return cached
    }

    if (!consumePlatformReadBudget(ctx.runId)) {
      return {
        output:
          '本次任务的站内作品读取次数已用完（每次任务最多 8 次）。请基于已读取的内容与既有上下文完成任务。',
        summary: '站内深读预算已用尽',
      }
    }

    const result = await readPlatformNovel(ctx.userId, args.novelId, args.chapterId, offset, limit)
    setCachedPlatformRead(ctx.runId, cacheKey, result)
    return result
  },
})

async function readPlatformNovel(
  userId: string,
  novelId: string,
  chapterId: string | undefined,
  offset: number,
  limit: number,
  transaction?: Prisma.TransactionClient,
): Promise<ToolResult> {
  const client = transaction ?? prisma
  const novel = await client.novel.findUnique({
    where: { id: novelId },
    select: {
      id: true,
      authorId: true,
      title: true,
      displayTitle: true,
      summary: true,
      tagNames: true,
      categoryName: true,
      status: true,
      visibility: true,
      wordCount: true,
      chapterCount: true,
      author: { select: { nickname: true } },
    },
  })

  if (!novel) {
    return { output: `未找到 novelId=${novelId} 对应的作品，可能已被删除。请用 platform_novel_search 重新定位。` }
  }

  const isOwner = novel.authorId === userId
  const title = novel.displayTitle ?? novel.title
  const published = novel.status === 'published' || novel.status === 'completed'

  // 可见性硬闸（镜像作品详情页 getNovelDetailData 的公开口径）：
  // 非作者只能看 public 且非草稿的作品
  if (!isOwner && (novel.visibility !== 'public' || novel.status === 'draft')) {
    return {
      output: `该作品《${title}》未公开，仅作者本人可查看。请换一个已上架的作品参考，或基于既有知识继续。`,
      summary: `作品《${title}》未公开`,
    }
  }

  // 章节可见性硬闸（同口径）：非作者限已发布/公开/已到发布时间的章节
  const chapterWhere: Prisma.ChapterWhereInput = isOwner
    ? { novelId: novel.id }
    : {
        novelId: novel.id,
        status: 'published',
        visibility: 'public',
        OR: [{ publishedAt: null }, { publishedAt: { lte: new Date() } }],
      }

  const display = {
    kind: 'platformNovel' as const,
    title,
    authorName: novel.author.nickname,
    isOwn: isOwner,
    published,
    tags: novel.tagNames,
    summary: novel.summary,
    chapterCount: novel.chapterCount,
    wordCount: novel.wordCount,
  }

  if (chapterId) {
    const chapter = await client.chapter.findFirst({
      where: { ...chapterWhere, id: chapterId },
      select: {
        id: true,
        title: true,
        content: true,
        wordCount: true,
        publishedTitle: true,
        publishedContent: true,
        publishedWordCount: true,
        publishedRevision: true,
      },
    })

    if (!chapter) {
      return {
        output: `作品《${title}》下未找到章节 ${chapterId}，或该章节未发布/仅作者可见。请重新查看章节列表核对 chapterId。`,
        summary: `章节不可见`,
        display,
      }
    }

    const chapterTitle = !isOwner && chapter.publishedRevision != null ? chapter.publishedTitle ?? chapter.title : chapter.title
    const chapterContent = !isOwner && chapter.publishedRevision != null ? chapter.publishedContent ?? '' : chapter.content
    const slice = chapterContent.slice(offset, offset + limit)
    const hasMore = offset + limit < chapterContent.length
    const output = [
      `作品：《${title}》 作者：${novel.author.nickname} · ${novelStatusLabel(isOwner, novel.status)} · 总字数：${novel.wordCount}`,
      `章节《${chapterTitle}》 总长 ${chapterContent.length} 字，当前返回 [${offset}, ${offset + slice.length})${hasMore ? '，后续还有内容，可继续用 offset 分段读取' : '（已到结尾）'}`,
      '正文：',
      slice || '（本章暂无正文）',
    ].join('\n')

    return {
      output,
      summary: `已查看《${title}》·《${chapterTitle}》`,
      display: { ...display, chapterTitle },
    }
  }

  const chapters = await client.chapter.findMany({
    where: chapterWhere,
    orderBy: { orderIndex: 'asc' },
    take: CHAPTER_LIST_IN_OUTPUT,
    select: { id: true, title: true, orderIndex: true, wordCount: true, publishedTitle: true, publishedWordCount: true, publishedRevision: true },
  })

  const chapterLines = chapters.map(
    (chapter) => {
      const publishedSnapshot = !isOwner && chapter.publishedRevision != null
      return `- [${chapter.id}] 第${chapter.orderIndex}章《${publishedSnapshot ? chapter.publishedTitle ?? chapter.title : chapter.title}》 ${publishedSnapshot ? chapter.publishedWordCount ?? 0 : chapter.wordCount}字`
    },
  )
  if (novel.chapterCount > chapters.length) {
    chapterLines.push(`（仅列出前 ${chapters.length} 章，共 ${novel.chapterCount} 章）`)
  }

  const output = [
    `作品：《${title}》 作者：${novel.author.nickname} · ${novelStatusLabel(isOwner, novel.status)}${novel.categoryName ? ` · 分类：${novel.categoryName}` : ''} · 总字数：${novel.wordCount} · 章节数：${novel.chapterCount}`,
    novel.tagNames.length ? `标签：${novel.tagNames.join('、')}` : '',
    novel.summary.trim() ? `简介：${clip(novel.summary, SUMMARY_IN_OUTPUT)}` : '简介：暂无',
    chapters.length ? `章节列表：\n${chapterLines.join('\n')}` : '章节列表：暂无可见章节。',
    '要读某章正文，再次调用本工具带 chapterId（可配 offset/limit 分段）。',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    output,
    summary: `已查看作品《${title}》· ${novel.chapterCount} 章`,
    display,
  }
}
