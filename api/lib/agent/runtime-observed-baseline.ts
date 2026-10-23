import { z } from 'zod'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readExecutionFrame } from './runtime-state.js'
import { formatDurableToolObservation, matchesToolObservation } from './runtime-common.js'

/** Only verified page results already reduced into this task count as reading.
 * A pointer, a successful DB fetch, or a single partial page is not full text. */
export async function hasReadFullToolOutput(tx: RuntimeTx, rootId: string, revision: number,
  source: { operationId: string; resultHash: string; output: string }) {
  const intervals: Array<[number, number]> = []
  let cursor: string | undefined
  for (;;) {
    const reads = await tx.agentOperation.findMany({ where: { taskRootId: rootId, action: 'execution_context_read', status: 'succeeded' },
      orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { effectReceipt: true } })
    for (const operation of reads) {
      const input = z.object({ input: z.object({ callId: z.string(), args: z.object({ operationId: z.string(), resultHash: z.string(),
        offset: z.number().int().nonnegative(), limit: z.number().int().positive() }), normalization: z.object({ sourceRevision: z.number().int().nonnegative() }) }) }).safeParse(operation.inputSnapshot)
      if (!input.success || input.data.input.args.operationId !== source.operationId || input.data.input.args.resultHash !== source.resultHash
        || input.data.input.normalization.sourceRevision + 2 > revision) continue
      const receipt = operation.effectReceipt
      if (!receipt || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash || runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原文分页回执损坏。')
      const result = z.object({ toolResult: z.object({ output: z.string(), observedOutputPage: z.object({ operationId: z.string(), resultHash: z.string(),
        offset: z.number().int().nonnegative(), end: z.number().int().nonnegative(), totalChars: z.number().int().nonnegative() }).strict() }) }).safeParse(receipt.result)
      if (!result.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '原文分页缺少读取范围。')
      const { args, normalization, callId } = input.data.input, page = result.data.toolResult.observedOutputPage
      const end = Math.min(source.output.length, args.offset + args.limit)
      if (page.operationId !== source.operationId || page.resultHash !== source.resultHash || page.offset !== args.offset
        || page.end !== end || page.totalChars !== source.output.length || args.offset > end
        || result.data.toolResult.output !== JSON.stringify({ operationId: source.operationId, resultHash: source.resultHash, offset: args.offset,
          totalChars: source.output.length, nextOffset: end < source.output.length ? end : null, content: source.output.slice(args.offset, end) })) return runtimeError('RUNTIME_RECEIPT_INVALID', '原文分页范围或内容不一致。')
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${operation.id}` } })
      const pending = await readExecutionFrame(tx, rootId, normalization.sourceRevision + 1)
      const reduced = await readExecutionFrame(tx, rootId, normalization.sourceRevision + 2)
      const message = reduced.state.messages.at(-1)
      if (!event || event.taskRootId !== rootId || event.operationId !== operation.id || event.type !== 'effect.committed'
        || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash
        || pending.state.pendingOperationId !== operation.id || reduced.state.phase !== 'idle' || message?.role !== 'tool' || message.toolCallId !== callId
        || message.content !== formatDurableToolObservation(operation.action, result.data.toolResult.output)) return runtimeError('RUNTIME_RECEIPT_INVALID', '分页原文尚未进入本任务上下文。')
      intervals.push([page.offset, page.end])
    }
    if (reads.length < 100) break
    cursor = reads.at(-1)!.id
  }
  let covered = 0
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    if (start > covered) return false
    covered = Math.max(covered, end)
  }
  return intervals.length > 0 && covered === source.output.length
}

const inputSchema = z.object({ input: z.object({ callId: z.string(), normalization: z.object({ sourceRevision: z.number().int().nonnegative() }) }) })
const resultSchema = z.object({ toolResult: z.object({ output: z.string(),
  observedMemories: z.array(z.object({ kind: z.literal('memory'), id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) })).optional(),
  observedStructure: z.object({ kind: z.literal('structure'), id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  observedState: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chapter'), id: z.string(), revision: z.number().int().positive() }),
    z.object({ kind: z.literal('plan'), id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.object({ kind: z.literal('novel'), id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.object({ kind: z.literal('charter'), id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.object({ kind: z.literal('changeset'), id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
  ]).optional(),
  display: z.union([
    z.object({ kind: z.literal('chapterDiff'), chapterId: z.string(), revision: z.number().int().positive() }).passthrough(),
    z.object({ kind: z.literal('chapterRef'), chapterId: z.string() }).passthrough(),
    z.object({ kind: z.literal('qualityReport'), chapterId: z.string() }).passthrough(),
    z.object({ kind: z.literal('storyCompiler') }).passthrough(),
    z.object({ kind: z.literal('changeSet'), changeSetId: z.string() }).passthrough(),
    z.object({ kind: z.enum(['planFile', 'planDiff', 'planRename', 'planDelete']), artifactId: z.string() }).passthrough(),
  ]).optional(),
}).passthrough() })

/** Only observations already reduced into this cursor can authorize a baseline.
 * Never query today's content revision to silently upgrade an old write. */
export async function readObservedBaseline(tx: RuntimeTx, rootId: string, revision: number, target: { kind: 'chapter' | 'plan' | 'structure' | 'memory' | 'novel' | 'charter' | 'changeset'; id: string }) {
  let afterId: string | undefined
  let best: { revision: number; baseline: NonNullable<z.infer<typeof resultSchema>['toolResult']['observedState'] | z.infer<typeof resultSchema>['toolResult']['observedStructure']> | { kind: 'memory'; id: string; hash: string } } | undefined
  for (;;) {
    const operations = await tx.agentOperation.findMany({ where: { taskRootId: rootId, kind: 'tool', status: 'succeeded',
      action: { in: target.kind === 'changeset' ? ['bulk_replace_preview', 'entity_rename_preview', 'changeset_apply', 'changeset_rollback'] : target.kind === 'charter' ? ['story_charter_get', 'story_charter_save', 'reader_promise_save', 'reader_promise_update'] : target.kind === 'novel' ? ['novel_get_context', 'novel_rename', 'novel_update_meta', 'cover_prompt_set'] : target.kind === 'memory' ? ['memory_search', 'memory_save', 'memory_event_save', 'memory_relation_save'] : target.kind === 'chapter' ? ['chapter_read', 'chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename', 'chapter_move', 'chapter_move_to_volume', 'chapter_merge', 'continuity_validate', 'quality_analyze']
        : target.kind === 'structure' ? ['volume_list', 'structure_outline', 'volume_update', 'volume_move', 'volume_delete', 'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge'] : ['plan_read', 'plan_save', 'plan_rename', 'plan_delete'] } },
      orderBy: { id: 'asc' }, take: 100, ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}), include: { effectReceipt: true } })
    for (const operation of operations) {
      const parsed = inputSchema.safeParse(operation.inputSnapshot)
      if (!parsed.success) continue // Legacy/non-cursor operations are not a saved baseline.
      const sourceRevision = parsed.data.input.normalization.sourceRevision
      if (sourceRevision + 2 > revision || (best && sourceRevision <= best.revision)) continue
      const receipt = operation.effectReceipt
      if (!receipt || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash || runtimeJson(receipt.result).hash !== receipt.resultHash) runtimeError('RUNTIME_RECEIPT_INVALID', '写入基线回执损坏。')
      const result = resultSchema.safeParse(receipt.result)
      if (!result.success) runtimeError('RUNTIME_RECEIPT_INVALID', '写入基线观察格式无效。')
      const value = result.data!.toolResult
      const baseline = target.kind === 'memory' ? value.observedMemories?.find(item => item.id === target.id) : target.kind === 'structure' ? value.observedStructure : value.observedState ?? (value.display?.kind === 'chapterDiff' ? { kind: 'chapter' as const, id: value.display.chapterId, revision: value.display.revision } : undefined)
      if (!baseline || baseline.kind !== target.kind || baseline.id !== target.id) continue
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${operation.id}` } })
      if (!event || event.taskRootId !== rootId || event.operationId !== operation.id || event.type !== 'effect.committed'
        || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash) runtimeError('RUNTIME_RECEIPT_INVALID', '写入基线缺少对应持久事件。')
      const pending = await readExecutionFrame(tx, rootId, sourceRevision + 1)
      const reduced = await readExecutionFrame(tx, rootId, sourceRevision + 2)
      const observation = reduced.state.messages.at(-1)
      if (pending.state.pendingOperationId !== operation.id || reduced.state.phase !== 'idle' || observation?.role !== 'tool'
        || observation.toolCallId !== parsed.data.input.callId || !matchesToolObservation(operation.action, value.output, observation.content,
          { operationId: operation.id, resultHash: receipt.resultHash })) runtimeError('RUNTIME_RECEIPT_INVALID', '读取观察尚未进入原执行上下文。')
      if (observation.content !== formatDurableToolObservation(operation.action, value.output)
        && !await hasReadFullToolOutput(tx, rootId, revision, { operationId: operation.id, resultHash: receipt.resultHash, output: value.output })) continue
      best = { revision: sourceRevision, baseline }
    }
    if (operations.length < 100) break
    afterId = operations.at(-1)!.id
  }
  return best?.baseline ?? null
}
