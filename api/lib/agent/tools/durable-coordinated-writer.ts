import { z } from 'zod'
import { runtimeError } from '../runtime-common.js'
import { withRunLease } from '../runtime-lease.js'
import { readExecutionFrame } from '../runtime-state.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { executeCoordinatedWritingServices } from '../writing-service-coordination.js'
import { projectChapterBodyResult, projectConfirmedToolFailure } from './contract.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

/** Read-only receipt adapter for an already admitted historical writer. */
export async function executeDurableCoordinatedWriter(ctx: ToolContext, tool: AgentTool, _input: unknown): Promise<ToolResult> {
  const capability = ctx.durableContent
  if (!capability?.cursor || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId)
    return runtimeError('RUNTIME_SCOPE_MISMATCH', '历史写入回执不属于当前执行。')
  const lease = { ...capability.lease }
  const operation = await withRunLease(lease, tx => tx.agentOperation.findUnique({ where: { taskRootId_operationKey: {
    taskRootId: lease.taskRootId, operationKey: capability.operationKey } } }))
  if (!operation) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '新写入必须通过普通章节工具。')
  const receipt = await executeCoordinatedWritingServices(ctx, lease, operation.id, tool.name)
  const source = z.object({ input: z.object({ normalization: z.object({ sourceRevision: z.number().int() }) }) }).parse(operation.inputSnapshot)
  const pending = await withRunLease(lease, tx => readExecutionFrame(tx, lease.taskRootId, source.input.normalization.sourceRevision + 1))
  await reduceExecutionReceipt(lease, { expectedRevision: pending.revision, expectedHash: pending.snapshotHash, operationId: operation.id })
  const provenance = { taskRootId: lease.taskRootId, operationId: operation.id, receiptId: receipt.operationId, resultHash: receipt.resultHash }
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return projectConfirmedToolFailure(ctx, { ...failed.data.toolResult, outcome: 'failed' }, failed.data.code, provenance)
  const result = z.object({ toolResult: z.custom<ToolResult>() }).parse(receipt.result).toolResult
  return projectChapterBodyResult(ctx, result, provenance)
}