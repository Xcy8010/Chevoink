import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { databaseNow, lockRunRoot, runtimeError, runtimeId, runtimeJson, runtimeTransaction, type RuntimeTx } from './runtime-common.js'
import { assertGoalRevisionFence, readGoalExecution } from './goal-fence.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'
import { parseToolArgsTolerant } from './tool-argument-parser.js'
import { coerceToolArgumentEnvelope } from './tools/argument-coercion.js'
import type { AgentStreamEventBody } from '../../../shared/contracts/index.js'
import type { AgentExecutionOutbox } from '@prisma/client'

const requestSchema = z.object({ version: z.literal(1), callId: z.string(), toolName: z.string(), sourceRevision: z.number().int().nonnegative(),
  sourceHash: z.string(), rawArguments: z.string(), args: z.unknown(), argsHash: z.string(), expiresAt: z.string().datetime() }).strict()
const decisionSchema = z.object({ version: z.literal(1), requestId: z.string(), requestHash: z.string(), approved: z.boolean(), userId: z.string(), timedOut: z.literal(true).optional() }).strict()

function requestKey(rootId: string, sourceHash: string, callId: string) {
  return `approval:${rootId}:${runtimeJson({ sourceHash, callId }).hash}`
}

/** Read-only projection from saved facts, including while a task is paused. */
export async function projectApprovalEvent(tx: RuntimeTx, source: AgentExecutionOutbox, userId: string): Promise<AgentStreamEventBody> {
  if (source.type === 'approval.requested') {
    const parsed = requestSchema.safeParse(source.payload)
    if (!parsed.success || source.eventKey !== requestKey(source.taskRootId, parsed.data.sourceHash, parsed.data.callId)
      || runtimeJson(parsed.data.args).hash !== parsed.data.argsHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '审批事件源损坏。')
    return { type: 'permission.ask', approvalId: source.id, callId: parsed.data.callId, toolName: parsed.data.toolName,
      title: parsed.data.toolName, args: parsed.data.args, expiresAt: parsed.data.expiresAt, allowAlways: false }
  }
  const decision = decisionSchema.safeParse(source.payload)
  if (source.type !== 'approval.resolved' || !decision.success || decision.data.userId !== userId
    || (decision.data.approved && decision.data.timedOut) || source.eventKey !== `approval-decision:${decision.data.requestId}`) return runtimeError('RUNTIME_RECEIPT_INVALID', '审批决定事件源损坏。')
  const request = await tx.agentExecutionOutbox.findFirst({ where: { id: decision.data.requestId, taskRootId: source.taskRootId, type: 'approval.requested' } })
  if (!request || runtimeJson(request.payload).hash !== decision.data.requestHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '审批事件缺少原请求。')
  const event = await projectApprovalEvent(tx, request, userId)
  if (event.type !== 'permission.ask') return runtimeError('RUNTIME_RECEIPT_INVALID', '审批事件类型无效。')
  return { type: 'permission.resolved', approvalId: request.id, callId: event.callId, approved: decision.data.approved }
}

/** One non-blocking scheduler step. Returned events are projections of saved
 * identities; callers must deliver through the durable event publisher. */
export async function pollToolApproval(token: RunLeaseToken, input: { expectedRevision: number; expectedHash: string; callId: string }) {
  token = { ...token }; input = { ...input }
  return withRunLease(token, async tx => {
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    if (current.frame.revision !== input.expectedRevision || current.frame.snapshotHash !== input.expectedHash || current.frame.state.phase !== 'idle') runtimeError('RUNTIME_STATE_CONFLICT', '审批轮询不是当前执行位置。')
    let index = current.frame.state.messages.length - 1
    while (index >= 0 && current.frame.state.messages[index].role === 'tool') index--
    const assistant = current.frame.state.messages[index]
    const call = assistant?.role === 'assistant' ? assistant.toolCalls?.find(call => !current.frame.state.messages.slice(index + 1).some(message => message.role === 'tool' && message.toolCallId === call.id)) : undefined
    if (!call || call.id !== input.callId) return runtimeError('RUNTIME_STATE_CONFLICT', '审批轮询不是当前调用。')
    const outcome = await readToolApprovalOutcome(tx, token, input.expectedHash, call.id, call.name, call.arguments)
    if (!outcome) return runtimeError('RUNTIME_APPROVAL_REQUIRED', '尚未创建审批请求。')
    const event: AgentStreamEventBody = outcome.status === 'pending'
      ? { type: 'permission.ask', approvalId: outcome.request.id, callId: call.id, toolName: call.name, title: call.name,
        args: outcome.requestData.args, allowAlways: false, expiresAt: outcome.requestData.expiresAt }
      : { type: 'permission.resolved', approvalId: outcome.request.id, callId: call.id, approved: outcome.status === 'approved' }
    return { status: outcome.status, event, sourceEventId: outcome.decision?.id ?? outcome.request.id }
  })
}

