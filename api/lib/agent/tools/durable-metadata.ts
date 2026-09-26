import { z } from 'zod'
import { DataAccessError } from '../../prisma.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { readObservedBaseline } from '../runtime-observed-baseline.js'
import { prepareToolCursorOperation } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { reduceExecutionReceipt, failedToolResultSchema } from '../runtime-reducer.js'
import { normalizeToolInput } from './input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'
import { getStoryCharterBundle } from '../story-compiler.js'
import { applyCoverSelection, prepareCoverSelection } from './cover-application.js'

export const METADATA_ACTIONS = ['cover_apply', 'session_rename', 'novel_rename', 'novel_update_meta', 'cover_prompt_set', 'story_charter_save', 'reader_promise_save', 'reader_promise_update'] as const
export const storyCharterHash = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value))).hash
export const novelMetadataHash = (value: { title: string; displayTitle: string | null; summary: string; tagNames: string[]; coverPrompt: string | null }) =>
  runtimeJson({ title: value.title, displayTitle: value.displayTitle, summary: value.summary, tagNames: value.tagNames, coverPrompt: value.coverPrompt }).hash

/** The original metadata tools execute DB-only inside the effect transaction. */
export async function executeDurableMetadata(ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>): Promise<ToolResult> {
  const capability = ctx.durableMetadata
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId
    || !(METADATA_ACTIONS as readonly string[]).includes(tool.name)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '作品设置缺少原任务能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (raw: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, raw)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const effective = normalize(args)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: 'metadata', targetId: lease.taskRootId, normalize, effectiveArgs: effective,
    operationInput: runtimeJson({ callId: ctx.callId, args: effective }).value })
  const receipt = await (async () => {
    const cover = tool.name === 'cover_apply' ? await prepareCoverSelection(ctx, effective) : null
    return commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '作品设置不属于原任务。')
    if (cover) return runtimeJson({ toolResult: await applyCoverSelection(ctx, cover, tx) }).value
    if (tool.name === 'session_rename') {
      const result = await tool.execute({ ...ctx, durableMetadata: undefined, transaction: tx }, effective)
      ctx.signal.throwIfAborted()
      return runtimeJson({ toolResult: result }).value
    }
    const target = await tx.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId } })
    const charterWrite = ['story_charter_save', 'reader_promise_save', 'reader_promise_update'].includes(tool.name)
    const kind = charterWrite ? 'charter' as const : 'novel' as const
    const baseline = await readObservedBaseline(tx, root.id, cursor.expectedRevision, { kind, id: ctx.novelId })
    const currentHash = charterWrite ? storyCharterHash(await getStoryCharterBundle(ctx.userId, ctx.novelId, tx, true))
      : target ? novelMetadataHash(target) : null
    if (!target || (baseline?.kind !== 'novel' && baseline?.kind !== 'charter') || baseline.kind !== kind || baseline.hash !== currentHash) {
      return runtimeError('METADATA_BASELINE_REQUIRED', charterWrite ? '创作宪章已变化或尚未读取，请先读取当前宪章再保存。' : '作品设置已变化或尚未读取，请先读取最新作品上下文再修改。')
    }
    const result = await tool.execute({ ...ctx, durableMetadata: undefined, transaction: tx }, effective)
    if (result.outcome === 'failed') return runtimeError('METADATA_WRITE_REJECTED', result.output)
    const savedHash = charterWrite ? storyCharterHash(await getStoryCharterBundle(ctx.userId, ctx.novelId, tx, true))
      : novelMetadataHash(await tx.novel.findUniqueOrThrow({ where: { id: target.id } }))
    ctx.signal.throwIfAborted()
    return runtimeJson({ toolResult: { ...result, summary: result.summary ?? '作品设置已处理',
      observedState: { kind, id: target.id, hash: savedHash } } }).value
    })
  })().catch(async error => {
    if (!(error instanceof DataAccessError) || !['COVER_ASSET_NOT_FOUND', 'COVER_ATTACHMENT_SCOPE', 'COVER_ATTACHMENT_SIZE', 'COVER_ATTACHMENT_INVALID', 'NOVEL_NOT_FOUND', 'METADATA_BASELINE_REQUIRED', 'METADATA_WRITE_REJECTED', 'READER_PROMISE_NOT_FOUND', 'PAYOFF_CHAPTER_REQUIRED'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '作品设置未修改' })
  })
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return { ...failed.data.toolResult, outcome: 'failed' }
  return z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
