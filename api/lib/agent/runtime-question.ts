import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { databaseNow, lockRunRoot, runtimeError, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { argumentNormalizationSchema, prepareToolCursorOperation, type ToolExecutionCursor } from './runtime-tool-cursor.js'
import { commitOperationEffectInTransaction, recordToolFailure } from './runtime-operations.js'
import { reduceExecutionReceipt } from './runtime-reducer.js'
import { normalizeToolInput } from './tools/input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './tools/types.js'
import { assertGoalRevisionFence, readGoalExecution } from './goal-fence.js'
import { recordWritingClarification } from './writing-clarification.js'
import { DIRECTION_PURPOSE_REQUIRED, QUESTION_TIMEOUT_NOTICE } from './tools/interact-tools.js'
import { readTaskBudgetInTransaction } from './runtime-budget.js'

export const durableQuestionContent = z.object({ question: z.string(), options: z.array(z.object({ label: z.string(), detail: z.string().optional() })),
  purpose: z.literal('novel_direction').optional() })
export const durableQuestionSchema = durableQuestionContent.extend({ version: z.literal(1), operationId: z.string(), callId: z.string(),
  expiresAt: z.string().datetime() }).strict()
const answerSchema = z.object({ requestId: z.string(), requestHash: z.string(), answer: z.string(), userId: z.string() }).strict()

export async function executeDurableQuestion(lease: RunLeaseToken, cursor: ToolExecutionCursor, ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>) {
  const normalize = (raw: unknown) => tool.parameters.parse(normalizeToolInput(tool, raw))
  const effective = durableQuestionContent.parse(normalize(args))
  const source = await withRunLease(lease, tx => readExecutionFrame(tx, lease.taskRootId, cursor.expectedRevision))
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: `exec:${source.state.nextOperationSequence}`,
    action: 'ask_user', callId: ctx.callId, targetId: lease.taskRootId, effectDomain: 'read', normalize, effectiveArgs: effective,
    operationInput: runtimeJson({ callId: ctx.callId, args: effective }).value })
  if (ctx.writingScope?.novelDirectionRequired && effective.purpose !== 'novel_direction') {
    const result = { output: DIRECTION_PURPOSE_REQUIRED, summary: '提问未发送' }
    await recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: 'NOVEL_DIRECTION_PURPOSE_REQUIRED', ...result })
    await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
    return { kind: 'tool' as const, result: { ...result, outcome: 'failed' as const } }
  }
  const waiting = await withRunLease(lease, async tx => {
    // Answer admission and timeout completion serialize on this same root lock.
    // Never carry a timeout decision into a later effect transaction: a valid
    // answer may have committed between those transactions.
    const finish = async (output: string, answer: string | null) => ({ receipt:
      await commitOperationEffectInTransaction(tx, lease, prepared.operation.id, prepared.operation.inputHash, async () => {
        ctx.signal.throwIfAborted()
        const clarification = answer === null ? null : await recordWritingClarification(tx, ctx,
          { callId: ctx.callId, ...effective, answer, source: 'durable_question', requestId: request!.id })
        return runtimeJson({ toolResult: {
        ...(clarification ? { semanticTransition: clarification } : {}),
        output, summary: answer === null ? '提问超时，未获回答' : '作者已回答',
        ...(answer === null ? { questionTimedOut: true } : {}),
        display: { kind: 'question', question: effective.question, options: effective.options, ...(answer === null ? { unanswered: true } : { answer }),
          ...(clarification ? { scopeResolution: 'accepted' } : {}) },
      } }).value
      }) })
    const key = `question:${prepared.operation.id}`
    let request = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: key } })
    if (!request) {
      const now = await databaseNow(tx)
      request = await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId, operationId: prepared.operation.id,
        eventKey: key, type: 'question.requested', payload: { version: 1, operationId: prepared.operation.id, callId: ctx.callId, ...effective,
          expiresAt: new Date(now.getTime() + env.agentApprovalTimeoutMs).toISOString() } } })
    }
    const question = durableQuestionSchema.parse(request.payload)
    if (request.taskRootId !== lease.taskRootId || request.type !== 'question.requested' || request.operationId !== prepared.operation.id || question.operationId !== prepared.operation.id
      || question.callId !== ctx.callId || runtimeJson(durableQuestionContent.parse(question)).hash !== runtimeJson(effective).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问内容已损坏。')
    const response = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question-answer:${request.id}` } })
    if (response) {
      const answer = answerSchema.parse(response.payload)
      if (response.taskRootId !== lease.taskRootId || response.type !== 'question.answered' || response.operationId !== prepared.operation.id || answer.requestId !== request.id
        || answer.requestHash !== runtimeJson(request.payload).hash || answer.userId !== lease.userId) return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问回答回执不匹配。')
      return finish(`作者的回答：${answer.answer}`, answer.answer)
    }
    if ((await databaseNow(tx)).getTime() >= Date.parse(question.expiresAt)) return finish(QUESTION_TIMEOUT_NOTICE, null)
    return { requestId: request.id }
  })
  if ('requestId' in waiting) return { kind: 'waiting_question' as const, requestId: waiting.requestId }
  const { receipt } = waiting
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const result = z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
  return { kind: 'tool' as const, result }
}

/** Validate historical question receipts without treating an old unanswered
 * creative question as a current tool permission or inventing an answer. */
export async function validateHistoricalQuestionReceipt(lease: RunLeaseToken) {
  return withRunLease(lease, async tx => {
    const { frame } = await readExecutionStateInTransaction(tx, lease.taskRootId)
    if (frame.state.phase !== 'idle') return null
    const messages = frame.state.messages
    const last = messages.at(-1)
    if (last?.role === 'assistant' && last.localCompletion) {
      // A timeout is terminal for its run. Only an admitted author Resume can
      // supersede this saved candidate, and never while an effect is unknown.
      if (last.localCompletion.kind === 'question_timeout') {
        const resumed = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: lease.taskRootId, runId: lease.runId, type: 'run.resume.queued' } })
        const source = z.object({ revision: z.number(), snapshotHash: z.string(), runId: z.string(), pauseEventId: z.string() }).safeParse(resumed?.payload)
        if (source.success && resumed?.eventKey === `resume:${source.data.pauseEventId}` && source.data.runId === lease.runId
          && source.data.revision === frame.revision && source.data.snapshotHash === frame.snapshotHash
          && !await tx.agentOperation.count({ where: { taskRootId: lease.taskRootId, status: { in: ['prepared', 'dispatched', 'unknown'] } } })
          && (await readTaskBudgetInTransaction(tx, lease.taskRootId)).unresolvedAttempts === 0n) {
          await saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
            snapshot: { ...frame.state, messages: [...messages, { role: 'system',
              content: '作者已主动继续原任务。原提问已超时且没有回答；请核对已保存的进度，需要作者决定时重新提问。' }] } })
          return null
        }
      }
      return frame
    }
    let at = messages.length - 1
    while (at >= 0 && messages[at].role === 'tool') at--
    const assistant = messages[at]
    if (assistant?.role !== 'assistant') return null
    for (const call of assistant.toolCalls ?? []) {
      if (call.name !== 'ask_user' || !messages.slice(at + 1).some(message => message.role === 'tool' && message.toolCallId === call.id)) continue
      const operations = await tx.agentOperation.findMany({ where: { taskRootId: lease.taskRootId, kind: 'tool', action: 'ask_user', status: 'succeeded',
        inputSnapshot: { path: ['input', 'callId'], equals: call.id },
        effectReceipt: { is: { result: { path: ['toolResult', 'failureCode'], equals: 'AUTHOR_INPUT_REQUIRED' } } } }, include: { effectReceipt: true }, take: 2 })
      if (!operations.length) continue // Imported/failed ordinary questions carry no new boundary.
      if (operations.length !== 1) return runtimeError('RUNTIME_RECEIPT_INVALID', '已消费提问的原操作不唯一。')
      const operation = operations[0], receipt = operation.effectReceipt
      const result = z.object({ toolResult: z.object({ failureCode: z.string().optional() }) }).safeParse(receipt?.result)
      if (!result.success || result.data.toolResult.failureCode !== 'AUTHOR_INPUT_REQUIRED') continue
      if (!receipt || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash || runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '已消费提问的原回执损坏。')
      const input = z.object({ input: z.object({ callId: z.string(), args: z.unknown(), normalization: argumentNormalizationSchema.optional() }) }).parse(operation.inputSnapshot)
      const normalization = input.input.normalization
      if (normalization) {
        const source = await readExecutionFrame(tx, lease.taskRootId, normalization.sourceRevision)
        if (normalization.sourceRevision >= frame.revision || source.snapshotHash !== normalization.sourceSnapshotHash
          || normalization.rawArguments !== call.arguments || normalization.normalizedArgsHash !== runtimeJson(input.input.args).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '已消费提问的参数归一化来源不一致。')
      } else {
        let args: unknown
        try { args = JSON.parse(call.arguments) } catch { return runtimeError('RUNTIME_RECEIPT_INVALID', '已消费提问的原调用参数损坏。') }
        if (runtimeJson(input.input.args).hash !== runtimeJson(args).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '已消费提问与当前调用不一致。')
      }
      if (input.input.callId !== call.id) return runtimeError('RUNTIME_RECEIPT_INVALID', '已消费提问调用身份不一致。')
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${operation.id}` } })
      if (!event || event.taskRootId !== lease.taskRootId || event.operationId !== operation.id || event.type !== 'effect.committed'
        || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问回执与效果事件不一致。')
      return null
    }
    return null
  })
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
      || runtimeJson(original.data.input.args).hash !== runtimeJson(durableQuestionContent.parse(question.data)).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '提问与原工具请求不一致，不能保存回答。')
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
