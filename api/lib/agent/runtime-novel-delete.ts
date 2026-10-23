import { randomUUID } from 'node:crypto'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { databaseNow, runtimeError, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { withManuscriptRunLease, withRunLeaseInTransaction, type RunLeaseToken } from './runtime-lease.js'
import { readToolApprovalOutcome } from './runtime-approval.js'
import { prepareToolCursorOperation, readAdmittedToolOperation, type ToolExecutionCursor } from './runtime-tool-cursor.js'
import { readExecutionFrame, readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { commitOperationEffectInTransaction } from './runtime-operations.js'
import { novelDeleteWorkSchema, novelDeleteEffectSchema, novelDeletionSchema } from './runtime-novel-delete-contract.js'
import { writeNovelDeletionArchive } from './runtime-novel-delete-archive.js'
import { readVerifiedNovelDeletion } from './runtime-novel-delete-read.js'
import { collectNovelDeletionScope } from './runtime-novel-delete-scope.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import type { AgentTool, ToolContext } from './tools/types.js'
import { normalizeToolInput } from './tools/input-validation.js'

export type NovelDeletionReady = { kind: 'deletion_ready'; operationId: string; inputHash: string; cursor: ToolExecutionCursor }

/** Prepare only. The live run and lease MUST still exist when the executor's
 * heartbeat unwinds. Model arguments never transport this internal contract. */
export async function prepareNovelDeletion(token: RunLeaseToken, cursor: ToolExecutionCursor, ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>): Promise<NovelDeletionReady> {
  token = { ...token }; cursor = { ...cursor }
  if (ctx.userId !== token.userId || ctx.runId !== token.runId || tool.name !== 'novel_delete' || token.parent) return runtimeError('RUNTIME_SCOPE_MISMATCH', '删除必须由原作者任务执行，不能由子任务代行。')
  return withManuscriptRunLease(token, async tx => {
    ctx.signal.throwIfAborted()
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    const origin = await readExecutionFrame(tx, token.taskRootId, cursor.expectedRevision)
    if (origin.snapshotHash !== cursor.expectedHash || origin.state.phase !== 'idle') return runtimeError('RUNTIME_STATE_CONFLICT', '删除必须绑定原始调用位置。')
    const key = `exec:${origin.state.nextOperationSequence}`
    const old = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: token.taskRootId, operationKey: key } } })
    if (old) {
      const admitted = await readAdmittedToolOperation(token, { operationId: old.id, action: 'novel_delete', novelId: ctx.novelId, callId: ctx.callId }, tx)
      novelDeleteWorkSchema.parse(admitted.input.work)
      if (admitted.operation.status !== 'prepared' || current.frame.state.pendingOperationId !== old.id) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原删除须先核对真实终态。')
      return { kind: 'deletion_ready', operationId: old.id, inputHash: old.inputHash,
        cursor: { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash } }
    }
    const frame = current.frame, spec = taskSpecSchema.parse(current.originalSpec)
    if (frame.revision !== cursor.expectedRevision || frame.snapshotHash !== cursor.expectedHash || frame.state.phase !== 'idle'
      || spec.scope.selection || spec.postconditions.some(item => item.code === 'EARLIER_CONTENT_UNCHANGED')) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '当前范围或执行位置不允许删除整部作品。')
    const novel = await tx.novel.findFirst({ where: { id: ctx.novelId, authorId: token.userId }, select: { title: true, displayTitle: true } })
    if (!novel || args.confirmTitle !== (novel.displayTitle?.trim() || novel.title)) return runtimeError('RUNTIME_DELETE_TITLE_MISMATCH', '确认书名与当前作品不一致，未删除。')
    const call = frame.state.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : []).reverse().find(call => call.id === ctx.callId)
    if (!call) return runtimeError('RUNTIME_STATE_CONFLICT', '删除缺少原工具调用。')
    const approval = await readToolApprovalOutcome(tx, token, frame.snapshotHash, call.id, 'novel_delete', call.arguments)
    if (approval?.status !== 'approved' || !approval.decision) return runtimeError('RUNTIME_APPROVAL_REQUIRED', '删除必须有本次原始调用的明确确认。')
    const work = novelDeleteWorkSchema.parse({ version: 1, userId: token.userId, taskRootId: token.taskRootId, originRunId: token.runId,
      sessionId: ctx.sessionId, novelId: ctx.novelId, title: novel.title, displayTitle: novel.displayTitle, confirmTitle: args.confirmTitle,
      approval: { requestId: approval.request.id, requestHash: runtimeJson(approval.request.payload).hash,
        decisionId: approval.decision.id, decisionHash: runtimeJson(approval.decision.payload).hash } })
    const prepared = await prepareToolCursorOperation(token, cursor, { key, action: 'novel_delete', callId: ctx.callId, targetId: token.taskRootId,
      effectDomain: 'deletion', requireApproval: true, effectiveArgs: args,
      normalize: raw => tool.parameters.parse(normalizeToolInput(tool, raw)), operationInput: runtimeJson({ novelId: ctx.novelId, callId: ctx.callId, args, work }).value }, tx)
    return { kind: 'deletion_ready', operationId: prepared.operation.id, inputHash: prepared.operation.inputHash,
      cursor: { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash } }
  })
}

