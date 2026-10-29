import { z } from 'zod'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { taskSpecSchema } from '../../../../shared/contracts/task-spec-contracts.js'
import { readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { coordinatedWritingManifest } from '../coordinated-writing-input.js'
import { withRunLease } from '../runtime-lease.js'
import { readExecutionFrame } from '../runtime-state.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { executeCoordinatedWritingServices } from '../writing-service-coordination.js'
import { projectChapterBodyResult, projectConfirmedToolFailure } from './contract.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

/** Read-only receipt adapter for an already admitted historical writer. */
export async function executeDurableCoordinatedWriter(ctx: ToolContext, tool: AgentTool, input: unknown): Promise<ToolResult> {
  const capability = ctx.durableContent
  if (!capability?.cursor || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId)
    return runtimeError('RUNTIME_SCOPE_MISMATCH', '历史写入回执不属于当前执行。')
  const lease = { ...capability.lease }
  const admitted = await withRunLease(lease, async tx => {
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.userId !== ctx.userId || root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId)
      return runtimeError('RUNTIME_SCOPE_MISMATCH', '历史写入回执不属于当前作者会话。')
    const locator = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: {
      taskRootId: lease.taskRootId, operationKey: capability.operationKey } }, select: { id: true } })
    if (!locator) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '新写入必须通过普通章节工具。')
    const proof = await readAdmittedToolOperation(lease, { operationId: locator.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId }, tx)
    const saved = proof.input, normalization = saved.normalization
    const snapshot = z.object({ input: z.object({ expectedRevision: z.number().int().positive(), writingManifest: z.unknown() }) }).safeParse(proof.operation.inputSnapshot)
    if (!snapshot.success) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '历史写入缺少原冻结清单。')
    const revision = snapshot.data.input
    if (proof.operation.operationKey !== capability.operationKey || runtimeJson(input).hash !== runtimeJson(saved.args).hash
      || saved.args.chapterId !== capability.chapterId || revision.expectedRevision !== capability.expectedRevision
      || normalization.sourceRevision !== capability.cursor!.expectedRevision || normalization.sourceSnapshotHash !== capability.cursor!.expectedHash
      || revision.writingManifest === undefined || runtimeJson(proof.operation.inputSnapshot).hash !== proof.operation.inputHash)
      return runtimeError('RUNTIME_IDENTITY_CONFLICT', '历史写入不能替换原正文、调用位置或冻结输入。')
    coordinatedWritingManifest({ spec: taskSpecSchema.parse(root.specSnapshot), prompt: null }, tool.name, capability.chapterId, saved.args.writing,
      { frozenManifest: revision.writingManifest })
    return proof
  })
  const operation = admitted.operation
  const receipt = await executeCoordinatedWritingServices(ctx, lease, operation.id, tool.name)
  const pending = await withRunLease(lease, tx => readExecutionFrame(tx, lease.taskRootId, admitted.input.normalization.sourceRevision + 1))
  await reduceExecutionReceipt(lease, { expectedRevision: pending.revision, expectedHash: pending.snapshotHash, operationId: operation.id })
  const provenance = { taskRootId: lease.taskRootId, operationId: operation.id, receiptId: receipt.operationId, resultHash: receipt.resultHash }
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return projectConfirmedToolFailure(ctx, { ...failed.data.toolResult, outcome: 'failed' }, failed.data.code, provenance)
  const result = z.object({ toolResult: z.custom<ToolResult>() }).parse(receipt.result).toolResult
  return projectChapterBodyResult(ctx, result, provenance)
}