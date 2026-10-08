import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { readOriginalTaskRequest } from './original-request.js'
import { allowsChapterOnlyCompletion } from './writing-scope.js'
import { MAX_CONTINUITY_CHECKS } from './story-compiler.js'
import { runtimeJson } from './runtime-common.js'
import { qualityUnavailableProofSchema } from './quality-unavailable-proof.js'

type Subject = { userId: string; novelId: string; runId: string }
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const limitedWritingOutcomeSchema = z.object({ kind: z.literal('delivered_with_limitations'), summary: z.string().min(1) }).strict()
const limitedWritingDeliveryV1Schema = z.object({
  version: z.literal(1), taskId: z.string().min(1), targetRunId: z.string().min(1), sourceRunId: z.string().min(1),
  chapters: z.array(z.object({ id: z.string().min(1), title: z.string(), revision: z.number().int().positive(), contentHash: hash,
    compilationId: z.string().min(1), compilerStateHash: hash, sourceChapterId: z.string().nullable(), sourceRevision: z.number().int().positive().nullable(),
    sourceContentHash: hash.nullable(), continuityCheckRounds: z.number().int().min(MAX_CONTINUITY_CHECKS),
    continuityStatus: z.enum(['missing', 'stale', 'incomplete']), qualityReportId: z.string().min(1), qualityReportHash: hash,
    retainedQualityIssueCount: z.number().int().nonnegative(),
  }).strict()).length(1),
  text: z.string().min(1), outcome: limitedWritingOutcomeSchema,
}).strict()
const limitedWritingDeliveryV2Schema = limitedWritingDeliveryV1Schema.extend({
  version: z.literal(2),
  chapters: z.array(limitedWritingDeliveryV1Schema.shape.chapters.element.extend({
    continuityCheckRounds: z.number().int().nonnegative(), continuityStatus: z.enum(['complete', 'missing', 'stale', 'incomplete']),
    qualityStatus: z.literal('unavailable'), qualityFailure: qualityUnavailableProofSchema,
  }).strict().refine(item => item.continuityStatus === 'complete' || item.continuityCheckRounds >= MAX_CONTINUITY_CHECKS)).length(1),
}).strict()
export const limitedWritingDeliverySchema = z.discriminatedUnion('version', [limitedWritingDeliveryV1Schema, limitedWritingDeliveryV2Schema])
export type LimitedWritingDelivery = z.infer<typeof limitedWritingDeliverySchema>
export const requiresCompletedReview = (text: string) => /(?:检查|复核|审查|审阅|校验|质量|连续性|一致性|check|review|validat|quality|continuity).{0,30}(?:通过|合格|无误|完成后|才能|才可|再交付|pass|before|deliver)|(?:必须|务必|确保|一定|only|must).{0,25}(?:通过|合格|无误|复核|检查|pass|review|check)|(?:不得|不能|禁止|must not|never).{0,10}(?:跳过|省略|bypass|skip).{0,10}(?:复核|检查|review|check)/iu.test(text)

/** Original author requirements cannot be waived by a tool, a model's todo or
 * a default premium policy. Unknown requirements keep the ordinary gate. */
export function allowsLimitedWritingDelivery(prompt: string | null): boolean {
  const chapterOnly = allowsChapterOnlyCompletion(prompt, false)
    || /^(?:请)?(?:修改|润色|修订|改写)(?:当前|本)(?:章节|章)(?:的)?(?:正文)?[。.!！]?$/iu.test(prompt?.trim() ?? '')
  return chapterOnly && !requiresCompletedReview(prompt ?? '')
}

/** Shared with parent admission: premium defaults cannot erase explicit frozen
 * author constraints or required outputs. */
export function allowsLimitedWritingContract(spec: TaskSpec, prompt: string | null) {
  const outputs = spec.expectedOutputs.filter(item => item.required)
  return ['write', 'revise'].includes(spec.intent) && allowsLimitedWritingDelivery(prompt)
    && !spec.hardConstraints.some(item => requiresCompletedReview(item.text))
    && outputs.length === 1 && outputs.every(item => ['artifact', 'text'].includes(item.kind) && item.minimumChineseCharacters === undefined)
}

export async function permitsLimitedWritingContract(tx: Prisma.TransactionClient, input: {
  spec: TaskSpec; prompt: string | null;
  root?: { id: string; novelId: string; userId: string; inputHash: string; specSnapshot: unknown };
}) {
  if (!allowsLimitedWritingContract(input.spec, input.prompt)) return false
  if (input.root && runtimeJson(taskSpecSchema.parse(input.root.specSnapshot)).hash !== runtimeJson(input.spec).hash) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '受限交付要求与原任务冻结契约不一致。')
  }
  if (!input.spec.postconditions.some(item => item.severity === 'error')) return true
  // Legacy tasks have no immutable admission baseline. Never manufacture one
  // from today's body or borrow another task's protection evidence.
  if (!input.root) return false
  const { evaluateTaskPostconditions } = await import('./runtime-postconditions.js')
  const checks = await evaluateTaskPostconditions(tx, input.root)
  return checks.filter(item => item.severity === 'error').every(item => item.status === 'passed')
}

/** Historical proof shapes remain readable, but a technical assessment failure
 * never authorizes a new completed task. The normal completion path requires
 * current checks and an actual chapter commit. */
export async function readLimitedWritingDelivery(_tx: Prisma.TransactionClient, _subject: Subject): Promise<LimitedWritingDelivery | null> {
  return null
}

