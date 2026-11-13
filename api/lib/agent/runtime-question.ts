import { randomUUID } from 'node:crypto'
import type { AgentRun } from '@prisma/client'
import { z } from 'zod'
import type { AgentQuestionDecision, PendingAgentQuestion, ResolveAgentQuestionResponse } from '../../../shared/contracts/index.js'
import { agentQuestionDecisionSchema, agentQuestionOptionSchema, agentQuestionPromptsSchema } from '../../../shared/contracts/schemas.js'
import { env } from '../../config/env.js'
import { databaseNow, durablePauseSchema, lockRunRoot, runtimeError, runtimeJson, runtimeTransaction, type RuntimeTx } from './runtime-common.js'
import { parkRunLease, withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { argumentNormalizationSchema, prepareToolCursorOperation, type ToolExecutionCursor } from './runtime-tool-cursor.js'
import { commitOperationEffectInTransaction, recordToolFailure, recordToolFailureInTransaction } from './runtime-operations.js'
import { readFailedToolResult, reduceExecutionReceipt } from './runtime-reducer.js'
import { normalizeToolInput } from './tools/input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './tools/types.js'
import { assertGoalRevisionFence, readGoalExecution } from './goal-fence.js'
import { setGoalRunPhaseInTransaction } from './goal-runtime.js'
import { recordWritingClarification } from './writing-clarification.js'
import { checkQuestionCoverOptions, DIRECTION_PURPOSE_REQUIRED, formatAuthorQuestionAnswer, formatAuthorQuestionAnswers,
  formatUnansweredQuestionWrapUp, QUESTION_TIMEOUT_NOTICE } from './tools/interact-tools.js'
import { readTaskBudgetInTransaction } from './runtime-budget.js'
import { MAIN_RUN_FILTER, pauseChildGrants } from './runtime-child.js'
import { interactiveRunSlots, QUESTION_CLOSING_ROOT_STATUS, QUESTION_WAITING_ROOT_STATUS } from './run-slots.js'
import { assertAgentManuscriptRevisionCurrent } from './manuscript-scope.js'
import { resumeDurableTaskInTransaction } from './runtime-resume.js'
import { stopAgentRun } from './active-runs.js'

export const durableQuestionContent = z.object({ question: z.string(), options: z.array(z.object({ label: z.string(), detail: z.string().optional(),
  coverAssetId: agentQuestionOptionSchema.shape.coverAssetId })),
  purpose: z.literal('novel_direction').optional(), questions: agentQuestionPromptsSchema.optional() })
const questionIdentity = durableQuestionContent.extend({ operationId: z.string(), callId: z.string() })
export const durableQuestionSchema = z.discriminatedUnion('version', [
  questionIdentity.extend({ version: z.literal(1), expiresAt: z.string().datetime() }).strict(),
  questionIdentity.extend({ version: z.literal(2) }).strict(),
])
const decisionIdentity = z.object({ requestId: z.string(), requestHash: z.string(), userId: z.string() })
export const questionCancellationReceiptSchema = decisionIdentity.extend({ cancelled: z.literal(true) }).strict()
const decisionReceipt = z.union([decisionIdentity.extend({ answer: z.string() }).strict(),
  decisionIdentity.extend({ answers: z.array(z.string().min(1).max(500).refine(answer => answer === answer.trim())).min(1).max(3) }).strict(),
  questionCancellationReceiptSchema])

function matchesQuestionDecision(question: z.infer<typeof durableQuestionContent>, decision: AgentQuestionDecision) {
  return 'cancelled' in decision || (question.questions ? 'answers' in decision && decision.answers.length === question.questions.length : 'answer' in decision)
}

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
    const finish = async (decision: AgentQuestionDecision | null) => ({ receipt:
      await commitOperationEffectInTransaction(tx, lease, prepared.operation.id, prepared.operation.inputHash, async () => {
        ctx.signal.throwIfAborted()
        const cancelled = decision !== null && 'cancelled' in decision
        const answers = decision !== null && 'answers' in decision ? decision.answers : undefined
        const answer = decision !== null && 'answer' in decision ? decision.answer : answers?.[0]
        const output = answer === undefined ? cancelled ? formatUnansweredQuestionWrapUp(effective, effective.purpose === 'novel_direction') : QUESTION_TIMEOUT_NOTICE
          : answers && effective.questions ? formatAuthorQuestionAnswers(effective.questions, answers) : formatAuthorQuestionAnswer(effective.options, answer)
        const clarification = answer === undefined ? null : await recordWritingClarification(tx, ctx,
          { callId: ctx.callId, question: effective.question, options: effective.options, answer, source: 'durable_question', requestId: request!.id })
        if (cancelled) {
          const goal = await readGoalExecution(lease.userId, lease.runId, tx)
          if (goal) await setGoalRunPhaseInTransaction(tx, goal, 'awaiting_input', 'GOAL_QUESTION_CANCELLED')
        }
        return runtimeJson({ toolResult: {
          ...(clarification ? { semanticTransition: clarification } : {}),
          output, summary: cancelled ? '作者已取消提问' : decision === null ? '提问超时，未获回答' : '作者已回答',
          ...(decision === null ? { questionTimedOut: true } : {}),
          ...(cancelled ? { questionCancelled: true, questionCancellationVersion: 2 } : {}),
          display: { kind: 'question', question: effective.question, options: effective.options,
            ...(effective.questions ? { questions: effective.questions } : {}), ...(answers ? { answers } : {}),
            ...(answer === undefined ? { unanswered: true } : { answer }), ...(cancelled ? { cancelled: true } : {}),
            ...(clarification ? { scopeResolution: 'accepted' } : {}) },
        } }).value
      }) })
    const key = `question:${prepared.operation.id}`
    let request = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: key } })
    if (!request) {
      if (effective.questions && !ctx.writingScope?.agentQuestionProtocol) return { failure: await recordToolFailureInTransaction(tx, lease,
        { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: 'TOOL_SCHEMA_INVALID',
          output: '当前作者端只支持单题，请使用 question 和 options 发一道题。', summary: '提问未发送' }) }
      const coverFailure = await checkQuestionCoverOptions(tx, ctx, effective)
      if (coverFailure) return { failure: await recordToolFailureInTransaction(tx, lease,
        { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, ...coverFailure, summary: '提问未发送' }) }
      const longWait = ctx.writingScope?.agentQuestionProtocol === 2 && !lease.parent && !await readGoalExecution(lease.userId, lease.runId, tx)
      const lifetime = longWait ? { version: 2 as const }
        : { version: 1 as const, expiresAt: new Date((await databaseNow(tx)).getTime() + env.agentApprovalTimeoutMs).toISOString() }
      request = await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId, operationId: prepared.operation.id,
        eventKey: key, type: 'question.requested', payload: { ...lifetime, operationId: prepared.operation.id, callId: ctx.callId, ...effective } } })
    }
    const question = durableQuestionSchema.parse(request.payload)
    if (request.taskRootId !== lease.taskRootId || request.type !== 'question.requested' || request.operationId !== prepared.operation.id || question.operationId !== prepared.operation.id
      || question.callId !== ctx.callId || runtimeJson(durableQuestionContent.parse(question)).hash !== runtimeJson(effective).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问内容已损坏。')
    const response = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question-answer:${request.id}` } })
    if (response) {
      const saved = decisionReceipt.safeParse(response.payload)
      if (!saved.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问回答回执不匹配。')
      const { requestId, requestHash, userId, ...decision } = saved.data
      if (response.taskRootId !== lease.taskRootId || response.type !== ('cancelled' in decision ? 'question.cancelled' : 'question.answered')
        || response.operationId !== prepared.operation.id || requestId !== request.id || requestHash !== runtimeJson(request.payload).hash
        || userId !== lease.userId || !matchesQuestionDecision(question, decision)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问回答回执不匹配。')
      return finish(decision)
    }
    if (question.version === 1 && (await databaseNow(tx)).getTime() >= Date.parse(question.expiresAt)) return finish(null)
    return { requestId: request.id, longWait: question.version === 2 }
  })
  if ('requestId' in waiting) return { kind: 'waiting_question' as const, requestId: waiting.requestId, longWait: waiting.longWait }
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const result = 'failure' in waiting ? readFailedToolResult(waiting.failure.result)
    : z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(waiting.receipt.result).toolResult as ToolResult
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
      // A closed question is terminal for its run. Only an admitted author Resume can
      // supersede this saved candidate, and never while an effect is unknown.
      if (last.localCompletion.kind === 'question_timeout' || last.localCompletion.kind === 'question_cancelled' || last.localCompletion.kind === 'question_unanswered') {
        const resumed = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: lease.taskRootId, runId: lease.runId, type: 'run.resume.queued' } })
        const source = z.object({ revision: z.number(), snapshotHash: z.string(), runId: z.string(), pauseEventId: z.string() }).safeParse(resumed?.payload)
        if (source.success && resumed?.eventKey === `resume:${source.data.pauseEventId}` && source.data.runId === lease.runId
          && source.data.revision === frame.revision && source.data.snapshotHash === frame.snapshotHash
          && !await tx.agentOperation.count({ where: { taskRootId: lease.taskRootId, status: { in: ['prepared', 'dispatched', 'unknown'] } } })
          && (await readTaskBudgetInTransaction(tx, lease.taskRootId)).unresolvedAttempts === 0n) {
          await saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
            snapshot: { ...frame.state, messages: [...messages, { role: 'system',
              content: `作者已主动继续原任务。原提问已${last.localCompletion.kind === 'question_timeout' ? '超时' : '取消'}且没有回答；请核对已保存的进度，需要作者决定时重新提问。` }] } })
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

type OriginalQuestion = {
  id: string; taskRootId: string; eventKey: string; operationId: string | null; runId: string; payload: unknown
}

/** The heartbeat has unwound. Park only if an answer did not win the root lock. */
export async function parkDurableQuestion(lease: RunLeaseToken, requestId: string) {
  const childRunIds = await parkRunLease(lease, async tx => {
    const { frame } = await readExecutionStateInTransaction(tx, lease.taskRootId)
    if (!frame.state.pendingOperationId) return runtimeError('RUNTIME_STATE_CONFLICT', '等待位置已变化，原提问不能挂起新的执行。')
    const request = await tx.agentExecutionOutbox.findFirst({ where: { id: requestId, taskRootId: lease.taskRootId,
      operationId: frame.state.pendingOperationId, type: 'question.requested', payload: { path: ['version'], equals: 2 } } })
    if (!request) return runtimeError('RUNTIME_STATE_CONFLICT', '等待位置已变化，原提问不能挂起新的执行。')
    if (await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question-answer:${request.id}` }, select: { id: true } })) return null
    const { operation } = await readOriginalQuestion(tx, request)
    if (operation.status !== 'prepared') return runtimeError('RUNTIME_STATE_CONFLICT', '等待的原提问已结束。')
    const children = await pauseChildGrants(tx, lease.taskRootId)
    await tx.agentTaskRoot.update({ where: { id: lease.taskRootId }, data: { status: QUESTION_WAITING_ROOT_STATUS } })
    await tx.agentRun.update({ where: { id: lease.runId }, data: { status: 'awaiting_approval' } })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId, operationId: operation.id,
      eventKey: `question-park:${request.id}`, type: 'question.parked', payload: { requestId: request.id }, createdAt: await databaseNow(tx) } })
    return children
  })
  for (const id of childRunIds ?? []) stopAgentRun(id)
  return childRunIds !== null
}
async function readOriginalQuestion(tx: RuntimeTx, request: OriginalQuestion) {
  const question = durableQuestionSchema.safeParse(request.payload)
  if (!question.success || request.operationId !== question.data.operationId || request.eventKey !== `question:${question.data.operationId}`) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '原提问身份不一致。')
  }
  const operation = await tx.agentOperation.findFirst({ where: { id: question.data.operationId, taskRootId: request.taskRootId, kind: 'tool', action: 'ask_user' } })
  const original = z.object({ input: z.object({ callId: z.string(), args: z.unknown() }) }).safeParse(operation?.inputSnapshot)
  if (!operation || !original.success || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
    || original.data.input.callId !== question.data.callId
    || runtimeJson(original.data.input.args).hash !== runtimeJson(durableQuestionContent.parse(question.data)).hash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '提问与原工具请求不一致。')
  }
  return { question: question.data, operation }
}