/** Persists the exact call shown for approval; requesting is not execution. */
export async function requestToolApproval(token: RunLeaseToken, input: { expectedRevision: number; expectedHash: string; callId: string; timeoutMs: number; normalize: (raw: unknown) => unknown }) {
  token = { ...token }; input = { ...input }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 86_400_000) runtimeError('RUNTIME_INPUT_INVALID', '审批期限无效。')
  return withRunLease(token, async tx => {
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    const frame = await readExecutionFrame(tx, token.taskRootId, input.expectedRevision)
    if (frame.snapshotHash !== input.expectedHash || frame.state.phase !== 'idle') runtimeError('RUNTIME_STATE_CONFLICT', '审批必须绑定原始执行位置。')
    let index = frame.state.messages.length - 1
    while (index >= 0 && frame.state.messages[index].role === 'tool') index--
    const assistant = frame.state.messages[index]
    const call = assistant?.role === 'assistant' ? assistant.toolCalls?.find(call => !frame.state.messages.slice(index + 1).some(message => message.role === 'tool' && message.toolCallId === call.id)) : undefined
    if (!call || call.id !== input.callId || call.incomplete) return runtimeError('RUNTIME_STATE_CONFLICT', '审批不是当前完整待执行调用。')
    const grant = current.configuration.toolAuthority.find(grant => grant.name === call.name)
    if (!grant || grant.permission === 'deny' || (grant.permission !== 'ask' && !grant.alwaysConfirm)
      || !current.configuration.tools.some(tool => tool.function.name === call.name)) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '审批不能扩大冻结工具权限。')
    const args = runtimeJson(input.normalize(coerceToolArgumentEnvelope(call.arguments ? parseToolArgsTolerant(call.arguments, false) : {})))
    const key = requestKey(token.taskRootId, frame.snapshotHash, call.id)
    const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: key } })
    if (existing) {
      const parsed = requestSchema.safeParse(existing.payload)
      if (existing.taskRootId !== token.taskRootId || existing.type !== 'approval.requested' || !parsed.success
        || parsed.data.sourceHash !== frame.snapshotHash || parsed.data.sourceRevision !== frame.revision || parsed.data.callId !== call.id
        || parsed.data.toolName !== call.name || parsed.data.rawArguments !== call.arguments || parsed.data.argsHash !== args.hash
        || runtimeJson(parsed.data.args).hash !== args.hash) runtimeError('RUNTIME_RECEIPT_INVALID', '原审批请求损坏或实际参数已变化。')
      return existing // Original expiry is never extended by polling or resume.
    }
    if (current.frame.revision !== frame.revision) runtimeError('RUNTIME_STATE_CONFLICT', '不能为已经离开的执行位置新建审批。')
    const now = await databaseNow(tx)
    return tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: token.taskRootId, runId: token.runId,
      eventKey: key, type: 'approval.requested', payload: { version: 1, callId: call.id, toolName: call.name, sourceRevision: frame.revision,
        sourceHash: frame.snapshotHash, rawArguments: call.arguments, args: args.value, argsHash: args.hash, expiresAt: new Date(now.getTime() + input.timeoutMs).toISOString() } } })
  })
}

