import { z } from 'zod'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { durableChatResultSchema } from './runtime-common.js'
import { readExecutionFrame, readExecutionStateInTransaction, saveExecutionState, type executionSnapshotSchema } from './runtime-state.js'
import { argumentNormalizationSchema, toolRejectionSchema } from './runtime-tool-cursor.js'
import { readToolApprovalOutcome } from './runtime-approval.js'
import { readObservedBaseline } from './runtime-observed-baseline.js'
import { formatDurableToolObservation, formatReferencedToolObservation, TOOL_OBSERVATION_INLINE_BYTES } from './runtime-common.js'
import { executionContextReadTool } from './tools/task-context-tools.js'
import { toOpenAIParameters } from './tool-schema.js'
export { formatDurableToolObservation } from './runtime-common.js'

type Message = z.infer<typeof executionSnapshotSchema>['messages'][number]
const successfulModel = z.object({ outcome: z.literal('succeeded'), result: durableChatResultSchema }).strict()
const toolInput = z.object({ input: z.object({ callId: z.string().min(1), args: z.record(z.string(), z.unknown()), normalization: argumentNormalizationSchema.optional(), rejection: toolRejectionSchema.optional() }) })
const toolResult = z.object({ toolResult: z.object({ output: z.string() }) })
export const failedToolResultSchema = z.object({ outcome: z.literal('failed'), effectApplied: z.literal(false), code: z.string(),
  toolResult: z.object({ output: z.string(), summary: z.string() }) }).strict()

/** Reduce a specific saved pending frame, never the latest conversational summary.
 * A retry names the same revision/hash/operation, even after the head has moved.
 * Receipt reads and CAS use separate transactions: no nested lease/root locks.
 * This is context recovery, not completion proof, authorization, or billing. */
