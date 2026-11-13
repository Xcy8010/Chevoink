import { randomUUID } from 'node:crypto'
import type { AgentExecutionOutbox } from '@prisma/client'
import { z } from 'zod'
import type { AgentQuestionDecision, AgentQuestionPrompt, PendingAgentQuestion, ResolveAgentQuestionResponse } from '../../../shared/contracts/index.js'
import { agentQuestionPromptSchema } from '../../../shared/contracts/schemas.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'
import { runtimeError, runtimeJsonHash, type RuntimeTx } from './runtime-common.js'
import { readExecutionFrame } from './runtime-state.js'
import { readHumanAdmission } from './goal-activation-authority.js'

const offerType = 'question.followup.offered'
const offerSchema = z.object({
  version: z.literal(1), completionId: z.string(), completionHash: z.string(), question: agentQuestionPromptSchema,
}).strict()
const completionSchema = z.object({
  version: z.literal(1), kind: z.literal('completed'), reviewOperationId: z.string(), resultHash: z.string(),
  sourceRevision: z.number().int().nonnegative(), sourceHash: z.string(),
  revision: z.number().int().positive(), snapshotHash: z.string(),
})
const proofSchema = z.object({
  sourceRevision: z.number(), sourceHash: z.string(), candidateHash: z.string(), evidenceHash: z.string(),
  evidence: z.object({ blockers: z.array(z.never()) }).passthrough(),
  questionFollowup: agentQuestionPromptSchema,
})
const decisionSchema = z.union([z.object({ answer: z.string() }).strict(), z.object({ cancelled: z.literal(true) }).strict()])
const decisionReceiptSchema = z.object({
  userId: z.string(), requestId: z.string(), requestHash: z.string(), decision: decisionSchema,
  continuation: z.object({ runId: z.string(), admissionHash: z.string() }).strict().optional(),
}).strict()

function offerKey(runId: string) { return `question-followup:${runId}` }
function decisionKey(requestId: string) { return `question-followup-decision:${requestId}` }

/** The terminal receipt and its offer are committed together by finalization. */
export async function recordCompletedQuestionOffer(tx: RuntimeTx, completion: AgentExecutionOutbox, question: AgentQuestionPrompt) {
  await tx.agentExecutionOutbox.create({ data: {
    id: randomUUID(), taskRootId: completion.taskRootId, runId: completion.runId, operationId: completion.operationId,
    eventKey: offerKey(completion.runId), type: offerType,
    payload: { version: 1, completionId: completion.id, completionHash: runtimeJsonHash(completion.payload), question },
  } })
}

