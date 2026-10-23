import { z } from 'zod'
import { taskSpecSchema } from '../../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../../prisma.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { withRunLease } from '../runtime-lease.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { coordinatedWritingManifest, coordinatedWriterActions } from '../coordinated-writing-input.js'
import { readOriginalTaskRequest } from '../original-request.js'
import { executeCoordinatedWritingServices } from '../writing-service-coordination.js'
import { normalizeToolInput } from './input-validation.js'
import { projectChapterBodyResult, projectConfirmedToolFailure } from './contract.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

/** Cursor shell only. Body/reviews/commit run below the genuine writer; no
 * child can reduce it early or replace an old frozen writer contract. */
export async function executeDurableCoordinatedWriter(ctx: ToolContext, tool: AgentTool, input: unknown): Promise<ToolResult> {
  const capability = ctx.durableContent
  if (!capability?.cursor || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId
    || !coordinatedWriterActions.some(action => action === tool.name)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '写作协调缺少真实写入位置。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (raw: unknown) => {
    const parsed = tool.parameters.parse(normalizeToolInput(tool, raw)) as Record<string, unknown>
    return Object.fromEntries(Object.entries({ ...parsed,
      chapterId: typeof parsed.chapterId === 'string' && parsed.chapterId.trim() ? parsed.chapterId.trim() : capability.chapterId }).filter(([, value]) => value !== undefined))
  }
  const args = normalize(input)
  const manifest = await withRunLease(lease, async tx => {
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.userId !== ctx.userId || root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '写作协调不属于原作品会话。')
    const original = await readOriginalTaskRequest(tx, ctx)
    return coordinatedWritingManifest({ spec: taskSpecSchema.parse(root.specSnapshot), prompt: original.prompt }, tool.name, capability.chapterId, args.writing)
  })
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    targetId: capability.chapterId, effectiveArgs: args, normalize,
    operationInput: runtimeJson({ novelId: ctx.novelId, callId: ctx.callId, args, expectedRevision: capability.expectedRevision, writingManifest: manifest }).value,
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
    const rejected = await rejectToolCursorCall(lease, cursor, ctx.callId)
    await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
    const failed = failedToolResultSchema.parse(rejected.receipt.result)
    return { rejected: projectConfirmedToolFailure(ctx, { ...failed.toolResult, outcome: 'failed' as const }, failed.code,
      { taskRootId: lease.taskRootId, operationId: rejected.operation.id, receiptId: rejected.receipt.operationId, resultHash: rejected.receipt.resultHash }) }
  })
  if ('rejected' in prepared) return prepared.rejected
  const receipt = await executeCoordinatedWritingServices(ctx, lease, prepared.operation.id, tool.name)
  ctx.signal.throwIfAborted()
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const provenance = { taskRootId: lease.taskRootId, operationId: prepared.operation.id, receiptId: receipt.operationId, resultHash: receipt.resultHash }
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return projectConfirmedToolFailure(ctx, { ...failed.data.toolResult, outcome: 'failed' }, failed.data.code, provenance)
  const result = z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
  return projectChapterBodyResult(ctx, result, provenance)
}
