import { z } from 'zod'
import type { Prisma } from '@prisma/client'

import { prisma } from '../../prisma.js'
import { recalculateNovelStats } from '../../data/internal.js'
import { ALL_NOVEL_TAGS, MAX_NOVEL_TAGS } from '../../../../shared/contracts/novel-tags.js'
import { enforceCoverTitleInPrompt } from './cover-prompt.js'
import { defineTool } from './types.js'

/**
 * 作品维度写工具集（自 write-tools.ts 模块级拆分而来，工具定义逐字保留）：
 * 改名/简介标签/封面提示词/发布/下架/删除，附作品统计重算（章节工具共用）。
 */

const WRITE_PERMISSION = { plan: 'deny', build: 'allow', review: 'deny' } as const
const DANGEROUS_PERMISSION = { plan: 'deny', build: 'ask', review: 'deny' } as const

export async function recalcNovelStats(novelId: string, db: Prisma.TransactionClient = prisma) {
  return recalculateNovelStats(db, novelId)
}

export const novelCreateTool = defineTool({
  name: 'novel_create',
  title: '创建作品',
  description: `仅用于作者还没有任何正式作品时，把系统准备的隐藏占位作品原子化初始化为第一部作品。应结合用户给出的题材和设定生成书名、简介与标签；标签必须来自站内统一标签库，最多 ${MAX_NOVEL_TAGS} 个。普通作品不能调用此工具。`,
  parameters: z.object({
    title: z.string().min(1).max(120).describe('作品名称'),
    summary: z.string().min(1).max(1000).describe('作品简介'),
    tags: z.array(z.string().min(1).max(24)).min(1).max(MAX_NOVEL_TAGS).describe(`站内标签，最多 ${MAX_NOVEL_TAGS} 个`),
  }),
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const novel = await prisma.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true, displayTitle: true, summary: true, chapterCount: true, wordCount: true },
    })
    if (!novel) return { output: '未找到当前作品。' }

    const isBootstrap =
      !novel.displayTitle?.trim()
      && (novel.title === '未命名作品' || novel.title === '我的第一部作品')
      && novel.summary === '先创建一部作品，再继续完善简介、章节和封面。'
      && novel.chapterCount === 0
      && novel.wordCount === 0
    if (!isBootstrap) return { output: '当前已是正式作品，不能重复执行创建作品。如需调整，请使用重命名或更新作品设置。' }

    const dedupedTags = [...new Set(args.tags.map((tag) => tag.trim()).filter(Boolean))]
    const rejectedTags = dedupedTags.filter((tag) => !ALL_NOVEL_TAGS.includes(tag))
    if (rejectedTags.length > 0) {
      return { output: `作品未创建：标签「${rejectedTags.join('、')}」不在站内标签库中，请改用上下文给出的标签。` }
    }

    const title = args.title.trim()
    await prisma.novel.update({
      where: { id: ctx.novelId },
      data: { title, displayTitle: title, summary: args.summary.trim(), tagNames: dedupedTags.slice(0, MAX_NOVEL_TAGS) },
    })
    return {
      output: `已创建作品《${title}》，并写入简介与标签。`,
      summary: `创建作品《${title}》`,
      snapshot: { target: 'novel', targetId: ctx.novelId, field: 'title', previousValue: novel.title },
    }
  },
})

export const novelRenameTool = defineTool({
  name: 'novel_rename',
  title: '重命名作品',
  description: '修改当前作品的标题（书名）。',
  parameters: z.object({
    title: z.string().min(1).max(120).describe('新书名'),
  }),
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const novel = await (ctx.transaction ?? prisma).novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true },
    })

    if (!novel) {
      return { outcome: 'failed' as const, output: '未找到当前作品。' }
    }

    await (ctx.transaction ?? prisma).novel.update({
      where: { id: ctx.novelId },
      data: { title: args.title.trim(), displayTitle: args.title.trim() },
    })

    return {
      output: `已把作品《${novel.title}》改名为《${args.title.trim()}》。`,
      summary: `作品改名《${args.title.trim()}》`,
      snapshot: { target: 'novel', targetId: ctx.novelId, field: 'title', previousValue: novel.title },
    }
  },
})

export const novelUpdateMetaTool = defineTool({
  name: 'novel_update_meta',
  title: '更新作品设置',
  description: `更新作品的简介和标签。仅传入需要修改的字段。标签必须从站内统一标签库中选择（上下文里已给出完整标签库），最多 ${MAX_NOVEL_TAGS} 个；请结合作品简介与正文内容挑选最贴切的分类、题材与风格标签。`,
  parameters: z.object({
    summary: z.string().min(1).max(1000).optional().describe('新的作品简介'),
    tags: z.array(z.string().min(1).max(24)).max(10).optional().describe(`新的标签列表（整体替换，必须来自站内标签库，最多 ${MAX_NOVEL_TAGS} 个）`),
  }),
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const novel = await (ctx.transaction ?? prisma).novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { summary: true, tagNames: true },
    })

    if (!novel) {
      return { outcome: 'failed' as const, output: '未找到当前作品。' }
    }

    if (args.summary === undefined && args.tags === undefined) {
      return { outcome: 'failed' as const, output: '没有提供任何要修改的字段（summary / tags）。' }
    }

    // 标签合法性校验：只接受站内标签库里的标签，越界的挑出来提示模型改用库内标签
    let nextTags: string[] | undefined
    let rejectedTags: string[] = []
    if (args.tags !== undefined) {
      const deduped = [...new Set(args.tags.map((tag) => tag.trim()).filter(Boolean))]
      nextTags = deduped.filter((tag) => ALL_NOVEL_TAGS.includes(tag)).slice(0, MAX_NOVEL_TAGS)
      rejectedTags = deduped.filter((tag) => !ALL_NOVEL_TAGS.includes(tag))

      if (nextTags.length === 0 && rejectedTags.length > 0) {
        return {
          outcome: 'failed' as const,
          output: `标签未保存：「${rejectedTags.join('、')}」不在站内标签库中。请从上下文给出的标签库里重新选择（如：玄幻、都市、系统、重生、爽文……）。`,
        }
      }
    }

    await (ctx.transaction ?? prisma).novel.update({
      where: { id: ctx.novelId },
      data: {
        summary: args.summary?.trim() || undefined,
        tagNames: nextTags ?? undefined,
      },
    })

    const changed = [args.summary !== undefined ? '简介' : '', nextTags !== undefined ? `标签（${nextTags.join('、')}）` : '']
      .filter(Boolean)
      .join('、')
    const rejectedNote = rejectedTags.length > 0 ? `已忽略库外标签：${rejectedTags.join('、')}。` : ''

    return {
      output: `已更新作品${changed}。${rejectedNote}`,
      summary: `更新作品${args.summary !== undefined ? '简介' : ''}${args.summary !== undefined && nextTags !== undefined ? '与' : ''}${nextTags !== undefined ? '标签' : ''}`,
      snapshot: { target: 'novel', targetId: ctx.novelId, field: 'summary', previousValue: novel.summary },
    }
  },
})

