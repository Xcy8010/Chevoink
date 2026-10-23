import { z } from 'zod'
import { DataAccessError } from '../../prisma.js'
import { activeChapterScope } from '../../data/internal.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { prepareToolCursorOperation } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { reduceExecutionReceipt, failedToolResultSchema } from '../runtime-reducer.js'
import { normalizeToolInput } from './input-validation.js'
import { readObservedBaseline } from '../runtime-observed-baseline.js'
import { changeSetFieldHash, changeSetBaselineHash, getChangeSetData } from '../../data/changeset.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

export const CHANGESET_ACTIONS = ['bulk_replace_preview', 'entity_rename_preview', 'changeset_apply', 'changeset_rollback'] as const

/** The actual preview/apply/rollback and its original response share one DB
 * transaction. A saved preview cannot silently become a different approved edit. */
export async function executeDurableChangeSet(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableChangeSet
  if (!capability || !(CHANGESET_ACTIONS as readonly string[]).includes(tool.name)
    || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '变更集缺少原任务执行能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const args = normalize(raw)
  const preview = tool.name.endsWith('_preview')
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: preview ? 'read' : 'changeset', targetId: ctx.novelId, effectiveArgs: args, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args }).value })
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    if (!preview) {
      const baseline = await readObservedBaseline(tx, lease.taskRootId, cursor.expectedRevision, { kind: 'changeset', id: String(args.changeSetId) })
      const current = await getChangeSetData(ctx.userId, String(args.changeSetId), tx)
      if (!current || baseline?.kind !== 'changeset' || current.novelId !== ctx.novelId || changeSetBaselineHash(current) !== baseline.hash) {
        return runtimeError('CHANGESET_PREVIEW_STALE', '变更集尚未在原任务中预览，或已在预览后变化。请重新核对预览，不能沿用另一任务或旧内容的审批。')
      }
      const set = await tx.changeSet.findFirst({ where: { id: String(args.changeSetId), userId: ctx.userId, novelId: ctx.novelId }, include: { patches: true } })
      if (!set) return runtimeError('CHANGESET_TARGET_MISSING', '变更集不属于当前作品。')
      const selected = Array.isArray(args.selectedPatchIds) ? new Set(args.selectedPatchIds) : null
      for (const patch of set.patches.filter(patch => selected && tool.name === 'changeset_apply' ? selected.has(patch.id) : patch.selected)) {
        if (ctx.protectedChapterIds?.has(patch.targetId)) return runtimeError('AUTHOR_SCOPE_PROTECTED', '作者要求保留的章节不能通过变更集写入。')
      }
      if (tool.name === 'changeset_apply' && set.status !== 'applied') {
        for (const patch of set.patches.filter(patch => selected ? selected.has(patch.id) : patch.selected)) {
          const chapter = await tx.chapter.findFirst({ where: { id: patch.targetId, authorId: ctx.userId, ...activeChapterScope(ctx.novelId) } })
          const current = chapter && (patch.field === 'title' ? chapter.title : patch.field === 'summary' ? chapter.summary : patch.field === 'content' ? chapter.content : undefined)
          if (!chapter || current === undefined || chapter.revision !== patch.expectedRevision || changeSetFieldHash(current) !== patch.beforeHash) {
            return runtimeError('CHANGESET_PREVIEW_STALE', '预览后的原文已变化，请基于当前版本重新预览并确认；未把旧审批用于新的内容。')
          }
        }
      }
    }
    const result = await tool.execute({ ...ctx, durableChangeSet: undefined, transaction: tx }, args)
    if (result.outcome === 'failed') return runtimeError('CHANGESET_TARGET_MISSING', result.output)
    ctx.signal.throwIfAborted()
    return runtimeJson({ toolResult: result }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !/^(CHANGESET_|EMPTY_CHANGESET|UNSUPPORTED_CHANGESET_|INVALID_TITLE_REPLACEMENT|AUTHOR_|SCOPE_NEEDS_INPUT|IMPORT_SCOPE_CHANGED)/.test(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '变更集未应用新改动' })
  })
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return { ...failed.data.toolResult, outcome: 'failed', failureCode: failed.data.code }
  return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
