import { z } from 'zod'
export const retainedFindingSchema = z.object({ source: z.enum(['continuity', 'quality']), reportId: z.string().min(1), findingId: z.string().min(1), reason: z.string().trim().min(1).max(1000) }).strict()
export const retainedFindings = z.array(retainedFindingSchema).max(40).optional().describe('不能安全改动的当前意见逐项留置：continuity 的 reportId 使用工具给出的检查绑定，findingId 为从0开始的索引；quality 使用当前报告ID与意见ID。必须写明具体安全原因，留置不表示问题已修复')

export const chapterWriteArguments = z.object({
  chapterId: z.string().optional().describe('目标章节 ID；缺省时默认写入最近操作/当前正在编辑的章节'),
  content: z.string().min(1).describe('完整的新正文'),
  retainedFindings,
})
export const chapterAppendArguments = z.object({
  chapterId: z.string().optional().describe('目标章节 ID；缺省时默认追加到最近操作/当前正在编辑的章节'),
  content: z.string().min(1).describe('要追加的内容'),
})
export const chapterPatchSchema = z.object({ oldText: z.string().min(1), newText: z.string() }).strict()
export const chapterEditArguments = z.object({
  chapterId: z.string().optional().describe('目标章节 ID；缺省时默认操作最近操作/当前正在编辑的章节'),
  oldText: z.string().optional().describe('要替换的原文片段（从 chapter_read 返回的正文逐字拷贝，含标点换行）；系统自动定位，须在正文中唯一，不唯一就向两侧多拷几句'),
  start: z.number().int().min(0).optional().describe('片段起始字符位置（仅作者选区给出精确坐标时传；常规改写用 oldText 定位）'),
  end: z.number().int().min(0).optional().describe('片段结束字符位置（不含）'),
  newText: z.string().optional().describe('单片段替换后的新文本；与 patches 互斥'),
  patches: z.array(chapterPatchSchema).min(1).max(8).optional().describe('一次合并的精确替换，最多8处；全部 oldText 来自同一个当前正文，必须唯一且不重叠。与 oldText/start/end/newText 互斥，任一无效则全部不写入'),
  retainedFindings,
}).superRefine((args, ctx) => {
  if (args.patches ? [args.oldText, args.start, args.end, args.newText].some(value => value !== undefined)
    : args.newText === undefined || (!args.oldText && (args.start === undefined || args.end === undefined))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '仅传 patches 或完整的单片段替换参数，不能混用' })
  }
})
