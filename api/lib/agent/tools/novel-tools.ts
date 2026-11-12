import { assertNovelInitializationDirection, assertNovelMetadataIntent } from '../novel-initialization.js'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import { DataAccessError, prisma } from '../../prisma.js'
import { recalculateNovelStats } from '../../data/internal.js'
import { ALL_NOVEL_TAGS, MAX_NOVEL_TAGS } from '../../../../shared/contracts/novel-tags.js'
import { BOOTSTRAP_NOVEL_SUMMARY, getMissingNovelPublishFields, novelPublishMetadataMessage } from '../../../../shared/contracts/novel-publish.js'
import { enforceCoverTitleInPrompt } from './cover-prompt.js'
import { defineTool } from './types.js'

/**
 * 作品维度写工具集（自 write-tools.ts 模块级拆分而来，工具定义逐字保留）：
 * 改名/简介标签/封面提示词/发布/下架/删除，附作品统计重算（章节工具共用）。
 */

const WRITE_PERMISSION = { plan: 'deny', build: 'allow', review: 'deny' } as const
const DANGEROUS_PERMISSION = { plan: 'deny', build: 'ask', review: 'deny' } as const
const lifecycleTransition = (novelId: string, before: string, after: string) => ({ targetId: `novel-status:${novelId}`,
  beforeHash: createHash('sha256').update(before).digest('hex'), afterHash: createHash('sha256').update(after).digest('hex') })

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
  permission: { ...WRITE_PERMISSION, plan: 'allow' },
  readOnly: false,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    const db = ctx.transaction ?? prisma
    const novel = await db.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true, displayTitle: true, summary: true, chapterCount: true, wordCount: true },
    })
    if (!novel) return { outcome: 'failed', output: '未找到当前作品。' }

    const isBootstrap =
      !novel.displayTitle?.trim()
      && (novel.title === '未命名作品' || novel.title === '我的第一部作品')
      && novel.summary === BOOTSTRAP_NOVEL_SUMMARY
      && novel.chapterCount === 0
      && novel.wordCount === 0
    if (!isBootstrap) return { outcome: 'failed', output: '当前已是正式作品，不能重复执行创建作品。如需调整，请使用重命名或更新作品设置。' }
    if (ctx.transaction && await db.chapter.count({ where: { novelId: ctx.novelId } })) {
      return { outcome: 'failed', output: '当前占位作品已有章节记录，不能覆盖为新作品。请先读取当前作品。' }
    }

    await assertNovelInitializationDirection(db, ctx)
    const dedupedTags = [...new Set(args.tags.map((tag) => tag.trim()).filter(Boolean))]
    const rejectedTags = dedupedTags.filter((tag) => !ALL_NOVEL_TAGS.includes(tag))
    if (rejectedTags.length > 0) {
      return { outcome: 'failed', output: `作品未创建：标签「${rejectedTags.join('、')}」不在站内标签库中，请改用上下文给出的标签。` }
    }

    const title = args.title.trim()
    const summary = args.summary.trim(), tagNames = dedupedTags.slice(0, MAX_NOVEL_TAGS)
    ctx.signal.throwIfAborted()
    await db.novel.update({
      where: { id: ctx.novelId },
      data: { title, displayTitle: title, summary, tagNames },
    })
    return {
      output: `已创建作品《${title}》，并写入简介与标签。`,
      summary: `创建作品《${title}》`,
      ...(title && summary && tagNames.length ? { novelSetupRecap: { title, summary, tagNames } } : {}),
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
  description: `更新当前作品的书名、简介和标签。作者明确要求初始化当前正式作品时，可将三项一次保存，不重复创建作品。完整初始化必须一次提供非空书名、简介与至少一个有效标签；单独修改某项时仅传入需要修改的字段。标签必须从站内统一标签库中选择（上下文里已给出完整标签库），最多 ${MAX_NOVEL_TAGS} 个；请结合作品简介与正文内容挑选最贴切的分类、题材与风格标签。`,
  parameters: z.object({
    title: z.string().trim().min(1).max(120).optional().describe('作者明确授权采用或修改的当前作品书名'),
    summary: z.string().min(1).max(1000).optional().describe('新的作品简介'),
    tags: z.array(z.string().min(1).max(24)).max(10).optional().describe(`新的标签列表（整体替换，必须来自站内标签库，最多 ${MAX_NOVEL_TAGS} 个）`),
  }),
  permission: { ...WRITE_PERMISSION, plan: 'allow' },
  readOnly: false,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    const novel = await (ctx.transaction ?? prisma).novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true, displayTitle: true, summary: true, tagNames: true, chapterCount: true, wordCount: true },
    })

    if (!novel) {
      return { outcome: 'failed' as const, output: '未找到当前作品。' }
    }

    const { completeInitialization, canOmitTitle } = await assertNovelMetadataIntent(ctx.transaction ?? prisma, ctx, novel)
    if (completeInitialization && ((!canOmitTitle && !args.title?.trim()) || !args.summary?.trim() || !args.tags?.length)) {
      throw new DataAccessError(400, 'INVALID_ARGUMENTS', canOmitTitle
        ? '补全作品信息需要同时提供简介与标签，本次未修改。'
        : '完整初始化需要一次提供书名、简介与标签；尚未保存任何字段，请补齐三项后重试。')
    }
    if (args.title === undefined && args.summary === undefined && args.tags === undefined) {
      return { outcome: 'failed' as const, output: '没有提供需要修改的书名、简介或标签。' }
    }

    // 标签合法性校验：只接受站内标签库里的标签，越界的挑出来提示模型改用库内标签
    let nextTags: string[] | undefined
    let rejectedTags: string[] = []
    if (args.tags !== undefined) {
      const deduped = [...new Set(args.tags.map((tag) => tag.trim()).filter(Boolean))]
      nextTags = deduped.filter((tag) => ALL_NOVEL_TAGS.includes(tag)).slice(0, MAX_NOVEL_TAGS)
      rejectedTags = deduped.filter((tag) => !ALL_NOVEL_TAGS.includes(tag))

      if (completeInitialization && (nextTags.length === 0 || rejectedTags.length > 0) || nextTags.length === 0 && rejectedTags.length > 0) {
        return {
          outcome: 'failed' as const,
          output: `标签未保存：「${rejectedTags.join('、')}」不在站内标签库中。请从上下文给出的标签库里重新选择（如：玄幻、都市、系统、重生、爽文……）。`,
        }
      }
    }

    const summary = args.summary?.trim() || undefined
    ctx.signal.throwIfAborted()
    await (ctx.transaction ?? prisma).novel.update({
      where: { id: ctx.novelId },
      data: {
        ...(args.title !== undefined ? { title: args.title, displayTitle: args.title } : {}),
        summary,
        tagNames: nextTags ?? undefined,
      },
    })

    const changed = [args.title !== undefined ? '书名' : '', args.summary !== undefined ? '简介' : '', nextTags !== undefined ? `标签（${nextTags.join('、')}）` : '']
      .filter(Boolean)
      .join('、')
    const rejectedNote = rejectedTags.length > 0 ? `已忽略库外标签：${rejectedTags.join('、')}。` : ''

    return {
      output: `已更新作品${changed}。${rejectedNote}`,
      summary: `更新作品${args.summary !== undefined ? '简介' : ''}${args.summary !== undefined && nextTags !== undefined ? '与' : ''}${nextTags !== undefined ? '标签' : ''}`,
      ...(completeInitialization && args.title && summary && nextTags?.length ? { novelSetupRecap: { title: args.title, summary, tagNames: nextTags } } : {}),
      snapshot: { target: 'novel', targetId: ctx.novelId, field: args.title !== undefined ? 'title' : 'summary', previousValue: args.title !== undefined ? novel.title : novel.summary },
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
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    const db = ctx.transaction ?? prisma
    const novel = await db.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true, displayTitle: true, status: true, coverAssetId: true, summary: true, tagNames: true },
    })

    if (!novel) {
      return { outcome: 'failed', output: '未找到当前作品。' }
    }
    if (args.confirmTitle.trim() !== (novel.displayTitle?.trim() || novel.title)) return { outcome: 'failed', output: '确认书名与当前作品不一致，作品未发布。请核对当前标题后再确认。' }
    const missing = getMissingNovelPublishFields({ ...novel, tags: novel.tagNames })
    if (missing.length) return { outcome: 'failed', output: novelPublishMetadataMessage(missing) }
    ctx.signal.throwIfAborted()
    await db.novel.update({
      where: { id: ctx.novelId },
      data: { status: 'published', publishedAt: new Date() },
    })

    return {
      output: `作品《${novel.title}》已发布。`,
      summary: `发布《${novel.title}》`,
      semanticTransition: lifecycleTransition(ctx.novelId, novel.status, 'published'),
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
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    const db = ctx.transaction ?? prisma
    const novel = await db.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true, displayTitle: true, status: true },
    })

    if (!novel) {
      return { outcome: 'failed', output: '未找到当前作品。' }
    }
    if (args.confirmTitle.trim() !== (novel.displayTitle?.trim() || novel.title)) return { outcome: 'failed', output: '确认书名与当前作品不一致，作品未下架。请核对当前标题后再确认。' }
    ctx.signal.throwIfAborted()
    await db.novel.update({ where: { id: ctx.novelId }, data: { status: 'archived' } })

    return {
      output: `作品《${novel.title}》已下架。`,
      summary: `下架《${novel.title}》`,
      semanticTransition: lifecycleTransition(ctx.novelId, novel.status, 'archived'),
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
