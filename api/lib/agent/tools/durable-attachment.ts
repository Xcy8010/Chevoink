import { z } from 'zod'
import type { AgentTool, ToolContext, ToolResult } from './types.js'
import { normalizeToolInput } from './input-validation.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { prepareToolCursorOperation, readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { assertCurrentToolPolicy, commitOperationEffect } from '../runtime-operations.js'
import { reduceExecutionReceipt } from '../runtime-reducer.js'
import { withRunLease } from '../runtime-lease.js'
import { DataAccessError } from '../../prisma.js'

/** Local authorized attachments only. Vision, network and paid providers must
 * use their own durable dispatch protocol, never this replayable file read. */
export async function executeDurableAttachmentRead(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableAttachment
  if (!capability || tool.name !== 'read_file' || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '文件读取缺少原任务能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const args = normalize(raw)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: 'read', targetId: ctx.novelId, effectiveArgs: args, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args }).value })
  let receipt = await withRunLease(lease, async tx => {
    const saved = await tx.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } })
    if (saved && (prepared.operation.status !== 'succeeded' || runtimeJson(saved.result).hash !== saved.resultHash)) return runtimeError('RUNTIME_RECEIPT_INVALID', '文件读取回执损坏。')
    if (!saved) await assertCurrentToolPolicy(tx, lease, prepared.operation)
    return saved
  })
  if (!receipt) {
    await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId })
    ctx.signal.throwIfAborted()
    let result: ToolResult
    try { result = await tool.execute({ ...ctx, durableAttachment: undefined }, args) }
    catch (error) {
      if (!(error instanceof DataAccessError) || !['ATTACHMENT_NOT_FOUND', 'FORBIDDEN', 'ATTACHMENT_TOO_LARGE', 'ATTACHMENT_SIZE_INVALID', 'ATTACHMENT_CHANGED'].includes(error.code)) throw error
      result = { outcome: 'failed', failureCode: error.code, output: '附件不存在、不可访问或超过读取上限。未替换为其他文件。', summary: '附件读取未完成' }
    }
    ctx.signal.throwIfAborted()
    receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async () => {
      ctx.signal.throwIfAborted()
      return runtimeJson({ toolResult: result }).value
    })
  }
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
