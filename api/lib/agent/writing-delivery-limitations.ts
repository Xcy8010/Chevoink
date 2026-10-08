import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { originalTaskRunIds, readOriginalTaskRequest } from './original-request.js'
import { allowsChapterOnlyCompletion, assertWritingTarget, lockWritingRunLineage, readNewDraftRevision, readWritingScope } from './writing-scope.js'
import { readChapterReviewReadiness, isChapterRevisionChannelOpen } from './chapter-review-guard.js'
import { continuityCheckRounds, MAX_CONTINUITY_CHECKS } from './story-compiler.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { readWritingPresentation } from './writing-request-context.js'
import { runtimeJson } from './runtime-common.js'
import { runCheckpointSchema } from './checkpoint.js'
import { qualityUnavailableProofSchema, readQualityUnavailableProof } from './quality-unavailable-proof.js'

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
const requiresCompletedReview = (text: string) => /(?:检查|复核|审查|审阅|校验|质量|连续性|一致性|check|review|validat|quality|continuity).{0,30}(?:通过|合格|无误|完成后|才能|才可|再交付|pass|before|deliver)|(?:必须|务必|确保|一定|only|must).{0,25}(?:通过|合格|无误|复核|检查|pass|review|check)|(?:不得|不能|禁止|must not|never).{0,10}(?:跳过|省略|bypass|skip).{0,10}(?:复核|检查|review|check)/iu.test(text)

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

/** Read-only evidence of saved writing with confirmed unavailable assessments. This
 * does not commit the bridge, complete scenes, certify a report, or spend a call.
 * Finalizers must re-read under their existing lease/CAS transaction. */