/** Authenticated user decision, not a worker lease. Root/run lock serializes stop. */
export async function resolveDurableApproval(input: { userId: string; runId: string; requestId: string; callId: string; approved: boolean; alwaysAllow: boolean }) {
  input = { ...input }
  runtimeId(input.requestId)
  if (typeof input.callId !== 'string' || !input.callId || typeof input.approved !== 'boolean' || typeof input.alwaysAllow !== 'boolean') runtimeError('RUNTIME_INPUT_INVALID', '审批身份与决定字段不完整。')
  if (input.alwaysAllow) runtimeError('RUNTIME_APPROVAL_SCOPE_INVALID', '本次审批只允许当前调用，不能扩展为会话永久授权。')
  return runtimeTransaction(async tx => {
    const goal = await readGoalExecution(input.userId, input.runId, tx)
    if (goal) await assertGoalRevisionFence(tx, goal)
    const { run, root } = await lockRunRoot(tx, input.userId, input.runId)
    const request = await tx.agentExecutionOutbox.findFirst({ where: { id: input.requestId, taskRootId: root.id, type: 'approval.requested' } })
    const parsed = requestSchema.safeParse(request?.payload)
    if (!request || !parsed.success || parsed.data.callId !== input.callId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '审批请求不属于当前调用。')
    const payload = parsed.data
    if (runtimeJson(payload.args).hash !== payload.argsHash) runtimeError('RUNTIME_RECEIPT_INVALID', '审批参数摘要不一致。')
    if (request.eventKey !== requestKey(root.id, payload.sourceHash, payload.callId)) runtimeError('RUNTIME_RECEIPT_INVALID', '审批请求身份不一致。')
    const requestHash = runtimeJson(request.payload).hash
    const decision = { version: 1, requestId: request.id, requestHash, approved: input.approved, userId: input.userId }
    const old = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `approval-decision:${request.id}` } })
    if (old) {
      if (old.taskRootId !== root.id || old.type !== 'approval.resolved' || runtimeJson(old.payload).hash !== runtimeJson(decision).hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '审批已有不同决定，不能覆盖。')
      return { resolved: true }
    }
    if (root.status !== 'active' || ['paused', 'cancelled', 'completed', 'failed'].includes(run.status)) runtimeError('RUNTIME_APPROVAL_NOT_PENDING', '任务已停止，不能新批准。')
    const current = await readExecutionStateInTransaction(tx, root.id)
    if (current.frame.revision !== payload.sourceRevision || current.frame.snapshotHash !== payload.sourceHash || current.frame.state.phase !== 'idle') runtimeError('RUNTIME_APPROVAL_NOT_PENDING', '当前任务已离开待审批位置。')
    if ((await databaseNow(tx)).getTime() >= Date.parse(payload.expiresAt)) runtimeError('RUNTIME_APPROVAL_EXPIRED', '审批已超时。')
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: run.id, eventKey: `approval-decision:${request.id}`, type: 'approval.resolved', payload: decision } })
    return { resolved: true }
  })
}

/** Caller holds withRunLease; absence/denial never grants an effect. */
export async function assertToolApproval(tx: RuntimeTx, token: RunLeaseToken, sourceHash: string, callId: string, toolName: string, rawArguments: string, argsHash: string) {
  const outcome = await readToolApprovalOutcome(tx, token, sourceHash, callId, toolName, rawArguments)
  if (!outcome || outcome.status === 'pending') return runtimeError('RUNTIME_APPROVAL_REQUIRED', '尚未收到明确审批。')
  if (outcome.requestData.argsHash !== argsHash) runtimeError('RUNTIME_RECEIPT_INVALID', '审批不匹配实际参数。')
  if (outcome.status === 'expired') runtimeError('RUNTIME_APPROVAL_EXPIRED', '审批已超时。')
  if (outcome.status === 'denied') runtimeError('RUNTIME_APPROVAL_DENIED', '用户拒绝本次调用。')
}

/** Caller holds the lease/root lock. A timed-out refusal and its observation can
 * be committed in the same transaction; a concurrently approved decision wins
 * only if it was already committed before the original deadline. */
export async function readToolApprovalOutcome(tx: RuntimeTx, token: RunLeaseToken, sourceHash: string, callId: string, toolName: string, rawArguments: string) {
  const request = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: requestKey(token.taskRootId, sourceHash, callId) } })
  const parsed = requestSchema.safeParse(request?.payload)
  if (!request) return null
  if (!parsed.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '审批请求损坏。')
  if (request.taskRootId !== token.taskRootId || request.type !== 'approval.requested' || parsed.data.sourceHash !== sourceHash
    || parsed.data.callId !== callId || parsed.data.toolName !== toolName || parsed.data.rawArguments !== rawArguments
    || runtimeJson(parsed.data.args).hash !== parsed.data.argsHash) runtimeError('RUNTIME_RECEIPT_INVALID', '审批不匹配原调用或实际参数。')
  let decision = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `approval-decision:${request.id}` } })
  if (!decision && (await databaseNow(tx)).getTime() >= Date.parse(parsed.data.expiresAt)) {
    decision = await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: token.taskRootId, runId: token.runId,
      eventKey: `approval-decision:${request.id}`, type: 'approval.resolved', payload: { version: 1, requestId: request.id,
        requestHash: runtimeJson(request.payload).hash, approved: false, userId: token.userId, timedOut: true } } })
  }
  if (!decision) return { status: 'pending' as const, request, requestData: parsed.data, decision: null }
  const resolved = decisionSchema.safeParse(decision?.payload)
  if (!resolved.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '审批决定损坏。')
  if (decision.taskRootId !== token.taskRootId || decision.type !== 'approval.resolved' || resolved.data.requestId !== request.id
    || resolved.data.userId !== token.userId || resolved.data.requestHash !== runtimeJson(request.payload).hash) runtimeError('RUNTIME_RECEIPT_INVALID', '审批决定身份不一致。')
  if (resolved.data.timedOut && resolved.data.approved) runtimeError('RUNTIME_RECEIPT_INVALID', '超时决定不能批准操作。')
  return { status: resolved.data.approved ? 'approved' as const : resolved.data.timedOut ? 'expired' as const : 'denied' as const,
    request, requestData: parsed.data, decision }
}
