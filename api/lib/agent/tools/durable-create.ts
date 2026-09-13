import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../../prisma.js'
import { activeChapterScope, activeVolumeWhere } from '../../data/internal.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { readExecutionStateInTransaction } from '../runtime-state.js'
import type { ToolContext, ToolResult } from './types.js'

/** Creation, layout, stats and receipt share one transaction. No process-local
 * "last created chapter" state can authorize a replay. */
export async function executeDurableCreate(ctx: ToolContext, args: { title: string }, normalize: (raw: unknown) => unknown,
  create: (tx: Prisma.TransactionClient) => Promise<ToolResult>, action: 'chapter_create' | 'volume_create' = 'chapter_create'): Promise<ToolResult> {
  const capability = ctx.durableCreate
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '创建能力与原任务不一致。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const effectiveArgs = runtimeJson(normalize(args)).value
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action, callId: ctx.callId,
    targetId: ctx.novelId, effectDomain: 'structure', effectiveArgs, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args: effectiveArgs }).value }).catch(async error => {
      if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
      const rejected = await rejectToolCursorCall(lease, cursor, ctx.callId)
      await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
      return { rejected: { ...failedToolResultSchema.parse(rejected.receipt.result).toolResult, outcome: 'failed' as const } }
    })
  if ('rejected' in prepared) return prepared.rejected
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    await assertAgentManuscriptCurrent(tx, ctx)
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '创建目标不属于原任务。')
    if (!await tx.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId } })) return runtimeError('NOVEL_NOT_FOUND', '作品不存在或无权修改其卷章结构。')
    const previous = await tx.agentOperation.findFirst({ where: { taskRootId: lease.taskRootId, action, status: 'succeeded',
      inputSnapshot: { path: ['input', 'args', 'title'], equals: args.title.trim() } }, include: { effectReceipt: true } })
    if (previous) {
      const oldReceipt = previous.effectReceipt
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${previous.id}` } })
      if (!oldReceipt || !previous.inputSnapshot || runtimeJson(previous.inputSnapshot).hash !== previous.inputHash || runtimeJson(oldReceipt.result).hash !== oldReceipt.resultHash
        || !event || event.taskRootId !== lease.taskRootId || event.type !== 'effect.committed'
        || runtimeJson(event.payload).hash !== runtimeJson({ operationId: previous.id, resultHash: oldReceipt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原创建回执损坏。')
      const result = z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(oldReceipt.result)
      const observed = z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('chapter'), id: z.string() }),
        z.object({ kind: z.literal('volume'), id: z.string() }),
      ]).safeParse(result.toolResult.observedState)
      const active = observed.success && (observed.data.kind === 'chapter'
        ? await tx.chapter.findFirst({ where: { id: observed.data.id, authorId: ctx.userId, ...activeChapterScope(ctx.novelId) } })
        : await tx.volume.findFirst({ where: { id: observed.data.id, novelId: ctx.novelId, ...activeVolumeWhere } }))
      if (!active) return runtimeError('AUTHOR_SCOPE_PROTECTED', '原创建结果已归档或不存在，不能复用旧回执或在新稿中自动重建。')
      return runtimeJson({ toolResult: { ...result.toolResult, summary: `复用本任务已创建${action === 'chapter_create' ? '章节' : '卷'}《${args.title.trim()}》` } }).value
    }
    const protectedIds = (await readExecutionStateInTransaction(tx, lease.taskRootId)).configuration.protectedChapterIds
    const before = await tx.chapter.findMany({ where: { novelId: ctx.novelId, id: { in: protectedIds } }, orderBy: { id: 'asc' }, select: { id: true, volumeId: true, orderIndex: true, orderInVolume: true, volume: { select: { orderIndex: true } } } })
    if (await tx.chapter.count({ where: { ...activeChapterScope(ctx.novelId), id: { in: protectedIds } } }) !== new Set(protectedIds).size) {
      return runtimeError('AUTHOR_SCOPE_PROTECTED', '原任务保护的章节已归档或不存在，请在当前稿件建立新任务。')
    }
    const result = await create(tx)
    const after = await tx.chapter.findMany({ where: { novelId: ctx.novelId, id: { in: protectedIds } }, orderBy: { id: 'asc' }, select: { id: true, volumeId: true, orderIndex: true, orderInVolume: true, volume: { select: { orderIndex: true } } } })
    if (runtimeJson(before).hash !== runtimeJson(after).hash) return runtimeError('AUTHOR_SCOPE_PROTECTED', '不能通过新建卷章改动受保护章节的顺序或所在卷序号。')
    const observed = result.observedState
    if (action === 'volume_create') {
      if (observed?.kind !== 'volume' || !await tx.volume.findFirst({ where: { id: observed.id, novelId: ctx.novelId, ...activeVolumeWhere, revision: observed.revision } })) return runtimeError('RUNTIME_RECEIPT_INVALID', '创建结果没有对应的卷基线。')
      ctx.signal.throwIfAborted()
      return runtimeJson({ toolResult: result }).value
    }
    if (observed?.kind !== 'chapter') return runtimeError('RUNTIME_RECEIPT_INVALID', '创建结果缺少章节基线。')
    const target = await tx.chapter.findFirst({ where: { id: observed.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId } })
    if (!target || target.revision !== observed.revision) return runtimeError('RUNTIME_RECEIPT_INVALID', '创建结果没有对应的章节基线。')
    ctx.signal.throwIfAborted()
    const memoryJob = await tx.memoryExtractionJob.findUnique({ where: { idempotencyKey: `${target.id}:${target.revision}` }, select: { id: true } })
    return runtimeJson({ toolResult: result, memoryJobId: memoryJob?.id ?? null, ...(target.content ? { progress: { kind: 'content_revision', targetId: target.id,
      beforeHash: runtimeJson({ content: '' }).hash, afterHash: runtimeJson({ content: target.content }).hash } } : {}) }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['VOLUME_NOT_FOUND', 'NOVEL_NOT_FOUND', 'AUTHOR_SCOPE_PROTECTED'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: action === 'chapter_create' ? '章节创建未执行' : '卷创建未执行' })
  })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  const result = z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result)
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return failed.success ? { ...failed.data.toolResult, outcome: 'failed' } : result.toolResult as ToolResult
}