/** Outside the heartbeat. Every effect below commits atomically or rolls back,
 * including the original receipt, retained accounting and actual manuscript
 * deletion. A lost response is reconciled from the authenticated tombstone. */
export async function commitNovelDeletion(token: RunLeaseToken, ready: NovelDeletionReady, signal: AbortSignal) {
  token = { ...token }; ready = { ...ready, cursor: { ...ready.cursor } }
  return runtimeTransaction(async tx => {
    const reconciled = await readVerifiedNovelDeletion(tx, token.userId, token.runId)
    if (reconciled) {
      if (reconciled.deletion.taskRootId !== token.taskRootId || reconciled.deletion.operationId !== ready.operationId
        || reconciled.deletion.inputHash !== ready.inputHash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '已提交删除与原操作不一致。')
      return { kind: 'novel_deleted' as const, deletion: reconciled.deletion }
    }
    signal.throwIfAborted()
    // Same admission lock/order as enqueue and queue claim. A saved author
    // request without a run cannot appear between the scope check and purge.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-admission:${token.userId}`}, 0))::text`
    const root = await tx.agentTaskRoot.findFirst({ where: { id: token.taskRootId, userId: token.userId } })
    if (!root) return runtimeError('RUNTIME_SCOPE_MISMATCH', '原删除任务不存在。')
    await lockNovelActiveScope(tx, root.novelId)
    await (await import('./writing-scope.js')).lockWritingRunLineage(tx, { userId: token.userId, novelId: root.novelId, runId: token.runId })
    const prepared = await withRunLeaseInTransaction(tx, token, async () => {
      if (token.parent) return runtimeError('RUNTIME_DELETE_RECONCILIATION_REQUIRED', '子任务不能删除作品。')
      const state = await readExecutionStateInTransaction(tx, root.id), pending = state.frame
      if (pending.revision !== ready.cursor.expectedRevision || pending.snapshotHash !== ready.cursor.expectedHash
        || pending.state.phase !== 'awaiting_operation' || pending.state.pendingOperationId !== ready.operationId) return runtimeError('RUNTIME_STATE_CONFLICT', '删除不是当前待执行操作。')
      const operation = await tx.agentOperation.findUniqueOrThrow({ where: { id: ready.operationId } })
      if (operation.taskRootId !== root.id || operation.kind !== 'tool' || operation.action !== 'novel_delete'
        || operation.status !== 'prepared' || operation.inputHash !== ready.inputHash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '删除原操作不一致。')
      const source = await readAdmittedToolOperation(token, { operationId: operation.id, action: 'novel_delete', novelId: root.novelId,
        callId: String((operation.inputSnapshot as { input?: { callId?: unknown } })?.input?.callId ?? '') }, tx)
      const work = novelDeleteWorkSchema.parse(source.input.work), spec = taskSpecSchema.parse(state.originalSpec)
      const novel = await tx.novel.findFirst({ where: { id: root.novelId, authorId: token.userId }, select: { title: true, displayTitle: true } })
      if (!novel || work.userId !== token.userId || work.taskRootId !== root.id || work.novelId !== root.novelId || work.sessionId !== root.sessionId
        || work.originRunId !== operation.originRunId || work.confirmTitle !== source.input.args.confirmTitle || novel.title !== work.title
        || novel.displayTitle !== work.displayTitle || work.confirmTitle !== (novel.displayTitle?.trim() || novel.title)
        || spec.scope.selection || spec.postconditions.some(item => item.code === 'EARLIER_CONTENT_UNCHANGED')) return runtimeError('RUNTIME_DELETE_TITLE_MISMATCH', '作品身份、范围或确认书名已变化，未删除。')
      const approval = await readToolApprovalOutcome(tx, token, source.input.normalization.sourceSnapshotHash, source.input.callId,
        'novel_delete', source.input.normalization.rawArguments)
      if (approval?.status !== 'approved' || !approval.decision || approval.request.id !== work.approval.requestId
        || runtimeJson(approval.request.payload).hash !== work.approval.requestHash || approval.decision.id !== work.approval.decisionId
        || runtimeJson(approval.decision.payload).hash !== work.approval.decisionHash) return runtimeError('RUNTIME_APPROVAL_REQUIRED', '原删除确认不一致，未删除。')
      const scope = await collectNovelDeletionScope(tx, token, root.novelId, operation.id)
      const archive = await writeNovelDeletionArchive(tx, { taskRootId: root.id, operationId: operation.id, inputHash: operation.inputHash, runId: token.runId }, scope.rows)
      const output = `作品《${work.confirmTitle}》已永久删除，原费用与执行证据保留。`, summary = `删除《${work.confirmTitle}》`
      const usage = await tx.agentProviderUsageReceipt.aggregate({ where: { attempt: { operation: { taskRootId: root.id } } }, _sum: { promptTokens: true, completionTokens: true } })
      const promptTokens = usage._sum.promptTokens ?? 0, completionTokens = usage._sum.completionTokens ?? 0
      const result = novelDeleteEffectSchema.parse({ toolResult: { output, summary }, deleted: { version: 1, userId: token.userId,
        taskRootId: root.id, runId: token.runId, novelId: root.novelId, workHash: runtimeJson(work).hash,
        source: { revision: pending.revision, hash: pending.snapshotHash }, archive, chapterCount: scope.chapters.length, runCount: scope.runs.length,
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, durationMs: Math.max(0, (await databaseNow(tx)).getTime() - operation.createdAt.getTime()) } })
      signal.throwIfAborted()
      const receipt = await commitOperationEffectInTransaction(tx, token, operation.id, operation.inputHash, async () => runtimeJson(result).value)
      const terminal = await saveExecutionStateInTransaction(tx, token, { ...ready.cursor, snapshot: { ...pending.state, phase: 'completed', pendingOperationId: null,
        messages: [...pending.state.messages, { role: 'tool', toolCallId: source.input.callId, content: output }, { role: 'assistant', content: output }] } })
      const held = await tx.agentRunLease.findUniqueOrThrow({ where: { runId: token.runId } })
      const deletion = novelDeletionSchema.parse({ ...result.deleted, operationId: operation.id, inputHash: operation.inputHash, sessionId: root.sessionId,
        receiptHash: receipt.resultHash, terminal: { revision: terminal.revision, hash: terminal.snapshotHash },
        messageId: `nd-${runtimeJson({ operationId: operation.id }).hash.slice(0, 48)}`, callId: source.input.callId, output, summary, committedAt: (await databaseNow(tx)).toISOString() })
      return { held, deletion, runIds: scope.runs.map(run => run.id) }
    })
    // The ordinary pre/post lease fence has completed while its live row exists.
    // Keep all row locks until the purge and final expiry/cancellation checks.
    const { purgeNovelDataInTransaction } = await import('../data-access.js')
    const counts = await purgeNovelDataInTransaction(tx, root.novelId, token.userId, true)
    if (counts.chapterCount !== prepared.deletion.chapterCount || counts.runCount !== prepared.deletion.runCount) return runtimeError('RUNTIME_STATE_CONFLICT', '删除范围在提交前变化，已回滚。')
    await tx.agentTaskRoot.update({ where: { id: root.id }, data: { status: 'completed' } })
    const payload = runtimeJson(prepared.deletion)
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: token.runId, operationId: ready.operationId,
      eventKey: `novel-delete:${ready.operationId}`, type: 'novel.deletion.committed', payload: payload.value } })
    for (const runId of prepared.runIds) await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId, operationId: ready.operationId,
      eventKey: `novel-deleted-run:${runId}`, type: 'novel.deletion.run', payload: { version: 1, userId: token.userId, runId,
        operationId: ready.operationId, inputHash: ready.inputHash, deletionHash: payload.hash } } })
    signal.throwIfAborted()
    if (!prepared.held.expiresAt || prepared.held.expiresAt <= await databaseNow(tx)) return runtimeError('RUNTIME_LEASE_LOST', '删除提交前原执行所有权已过期，已回滚。')
    return { kind: 'novel_deleted' as const, deletion: prepared.deletion }
  }, { signal })
}
