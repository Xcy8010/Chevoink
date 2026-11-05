import { readNovelInitializationCompletion } from './novel-initialization.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { loadSessionTodoItems } from './tools/todo-tools.js'
import { runtimeJson } from './runtime-common.js'

export type TaskResponseContinue = { eventId: string; afterSeq: number; ownerSeq: number; ownerHash: string }
export type TaskResponse = { taskId: string; requestHash: string; answer: string; authorContinue?: TaskResponseContinue }

/** A current server-admitted human Continue, never an old start or auto-resume. */
async function currentResponseContinue(tx: Prisma.TransactionClient, runId: string, witness: TaskResponseContinue): Promise<boolean> {
  if (!witness.eventId || !Number.isSafeInteger(witness.afterSeq) || witness.afterSeq < 0
    || witness.ownerSeq !== witness.afterSeq + 1) return false
  const owner = await tx.agentRunEvent.findFirst({ where: { runId, type: 'run.started' }, orderBy: { seq: 'desc' } })
  if (!owner || owner.seq !== witness.ownerSeq || runtimeJson(owner.payload).hash !== witness.ownerHash) return false
  const payload = owner.payload && typeof owner.payload === 'object' && !Array.isArray(owner.payload) ? owner.payload : null
  const marker = payload?.authorContinue && typeof payload.authorContinue === 'object' && !Array.isArray(payload.authorContinue) ? payload.authorContinue : null
  if (marker?.eventId !== witness.eventId || marker.afterSeq !== witness.afterSeq) return false
  const terminal = await tx.agentRunEvent.findFirst({ where: { id: witness.eventId, runId,
    type: { in: ['run.paused', 'run.finished'] }, seq: { lte: witness.afterSeq } } })
  const latest = await tx.agentRunEvent.findFirst({ where: { runId, type: { in: ['run.paused', 'run.finished'] },
    seq: { lt: witness.ownerSeq } }, orderBy: { seq: 'desc' } })
  return !!terminal && terminal.id === latest?.id
}
/** A complete serialized function-call envelope is protocol data, not an answer.
 * Code examples with surrounding prose/fences are not raw envelopes. */
export function isTaskResponseToolEnvelope(text: string): boolean {
  if (!text.trimStart().startsWith('{')) return false
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const envelope = value as Record<string, unknown>
    const functionCall = (candidate: unknown): boolean => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
      const call = candidate as Record<string, unknown>
      return typeof call.name === 'string' && call.name.trim().length > 0 && typeof call.arguments === 'string'
    }
    return functionCall(envelope.function_call) || Array.isArray(envelope.tool_calls) && envelope.tool_calls.length > 0
      && envelope.tool_calls.every(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        && candidate.type === 'function' && functionCall(candidate.function))
  } catch { return false }
}

const manuscriptWork = new Set(['story_compiler_prepare', 'scene_task_build', 'chapter_create', 'chapter_write',
  'chapter_append', 'chapter_edit_range', 'chapter_rename', 'quality_revision_apply', 'chapter_bridge_commit',
  'quality_analyze', 'continuity_validate', 'research_report_save', 'plan_save',
  'changeset_apply', 'changeset_rollback', 'volume_create', 'volume_move', 'volume_update', 'volume_delete',
  'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge'])

/** Mechanical execution evidence only: the main Agent owns response semantics.
 * Frozen inferred intent/target metadata is never proof that writing started. */
