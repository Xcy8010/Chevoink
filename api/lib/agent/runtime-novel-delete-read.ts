import { z } from 'zod'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readToolOperationSource } from './runtime-tool-cursor.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'
import { recordedToolApprovalRequestSchema, recordedToolApprovalDecisionSchema } from './runtime-approval.js'
import { novelDeleteWorkSchema, novelDeleteEffectSchema, novelDeletionRunIndexSchema, novelDeletionSchema } from './runtime-novel-delete-contract.js'
import { readNovelDeletionArchive } from './runtime-novel-delete-archive.js'

/** Read-only authentication of an already committed deletion. A missing live
 * run/novel alone is never success. No lease is fabricated and no approval,
 * completion event, wallet entry or provider operation is created here. */
export async function readVerifiedNovelDeletion(tx: RuntimeTx, userId: string, runId: string) {
  try { return await read(tx, userId, runId) }
  catch (error) {
    if (error instanceof z.ZodError) return runtimeError('RUNTIME_RECEIPT_INVALID', '原作品删除回执格式无效。')
    throw error
  }
}

async function read(tx: RuntimeTx, userId: string, runId: string) {
  const indexEvent = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `novel-deleted-run:${runId}` } })
  if (!indexEvent) return null
  const root = await tx.agentTaskRoot.findUnique({ where: { id: indexEvent.taskRootId } })
  // Do not parse or expose another owner's private historical data.
  if (!root || root.userId !== userId) return null
  const index = novelDeletionRunIndexSchema.parse(indexEvent.payload)
  if (indexEvent.type !== 'novel.deletion.run' || indexEvent.runId !== runId || indexEvent.operationId !== index.operationId
    || index.userId !== userId || index.runId !== runId || root.status !== 'completed') return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除任务索引无效。')
  const operation = await tx.agentOperation.findUnique({ where: { id: index.operationId }, include: { effectReceipt: true } })
  const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `novel-delete:${index.operationId}` } })
  if (!operation || operation.taskRootId !== root.id || operation.kind !== 'tool' || operation.action !== 'novel_delete' || operation.status !== 'succeeded'
    || operation.inputHash !== index.inputHash || !operation.effectReceipt || !event || event.taskRootId !== root.id || event.operationId !== operation.id
    || event.type !== 'novel.deletion.committed' || runtimeJson(event.payload).hash !== index.deletionHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除缺少真实效果与终态来源。')
  const deletion = novelDeletionSchema.parse(event.payload), receipt = operation.effectReceipt, effect = novelDeleteEffectSchema.parse(receipt.result)
  if (deletion.userId !== userId || deletion.taskRootId !== root.id || deletion.novelId !== root.novelId || deletion.sessionId !== root.sessionId
    || deletion.operationId !== operation.id || deletion.inputHash !== operation.inputHash || deletion.runId !== receipt.runId || deletion.runId !== event.runId
    || runtimeJson(receipt.result).hash !== receipt.resultHash || deletion.receiptHash !== receipt.resultHash
    || runtimeJson(effect.deleted).hash !== runtimeJson({ version: 1, userId, taskRootId: root.id, runId: deletion.runId, novelId: deletion.novelId,
      workHash: deletion.workHash, source: deletion.source, archive: deletion.archive, chapterCount: deletion.chapterCount, runCount: deletion.runCount,
      usage: deletion.usage, durationMs: deletion.durationMs }).hash
    || effect.toolResult.output !== deletion.output || effect.toolResult.summary !== deletion.summary) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除回执与终态不一致。')
  const committed = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${operation.id}` } })
  if (!committed || committed.type !== 'effect.committed' || committed.taskRootId !== root.id || committed.operationId !== operation.id || committed.runId !== deletion.runId
    || runtimeJson(committed.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除效果事件缺失。')
  const source = await readToolOperationSource(tx, operation), work = novelDeleteWorkSchema.parse(source.input.work)
  if (runtimeJson(work).hash !== deletion.workHash || source.input.novelId !== root.novelId || work.novelId !== root.novelId
    || work.userId !== userId || work.taskRootId !== root.id || work.originRunId !== operation.originRunId || work.sessionId !== root.sessionId
    || source.input.args.confirmTitle !== work.confirmTitle || work.confirmTitle !== (work.displayTitle?.trim() || work.title)
    || deletion.callId !== source.input.callId) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除缺少一致的作品、标题与调用身份。')
  const requestEvent = await tx.agentExecutionOutbox.findUnique({ where: { id: work.approval.requestId } })
  const decisionEvent = await tx.agentExecutionOutbox.findUnique({ where: { id: work.approval.decisionId } })
  if (!requestEvent || !decisionEvent || requestEvent.taskRootId !== root.id || requestEvent.type !== 'approval.requested'
    || requestEvent.eventKey !== `approval:${root.id}:${runtimeJson({ sourceHash: source.source.snapshotHash, callId: source.input.callId }).hash}`
    || decisionEvent.taskRootId !== root.id || decisionEvent.type !== 'approval.resolved' || decisionEvent.eventKey !== `approval-decision:${requestEvent.id}`
    || runtimeJson(requestEvent.payload).hash !== work.approval.requestHash || runtimeJson(decisionEvent.payload).hash !== work.approval.decisionHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除的明确确认来源缺失。')
  const request = recordedToolApprovalRequestSchema.parse(requestEvent.payload), decision = recordedToolApprovalDecisionSchema.parse(decisionEvent.payload)
  if (!decision.approved || decision.timedOut || decision.userId !== userId || decision.requestId !== requestEvent.id || decision.requestHash !== work.approval.requestHash
    || request.toolName !== 'novel_delete' || request.callId !== source.input.callId || request.sourceRevision !== source.source.revision || request.sourceHash !== source.source.snapshotHash
    || request.rawArguments !== source.input.normalization.rawArguments || request.argsHash !== source.input.normalization.normalizedArgsHash
    || runtimeJson(request.args).hash !== request.argsHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原确认未覆盖此次删除。')
  const pending = await readExecutionFrame(tx, root.id, deletion.source.revision), state = await readExecutionStateInTransaction(tx, root.id)
  const grant = state.configuration.toolAuthority.find(item => item.name === 'novel_delete')
  if (state.configuration.mode !== 'build' || !grant || grant.permission === 'deny'
    || !state.configuration.tools.some(tool => tool.function.name === 'novel_delete')) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除不在冻结工具授权内。')
  if (pending.revision !== source.source.revision + 1 || pending.snapshotHash !== deletion.source.hash || pending.state.phase !== 'awaiting_operation' || pending.state.pendingOperationId !== operation.id
    || state.frame.revision !== pending.revision + 1 || state.frame.revision !== deletion.terminal.revision || state.frame.snapshotHash !== deletion.terminal.hash
    || state.frame.state.phase !== 'completed') return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除终态没有连续的持久执行位置。')
  const terminal = state.frame.state, toolMessage = terminal.messages.at(-2), finalMessage = terminal.messages.at(-1)
  if (terminal.messages.length !== pending.state.messages.length + 2 || terminal.turn !== pending.state.turn
    || terminal.nextOperationSequence !== pending.state.nextOperationSequence || terminal.checkpointIndex !== pending.state.checkpointIndex
    || runtimeJson(terminal.messages.slice(0, -2)).hash !== runtimeJson(pending.state.messages).hash
    || toolMessage?.role !== 'tool' || toolMessage.toolCallId !== deletion.callId || toolMessage.content !== deletion.output
    || finalMessage?.role !== 'assistant' || finalMessage.content !== deletion.output || finalMessage.toolCalls?.length) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除终态与真实工具结果不一致。')
  const rows = await readNovelDeletionArchive(tx, deletion), runs = rows.filter(row => row.kind === 'run')
  const run = runs.find(row => row.id === runId)
  if (!run || runs.length !== deletion.runCount || runs.some(row => row.userId !== userId || row.novelId !== root.novelId)
    || !runs.some(row => row.id === deletion.runId && row.taskRootId === root.id && row.sessionId === root.sessionId)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除账务任务归属不完整。')
  if (await tx.novel.findUnique({ where: { id: root.novelId }, select: { id: true } }) || await tx.agentRun.findUnique({ where: { id: runId }, select: { id: true } })) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原删除后置条件尚未核实。')
  return { deletion, work, run, rows, source }
}