export async function readLimitedWritingDelivery(tx: Prisma.TransactionClient, subject: Subject): Promise<LimitedWritingDelivery | null> {
  await lockNovelActiveScope(tx, subject.novelId)
  await lockWritingRunLineage(tx, subject)
  await assertAgentManuscriptCurrent(tx, subject)
  const scope = await readWritingScope(tx, subject)
  const spec = taskSpecSchema.safeParse(scope.spec)
  if (!spec.success || !allowsLimitedWritingContract(spec.data, scope.prompt)
    || scope.writing?.kind !== 'bounded' || scope.writing.targets.length !== 1) return null
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    status: { in: ['queued', 'running', 'awaiting_approval'] } } })
  if (!run) return null
  const root = run.taskRootId ? await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: run.taskRootId } }) : undefined
  const originalRoot = root && root.id !== scope.taskId ? await tx.agentTaskRoot.findFirstOrThrow({ where: {
    id: scope.taskId, userId: subject.userId, novelId: subject.novelId } }) : root
  if (!await permitsLimitedWritingContract(tx, { spec: spec.data, prompt: scope.prompt, root: originalRoot })) return null
  const usage = run.usage && typeof run.usage === 'object' && !Array.isArray(run.usage) ? run.usage : null
  if (usage && 'checkpoint' in usage) {
    const checkpoint = runCheckpointSchema.safeParse(usage.checkpoint)
    if (!checkpoint.success) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原执行检查点损坏，不能受限交付。')
    if (checkpoint.data.pendingReviews?.length) return null
  }
  const ownSpec = taskSpecSchema.safeParse(run.taskSpec)
  if (!ownSpec.success || !['write', 'revise'].includes(ownSpec.data.intent)) return null
  if (scope.parentRunId && !await tx.agentRun.findFirst({ where: { id: scope.parentRunId, userId: subject.userId, novelId: subject.novelId,
    status: { in: ['queued', 'running', 'awaiting_approval'] } } })) return null
  const runIds = await originalTaskRunIds(tx, subject, scope)
  if (!run.taskRootId) {
    const todos = await readLegacyDeliveryTodos(tx, run.sessionId, runIds)
    if (todos.some(item => ['pending', 'in_progress'].includes(item.status) && !limitedReviewDependency(item.content))) return null
  }
  if (await tx.agentRun.count({ where: { id: { not: subject.runId }, userId: subject.userId, novelId: subject.novelId,
    OR: [{ session: { spawnedFromRunId: { in: runIds } } }, { incomingChildGrant: { currentParentRunId: { in: runIds } } }],
    status: { notIn: ['completed', 'cancelled'] } } })
    || await tx.agentSubtaskRun.count({ where: { userId: subject.userId, novelId: subject.novelId, parentRunId: { in: runIds },
      status: { notIn: ['completed', 'succeeded', 'cancelled'] } } })) return null
  const rootIds = (await tx.agentRun.findMany({ where: { id: { in: runIds } }, select: { taskRootId: true } })).flatMap(item => item.taskRootId ? [item.taskRootId] : [])
  if (await tx.agentOperation.count({ where: { taskRootId: { in: rootIds }, status: { in: ['prepared', 'dispatched', 'unknown'] } } })
    || await tx.agentProviderAttempt.count({ where: { operation: { taskRootId: { in: rootIds } }, status: { in: ['prepared', 'dispatched', 'unknown'] } } })
    || await tx.aiUsageLog.count({ where: { userId: subject.userId, agentRunId: { in: runIds }, billingStatus: { in: ['prepared', 'pending_usage'] } } })) return null
  const target = scope.writing.targets[0]
  const id = target.chapterId ?? scope.bindings?.targets.find(item => item.orderIndex === target.orderIndex)?.chapterId
  if (!id) return null
  await assertWritingTarget(tx, subject, { chapterId: id })
  await tx.$queryRaw`SELECT id FROM chapters WHERE id = ${id} FOR SHARE`
  const chapter = await tx.chapter.findFirst({ where: { id, authorId: subject.userId, ...activeChapterScope(subject.novelId) } })
  if (!chapter?.content.trim() || chapter.orderIndex !== target.orderIndex) return null
  const compilation = await tx.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId: id, runId: { in: runIds }, status: 'active' }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!compilation?.bridge || compilation.bridge.toChapterId !== id || compilation.bridge.targetRevision !== chapter.revision) return null
  readNewDraftRevision(compilation.validation) // Malformed historical audit proof remains fail-closed.
  const sourceId = compilation.bridge.fromChapterId
  if (sourceId) await tx.$queryRaw`SELECT id FROM chapters WHERE id = ${sourceId} FOR SHARE`
  const source = sourceId ? await tx.chapter.findFirst({ where: { id: sourceId, ...activeChapterScope(subject.novelId) } }) : null
  if (sourceId && (!source || source.revision !== compilation.bridge.sourceRevision)) return null
  const readiness = await readChapterReviewReadiness(tx, subject, compilation.id)
  // Historical counts cannot certify current writing or create a new limited
  // terminal decision. Old proof schemas/readers remain receipt-compatible.
  if (!readiness || readiness.ready || readiness.continuity !== 'complete') return null
  const quality = await tx.chapterQualityReport.findFirst({ where: { userId: subject.userId, novelId: subject.novelId,
    compilationId: compilation.id, chapterId: id, runId: { in: runIds } }, include: { findings: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!quality) return null
  const qualityFailure = readiness.quality === 'complete' ? null
    : await readQualityUnavailableProof(tx, subject, runIds, quality, chapter, root?.id ?? null)
  if (readiness.quality !== 'complete' && !qualityFailure) return null
  if (readiness.quality === 'complete' && (readiness.qualityReportId !== quality.id || readiness.continuity === 'complete')) return null
  // Ordinary writing permission is not an obligation to keep automatically
  // rewriting after a confirmed unusable quality assessment. A current factual
  // error and every ordinary v1 remediation channel keep the original gate.
  if (!(qualityFailure && readiness.continuity === 'complete' && readiness.continuityErrorCount === 0)
    && await isChapterRevisionChannelOpen(tx, subject, chapter)) return null
  // Projection precedes domain continuation. Independent obligations must keep
  // control of the executor; exempt only this exact proven compilation.
  if (await tx.storyCompilation.count({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds },
    id: { not: compilation.id }, status: 'active' } })) return null
  const others = await tx.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    runId: { in: runIds }, id: { not: compilation.id }, status: 'completed' }, include: { bridge: true, chapter: true } })
  if (others.some(item => !item.bridge?.committedAt || item.chapter?.revision !== item.bridge.targetRevision)) return null
  if (root) {
    const { readExecutionStateInTransaction } = await import('./runtime-state.js')
    const { readDurableTodoItems } = await import('./tools/durable-todo.js')
    const { collectDurableToolEvidence } = await import('./runtime-evidence.js')
    const { collectDurableDeliverables } = await import('./runtime-deliverables.js')
    const { collectDurableMemoryWork } = await import('./runtime-memory.js')
    const { readTaskBudgetInTransaction } = await import('./runtime-budget.js')
    const current = await readExecutionStateInTransaction(tx, root.id)
    const todos = await readDurableTodoItems(tx, root.id, current.frame.revision)
    if (todos.some(item => ['pending', 'in_progress'].includes(item.status) && !limitedReviewDependency(item.content))) return null
    const evidence = await collectDurableToolEvidence(tx, root.id, current.frame.revision)
    const deliverables = await collectDurableDeliverables(tx, root, evidence.effects)
    const memory = await collectDurableMemoryWork(tx, root, evidence.effects)
    if (deliverables.some(item => ['missing', 'changed'].includes(item.status)) || memory.some(item => !item.completed)
      || (await readTaskBudgetInTransaction(tx, root.id)).unresolvedAttempts > 0n) return null
  }
  const retainedQualityIssueCount = quality.findings.filter(item => item.disposition !== 'repaired' && item.authorFeedback !== 'rejected').length
  const length = scope.prompt?.match(/(\d{2,6})\s*[-–—−~～〜－至到]\s*(\d{2,6})\s*字/u)
  if (length && (chapter.content.trim().length < Number(length[1]) || chapter.content.trim().length > Number(length[2]))) return null
  const presentation = await readWritingPresentation(tx, subject, [{ ...target, chapterId: id }])
  const summary = `《${chapter.title}》正文已保存（r${chapter.revision}）；连续性已检查，原报告与意见保留。${qualityFailure
    ? '质量检查响应已收到，但报告格式未能完成验证；质量尚未判定通过，待复核。' : ''}${retainedQualityIssueCount ? `质量报告仍有${retainedQualityIssueCount}条未处理意见。` : ''}`
  const full = presentation ? presentation.mode === 'full_text' : scope.writing.titleAndBodyOnly
  return limitedWritingDeliverySchema.parse({ version: qualityFailure ? 2 : 1, taskId: scope.taskId, targetRunId: subject.runId, sourceRunId: scope.sourceRunId,
    chapters: [{ id, title: chapter.title, revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash,
      compilationId: compilation.id, compilerStateHash: runtimeJson(JSON.parse(JSON.stringify(compilation))).hash,
      sourceChapterId: sourceId, sourceRevision: source?.revision ?? null, sourceContentHash: source ? runtimeJson({ content: source.content }).hash : null,
      continuityCheckRounds: continuityCheckRounds(compilation.validation), continuityStatus: readiness.continuity, qualityReportId: quality.id,
      ...(qualityFailure ? { qualityStatus: 'unavailable', qualityFailure } : {}),
      qualityReportHash: runtimeJson(JSON.parse(JSON.stringify(quality))).hash, retainedQualityIssueCount }],
    text: `${full ? `${chapter.title}\n\n${chapter.content}\n\n` : ''}${summary}`, outcome: { kind: 'delivered_with_limitations', summary } })
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