async function readQuestionPause(tx: RuntimeTx, rootId: string, runId: string) {
  const pause = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
  const proof = durablePauseSchema.safeParse(pause?.payload)
  return pause && pause.eventKey === `pause:${pause.id}` && proof.success
    && proof.data.runIds.includes(runId) ? pause : null
}

export async function recordQuestionWake(tx: RuntimeTx, lease: RunLeaseToken, operationId: string) {
  const request = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question:${operationId}` } })
  if (!request || request.runId !== lease.runId || request.taskRootId !== lease.taskRootId) return
  const parked = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question-park:${request.id}` } })
  if (!parked || parked.runId !== lease.runId || parked.operationId !== operationId) return
  await tx.agentExecutionOutbox.upsert({ where: { eventKey: `question-wake:${request.id}` }, update: {}, create: {
    id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId, operationId, eventKey: `question-wake:${request.id}`,
    type: 'question.woken', payload: { requestId: request.id }, createdAt: await databaseNow(tx),
  } })
}

export async function hasCancelledDurableQuestion(tx: RuntimeTx, taskRootId: string, runId: string) {
  const latest = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId, runId, type: 'question.cancelled' },
    orderBy: { sequence: 'desc' }, select: { operationId: true, payload: true } })
  if (!latest?.operationId) return false
  const state = await tx.agentExecutionState.findUnique({ where: { taskRootId }, select: { revision: true } })
  if (!state) return false
  const frame = await readExecutionFrame(tx, taskRootId, state.revision)
  const last = frame.state.messages.at(-1)
  const closed = last?.role === 'assistant' && last.localCompletion?.kind === 'question_unanswered' ? last.localCompletion.operationId : null
  const operationId = frame.state.pendingOperationId ?? closed
  if (operationId !== latest.operationId) return false
  const request = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question:${operationId}` } })
  const question = durableQuestionSchema.safeParse(request?.payload)
  if (!request || request.taskRootId !== taskRootId || request.runId !== runId || request.type !== 'question.requested'
    || !question.success || question.data.version !== 2) return false
  const receipt = questionCancellationReceiptSchema.safeParse(latest.payload)
  return receipt.success && receipt.data.requestId === request.id && receipt.data.requestHash === runtimeJson(request.payload).hash
}

export async function readPendingDurableQuestion(tx: RuntimeTx, userId: string, runId: string): Promise<PendingAgentQuestion | null> {
  const { run, root } = await lockRunRoot(tx, userId, runId)
  const waiting = root.status === QUESTION_WAITING_ROOT_STATUS && run.status === 'awaiting_approval'
    || root.status === 'active' && ['queued', 'running'].includes(run.status)
  const state = waiting ? 'waiting'
    : root.status === 'paused' && run.status === 'paused' ? 'stopped' : null
  if (!state) return null
  const request = await tx.agentExecutionOutbox.findFirst({ where: { runId, taskRootId: root.id, type: 'question.requested',
    payload: { path: ['version'], equals: 2 } }, orderBy: { sequence: 'desc' } })
  if (!request || await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question-answer:${request.id}` }, select: { id: true } })) return null
  if (state === 'stopped' && !await readQuestionPause(tx, root.id, run.id)) return null
  if (!await tx.novel.findFirst({ where: { id: run.novelId, authorId: userId, manuscriptRevision: run.manuscriptRevision }, select: { id: true } })) return null
  const { frame } = await readExecutionStateInTransaction(tx, root.id)
  if (frame.state.pendingOperationId !== request.operationId) return null
  const { question, operation } = await readOriginalQuestion(tx, request)
  if (operation.status !== 'prepared') return null
  return { ...durableQuestionContent.parse(question), requestId: request.id, runId: run.id, callId: question.callId, state }
}

