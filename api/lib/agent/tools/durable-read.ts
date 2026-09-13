import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { ToolContext, ToolResult } from './types.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { DataAccessError } from '../../prisma.js'

/** DB-only reads: the returned observation and baseline are committed together.
 * Never use for paid network, subprocess, filesystem, or a tool with external effects. */
export async function executeDurableRead(ctx: ToolContext, action: 'craft_search' | 'style_leakage_check' | 'research_dossier_get' | 'first_three_prototype_get' | 'style_profile_get' | 'retrieval_trace_read' | 'memory_review_list' | 'character_voice_get' | 'experience_anchor_get' | 'directive_list' | 'project_search' | 'entity_resolve' | 'impact_analyze' | 'structure_validate' | 'story_charter_get' | 'quality_report_get' | 'execution_context_read' | 'chapter_read' | 'plan_read' | 'novel_get_context' | 'chapter_list_summaries' | 'memory_search' | 'volume_list' | 'structure_outline' | 'session_history_search' | 'session_message_read' | 'task_context_list' | 'task_context_read', args: unknown,
  normalize: (raw: unknown) => unknown, read: (tx: Prisma.TransactionClient) => Promise<ToolResult>): Promise<ToolResult> {
  const capability = ctx.durableRead && { ...ctx.durableRead, lease: { ...ctx.durableRead.lease }, cursor: { ...ctx.durableRead.cursor } }
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '读取能力与原任务不一致。')
  const grant = ctx.toolAuthority?.get(action)
  if (!grant || grant.permission === 'deny') runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '当前任务不允许此读取。')
  const { lease, cursor } = capability
  const effectiveArgs = runtimeJson(args).value
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action, callId: ctx.callId,
    effectDomain: 'read', targetId: ctx.novelId, requireApproval: grant!.permission === 'ask' || grant!.alwaysConfirm, effectiveArgs, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, chapterId: ctx.chapterId ?? null, args: effectiveArgs }).value }).catch(async error => {
      if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
      const rejected = await rejectToolCursorCall(lease, cursor, ctx.callId)
      await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
      return { rejected: { ...failedToolResultSchema.parse(rejected.receipt.result).toolResult, outcome: 'failed' as const } }
    })
  if ('rejected' in prepared) return prepared.rejected
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) runtimeError('RUNTIME_SCOPE_MISMATCH', '读取不属于原任务范围。')
    const result = await read(tx)
    if (result.outcome === 'failed') throw new DataAccessError(409, 'TOOL_READ_NOT_FOUND', result.output)
    ctx.signal.throwIfAborted()
    return runtimeJson({ toolResult: { ...result, summary: result.summary ?? '读取完成' } }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['TOOL_READ_NOT_FOUND', 'QUALITY_REPORT_NOT_FOUND', 'RETRIEVAL_TRACE_NOT_FOUND', 'CHAPTER_NOT_FOUND'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '未找到读取目标' })
  })
  const failure = failedToolResultSchema.safeParse(receipt.result)
  const result = z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }).passthrough() }).parse(receipt.result)
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return failure.success ? { ...failure.data.toolResult, outcome: 'failed' } : result.toolResult as ToolResult
}
