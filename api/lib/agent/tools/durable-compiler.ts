import { z } from 'zod'
import { DataAccessError } from '../../prisma.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { compilerStateHash } from '../runtime-compiler-observation.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { normalizeToolInput } from './input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

const actions = new Set(['story_compiler_prepare', 'scene_task_build', 'chapter_bridge_get', 'chapter_bridge_commit'])
const failures = new Set(['TOOL_COMPILER_REQUIRED', 'TOOL_COMPILER_STALE', 'COMPILATION_NOT_FOUND', 'COMPILATION_STAGE_CONFLICT',
  'SCENE_TASK_COUNT_INVALID', 'NOVEL_NOT_FOUND', 'CHAPTER_NOT_FOUND', 'TARGET_CHAPTER_GAP', 'AUTHOR_CHAPTER_SCOPE', 'SCOPE_NEEDS_INPUT',
  'RUNTIME_SCOPE_MISMATCH', 'RUNTIME_PARENT_LEASE_LOST', 'CONTINUITY_INPUT_STALE', 'CONTINUITY_ERRORS_REMAIN', 'QUALITY_CHECK_REQUIRED'])

/** These tools are DB-only. Model critics/repairs must use separately
 * receipted provider operations, never this retryable transaction adapter. */
export async function executeDurableCompiler(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableCompiler && { ...ctx.durableCompiler, lease: { ...ctx.durableCompiler.lease },
    cursor: { ...ctx.durableCompiler.cursor }, baseline: ctx.durableCompiler.baseline && { ...ctx.durableCompiler.baseline } }
  if (!capability || !actions.has(tool.name) || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '编译能力与原任务不一致。')
  const { lease, cursor, baseline } = capability
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, item]) => item !== undefined))
  const args = normalize(raw)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: tool.name === 'chapter_bridge_get' ? 'read' : 'compiler', targetId: lease.taskRootId,
    effectiveArgs: args, normalize, operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args, baseline }).value }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
    const rejected = await rejectToolCursorCall(lease, cursor, ctx.callId)
    await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
    return { rejected: { ...failedToolResultSchema.parse(rejected.receipt.result).toolResult, outcome: 'failed' as const } }
  })
  if ('rejected' in prepared) return prepared.rejected
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '编译工具不属于原任务范围。')
    if (tool.name === 'scene_task_build' || tool.name === 'chapter_bridge_commit') {
      if (!baseline) throw new DataAccessError(409, 'TOOL_COMPILER_REQUIRED', '本次未执行。请先准备本任务的章节编译，或用 chapter_bridge_get 读取本任务的 compilationId；不能使用其他任务的章节桥。')
      const current = await compilerStateHash(tx, ctx.userId, ctx.novelId, root.id, baseline.id)
      if (current !== baseline.hash) throw new DataAccessError(409, 'TOOL_COMPILER_STALE', `本次未执行。compilationId=${baseline.id} 的阶段或内容已变化，请先 chapter_bridge_get 重新读取后再决定，不覆盖新状态。`)
    }
    const result = await tool.execute({ ...ctx, durableCompiler: capability, transaction: tx }, args)
    if (result.outcome === 'failed') throw new DataAccessError(409, 'COMPILATION_NOT_FOUND', result.output)
    const id = result.display?.kind === 'storyCompiler' ? result.display.compilationId : undefined
    const hash = id ? await compilerStateHash(tx, ctx.userId, ctx.novelId, root.id, id) : null
    if (!id || !hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '编译结果缺少原任务内的状态身份。')
    ctx.signal.throwIfAborted()
    return runtimeJson({ compilerState: { id, hash }, toolResult: { ...result, summary: result.summary ?? '读取章节编译状态' } }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !failures.has(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '章节编译未执行' })
  })
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  return failed.success ? { ...failed.data.toolResult, outcome: 'failed' } : z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