export async function assertLimitedWritingDelivery(tx: Prisma.TransactionClient, subject: Subject, expected: LimitedWritingDelivery) {
  const parsed = limitedWritingDeliverySchema.safeParse(expected)
  if (!parsed.success || parsed.data.targetRunId !== subject.runId) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '受限交付凭证损坏或不属于当前执行。')
  const current = await readLimitedWritingDelivery(tx, subject)
  if (!current || runtimeJson(current).hash !== runtimeJson(parsed.data).hash) throw new DataAccessError(409, 'WRITING_DELIVERY_STALE', '受限交付前正文、检查依据或任务状态已变化；保留当前正文重新核对。')
}

/** Todo text is not completion proof. Only explicit checks/commit dependencies
 * of this one chapter may remain pending; unrelated work still blocks. */
export function limitedReviewDependency(content: string) {
  if (!/连续性|continuity|质量|quality|人类感|章节终态|章节桥|chapter_bridge_commit/iu.test(content)) return false
  return !content.replace(/连续性(?:检查|复核)?|(?:人类感)?质量(?:检查|复核)?|人类感检查|章节(?:桥|终态)|终态提交|chapter_bridge_commit|quality_analyze|(?:continuity|quality)(?: check| review)?/giu, '')
    .replace(/完成|执行|进行|复核|检查|提交|核对|当前版本|最终版本|当前|本章|并|及|与|and|final|current|complete|submit|[\s、，。:：]/giu, '').trim()
}

/** A persisted limited child is not an unrestricted completion certificate. */
export function readRunLimitedWritingOutcome(usage: unknown) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || !('outcome' in usage)) return null
  const record = usage as Record<string, unknown>
  const proof = limitedWritingDeliverySchema.safeParse(record.deliveryProof)
  if (!proof.success || runtimeJson(record.outcome).hash !== runtimeJson(proof.data.outcome).hash) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '受限交付终态缺少完整凭证。')
  }
  return proof.data
}

/** Parent completion consumes the actual child terminal receipt, rather than
 * trusting DB completed or a copied public outcome alone. */
export async function verifyRunLimitedWritingOutcome(tx: Prisma.TransactionClient, subject: Subject) {
  const run = await tx.agentRun.findFirstOrThrow({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  const limited = readRunLimitedWritingOutcome(run.usage)
  if (!limited) return null
  const original = await readOriginalTaskRequest(tx, subject)
  if (limited.targetRunId !== run.id || limited.taskId !== original.taskId || limited.sourceRunId !== original.sourceRunId
    || run.status !== 'completed' || !run.taskRootId) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '受限子任务终态缺少原任务身份。')
  const operation = await tx.agentOperation.findFirst({ where: { taskRootId: run.taskRootId, originRunId: run.id, action: 'completion_finalize', kind: 'internal', status: 'succeeded' },
    include: { effectReceipt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const receipt = operation?.effectReceipt
  const result = z.object({ limitedWritingDelivery: limitedWritingDeliverySchema, outcome: limitedWritingOutcomeSchema,
    sourceRevision: z.number().int().nonnegative(), sourceHash: hash, candidateHash: hash, evidenceHash: hash,
    evidence: z.object({ blockers: z.array(z.never()), limitedWritingDelivery: limitedWritingDeliverySchema }).passthrough() }).safeParse(receipt?.result)
  const admission = z.object({ input: z.object({ limitedWritingDelivery: limitedWritingDeliverySchema, outcome: limitedWritingOutcomeSchema }) }).safeParse(operation?.inputSnapshot)
  const event = operation ? await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `decision:${operation.id}` } }) : null
  if (!operation || !receipt || !result.success || !admission.success || !event || event.operationId !== operation.id || event.runId !== run.id
    || event.type !== 'execution.completion.decided' || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
    || runtimeJson(receipt.result).hash !== receipt.resultHash || runtimeJson(result.data.evidence).hash !== result.data.evidenceHash
    || [result.data.limitedWritingDelivery, result.data.evidence.limitedWritingDelivery, admission.data.input.limitedWritingDelivery].some(proof => runtimeJson(proof).hash !== runtimeJson(limited).hash)
    || [result.data.outcome, admission.data.input.outcome].some(outcome => runtimeJson(outcome).hash !== runtimeJson(limited.outcome).hash)) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '受限子任务缺少真实终态回执。')
  }
  const decision = z.object({ resultHash: hash, sourceRevision: z.number().int().nonnegative(), sourceHash: hash,
    revision: z.number().int().positive(), snapshotHash: hash, outcome: limitedWritingOutcomeSchema }).parse(event.payload)
  const { readExecutionFrame, readExecutionStateInTransaction } = await import('./runtime-state.js')
  const source = await readExecutionFrame(tx, run.taskRootId, result.data.sourceRevision)
  const current = await readExecutionStateInTransaction(tx, run.taskRootId)
  const candidate = source.state.messages.at(-1)
  if (decision.resultHash !== receipt.resultHash || decision.sourceHash !== source.snapshotHash || result.data.sourceHash !== source.snapshotHash
    || decision.sourceRevision !== result.data.sourceRevision || decision.revision !== result.data.sourceRevision + 1
    || decision.snapshotHash !== current.frame.snapshotHash || current.frame.revision !== decision.revision || current.frame.state.phase !== 'completed'
    || runtimeJson(current.frame.state.messages).hash !== runtimeJson(source.state.messages).hash || candidate?.role !== 'assistant' || candidate.content !== limited.text
    || result.data.candidateHash !== runtimeJson({ content: candidate.content, reasoning: candidate.reasoning ?? null }).hash
    || runtimeJson(decision.outcome).hash !== runtimeJson(limited.outcome).hash) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '受限子任务终态与原执行帧不一致。')
  return limited
}
