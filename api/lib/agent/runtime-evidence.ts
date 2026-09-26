import { z } from 'zod'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readExecutionFrame } from './runtime-state.js'
import { formatDurableToolObservation, matchesToolObservation } from './runtime-common.js'
import { hasReadFullToolOutput } from './runtime-observed-baseline.js'
import { durableProgressSchema } from './runtime-checkpoint.js'

const inputSchema = z.object({ input: z.object({ callId: z.string(), normalization: z.object({ sourceRevision: z.number().int().nonnegative() }) }) })
const resultSchema = z.object({ toolResult: z.object({ output: z.string(), summary: z.string(), outcome: z.literal('failed').optional() }).passthrough(), progress: z.unknown().optional() })
const reads = new Set(['account_credits', 'account_credit_history', 'account_novels', 'chapter_read', 'plan_read', 'novel_get_context', 'chapter_list_summaries', 'memory_search', 'volume_list', 'structure_outline',
  'task_context_list', 'task_context_read', 'session_history_search', 'session_message_read', 'chapter_bridge_get',
  'directive_list', 'project_search', 'entity_resolve', 'impact_analyze', 'structure_validate', 'story_charter_get', 'quality_report_get', 'research_dossier_get', 'first_three_prototype_get',
  'memory_review_list', 'character_voice_get', 'experience_anchor_get', 'style_profile_get', 'retrieval_trace_read', 'craft_search', 'style_leakage_check'])

function observationIdentity(action: string, output: string) {
  // Audit IDs change on distinct calls, not the observed findings. Keep them in
  // receipts/UI while excluding only the tool's own generated marker from progress.
  if (action === 'craft_search') return runtimeJson({ action, output: output.replace(/^检索记录 traceId=[A-Za-z0-9_-]+。/, '检索记录。') }).hash
  if (action === 'style_leakage_check') return runtimeJson({ action, output: output.replace(/checkId=[A-Za-z0-9_-]+$/, 'checkId=已记录') }).hash
  if (action !== 'project_search') return runtimeJson({ action, output }).hash
  // Search saves a fresh artifact per distinct admitted operation. Its generated
  // ID is not new research progress; only remove that ID from the tool's own
  // first-line header, never from matched chapter text below it.
  const newline = output.indexOf('\n')
  const header = newline < 0 ? output : output.slice(0, newline)
  const body = newline < 0 ? '' : output.slice(newline)
  return runtimeJson({ action, output: header.replace(/本次返回结果已保存为 artifactId=[A-Za-z0-9_-]+，/, '本次返回结果已保存，') + body }).hash
}

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
      if (durableProgressSchema.safeParse(result.data.progress).success) { progressSequence = String(event.sequence); continue }
      if (reads.has(operation.action)) {
        if (message.content !== formatDurableToolObservation(operation.action, result.data.toolResult.output)
          && !await hasReadFullToolOutput(tx, taskRootId, revision, { operationId: operation.id, resultHash: receipt.resultHash, output: result.data.toolResult.output })) continue
        const identity = observationIdentity(operation.action, result.data.toolResult.output)
        if (!observations.has(identity)) { progressSequence = String(event.sequence); observations.add(identity) }
      }
    }
    if (events.length < 100) break
    cursor = events.at(-1)!.sequence
  }
  return { effects, progressSequence }
}
