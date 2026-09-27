import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { databaseNow, lockRunRoot, runtimeError, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'
import { prepareToolCursorOperation, type ToolExecutionCursor } from './runtime-tool-cursor.js'
import { commitOperationEffectInTransaction } from './runtime-operations.js'
import { reduceExecutionReceipt } from './runtime-reducer.js'
import { normalizeToolInput } from './tools/input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './tools/types.js'
import { assertGoalRevisionFence, readGoalExecution } from './goal-fence.js'

export const durableQuestionSchema = z.object({ version: z.literal(1), operationId: z.string(), callId: z.string(),
  question: z.string(), options: z.array(z.object({ label: z.string(), detail: z.string().optional() })), expiresAt: z.string().datetime() }).strict()
const answerSchema = z.object({ requestId: z.string(), requestHash: z.string(), answer: z.string(), userId: z.string() }).strict()

export async function executeDurableQuestion(lease: RunLeaseToken, cursor: ToolExecutionCursor, ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>) {
  const normalize = (raw: unknown) => tool.parameters.parse(normalizeToolInput(tool, raw))
  const effective = z.object({ question: z.string(), options: z.array(z.object({ label: z.string(), detail: z.string().optional() })) }).parse(normalize(args))
  const source = await withRunLease(lease, tx => readExecutionFrame(tx, lease.taskRootId, cursor.expectedRevision))
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: `exec:${source.state.nextOperationSequence}`,
    action: 'ask_user', callId: ctx.callId, targetId: lease.taskRootId, effectDomain: 'read', normalize, effectiveArgs: effective,
    operationInput: runtimeJson({ callId: ctx.callId, args: effective }).value })
  const waiting = await withRunLease(lease, async tx => {
    // Answer admission and timeout completion serialize on this same root lock.
    // Never carry a timeout decision into a later effect transaction: a valid
    // answer may have committed between those transactions.
    const finish = async (output: string, answer: string | null) => ({ receipt:
      await commitOperationEffectInTransaction(tx, lease, prepared.operation.id, prepared.operation.inputHash, async () => runtimeJson({ toolResult: {
        output, summary: answer === null ? '提问未获回答' : '作者已回答',
        display: { kind: 'question', ...effective, ...(answer === null ? { unanswered: true } : { answer }) },
      } }).value) })
    const key = `question:${prepared.operation.id}`
    let request = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: key } })
    if (!request && await tx.agentExecutionOutbox.count({ where: { taskRootId: lease.taskRootId, type: 'question.requested' } }) >= 3) return finish('本任务已使用三次提问。请基于已确认信息继续原授权内的工作；缺少关键决定的部分保持未完成，不猜测授权。', null)
    if (!request) {
      const now = await databaseNow(tx)
      request = await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId, operationId: prepared.operation.id,
        eventKey: key, type: 'question.requested', payload: { version: 1, operationId: prepared.operation.id, callId: ctx.callId, ...effective,
          expiresAt: new Date(now.getTime() + env.agentApprovalTimeoutMs).toISOString() } } })
    }
    const question = durableQuestionSchema.parse(request.payload)
    if (request.taskRootId !== lease.taskRootId || request.type !== 'question.requested' || request.operationId !== prepared.operation.id || question.operationId !== prepared.operation.id
      || question.callId !== ctx.callId || runtimeJson({ question: question.question, options: question.options }).hash !== runtimeJson(effective).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问内容已损坏。')
    const response = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question-answer:${request.id}` } })
    if (response) {
      const answer = answerSchema.parse(response.payload)
      if (response.taskRootId !== lease.taskRootId || response.type !== 'question.answered' || response.operationId !== prepared.operation.id || answer.requestId !== request.id
        || answer.requestHash !== runtimeJson(request.payload).hash || answer.userId !== lease.userId) return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问回答回执不匹配。')
      return finish(`作者的回答：${answer.answer}`, answer.answer)
    }
    if ((await databaseNow(tx)).getTime() >= Date.parse(question.expiresAt)) return finish('提问已超时。仅继续不依赖该决定且已获授权的工作；不能把未回答当作批准。', null)
    return { requestId: request.id }
  })
  if ('requestId' in waiting) return { kind: 'waiting_question' as const, requestId: waiting.requestId }
  const { receipt } = waiting
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return { kind: 'tool' as const, result: z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult }
}

export async function resolveDurableQuestion(input: { userId: string; runId: string; callId: string; requestId: string; answer: string }) {
  const captured = { ...input, answer: input.answer.trim() }
  if (!captured.answer || captured.answer.length > 4000) return runtimeError('RUNTIME_INPUT_INVALID', '回答内容无效。')
  return runtimeTransaction(async tx => {
    const goal = await readGoalExecution(captured.userId, captured.runId, tx)
    if (goal) await assertGoalRevisionFence(tx, goal)
    const { run, root } = await lockRunRoot(tx, captured.userId, captured.runId)
    const request = await tx.agentExecutionOutbox.findFirst({ where: { id: captured.requestId, taskRootId: root.id, type: 'question.requested' } })
    const question = durableQuestionSchema.safeParse(request?.payload)
    if (!request || !question.success || question.data.callId !== captured.callId || request.operationId !== question.data.operationId
      || request.eventKey !== `question:${question.data.operationId}`) return runtimeError('QUESTION_NOT_PENDING', '回答不属于原提问。')
    const operation = await tx.agentOperation.findFirst({ where: { id: question.data.operationId, taskRootId: root.id, kind: 'tool', action: 'ask_user' } })
    const original = z.object({ input: z.object({ callId: z.string(), args: z.unknown() }) }).safeParse(operation?.inputSnapshot)
    if (!operation || !original.success || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
      || original.data.input.callId !== captured.callId
      || runtimeJson(original.data.input.args).hash !== runtimeJson({ question: question.data.question, options: question.data.options }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '提问与原工具请求不一致，不能保存回答。')
    const payload = { requestId: request.id, requestHash: runtimeJson(request.payload).hash, answer: captured.answer, userId: captured.userId }
    const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question-answer:${request.id}` } })
    if (existing) {
      if (existing.taskRootId !== root.id || existing.type !== 'question.answered' || existing.operationId !== operation.id
        || runtimeJson(existing.payload).hash !== runtimeJson(payload).hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原提问已有不同回答或回执损坏。')
      return { resolved: true }
    }
    const { frame } = await readExecutionStateInTransaction(tx, root.id)
    if (root.status !== 'active' || operation.status !== 'prepared' || !['queued', 'running'].includes(run.status) || frame.state.pendingOperationId !== question.data.operationId
      || (await databaseNow(tx)).getTime() >= Date.parse(question.data.expiresAt)) return runtimeError('QUESTION_NOT_PENDING', '提问已结束或任务已暂停，不能向旧问题提交新回答。')
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: run.id, operationId: question.data.operationId,
      eventKey: `question-answer:${request.id}`, type: 'question.answered', payload } })
    return { resolved: true }
  })
}
