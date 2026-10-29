import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { runtimeError } from './runtime-common.js'
import { readAdmittedToolOperation } from './runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from './runtime-operations.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { readContinuityRequestBilling } from './continuity-review.js'
import type { ToolContext } from './tools/types.js'

/** Historical coordinated writers may replay their actual committed receipt.
 * New writing uses ordinary chapter tools and the registered review service.
 * Unfinished old work never dispatches its former phase/candidate pipeline. */
export async function executeCoordinatedWritingServices(ctx: ToolContext, lease: RunLeaseToken, operationId: string, action: string) {
  const admitted = await readAdmittedToolOperation(lease, { operationId, action, novelId: ctx.novelId, callId: ctx.callId })
  const saved = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId } }))
  if (saved) return commitOperationEffect(lease, operationId, admitted.operation.inputHash, async () => runtimeError('RUNTIME_RECEIPT_INVALID', '原回执不能重新执行。'))
  const billing = await withRunLease(lease, async tx => {
    const original = await readOriginalTaskRequest(tx, ctx), runIds = await originalTaskRunIds(tx, ctx, original)
    const chapter = { id: String(admitted.input.args.chapterId) }
    return readContinuityRequestBilling(tx, ctx, { runIds, chapter }, null)
  })
  if (!billing.known) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原请求用量或费用尚未确认，已保存正文与原回执保留，未追加请求。')
  return recordToolFailure(lease, { operationId, inputHash: admitted.operation.inputHash, code: 'CONTINUITY_REPORT_INCOMPLETE',
    output: '原写入与报告记录已保留；请通过普通章节工具处理当前正文并完成检查、提交。', summary: '原协调检查未完成' })
}