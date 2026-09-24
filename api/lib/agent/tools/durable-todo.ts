import { z } from 'zod'
import type { AgentTool, ToolContext, ToolResult } from './types.js'
import { runtimeError, runtimeJson, type RuntimeTx } from '../runtime-common.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { readExecutionFrame } from '../runtime-state.js'
import { formatDurableToolObservation } from '../runtime-common.js'
import { DataAccessError } from '../../prisma.js'
import { normalizeToolInput } from './input-validation.js'
import { todoWriteTool, prepareTodoUpdate, renderTodoItems } from './todo-tools.js'

const itemsSchema = z.array(z.object({ id: z.string().max(64).optional(), reason: z.string().max(200).optional(), content: z.string().min(1).max(100), status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']) }).strict()).max(20)
const resultSchema = z.object({ todoItems: itemsSchema, toolResult: z.object({ output: z.string(), summary: z.string() }).passthrough() })

/** Author directives share the task-state transaction boundary. Saving a
 * directive is not content progress and cannot renew a checkpoint budget. */
export async function executeDurableDirective(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableTask
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId
    || !['directive_save', 'directive_supersede'].includes(tool.name)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '作者指令缺少原任务能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const args = normalize(raw)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: 'task', targetId: lease.taskRootId, effectiveArgs: args, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, taskRootId: lease.taskRootId, args }).value })
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '作者指令不属于原任务。')
    const result = await tool.execute({ ...ctx, durableTask: undefined, transaction: tx }, args)
    if (result.outcome === 'failed') return runtimeError('DIRECTIVE_WRITE_REJECTED', result.output)
    ctx.signal.throwIfAborted()
    return runtimeJson({ toolResult: result }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['DIRECTIVE_WRITE_REJECTED', 'DIRECTIVE_NOT_FOUND', 'DIRECTIVE_CHANGED'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash,
      code: error.code, output: error.message, summary: '指令未保存' })
  })
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return { ...failed.data.toolResult, outcome: 'failed' }
  return z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }) }).parse(receipt.result).toolResult
}

/** Only this root's confirmed/reduced receipt is authoritative; the artifact is a UI copy. */
export async function readDurableTodoItems(tx: RuntimeTx, rootId: string, revision: number, pendingOperationId?: string | null) {
  const event = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: rootId, type: 'effect.committed',
    operation: { action: 'todo_write', status: 'succeeded', ...(pendingOperationId ? { id: { not: pendingOperationId } } : {}) } }, orderBy: { sequence: 'desc' }, include: { operation: { include: { effectReceipt: true } } } })
  if (!event) return []
  const operation = event.operation!, receipt = operation.effectReceipt
  if (!receipt || operation.taskRootId !== rootId || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
    || runtimeJson(receipt.result).hash !== receipt.resultHash || event.eventKey !== `effect:${operation.id}`
    || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原任务待办回执损坏，不能使用历史消息或副本覆盖。')
  const input = z.object({ input: z.object({ callId: z.string(), normalization: z.object({ sourceRevision: z.number().int().nonnegative() }) }) }).safeParse(operation.inputSnapshot)
  const result = resultSchema.safeParse(receipt.result)
  if (!input.success || !result.success || input.data.input.normalization.sourceRevision + 2 > revision) return runtimeError('RUNTIME_RECEIPT_INVALID', '待办尚未进入原执行上下文。')
  const sourceRevision = input.data.input.normalization.sourceRevision
  const pending = await readExecutionFrame(tx, rootId, sourceRevision + 1)
  const reduced = await readExecutionFrame(tx, rootId, sourceRevision + 2)
  const observation = reduced.state.messages.at(-1)
  if (pending.state.pendingOperationId !== operation.id || reduced.state.phase !== 'idle' || observation?.role !== 'tool'
    || observation.toolCallId !== input.data.input.callId || observation.content !== formatDurableToolObservation('todo_write', result.data.toolResult.output)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原待办缺少对应执行观察。')
  return result.data.todoItems
}

export async function executeDurableTodo(ctx: ToolContext, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableTask && { ...ctx.durableTask, lease: { ...ctx.durableTask.lease }, cursor: { ...ctx.durableTask.cursor } }
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '待办能力与原任务不一致。')
  const { lease, cursor } = capability
  const normalize = (value: unknown) => todoWriteTool.parameters.parse(normalizeToolInput(todoWriteTool, value))
  const args = normalize(raw)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: 'todo_write', callId: ctx.callId,
    effectDomain: 'task', targetId: lease.taskRootId, effectiveArgs: args, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, taskRootId: lease.taskRootId, args }).value }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
    const rejected = await rejectToolCursorCall(lease, cursor, ctx.callId)
    await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
    return { rejected: { ...failedToolResultSchema.parse(rejected.receipt.result).toolResult, outcome: 'failed' as const } }
  })
  if ('rejected' in prepared) return prepared.rejected
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '待办不属于原任务范围。')
    const previous = await readDurableTodoItems(tx, root.id, cursor.expectedRevision)
    const { items, changed, error } = prepareTodoUpdate(previous, args.items, args.changeReason)
    if (error) return runtimeJson({ todoItems: previous, toolResult: { outcome: 'failed', summary: '待办更新未接受', output: `${error}\n本任务实际清单：\n${renderTodoItems(previous)}`, display: { kind: 'todoList', items: previous } } }).value
    const completed = items.filter(item => item.status === 'completed').length
    const cancelled = items.filter(item => item.status === 'cancelled').length
    const progress = `${completed}/${items.length - cancelled}${cancelled ? `，${cancelled} 项已取消` : ''}`
    if (!changed) return runtimeJson({ todoItems: items, toolResult: { summary: '待办清单未变更',
      output: `待办清单未变更，不清空或覆盖原清单。仅长任务/复杂任务开工前建立至少两项真实工作；禁止为收尾补造完成项。${items.length ? `\n本任务原清单：\n${renderTodoItems(items)}` : '\n本任务没有清单；已完成请直接交付，否则继续实际工作。'}` } }).value
    const existing = await tx.agentArtifact.findFirst({ where: { artifactType: 'chapterPlan', metadata: { path: ['todoList'], equals: true },
      run: { taskRootId: root.id, userId: ctx.userId, sessionId: ctx.sessionId } }, select: { id: true } })
    const data = { content: JSON.stringify(items), summary: `待办 ${progress}`, metadata: { todoList: true, taskRootId: root.id, todoRunId: ctx.runId } }
    if (existing) await tx.agentArtifact.update({ where: { id: existing.id }, data })
    else await tx.agentArtifact.create({ data: { ...data, runId: ctx.runId, artifactType: 'chapterPlan', title: '任务待办清单' } })
    ctx.signal.throwIfAborted()
    // Todo bookkeeping is never budget/checkpoint progress or proof of completion.
    return runtimeJson({ todoItems: items, toolResult: { summary: `待办 ${progress} 已完成`,
      output: `待办清单已更新（${progress} 已完成）：\n${renderTodoItems(items)}\n${items.some(item => item.status === 'pending' || item.status === 'in_progress') ? '继续执行未完成工作；受阻应如实说明，不得假勾选。' : '请核对实际交付，不以勾选清单替代成果验证。'}`,
      display: { kind: 'todoList', items } } }).value
  })
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return resultSchema.parse(receipt.result).toolResult as ToolResult
}
