import { observeSemanticTransition, observeRequiredResult, semanticReadIdentity, observeSemanticReadProgress, observeWritingWorkflowMilestone, writingWorkflowMilestoneSchema } from './semantic-progress.js'
import { taskSpecSchema } from '../../../shared/contracts/index.js'
import { readOriginalTaskRequest } from './original-request.js'
import { z } from 'zod'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readExecutionFrame } from './runtime-state.js'
import { formatDurableToolObservation, matchesToolObservation } from './runtime-common.js'
import { hasReadFullToolOutput } from './runtime-observed-baseline.js'
import { durableProgressSchema } from './runtime-checkpoint.js'

const inputSchema = z.object({ input: z.object({ callId: z.string(), normalization: z.object({ sourceRevision: z.number().int().nonnegative() }) }) })
const resultSchema = z.object({ toolResult: z.object({ output: z.string(), summary: z.string(), outcome: z.literal('failed').optional(), semanticTransition: z.object({ targetId: z.string().min(1), beforeHash: z.string().regex(/^[a-f0-9]{64}$/), afterHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(), requiredResult: z.object({ targetId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  workflowMilestone: writingWorkflowMilestoneSchema.optional(),
  observedChapterRange: z.object({ targetId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict().refine(value => value.end >= value.start).optional(),
}).passthrough(), progress: z.unknown().optional() })
/** Receipt metadata is evidence only after its exact observation entered the
 * saved context. Repeated reads, bookkeeping and failed outcomes are not new
 * progress and cannot reset the task's stagnation ceiling. */
export async function collectDurableToolEvidence(tx: RuntimeTx, taskRootId: string, revision: number) {
  if (await tx.agentOperation.findFirst({ where: { taskRootId, kind: 'tool', status: 'succeeded', OR: [
    { effectReceipt: { is: null } }, { events: { none: { type: 'effect.committed' } } },
  ] }, select: { id: true } })) return runtimeError('RUNTIME_RECEIPT_INVALID', '已成功工具缺少效果回执或事件，不能从证据清单中静默遗漏。')
  let cursor: bigint | undefined
  let progressSequence = '0'
  const observations = new Set<string>()
  const effects: Array<{ operationId: string; action: string; resultHash: string; sequence: string; sourceRevision: number; outcome: 'succeeded' | 'failed'; summary: string }> = []
  for (;;) {
    const events = await tx.agentExecutionOutbox.findMany({ where: { taskRootId, type: 'effect.committed', ...(cursor === undefined ? {} : { sequence: { gt: cursor } }),
      operation: { kind: 'tool', status: 'succeeded' } }, orderBy: { sequence: 'asc' }, take: 100, include: { operation: { include: { effectReceipt: true } } } })
    for (const event of events) {
      const operation = event.operation!, receipt = operation.effectReceipt
      const input = inputSchema.safeParse(operation.inputSnapshot)
      if (!input.success || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash || !receipt || runtimeJson(receipt.result).hash !== receipt.resultHash
        || event.eventKey !== `effect:${operation.id}` || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '进展或完成审查的工具证据损坏。')
      const sourceRevision = input.data.input.normalization.sourceRevision
      if (sourceRevision + 2 > revision) continue
      const result = resultSchema.safeParse(receipt.result)
      if (!result.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '工具证据缺少完整结果。')
      const pending = await readExecutionFrame(tx, taskRootId, sourceRevision + 1)
      const reduced = await readExecutionFrame(tx, taskRootId, sourceRevision + 2)
      const message = reduced.state.messages.at(-1)
      if (pending.state.pendingOperationId !== operation.id || reduced.state.phase !== 'idle' || message?.role !== 'tool'
        || message.toolCallId !== input.data.input.callId || !matchesToolObservation(operation.action, result.data.toolResult.output, message.content,
          { operationId: operation.id, resultHash: receipt.resultHash })) return runtimeError('RUNTIME_RECEIPT_INVALID', '工具证据未进入原执行上下文。')
      const failed = result.data.toolResult.outcome === 'failed'
      effects.push({ operationId: operation.id, action: operation.action, resultHash: receipt.resultHash, sequence: String(event.sequence), sourceRevision,
        outcome: failed ? 'failed' : 'succeeded', summary: result.data.toolResult.summary })
      if (failed || operation.action === 'todo_write') continue
      const milestone = result.data.toolResult.workflowMilestone
      if (milestone) {
        const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: taskRootId } })
        const original = await readOriginalTaskRequest(tx, { userId: root.userId, novelId: root.novelId, runId: receipt.runId })
        const spec = taskSpecSchema.safeParse(original.spec)
        if (!spec.success || milestone.runId !== receipt.runId || milestone.userId !== root.userId || milestone.novelId !== root.novelId)
          return runtimeError('RUNTIME_RECEIPT_INVALID', '准备进度不属于当前原始任务。')
        if (original.taskId === taskRootId && !original.parentRunId && observeWritingWorkflowMilestone(observations, operation.action, milestone,
          { userId: root.userId, novelId: root.novelId, runId: receipt.runId, taskSpec: spec.data })) progressSequence = String(event.sequence)
      }
      const progress = durableProgressSchema.safeParse(result.data.progress)
      if (progress.success && observeSemanticTransition(observations, `${progress.data.kind}:${operation.action === 'plan_save' ? 'plan' : progress.data.targetId}`, progress.data.beforeHash, progress.data.afterHash)) progressSequence = String(event.sequence)
      const transition = result.data.toolResult.semanticTransition
      if (transition && observeSemanticTransition(observations, `structure_revision:${transition.targetId}`, transition.beforeHash, transition.afterHash)) progressSequence = String(event.sequence)
      const required = result.data.toolResult.requiredResult
      if (operation.action === 'chapter_bridge_commit' && required && observeRequiredResult(observations, `chapter:${required.targetId}`, required.contentHash)) progressSequence = String(event.sequence)
      const identity = semanticReadIdentity(operation.action, result.data.toolResult.output)
      if (identity) {
        if (message.content !== formatDurableToolObservation(operation.action, result.data.toolResult.output)
          && !await hasReadFullToolOutput(tx, taskRootId, revision, { operationId: operation.id, resultHash: receipt.resultHash, output: result.data.toolResult.output })) continue
        if (observeSemanticReadProgress(observations, operation.action, result.data.toolResult.output, result.data.toolResult.observedChapterRange)) progressSequence = String(event.sequence)
      }
    }
    if (events.length < 100) break
    cursor = events.at(-1)!.sequence
  }
  return { effects, progressSequence }
}
