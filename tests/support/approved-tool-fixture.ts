import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { readEffectiveNativeTooling } from '../../api/lib/agent/native-tool-policy.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { requestToolApproval, resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'

/** Positive child fixtures record a real human approval for the exact call.
 * Permission-denial and approval lifecycle cases use the production entry directly. */
export async function prepareApprovedFixtureTool(...args: Parameters<typeof prepareToolCursorOperation>) {
  const [lease, cursor, input] = args
  const current = await loadExecutionState(lease.userId, lease.runId)
  const tooling = await withRunLease(lease, tx => readEffectiveNativeTooling(tx, lease, current.configuration, taskSpecSchema.parse(current.originalSpec)))
  const grant = tooling.toolAuthority.find(item => item.name === input.action)
  if (grant?.permission === 'ask' || grant?.alwaysConfirm) {
    const request = await requestToolApproval(lease, { ...cursor, callId: input.callId, timeoutMs: 60000, normalize: input.normalize })
    await resolveDurableApproval({ userId: lease.userId, runId: lease.runId, requestId: request.id, callId: input.callId, approved: true, alwaysAllow: false })
  }
  return prepareToolCursorOperation(...args)
}
