import { z } from 'zod'
import { defineTool } from './types.js'

export const taskRespondTool = defineTool({
  name: 'task_respond',
  title: '答复问题',
  description: '根据完整原始请求判断本次只需解释、讨论或答复时，完成必要读取后单独调用，answer 是直接交付给作者的完整答复。无需建立待办；不会再请求一次模型。已经准备、创建、修改章节或尚有未完成实际工作时不能使用；本工具不改变原任务权限。',
  parameters: z.object({ answer: z.string().min(1).refine(value => value.trim().length > 0, '答复不能为空') }).strict(),
  readOnly: true,
  permission: { plan: 'allow', build: 'allow', review: 'allow' },
  async execute(ctx, args) {
    if (!ctx.respondTask || ctx.inlineChild) return { outcome: 'failed', failureCode: 'TASK_RESPONSE_UNAVAILABLE',
      summary: '本次答复未交付', output: '本工具仅接受当前主任务单独的原生终结调用；继续原任务已获准工作。' }
    return { terminalResponse: await ctx.respondTask(args.answer), summary: '答复已核对', output: '答复已核对，执行器将直接交付。' }
  },
})
