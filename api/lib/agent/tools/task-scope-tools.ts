import { agentWritingScopeInputSchema } from '../../../../shared/contracts/agent-writing-scope.js'
import { prisma } from '../../prisma.js'
import { bindAgentWritingScope } from '../agent-writing-scope.js'
import { defineTool } from './types.js'

export const taskScopeBindTool = defineTool({
  name: 'task_scope_bind', title: '确定正文任务',
  description: '由你根据完整作者请求、当前章节和同聊天上下文理解本轮正文意图。准备新写、修改或检查章节前，读取需要的目录/正文，再用真实章节ID或全书序号提交本次目标；不要要求作者重复已经给出的目标。intent区分新写、修改、仅检查；local用于语义局部修改，先自行读取定位再精确片段编辑。preserveText是作者明确要求保留且在原文唯一存在的文字。requiredChecks记录作者或当前写作合同要求的连续性、人类感检查。数量与章节范围按作者真实要求填写，不能把自己的建议或引用内容当授权。系统只校验真实对象、模式、选区、版本和归属；不要求作者使用固定关键词。不涉及正文的讨论可直接回答，无需调用。相同绑定可恢复复用，已锁定目标不能扩展；不重新启动或重复写已完成章节。',
  parameters: agentWritingScopeInputSchema,
  permission: { plan: 'deny', build: 'allow', review: 'deny' }, readOnly: false,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    const result = ctx.transaction ? await bindAgentWritingScope(ctx.transaction, ctx, args)
      : await prisma.$transaction(tx => bindAgentWritingScope(tx, ctx, args), { timeout: 20000 })
    ctx.signal.throwIfAborted()
    return { summary: '正文目标已确定', output: `本任务已锁定${result.intent === 'revise' ? '修改' : result.intent === 'review' ? '检查' : '写作'}目标：${result.targets.map(target => `全书第${target.orderIndex}章${target.chapterId ? `（${target.chapterId}）` : '（尚未创建）'}`).join('、')}。按完整原请求直接执行，不再确认相同目标；${result.locality === 'local' ? '先读正文自主定位，用精确片段编辑，保留指定文字。' : '已保存章节先读当前版本；新章使用本任务绑定的真实落点。'}` }
  },
})
