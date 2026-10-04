import { DataAccessError, prisma } from '../prisma.js'

/** Recheck at admission and dispatch: stale/deleted/foreign selections never silently become another helper. */
export async function requireSelectedSubagent(userId: string, novelId: string, id: string) {
  const item = await prisma.agentSubtask.findFirst({
    where: { id, userId, novelId, enabled: true },
    select: { id: true, name: true, role: true, triggerCondition: true, prompt: true },
  })
  if (!item) throw new DataAccessError(409, 'SUBAGENT_UNAVAILABLE', '指定的子 Agent 已停用、删除或不属于当前作品，请重新选择。')
  if (!['research', 'continuity', 'quality', 'lore'].includes(item.role)) {
    throw new DataAccessError(409, 'SUBAGENT_UNAVAILABLE', '指定的子 Agent 角色无效，请先在管理面板修正。')
  }
  return item
}

export function selectedSubagentGuidance(id: string): string {
  return `作者本轮手动指定 subagentId=${id}。这项明确选择本身就是调用依据，不要求用户重复触发词。先核对职责和当前任务：在职责与权限允许的范围内用 subagent_run 委派具体、自包含的子任务；调用仍走审批，模型、推理强度与费用按实际选择并冻结的线路执行。若职责不适用或授权不足，请明确解释，不能偷偷改用另一个助手或创建替代助手。恢复任务时先核对同一任务已有调用回执，已完成的委派不要重复执行。收到报告后核验来源与实际结果再整合，不把选择助手当成已执行。`
}