export async function reduceExecutionReceipt(token: RunLeaseToken, input: {
  expectedRevision: number; expectedHash: string; operationId: string
}) {
  const lease = { ...token }, cursor = { ...input }
  if (!Number.isSafeInteger(cursor.expectedRevision) || cursor.expectedRevision < 0
    || !/^[a-f0-9]{64}$/.test(cursor.expectedHash)) runtimeError('RUNTIME_STATE_INVALID', '回执归约位置无效。')
  const snapshot = await withRunLease(lease, async tx => {
    const current = await readExecutionStateInTransaction(tx, lease.taskRootId)
    const frame = await readExecutionFrame(tx, lease.taskRootId, cursor.expectedRevision)
    if (frame.snapshotHash !== cursor.expectedHash || frame.state.phase !== 'awaiting_operation'
      || frame.state.pendingOperationId !== cursor.operationId) runtimeError('RUNTIME_STATE_CONFLICT', '回执与原待执行位置不一致。')
    const operation = await tx.agentOperation.findFirst({ where: { id: cursor.operationId, taskRootId: lease.taskRootId }, include: { effectReceipt: true } })
    if (!operation || (operation.status !== 'succeeded' && !(operation.kind === 'tool' && operation.status === 'failed'))) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原操作没有确认终态，不能将部分结果当成交付。')
    if (!operation.inputSnapshot || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原操作输入损坏。')
    let appended: Message
    if (operation.kind === 'provider') {
      const attempts = await tx.agentProviderAttempt.findMany({ where: { operationId: operation.id, status: 'succeeded', dispatchedAt: { not: null } }, take: 2 })
      if (attempts.length !== 1) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '模型成功回执不唯一，不能猜测采用哪次结果。')
      const attempt = attempts[0], parsed = successfulModel.safeParse(attempt.result)
      if (!parsed.success || !attempt.resultHash || runtimeJson(attempt.result).hash !== attempt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '模型结果回执不完整或损坏。')
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `result:${attempt.id}:${attempt.resultHash}` } })
      if (!event || event.taskRootId !== lease.taskRootId || event.operationId !== operation.id || event.type !== 'provider.result.recorded'
        || runtimeJson(event.payload).hash !== runtimeJson({ attemptId: attempt.id, status: 'succeeded', resultHash: attempt.resultHash }).hash) runtimeError('RUNTIME_RECEIPT_INVALID', '模型结果与持久事件不一致。')
      const result = parsed.data.result
      if (result.toolCalls.some(call => !call.id || !call.name) || new Set(result.toolCalls.map(call => call.id)).size !== result.toolCalls.length) runtimeError('RUNTIME_RECEIPT_INVALID', '模型工具调用身份缺失或重复。')
      appended = { role: 'assistant', content: result.content || null,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) }
    } else if (operation.kind === 'tool') {
      const receipt = operation.effectReceipt, parsedInput = toolInput.safeParse(operation.inputSnapshot)
      const parsedResult = toolResult.safeParse(receipt?.result)
      if (!receipt || !parsedInput.success || !parsedResult.success || runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '工具输入关联或结果回执缺失。')
      const failed = operation.status === 'failed'
      if (failed && !failedToolResultSchema.safeParse(receipt.result).success) runtimeError('RUNTIME_RECEIPT_INVALID', '工具失败观察不完整。')
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `${failed ? 'observation' : 'effect'}:${operation.id}` } })
      if (!event || event.taskRootId !== lease.taskRootId || event.operationId !== operation.id || event.type !== (failed ? 'tool.observation.recorded' : 'effect.committed')
        || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash, ...(failed ? { outcome: 'failed' } : {}) }).hash) runtimeError('RUNTIME_RECEIPT_INVALID', '工具结果与持久事件不一致。')
      const callId = parsedInput.data.input.callId
      // Only the latest assistant turn may own this reply. Old turns are not authority.
      let assistantIndex = frame.state.messages.length - 1
      while (assistantIndex >= 0 && frame.state.messages[assistantIndex].role === 'tool') assistantIndex--
      const assistant = frame.state.messages[assistantIndex]
      const calls = assistant?.role === 'assistant' ? assistant.toolCalls?.filter(call => call.id === callId) : undefined
      const rejection = parsedInput.data.input.rejection
      if (!calls || calls.length !== 1 || calls[0].name !== operation.action || (calls[0].incomplete && !rejection)
        || frame.state.messages.slice(assistantIndex + 1).some(message => message.role === 'tool' && message.toolCallId === callId)) runtimeError('RUNTIME_STATE_CONFLICT', '工具结果不属于当前未回答的完整调用。')
      const normalization = parsedInput.data.input.normalization
      if (rejection) {
        if ((rejection.code === 'TOOL_TARGET_REQUIRED') !== Boolean(rejection.target)
          || (rejection.target && operation.action !== 'plan_save')) runtimeError('RUNTIME_RECEIPT_INVALID', '目标拒绝缺少原计划身份。')
        if ((rejection.code === 'TOOL_BASELINE_REQUIRED') !== Boolean(rejection.baseline)) runtimeError('RUNTIME_RECEIPT_INVALID', '基线拒绝缺少对应目标。')
        if (rejection.baseline?.id && await readObservedBaseline(tx, lease.taskRootId, rejection.sourceRevision, { kind: rejection.baseline.kind, id: rejection.baseline.id })) runtimeError('RUNTIME_RECEIPT_INVALID', '原执行位置已有读取基线，不能伪造缺失观察。')
        const approvalCode = rejection.code === 'TOOL_APPROVAL_DENIED' || rejection.code === 'TOOL_APPROVAL_EXPIRED'
        if (approvalCode !== Boolean(rejection.approval)) runtimeError('RUNTIME_RECEIPT_INVALID', '审批拒绝缺少原决定。')
        if (rejection.approval) {
          const outcome = await readToolApprovalOutcome(tx, lease, rejection.sourceSnapshotHash, callId, operation.action, rejection.rawArguments)
          if (!outcome || !outcome.decision || outcome.status !== (rejection.code === 'TOOL_APPROVAL_EXPIRED' ? 'expired' : 'denied')
            || outcome.request.id !== rejection.approval.requestId || outcome.decision.id !== rejection.approval.decisionId
            || runtimeJson(outcome.decision.payload).hash !== rejection.approval.decisionHash) runtimeError('RUNTIME_RECEIPT_INVALID', '审批拒绝与原决定不一致。')
        }
        const definition = current.configuration.tools.find(tool => tool.function.name === operation.action)
        if ((rejection.code === 'TOOL_SCHEMA_INVALID') !== Boolean(rejection.validation)
          || (rejection.validation && (!definition || runtimeJson(definition.function.parameters).hash !== rejection.validation.schemaHash))) runtimeError('RUNTIME_RECEIPT_INVALID', '字段拒绝回执未绑定原始工具schema。')
        const source = await readExecutionFrame(tx, lease.taskRootId, rejection.sourceRevision)
        const failure = failedToolResultSchema.safeParse(receipt.result)
        if (!failed || !failure.success || failure.data.code !== rejection.code || normalization
          || rejection.sourceRevision >= frame.revision || source.snapshotHash !== rejection.sourceSnapshotHash
          || runtimeJson(source.state.messages).hash !== runtimeJson(frame.state.messages).hash
          || rejection.rawArguments !== calls![0].arguments || rejection.incomplete !== Boolean(calls![0].incomplete)
          || Object.keys(parsedInput.data.input.args).length !== 0) runtimeError('RUNTIME_RECEIPT_INVALID', '工具拒绝观察与原始调用不一致。')
      } else if (normalization) {
        const source = await readExecutionFrame(tx, lease.taskRootId, normalization.sourceRevision)
        if (normalization.sourceRevision >= frame.revision || source.snapshotHash !== normalization.sourceSnapshotHash
          || runtimeJson(source.state.messages).hash !== runtimeJson(frame.state.messages).hash
          || normalization.rawArguments !== calls![0].arguments || normalization.normalizedArgsHash !== runtimeJson(parsedInput.data.input.args).hash) runtimeError('RUNTIME_RECEIPT_INVALID', '参数归一化回执与原调用或实际效果不同。')
      } else {
        let originalArgs: unknown
        try { originalArgs = JSON.parse(calls![0].arguments) } catch { return runtimeError('RUNTIME_RECEIPT_INVALID', '原工具参数不能解析，不能猜测调用关联。') }
        if (runtimeJson(originalArgs).hash !== runtimeJson(parsedInput.data.input.args).hash) runtimeError('RUNTIME_STATE_CONFLICT', '工具回执参数与原调用不同，需要明确的参数归一化回执。')
      }
      const output = parsedResult.data.toolResult.output
      const canReadArchive = current.configuration.tools.some(tool => tool.function.name === 'execution_context_read'
        && runtimeJson(tool.function.parameters).hash === runtimeJson(toOpenAIParameters(executionContextReadTool.parameters)).hash)
        && current.configuration.toolAuthority.some(grant => grant.name === 'execution_context_read' && grant.permission === 'allow' && !grant.alwaysConfirm)
      appended = { role: 'tool', toolCallId: callId, content: operation.action !== 'execution_context_read' && canReadArchive
        && Buffer.byteLength(output, 'utf8') > TOOL_OBSERVATION_INLINE_BYTES
        ? formatReferencedToolObservation(operation.action, output, { operationId: operation.id, resultHash: receipt.resultHash })
        : formatDurableToolObservation(operation.action, output) }
    } else return runtimeError('RUNTIME_STATE_CONFLICT', '内部操作不能伪装成模型工具回复。')
    return { ...frame.state, phase: 'idle' as const, pendingOperationId: null, messages: [...frame.state.messages, appended] }
  })
  return saveExecutionState(lease, { expectedRevision: cursor.expectedRevision, expectedHash: cursor.expectedHash, snapshot })
}