export const coverPromptSetTool = defineTool({
  name: 'cover_prompt_set',
  title: '设置封面提示词',
  description: '把设计好的封面提示词写入当前作品，供后续生成封面使用。提示词需适配 3:4 竖版书封构图，并要求画面包含书名标题文字。',
  parameters: z.object({
    prompt: z
      .string()
      .min(4)
      .max(2000)
      .describe('封面提示词（中文，含主体/氛围/构图/风格关键词）。平台规定书封必须带作品名：提示词必须要求画面包含书名标题文字，严禁写「无文字/没有文字/no text」类负向约束（服务端也会强制纠正）'),
  }),
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const novel = await (ctx.transaction ?? prisma).novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { coverPrompt: true, title: true, displayTitle: true },
    })

    if (!novel) {
      return { outcome: 'failed' as const, output: '未找到当前作品。' }
    }

    // 服务端强制保险：与 cover_generate 同一口径，落库的提示词必须要求封面带书名标题文字
    const finalPrompt = enforceCoverTitleInPrompt(args.prompt.trim(), novel.title, novel.displayTitle)

    await (ctx.transaction ?? prisma).novel.update({ where: { id: ctx.novelId }, data: { coverPrompt: finalPrompt } })

    return {
      output: '封面提示词已保存到作品设置。',
      summary: '保存封面提示词',
      display: { kind: 'markdown', markdown: `**封面提示词**\n\n${finalPrompt}` },
      snapshot: { target: 'novel', targetId: ctx.novelId, field: 'coverPrompt', previousValue: novel.coverPrompt },
    }
  },
})

export const novelPublishTool = defineTool({
  name: 'novel_publish',
  title: '发布作品',
  description: '把作品切换到公开发布状态。高危操作，需要用户确认。',
  parameters: z.object({
    confirmTitle: z.string().describe('复述当前书名以确认操作对象'),
  }),
  permission: DANGEROUS_PERMISSION,
  readOnly: false,
  dangerous: true,
  async execute(ctx) {
    const novel = await prisma.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true, status: true },
    })

    if (!novel) {
      return { output: '未找到当前作品。' }
    }

    await prisma.novel.update({
      where: { id: ctx.novelId },
      data: { status: 'published', publishedAt: new Date() },
    })

    return {
      output: `作品《${novel.title}》已发布。`,
      summary: `发布《${novel.title}》`,
      snapshot: { target: 'novel', targetId: ctx.novelId, field: 'status', previousValue: novel.status },
    }
  },
})

export const novelArchiveTool = defineTool({
  name: 'novel_archive',
  title: '下架作品',
  description: '把作品切换到已下架（归档）状态。高危操作，需要用户确认。',
  parameters: z.object({
    confirmTitle: z.string().describe('复述当前书名以确认操作对象'),
  }),
  permission: DANGEROUS_PERMISSION,
  readOnly: false,
  dangerous: true,
  async execute(ctx) {
    const novel = await prisma.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true, status: true },
    })

    if (!novel) {
      return { output: '未找到当前作品。' }
    }

    await prisma.novel.update({ where: { id: ctx.novelId }, data: { status: 'archived' } })

    return {
      output: `作品《${novel.title}》已下架。`,
      summary: `下架《${novel.title}》`,
      snapshot: { target: 'novel', targetId: ctx.novelId, field: 'status', previousValue: novel.status },
    }
  },
})

export const novelDeleteTool = defineTool({
  name: 'novel_delete',
  title: '删除作品',
  description: '永久删除当前作品及其全部章节、封面与记忆，不可恢复。高危操作，需要用户确认。',
  parameters: z.object({
    confirmTitle: z.string().describe('复述当前书名以确认操作对象'),
  }),
  permission: DANGEROUS_PERMISSION,
  readOnly: false,
  dangerous: true,
  async execute(ctx) {
    const novel = await prisma.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true },
    })

    if (!novel) {
      return { output: '未找到当前作品，可能已被删除。' }
    }

    const { deleteNovelData } = await import('../../data-access.js')
    await deleteNovelData(ctx.userId, ctx.novelId)

    return {
      output: `作品《${novel.title}》已永久删除。本次任务到此结束，请告知用户结果，不要再调用其他工具。`,
      summary: `删除《${novel.title}》`,
    }
  },
})