export async function resolveDurableQuestion(input: { userId: string; runId: string; callId: string; requestId: string } & AgentQuestionDecision,
  assertResumeResources?: (tx: RuntimeTx, run: AgentRun) => Promise<void>): Promise<ResolveAgentQuestionResponse> {
  const { userId, runId, callId, requestId, ...decisionInput } = input
  const decision = agentQuestionDecisionSchema.safeParse(decisionInput)
  if (!decision.success) return runtimeError('RUNTIME_INPUT_INVALID', '回答内容无效。')
  const captured: AgentQuestionDecision = 'answer' in decision.data ? { answer: decision.data.answer.trim() }
    : 'answers' in decision.data ? { answers: decision.data.answers.map(answer => answer.trim()) } : decision.data
  if ('answer' in captured && captured.answer.length > 4000) return runtimeError('RUNTIME_INPUT_INVALID', '回答内容无效。')
  const type = 'cancelled' in captured ? 'question.cancelled' : 'question.answered'
  return runtimeTransaction(async tx => {
    const identity = await tx.agentRun.findFirst({ where: { id: runId, userId }, select: { novelId: true } })
    if (!identity) return runtimeError('RUNTIME_SCOPE_MISMATCH', '任务不存在或不属于当前用户。')
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-admission:${userId}`}, 0))::text`
    // Manuscript/goal locks precede the run/root, including the stopped resume.
    await (await import('../data/novel-write-lock.js')).lockNovelActiveScope(tx, identity.novelId)
    const goal = await readGoalExecution(userId, runId, tx)
    if (goal) await assertGoalRevisionFence(tx, goal)
    const { run, root } = await lockRunRoot(tx, userId, runId)
    const request = await tx.agentExecutionOutbox.findFirst({ where: { id: requestId, taskRootId: root.id, type: 'question.requested' } })
    if (!request) return runtimeError('QUESTION_NOT_PENDING', '回答不属于原提问。')
    const { question, operation } = await readOriginalQuestion(tx, request)
    if (question.callId !== callId) return runtimeError('QUESTION_NOT_PENDING', '回答不属于原提问。')
    if (!matchesQuestionDecision(question, captured)) return runtimeError('RUNTIME_INPUT_INVALID', '回答数量必须与原提问一致。')
    const payload = { requestId: request.id, requestHash: runtimeJson(request.payload).hash, ...captured, userId }
    const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `question-answer:${request.id}` } })
    if (existing) {
      if (existing.taskRootId !== root.id || existing.type !== type || existing.operationId !== operation.id
        || runtimeJson(existing.payload).hash !== runtimeJson(payload).hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原提问已有不同回答或回执损坏。')
      if (question.version === 2 && !('cancelled' in captured)) {
        const target = await tx.agentRun.findFirst({ where: { id: existing.runId, taskRootId: root.id, userId, sessionId: root.sessionId }, select: { id: true } })
        if (!target) return runtimeError('RUNTIME_RECEIPT_INVALID', '原回答的执行轮次缺失。')
        return { resolved: true, runId: target.id }
      }
      return { resolved: true }
    }
    const { frame } = await readExecutionStateInTransaction(tx, root.id)
    if (operation.status !== 'prepared' || frame.state.pendingOperationId !== operation.id) return runtimeError('QUESTION_NOT_PENDING', '原提问已结束。')
    let targetRunId = run.id
    if (question.version === 1) {
      if (root.status !== 'active' || !['queued', 'running'].includes(run.status)
        || (await databaseNow(tx)).getTime() >= Date.parse(question.expiresAt)) return runtimeError('QUESTION_NOT_PENDING', '提问已结束或任务已暂停，不能向旧问题提交新回答。')
    } else {
      const latest = await tx.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, sessionId: root.sessionId, userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })
      if (latest?.id !== run.id || request.runId !== run.id) return runtimeError('QUESTION_NOT_PENDING', '会话已有后续任务，不能回答旧提问。')
      const parked = root.status === QUESTION_WAITING_ROOT_STATUS && run.status === 'awaiting_approval'
      const stopped = root.status === 'paused' && run.status === 'paused'
      const parking = root.status === 'active' && ['queued', 'running'].includes(run.status)
      if (!parked && !stopped && !parking) return runtimeError('QUESTION_NOT_PENDING', '原提问已结束。')
      const pause = stopped ? await readQuestionPause(tx, root.id, run.id) : null
      if (stopped && !pause) return runtimeError('QUESTION_NOT_PENDING', '缺少原提问的暂停记录。')
      if (!('cancelled' in captured)) await assertResumeResources?.(tx, run)
      if (!(stopped && 'cancelled' in captured)) {
        await assertAgentManuscriptRevisionCurrent(tx, { userId, novelId: run.novelId, runId })
        if (parked) {
          if (!('cancelled' in captured) && await tx.agentRun.count({ where: { ...MAIN_RUN_FILTER, ...interactiveRunSlots, userId } }) >= env.agentUserMaxConcurrent) {
            return runtimeError('RUN_LIMIT', '同时进行的任务数已达上限，请稍后提交。')
          }
          await tx.agentTaskRoot.update({ where: { id: root.id }, data: { status: 'cancelled' in captured ? QUESTION_CLOSING_ROOT_STATUS : 'active' } })
          await tx.agentRun.update({ where: { id: run.id }, data: { status: 'queued' } })
        } else if (pause) {
          const resumed = await resumeDurableTaskInTransaction(tx, { userId, runId, pauseEventId: pause.id }, request.id)
          targetRunId = resumed.run.id
        }
      }
    }
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: targetRunId, operationId: operation.id,
      eventKey: `question-answer:${request.id}`, type, payload } })
    return { resolved: true, ...(question.version === 2 && !('cancelled' in captured) ? { runId: targetRunId } : {}) }
  })
}
