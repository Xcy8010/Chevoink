import { z } from 'zod'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readExecutionFrame } from './runtime-state.js'
import { formatDurableToolObservation, matchesToolObservation } from './runtime-common.js'
import { hasReadFullToolOutput } from './runtime-observed-baseline.js'

export const compilerObservationSchema = z.object({ id: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

export async function compilerStateHash(tx: RuntimeTx, userId: string, novelId: string, rootId: string, id: string) {
  const compilation = await tx.storyCompilation.findFirst({ where: { id, userId, novelId, run: { taskRootId: rootId } },
    include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
  return compilation ? runtimeJson(JSON.parse(JSON.stringify(compilation))).hash : null
}

/** A scene mutation names an already reduced observation from this root, never
 * the newest compilation in the novel or a chapter-matching old task. */
export async function readCompilerObservation(tx: RuntimeTx, rootId: string, revision: number, id?: string) {
  let cursor: bigint | undefined
  for (;;) {
    const events = await tx.agentExecutionOutbox.findMany({ where: { taskRootId: rootId, type: 'effect.committed',
      ...(cursor === undefined ? {} : { sequence: { lt: cursor } }),
      operation: { action: { in: ['story_compiler_prepare', 'scene_task_build', 'chapter_bridge_get', 'continuity_validate', 'chapter_bridge_commit', 'quality_analyze'] }, status: 'succeeded' } },
      orderBy: { sequence: 'desc' }, take: 100, include: { operation: { include: { effectReceipt: true } } } })
    for (const event of events) {
      const operation = event.operation!, receipt = operation.effectReceipt
      const input = z.object({ input: z.object({ callId: z.string(), normalization: z.object({ sourceRevision: z.number().int().nonnegative() }) }) }).safeParse(operation.inputSnapshot)
      if (!input.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '编译观察缺少原执行位置。')
      const source = input.data.input.normalization.sourceRevision
      if (source + 2 > revision) continue
      if (!receipt || operation.taskRootId !== rootId || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
        || runtimeJson(receipt.result).hash !== receipt.resultHash || event.eventKey !== `effect:${operation.id}`
        || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '编译观察回执损坏。')
      const result = z.object({ compilerState: compilerObservationSchema, toolResult: z.object({ output: z.string() }) }).safeParse(receipt.result)
      if (['quality_analyze', 'continuity_validate'].includes(operation.action) && receipt.result && typeof receipt.result === 'object' && !Array.isArray(receipt.result) && !('compilerState' in receipt.result)) continue // 独立章检查不产生编译观察。
      if (!result.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '编译观察缺少目标身份。')
      if (id && result.data.compilerState.id !== id) continue
      const pending = await readExecutionFrame(tx, rootId, source + 1)
      const reduced = await readExecutionFrame(tx, rootId, source + 2)
      const message = reduced.state.messages.at(-1)
      if (pending.state.pendingOperationId !== operation.id || reduced.state.phase !== 'idle' || message?.role !== 'tool'
        || message.toolCallId !== input.data.input.callId || !matchesToolObservation(operation.action, result.data.toolResult.output, message.content,
          { operationId: operation.id, resultHash: receipt.resultHash })) return runtimeError('RUNTIME_RECEIPT_INVALID', '编译观察尚未进入原上下文。')
      if (message.content !== formatDurableToolObservation(operation.action, result.data.toolResult.output)
        && !await hasReadFullToolOutput(tx, rootId, revision, { operationId: operation.id, resultHash: receipt.resultHash, output: result.data.toolResult.output })) continue
      return result.data.compilerState
    }
    if (events.length < 100) return null
    cursor = events.at(-1)!.sequence
  }
}
