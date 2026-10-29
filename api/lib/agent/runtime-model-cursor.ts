import { currentNativeToolViews, previousImplicitStrictToolViews, readFrozenModelToolViews } from './runtime-tool-view.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { preparePricedProviderOperationInTransaction } from './runtime-settlement.js'

export type ModelExecutionCursor = { expectedRevision: number; expectedHash: string }
export type FrozenModelRoute = { provider: string; model: string; endpoint: string; reasoningEffort: string }

/** No secret in this digest. The bootstrapper must freeze the same resolved route. */
export function modelRouteRevision(route: FrozenModelRoute): string {
  return runtimeJson({ version: 1, ...route }).hash
}

export async function validateModelCursor(token: RunLeaseToken, cursor: ModelExecutionCursor, input: {
  operationKey: string; parentOperationId?: string; messages: unknown; tools: unknown; tier: string; route: FrozenModelRoute
}) {
  token = { ...token }; cursor = { ...cursor }
  input = { ...input, messages: runtimeJson(input.messages).value, tools: runtimeJson(input.tools).value, route: { ...input.route } }
  if (!Number.isSafeInteger(cursor.expectedRevision) || cursor.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(cursor.expectedHash)) runtimeError('RUNTIME_STATE_INVALID', '模型轮次位置无效。')
  return withRunLease(token, async tx => {
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    const frame = await readExecutionFrame(tx, token.taskRootId, cursor.expectedRevision)
    if (frame.snapshotHash !== cursor.expectedHash || frame.state.phase !== 'idle' || frame.state.pendingOperationId
      || input.operationKey !== `exec:${frame.state.nextOperationSequence}` || input.parentOperationId) runtimeError('RUNTIME_STATE_CONFLICT', '主模型调用必须来自原空闲执行位置。')
    const projected = await currentNativeToolViews(current.configuration.tools, taskSpecSchema.parse(current.originalSpec).scope)
    let tools: unknown = projected
    let previousTools: unknown = previousImplicitStrictToolViews(current.configuration.tools, projected)
    if (current.frame.state.phase === 'awaiting_operation' && current.frame.state.pendingOperationId) {
      const operation = await tx.agentOperation.findUniqueOrThrow({ where: { id: current.frame.state.pendingOperationId } })
      if (operation.kind !== 'provider' || operation.status !== 'prepared' || operation.operationKey !== input.operationKey
        || operation.taskRootId !== token.taskRootId || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
        || current.frame.revision !== frame.revision + 1
        || runtimeJson(current.frame.state.messages).hash !== runtimeJson(frame.state.messages).hash
        || await tx.agentProviderAttempt.count({ where: { operationId: operation.id, OR: [{ dispatchedAt: { not: null } }, { status: { not: 'prepared' } }] } })) {
        return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原模型请求不能用新工具视图替换或重派。')
      }
      tools = readFrozenModelToolViews(operation.inputSnapshot)
      // Prepared recovery authenticates its complete original request only.
      previousTools = undefined
    }
    const toolHash = runtimeJson(input.tools).hash
    if (runtimeJson(input.messages).hash !== runtimeJson(frame.state.messages).hash || toolHash !== runtimeJson(tools).hash
      && (previousTools === undefined || toolHash !== runtimeJson(previousTools).hash)) runtimeError('RUNTIME_IDENTITY_CONFLICT', '模型上下文或工具列表与冻结执行状态不同。')
    const model = current.configuration.model
    if (model.tier !== input.tier || model.provider !== input.route.provider || model.modelName !== input.route.model
      || model.reasoningEffort !== input.route.reasoningEffort || model.routeRevision !== modelRouteRevision(input.route)) runtimeError('RUNTIME_IDENTITY_CONFLICT', '模型路由与冻结配置不同，不能静默切换供应商或模型。')
    // Never skip the tool-result phase by asking the model again from the same
    // assistant tool-call message. Failure/cancellation observations need receipts too.
    let index = frame.state.messages.length - 1
    while (index >= 0 && frame.state.messages[index].role === 'tool') index--
    const assistant = frame.state.messages[index]
    if (assistant?.role === 'assistant' && assistant.toolCalls?.some(call => !frame.state.messages.slice(index + 1)
      .some(message => message.role === 'tool' && message.toolCallId === call.id))) runtimeError('RUNTIME_TOOL_RESULTS_REQUIRED', '原工具调用尚无完整观察结果，不能跳过。')
    return frame
  })
}

/** Commit before provider admission and HTTP. Replay binds the same pending frame. */
export async function prepareModelCursorOperation(token: RunLeaseToken, cursor: ModelExecutionCursor,
  input: Parameters<typeof preparePricedProviderOperationInTransaction>[2]) {
  token = { ...token }; cursor = { ...cursor }
  input = { ...input, request: runtimeJson(input.request).value, price: { ...input.price } }
  return withRunLease(token, async tx => {
    const frame = await readExecutionFrame(tx, token.taskRootId, cursor.expectedRevision)
    if (frame.snapshotHash !== cursor.expectedHash || frame.state.phase !== 'idle'
      || input.key !== `exec:${frame.state.nextOperationSequence}` || input.parentOperationId) runtimeError('RUNTIME_STATE_CONFLICT', '原模型轮次位置已变化。')
    const operation = await preparePricedProviderOperationInTransaction(tx, token, input)
    const pending = await saveExecutionStateInTransaction(tx, token, { ...cursor, snapshot: { ...frame.state, phase: 'awaiting_operation', pendingOperationId: operation.id,
      turn: frame.state.turn + 1, nextOperationSequence: frame.state.nextOperationSequence + 1 } })
    return { operation, pending }
  })
}
