import { agentWritingScopeInputSchema } from '../../../../shared/contracts/agent-writing-scope.js'
import { prisma } from '../../prisma.js'
import { bindAgentWritingScope } from '../agent-writing-scope.js'
import { defineTool } from './types.js'

export const taskScopeBindTool = defineTool({
  name: 'task_scope_bind', title: '记录正文计划',
  description: '可选：记录你根据完整作者请求和已读上下文制定的正文计划，普通正文和结构工具不需要先调用本工具。intent区分写作、修订和检查；目标使用真实章节ID或全书序号。preserveText记录作者明确要求保留的原文，requiredChecks记录拟进行的检查。计划不是工具权限，不因未记录计划要求作者重复目标；直接按真实请求使用普通工具，真实选区、模式、归属和当前版本仍生效。相同记录可恢复复用，不以计划记录宣称正文已完成。',
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
