import { z } from 'zod'

import { FIXED_NOVEL_COVER_SIZE } from '../../../../shared/contracts/index.js'
import { generateCoverImageData } from '../../ai-service.js'
import { prisma } from '../../prisma.js'
import { enforceCoverTitleInPrompt } from './cover-prompt.js'
import { defineTool } from './types.js'
import { applyCoverSelection, prepareCoverSelection } from './cover-application.js'

const WRITE_PERMISSION = { plan: 'deny', build: 'allow', review: 'deny' } as const

/** 生成封面候选图（复用现有生图与 CoverAsset 存储实现） */
export const coverGenerateTool = defineTool({
  name: 'cover_generate',
  title: '生成封面',
  description:
    '按提示词生成封面候选图（3:4 竖版书封），生成结果会展示给用户挑选。建议先用 cover_prompt_set 保存提示词再生成。生图服务响应很慢（单张可能需要几分钟），一次最多生成 2 张，需要更多候选时分多次调用。',
  parameters: z.object({
    prompt: z
      .string()
      .min(4)
      .max(2000)
      .describe('封面提示词（中文，含主体/氛围/构图/风格关键词）。平台规定书封必须带作品名：提示词必须要求画面包含书名标题文字，严禁写「无文字/没有文字/no text」类负向约束（服务端也会强制纠正）'),
    count: z.number().int().min(1).max(2).optional().describe('生成张数，默认 1，最多 2'),
  }),
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const novel = await prisma.novel.findFirst({
      where: { id: ctx.novelId, authorId: ctx.userId },
      select: { title: true, displayTitle: true },
    })

    if (!novel) {
      return { output: '未找到当前作品。' }
    }

    // 服务端强制保险：清洗「无文字」类负向短语，并确保提示词要求封面带书名标题文字
    const finalPrompt = enforceCoverTitleInPrompt(args.prompt.trim(), novel.title, novel.displayTitle)

    const { images } = await generateCoverImageData(ctx.userId, {
      prompt: finalPrompt,
      size: FIXED_NOVEL_COVER_SIZE,
      count: args.count ?? 1,
      novelId: ctx.novelId,
    })

    if (images.length === 0) {
      return { output: '封面生成失败：图像服务没有返回结果，可稍后重试或调整提示词。' }
    }

    const candidates = images
      .map((image, index) => `候选${index + 1}：coverAssetId ${image.id}，候选图 url ${image.imageUrl}`)
      .join('；')

    return {
      output: `已生成 ${images.length} 张封面候选图：${candidates}。接下来必须先对每张候选调用 view_image（url 传上面给出的候选图 url，也可直传 coverAssetId）校验画面（主体/构图是否符合提示词、封面是否清晰包含书名标题文字，实际使用的提示词「${finalPrompt.slice(0, 120)}」），校验通过后再用 ask_user 询问作者是否应用（多张时问选哪张），得到确认后用 cover_apply 带对应 ID 应用；不要不问就结束任务。`,
      summary: `生成 ${images.length} 张封面候选`,
      display: {
        kind: 'coverImages',
        images: images.map((image) => ({ id: image.id, url: image.imageUrl })),
      },
    }
  },
})

/** 把已生成的封面应用为作品封面 */
export const coverApplyTool = defineTool({
  name: 'cover_apply',
  title: '应用封面',
  description: '按作者明确要求，把候选图或当前任务中作者上传的图片设为当前作品封面。候选图传 coverAssetId，上传图片传附件真实 attachmentUrl，二选一。直接应用作者指定图片，不要重新生成。',
  parameters: z.object({
    coverAssetId: z.string().trim().min(1).max(64).optional().describe('要应用的封面候选资源 ID'),
    attachmentUrl: z.string().min(1).max(1024).optional().describe('当前任务的用户图片附件 URL'),
  }).refine(value => Boolean(value.coverAssetId) !== Boolean(value.attachmentUrl), '请选择一个封面候选或图片附件'),
  permission: WRITE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const cover = await prepareCoverSelection(ctx, args)
    return prisma.$transaction(tx => applyCoverSelection(ctx, cover, tx))
  },
})