async function readOffer(tx: RuntimeTx, source: AgentExecutionOutbox, userId: string) {
  const run = await tx.agentRun.findFirst({ where: { id: source.runId, userId, status: 'completed', engine: 'loop', runtimeProtocolVersion: 1,
    taskRootId: source.taskRootId, incomingChildGrant: null, goalExecution: null },
  include: { session: { select: { userId: true, novelId: true, spawnedFromRunId: true } },
    novel: { select: { authorId: true, manuscriptRevision: true } },
    taskRoot: { select: { status: true, userId: true, novelId: true, sessionId: true } } } })
  if (!run || run.session.userId !== userId || run.session.novelId !== run.novelId || run.session.spawnedFromRunId
    || run.novel.authorId !== userId || run.taskRoot?.status !== 'completed' || run.taskRoot.userId !== userId
    || run.taskRoot.novelId !== run.novelId || run.taskRoot.sessionId !== run.sessionId) return null

  const offer = offerSchema.safeParse(source.payload)
  if (!offer.success || source.type !== offerType || source.eventKey !== offerKey(run.id) || !source.operationId) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '后续提问缺少原完成回执。')
  }
  const completion = await tx.agentExecutionOutbox.findUnique({ where: { id: offer.data.completionId } })
  const decision = completionSchema.safeParse(completion?.payload)
  if (!completion || !decision.success || completion.type !== 'execution.completion.decided' || completion.runId !== run.id
    || completion.taskRootId !== source.taskRootId || completion.operationId !== source.operationId
    || completion.eventKey !== `decision:${source.operationId}` || decision.data.reviewOperationId !== source.operationId
    || completion.sequence >= source.sequence || runtimeJsonHash(completion.payload) !== offer.data.completionHash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '后续提问与原完成回执不一致。')
  }
  const receipt = await tx.agentEffectReceipt.findUnique({ where: { operationId: source.operationId }, include: { operation: true } })
  const proof = proofSchema.safeParse(receipt?.result)
  const { revision, snapshotHash, sourceRevision, sourceHash, resultHash } = decision.data
  const frame = await readExecutionFrame(tx, source.taskRootId, revision)
  const candidate = frame.state.messages.at(-1)
  if (!receipt || !proof.success || receipt.runId !== run.id || receipt.operation.taskRootId !== source.taskRootId
    || receipt.operation.action !== 'completion_finalize' || receipt.operation.status !== 'succeeded'
    || receipt.resultHash !== resultHash || runtimeJsonHash(receipt.result) !== resultHash
    || proof.data.sourceRevision !== sourceRevision || proof.data.sourceHash !== sourceHash
    || runtimeJsonHash(proof.data.evidence) !== proof.data.evidenceHash
    || revision !== sourceRevision + 1 || frame.snapshotHash !== snapshotHash || frame.previousHash !== sourceHash
    || frame.state.phase !== 'completed' || candidate?.role !== 'assistant' || candidate.localCompletion?.kind !== 'novel_setup'
    || runtimeJsonHash({ content: candidate.content, reasoning: candidate.reasoning ?? null }) !== proof.data.candidateHash
    || runtimeJsonHash(proof.data.questionFollowup) !== runtimeJsonHash(offer.data.question)) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '后续提问与原交付内容不一致。')
  }
  const question: PendingAgentQuestion = { ...offer.data.question, runId: run.id, requestId: source.id, callId: source.id, state: 'completed' }
  return { run, question, requestHash: runtimeJsonHash(source.payload) }
}

async function isLatestSource(tx: RuntimeTx, run: NonNullable<Awaited<ReturnType<typeof readOffer>>>['run']) {
  if (run.manuscriptRevision !== run.novel.manuscriptRevision) return false
  const latest = await tx.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, sessionId: run.sessionId, userId: run.userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })
  return latest?.id === run.id
}

export async function readPendingCompletedQuestion(tx: RuntimeTx, input: { userId: string; sessionId: string; runId: string }): Promise<PendingAgentQuestion | null> {
  const source = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: offerKey(input.runId) } })
  if (!source || source.runId !== input.runId || await tx.agentExecutionOutbox.findUnique({ where: { eventKey: decisionKey(source.id) }, select: { id: true } })) return null
  const offer = await readOffer(tx, source, input.userId)
  if (!offer || offer.run.sessionId !== input.sessionId || !await isLatestSource(tx, offer.run)) return null
  return offer.question
}

type PendingCompletedDecision = {
  kind: 'pending'
  question: PendingAgentQuestion
  requestHash: string
  taskRootId: string
  operationId: string
  userId: string
  sessionId: string
  novelId: string
  decision: z.infer<typeof decisionSchema>
  prompt?: string
}

/** Mutating callers read under the existing account admission lock. Replays
 * return the recorded target even when it has already reached a terminal state. */