/** Same ordering as loadSessionTodoItems, inside the delivery transaction.
 * Unlike its UI-compatible tolerant reader, invalid authoritative state cannot
 * disappear here and thereby authorize terminal delivery. */
async function readLegacyDeliveryTodos(tx: Prisma.TransactionClient, sessionId: string, runIds: string[]) {
  const items = z.array(z.object({ content: z.string().min(1), status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']) }).passthrough())
  const messages = await tx.agentMessage.findMany({ where: { sessionId, role: 'assistant', runId: { in: runIds } },
    orderBy: { createdAt: 'desc' }, take: 40, select: { parts: true, createdAt: true } })
  const artifact = await tx.agentArtifact.findFirst({ where: { artifactType: 'chapterPlan', runId: { in: runIds }, run: { sessionId },
    metadata: { path: ['todoList'], equals: true } }, orderBy: { updatedAt: 'desc' }, select: { content: true, updatedAt: true } })
  let value: unknown
  for (const message of messages) {
    if (artifact && artifact.updatedAt > message.createdAt) break
    if (!Array.isArray(message.parts)) continue
    for (const part of [...message.parts].reverse()) {
      if (part && typeof part === 'object' && !Array.isArray(part) && part.type === 'tool-call' && part.toolName === 'todo_write' && part.status === 'success'
        && part.display && typeof part.display === 'object' && !Array.isArray(part.display) && part.display.kind === 'todoList') {
        value = part.display.items
        break
      }
    }
    if (value !== undefined) break
  }
  if (value === undefined && artifact) {
    try { value = JSON.parse(artifact.content) } catch { throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原任务待办内容损坏，不能受限交付。') }
  }
  if (value === undefined) return []
  const parsed = items.safeParse(value)
  if (!parsed.success) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原任务待办清单损坏，不能受限交付。')
  return parsed.data
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
