import { z } from 'zod'
import type { AgentTool, ToolContext, ToolResult } from './types.js'
import { normalizeToolInput } from './input-validation.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { prepareToolCursorOperation, readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { assertCurrentToolPolicy, commitOperationEffect } from '../runtime-operations.js'
import { reduceExecutionReceipt } from '../runtime-reducer.js'
import { withRunLease, withRunLeaseInTransaction } from '../runtime-lease.js'
import { DataAccessError } from '../../prisma.js'
import { recordResearchReadOutcome } from '../research-sources.js'

/** WebToolCall remains the sole network permit and fixed-price ledger. This
 * adapter binds it to the genuine model cursor, then projects its saved result.
 * No HTTP is executed in a retryable database transaction. */
export async function executeDurableWeb(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableWeb
  if (!capability || !['web_search', 'web_read'].includes(tool.name)
    || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '联网工具缺少原任务执行能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const args = normalize(raw)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: 'read', targetId: ctx.novelId, effectiveArgs: args, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args }).value })
  const saved = await withRunLease(lease, async tx => {
    const receipt = await tx.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } })
    if (receipt && (prepared.operation.status !== 'succeeded' || runtimeJson(receipt.result).hash !== receipt.resultHash)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原联网工具回执不完整。')
    return receipt
  })
  let receipt = saved
  if (!receipt) {
    const admitted = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId })
    // A new worker uses the original dispatch/billing run, never today's run ID.
    const project = async (work: (ctx: ToolContext) => Promise<ToolResult>) => {
      const committed = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
        ctx.signal.throwIfAborted()
        const result = await work({ ...webContext, transaction: tx, webProjection: undefined })
        ctx.signal.throwIfAborted()
        return runtimeJson({ toolResult: result }).value
      })
      return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(committed.result).toolResult as ToolResult
    }
    const webContext: ToolContext = { ...ctx, durableWeb: undefined, runId: admitted.operation.originRunId, webProjection: project,
      webAdmission: (tx, work) => withRunLeaseInTransaction(tx, lease, async () => {
        const original = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId }, tx)
        if (original.operation.status !== 'prepared' || original.operation.inputHash !== prepared.operation.inputHash) return runtimeError('RUNTIME_STATE_CONFLICT', '原联网操作不再等待派发。')
        await assertCurrentToolPolicy(tx, lease, original.operation)
        ctx.signal.throwIfAborted()
        const value = await work()
        ctx.signal.throwIfAborted()
        return value
      }) }
    let result: ToolResult
    let knownRefusal = false
    try { result = await tool.execute(webContext, args) }
    catch (error) {
      // Unknown dispatch/settlement and authority failures stay pending. A known
      // bounded research/reader refusal is an observation, not an empty success.
      if (!(error instanceof DataAccessError) || (!/^(WEB_(READ|SEARCH)_|RESEARCH_)/.test(error.code)
        && !['CREDIT_WEB_TOOL_FAILED', 'CREDITS_EXHAUSTED', 'CREDITS_RESERVED', 'CREDITS_SETTLEMENT_PENDING'].includes(error.code))
        || error.code === 'RESEARCH_REQUEST_UNCERTAIN' || error.code === 'RESEARCH_REQUEST_ALREADY_RESERVED') throw error
      result = { outcome: 'failed', failureCode: error.code, output: error.message, summary: '联网未取得可用证据' }
      knownRefusal = true
    }
    ctx.signal.throwIfAborted()
    receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
      ctx.signal.throwIfAborted()
      // A completed response rejected during projection is a known failed read,
      // not a consumed request with an unknowable supplier result. The failed
      // projection rolled back, so save this observation with its final receipt.
      if (knownRefusal && tool.name === 'web_read') await recordResearchReadOutcome({ ...webContext, transaction: tx }, false)
      return runtimeJson({ toolResult: result }).value
    })
  }
  const result = z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return result
}
