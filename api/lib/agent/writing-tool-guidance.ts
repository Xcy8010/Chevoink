import type { TaskSpec } from '../../../shared/contracts/index.js'

/** Guidance uses the server-frozen task, never the editor anchor or tool input.
 * It does not change admission, saved decisions, bindings or permissions. */
export function frozenWritingToolGuidance(action: string, scope?: TaskSpec['scope']): string {
  if (!['story_compiler_prepare', 'chapter_create'].includes(action)) return ''
  const writing = scope?.writing
  const target = writing?.kind === 'bounded' && writing.targets.length === 1 ? writing.targets[0] : undefined
  if (!target || target.chapterId !== null || !Number.isSafeInteger(target.orderIndex) || target.orderIndex <= 0
    || target.volumeId !== undefined || target.positionInVolume !== undefined) return ''
  const frozen = `服务端原任务已授权新建全书第${target.orderIndex}章。若本任务已建立编译或绑定章节，复用其真实 compilationId/chapterId 继续缺失步骤，不重复准备或建章。不要使用界面当前章节或前章编号作为待写 chapterId。`
  if (action === 'story_compiler_prepare') return `${frozen}仅本任务尚未准备时，先纠正 story_compiler_prepare：省略 chapterId，targetOrderIndex 可省略或只填数字 ${target.orderIndex}，intentSummary 填本章实际写作目标。${writing?.tailVolume
    ? 'volumeDecision 必填，按已读取的卷目标与前章事实决定 continue 或 new_volume，并给出真实理由。'
    : ''}前章只作承接参考，不是本次写入目标；准备失败后应先纠正准备参数，不要跳过准备直接创建章节。已有本任务编译时复用返回的 compilationId。`
  return `${frozen}仅目标尚未创建时，先完成本任务 PREPARE 并保存卷决定。continue 沿用当前卷时，chapter_create 最小参数为 {"title":"章节名称"}（content 可选）；省略 newVolume、volumeId、volumeOrder、positionInVolume，服务器按冻结全书位置定位。只有 PREPARE 已保存 new_volume 决定且真实卷目标已收束时才填写 newVolume；newVolume 表示新增卷，不能填写已有卷或与已有卷定位混用。位置字段需要填写时使用整数，不用字符串；title 默认只写章名，作者明确指定的非空命名均可使用，不因章号或书名号拒绝创建。`
}