export async function assertTaskResponseEligible(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; sessionId: string; runId: string }, expected?: TaskResponse,
  authorContinue = expected?.authorContinue) {
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    sessionId: subject.sessionId, runtimeProtocolVersion: 0, taskRootId: null, status: 'running' } })
  const original = await readOriginalTaskRequest(tx, subject)
  const parsed = taskSpecSchema.safeParse(original.spec)
  if (parsed.success && parsed.data.scope.agentWritingProtocol === 1) {
    const effective = await (await import('./writing-scope.js')).effectiveWritingTaskSpec(tx, subject, parsed.data)
    if (effective.scope.agentWritingBinding && ['write', 'revise'].includes(effective.intent))
      throw new DataAccessError(409, 'TASK_RESPONSE_WORK_PENDING', '已经绑定本次正文目标，请完成实际写入和必要检查，不能改用普通答复结束。')
  }
  if (!run || original.parentRunId || !original.prompt || !parsed.success
    || parsed.data.responseDeliveryProtocol !== 1 && !(authorContinue && await currentResponseContinue(tx, subject.runId, authorContinue))) {
    throw new DataAccessError(409, 'TASK_RESPONSE_UNAVAILABLE', '原任务未启用直接答复交付，保留原执行流程。')
  }
  if (parsed.data.postconditions.some(condition => condition.code === 'NOVEL_METADATA_INITIALIZED')
    && (await readNovelInitializationCompletion(tx, subject)).status === 'incomplete') throw new DataAccessError(409, 'TASK_RESPONSE_WORK_PENDING', '作品初始化尚未实际保存，不能仅用文字结束；继续已授权的书名、简介与标签保存。')
  const proof = { taskId: original.taskId, requestHash: createHash('sha256').update(original.prompt).digest('hex'),
    ...(parsed.data.responseDeliveryProtocol !== 1 && authorContinue ? { authorContinue: { ...authorContinue } } : {}) }
  if (expected && (expected.taskId !== proof.taskId || expected.requestHash !== proof.requestHash)) {
    throw new DataAccessError(409, 'TASK_RESPONSE_STALE', '原任务在答复交付前已变化，答复未交付。')
  }
  const runIds = await originalTaskRunIds(tx, subject, original)
  const runs = await tx.agentRun.findMany({ where: { id: { in: runIds }, userId: subject.userId, novelId: subject.novelId },
    select: { id: true, status: true, writingBindings: true } })
  const compilation = await tx.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId,
    runId: { in: runIds } }, select: { id: true } })
  const messages = await tx.agentMessage.findMany({ where: { runId: { in: runIds }, role: 'assistant' }, select: { parts: true } })
  const actualWork = messages.some(message => Array.isArray(message.parts) && message.parts.some(part => {
    if (!part || typeof part !== 'object' || Array.isArray(part) || part.type !== 'tool-call') return false
    const display = part.display && typeof part.display === 'object' && !Array.isArray(part.display) ? part.display : null
    return part.reviewOutcome === 'provider_unresolved' || manuscriptWork.has(String(part.toolName))
      && (part.status === 'success' || part.status === 'running' || part.status === 'pending'
        // A writer can commit and then fail in post-write bookkeeping. Only
        // deterministic preexecution parameter failures prove no effect.
        || part.status === 'failed' && part.preExecutionFailure !== true
        || !!part.snapshot || display?.kind === 'chapterDiff' && display.appliedDirectly === true)
  }))
  const todos = await loadSessionTodoItems(subject.sessionId, runIds, tx)
  const unresolvedOperations = await tx.agentOperation.count({ where: { originRunId: { in: runIds },
    OR: [{ status: { in: ['prepared', 'dispatched', 'unknown'] } }, { action: { in: [...manuscriptWork] }, status: 'succeeded' }] } })
  const unfinishedSubtasks = await tx.agentSubtaskRun.count({ where: { userId: subject.userId, novelId: subject.novelId,
    parentRunId: { in: runIds }, status: { notIn: ['completed', 'cancelled'] } } })
  if (compilation || actualWork || unresolvedOperations || unfinishedSubtasks || runs.some(item => item.writingBindings !== null && item.writingBindings !== undefined
    || item.id !== subject.runId && ['queued', 'running', 'awaiting_approval'].includes(item.status))
    || todos.some(item => ['pending', 'in_progress'].includes(item.status))) {
    const pending = todos.filter(item => ['pending', 'in_progress'].includes(item.status))
    const next = [
      pending.length ? `尚未完成的原待办：${pending.slice(0, 5).map(item => item.content).join('；')}。` : '',
      compilation ? `本任务已有章节编译${compilation.id}，用chapter_bridge_get读取当前目标及缺失的正文、必要检查或提交步骤；复用有效结果，不重建编译。` : '',
      actualWork && !compilation ? '本任务已经执行计划或正文等实际工作，先核对工具回执并完成原目标；计划未保存用plan_save，已有计划用plan_read核对后只补缺失内容。' : '',
      unfinishedSubtasks ? '仍有未终态的本任务子工作，读取其真实状态后继续或等待，不创建替代任务。' : '',
      unresolvedOperations ? '已有执行操作或待核回执须按原主流程交付；未知结果先核对，不重复请求。' : '',
    ].filter(Boolean).join('')
    throw new DataAccessError(409, 'TASK_RESPONSE_WORK_PENDING', `当前不能用task_respond提前收尾。${next}继续原主流程；完成原目标后正常交付，不反复调用task_respond，也不把待办标记完成来绕过实际工作。`)
  }
  return proof
}