export async function readCompletedQuestionDecision(tx: RuntimeTx, input: {
  userId: string; runId: string; requestId: string; callId: string; decision: AgentQuestionDecision
}): Promise<PendingCompletedDecision | { kind: 'replay'; result: ResolveAgentQuestionResponse } | null> {
  const source = await tx.agentExecutionOutbox.findFirst({ where: { id: input.requestId, type: offerType } })
  if (!source) return null
  if (source.runId !== input.runId || source.id !== input.callId || !source.operationId) {
    return runtimeError('QUESTION_NOT_PENDING', '回答不属于原提问。')
  }
  const offer = await readOffer(tx, source, input.userId)
  if (!offer) return runtimeError('QUESTION_NOT_PENDING', '原提问已结束或不属于当前作者。')
  const submitted = decisionSchema.safeParse(input.decision)
  if (!submitted.success) return runtimeError('RUNTIME_INPUT_INVALID', '此提问需要一个回答。')
  const decision = 'answer' in submitted.data ? { answer: submitted.data.answer.trim() } : submitted.data
  if ('answer' in decision && (!decision.answer || decision.answer.length > 4000)) return runtimeError('RUNTIME_INPUT_INVALID', '回答内容无效。')
  const original = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: decisionKey(source.id) } })
  if (original) {
    const payload = decisionReceiptSchema.safeParse(original.payload)
    const type = 'cancelled' in decision ? 'question.followup.cancelled' : 'question.followup.answered'
    if (!payload.success || original.taskRootId !== source.taskRootId || original.operationId !== source.operationId
      || original.runId !== source.runId || original.sequence <= source.sequence || original.type !== type || payload.data.userId !== input.userId
      || payload.data.requestId !== source.id || payload.data.requestHash !== offer.requestHash
      || runtimeJsonHash(payload.data.decision) !== runtimeJsonHash(decision)) {
      return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原提问已有不同回答或回执损坏。')
    }
    const continuation = payload.data.continuation
    if ('answer' in decision) {
      const target = continuation && await readContinuationTarget(tx, offer.run, source.taskRootId, continuation.runId, decision.answer)
      if (!target || target.admissionHash !== continuation?.admissionHash) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '已准入的后续轮次缺失，不能重复创建。')
      }
      return { kind: 'replay', result: { resolved: true, runId: target.runId, messageId: target.messageId } }
    }
    if (continuation) return runtimeError('RUNTIME_RECEIPT_INVALID', '取消后的提问不能关联新轮次。')
    return { kind: 'replay', result: { resolved: true } }
  }
  if (!await isLatestSource(tx, offer.run)) return runtimeError('QUESTION_NOT_PENDING', '会话或作品已有后续变更，不能回答旧提问。')
  return { kind: 'pending', question: offer.question, requestHash: offer.requestHash, taskRootId: source.taskRootId, operationId: source.operationId,
    userId: input.userId, sessionId: offer.run.sessionId, novelId: offer.run.novelId, decision,
    ...('answer' in decision ? { prompt: decision.answer } : {}) }
}

async function readContinuationTarget(tx: RuntimeTx, scope: { userId: string; sessionId: string; novelId: string }, rootId: string, runId: string, prompt: string) {
  const target = await tx.agentRun.findFirst({ where: { id: runId, userId: scope.userId, sessionId: scope.sessionId,
    novelId: scope.novelId, engine: 'loop', incomingChildGrant: null, goalExecution: null },
  select: { id: true, taskRootId: true, startRequest: true } })
  if (!target || target.taskRootId === rootId) return null
  const admission = readHumanAdmission(target.startRequest)
  if (!admission || admission.request.sessionId !== scope.sessionId || admission.request.novelId !== scope.novelId
    || admission.request.prompt !== prompt) return null
  const message = await tx.agentMessage.findFirst({ where: { runId: target.id, sessionId: scope.sessionId, role: 'user' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, parts: true } })
  if (!message || runtimeJsonHash(message.parts) !== runtimeJsonHash([{ type: 'text', text: prompt }])) return null
  return { runId: target.id, admissionHash: admission.grant.requestHash, messageId: message.id }
}

export async function recordCompletedQuestionDecision(tx: RuntimeTx, pending: PendingCompletedDecision, continuationRunId?: string): Promise<ResolveAgentQuestionResponse> {
  const { decision } = pending
  const cancelled = 'cancelled' in decision
  const continuation = !cancelled && continuationRunId && continuationRunId !== pending.question.runId
    ? await readContinuationTarget(tx, pending, pending.taskRootId, continuationRunId, decision.answer) : null
  if (cancelled ? continuationRunId !== undefined : !continuation) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '后续回答与本次新轮次不一致。')
  }
  await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: pending.taskRootId, runId: pending.question.runId,
    operationId: pending.operationId, eventKey: decisionKey(pending.question.requestId),
    type: cancelled ? 'question.followup.cancelled' : 'question.followup.answered',
    payload: { userId: pending.userId, requestId: pending.question.requestId, requestHash: pending.requestHash,
      decision, ...(continuation ? { continuation: { runId: continuation.runId, admissionHash: continuation.admissionHash } } : {}) } } })
  return { resolved: true, ...(continuation ? { runId: continuation.runId, messageId: continuation.messageId } : {}) }
}
