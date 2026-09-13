import { z } from 'zod'
import { DataAccessError } from '../../prisma.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import { getStructureRevisionHash } from '../../data/volume.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { readExecutionStateInTransaction } from '../runtime-state.js'
import { readObservedBaseline } from '../runtime-observed-baseline.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { normalizeToolInput } from './input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'
import { STRUCTURE_MUTATIONS, structureContentTargets } from '../runtime-common.js'
import { isAgent2FeatureEnabled } from '../../agent2-feature-flags.js'
import { enqueueChapterMemoryExtraction } from '../story-memory.js'
import { recordStoryCompilerWrite } from '../story-compiler.js'

/** DB-only structural effects and their receipt commit together. Network and
 * background model work must not be introduced into this callback. */
export async function executeDurableStructure(ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>): Promise<ToolResult> {
  const capability = ctx.durableStructure
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId
    || !STRUCTURE_MUTATIONS.some(name => name === tool.name)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '结构操作能力与原任务不一致。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }, expectedHash = capability.expectedHash
  const normalize = (raw: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, raw)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const effectiveArgs = normalize(args)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    targetId: ctx.novelId, effectDomain: 'structure', effectiveArgs, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args: effectiveArgs, expectedHash }).value }).catch(async error => {
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
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '结构操作不属于原任务。')
    const observed = await readObservedBaseline(tx, root.id, cursor.expectedRevision, { kind: 'structure', id: ctx.novelId })
    if (observed?.kind !== 'structure' || observed.hash !== expectedHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '结构基线不属于原执行观察。')
    if (await getStructureRevisionHash(tx, ctx.novelId) !== expectedHash) return runtimeError('STRUCTURE_REVISION_CONFLICT', '作品结构或章节版本已变化。本次未执行，请重新读取卷结构和目标章节后再操作。')
    for (const id of structureContentTargets(tool.name, effectiveArgs)) {
      const baseline = await readObservedBaseline(tx, root.id, cursor.expectedRevision, { kind: 'chapter', id })
      const chapter = await tx.chapter.findFirst({ where: { id, novelId: ctx.novelId } })
      if (baseline?.kind !== 'chapter' || chapter?.revision !== baseline.revision) return runtimeError('STRUCTURE_REVISION_CONFLICT', '拆分或合并所依据的正文已变化，请重新读取目标章节。')
    }
    const { configuration } = await readExecutionStateInTransaction(tx, root.id)
    const contentBefore = await tx.chapter.findMany({ where: { novelId: ctx.novelId, id: { in: structureContentTargets(tool.name, effectiveArgs) } },
      select: { id: true, title: true, content: true, revision: true, volumeId: true, orderIndex: true, orderInVolume: true } })
    const protectedQuery = { where: { novelId: ctx.novelId, id: { in: configuration.protectedChapterIds } }, orderBy: { id: 'asc' as const },
      select: { id: true, title: true, content: true, revision: true, volumeId: true, orderIndex: true, orderInVolume: true,
        volume: { select: { title: true, summary: true, orderIndex: true } } } }
    const before = await tx.chapter.findMany(protectedQuery)
    const result = await tool.execute({ ...ctx, durableStructure: undefined, transaction: tx, protectedChapterIds: new Set(configuration.protectedChapterIds) }, effectiveArgs)
    if (result.outcome === 'failed') throw new DataAccessError(409, 'STRUCTURE_TARGET_NOT_FOUND', result.output)
    if (runtimeJson(before).hash !== runtimeJson(await tx.chapter.findMany(protectedQuery)).hash) return runtimeError('AUTHOR_SCOPE_PROTECTED', '结构操作会影响受保护的正文、顺序或所属卷信息，本次未执行。')
    const memoryJobIds: string[] = []
    const affected = result.affectedChapterIds ?? []
    const contentAfter = await tx.chapter.findMany({ where: { novelId: ctx.novelId, id: { in: affected } },
      select: { id: true, title: true, content: true, revision: true, volumeId: true, orderIndex: true, orderInVolume: true } })
    if (contentAfter.length !== new Set(affected).size) return runtimeError('RUNTIME_RECEIPT_INVALID', '结构结果章节不属于当前作品。')
    for (const chapter of contentAfter) {
      const previous = contentBefore.find(item => item.id === chapter.id)?.content ?? ''
      if (previous === chapter.content) continue
      if (isAgent2FeatureEnabled('memory2', ctx.userId)) memoryJobIds.push(await enqueueChapterMemoryExtraction({ novelId: ctx.novelId, chapterId: chapter.id,
        chapterRevision: chapter.revision, before: previous, after: chapter.content }, tx))
      if (isAgent2FeatureEnabled('storyCompiler', ctx.userId)) await recordStoryCompilerWrite({ userId: ctx.userId, novelId: ctx.novelId,
        runId: ctx.runId, chapterId: chapter.id, chapterOrderIndex: chapter.orderIndex, chapterRevision: chapter.revision }, tx)
    }
    ctx.signal.throwIfAborted()
    const afterHash = await getStructureRevisionHash(tx, ctx.novelId)
    return runtimeJson({ toolResult: { ...result, observedStructure: { kind: 'structure', id: ctx.novelId, hash: afterHash } },
      contentBefore, contentAfter, memoryJobIds,
      progress: { kind: 'structure_revision', targetId: ctx.novelId, beforeHash: expectedHash, afterHash } }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['STRUCTURE_TARGET_NOT_FOUND', 'STRUCTURE_REVISION_CONFLICT', 'VOLUME_REVISION_CONFLICT', 'CHAPTER_REVISION_CONFLICT',
      'AUTHOR_SCOPE_PROTECTED', 'LAST_VOLUME_REQUIRED', 'VOLUME_NOT_EMPTY', 'VOLUME_NOT_FOUND', 'NOVEL_NOT_FOUND', 'INVALID_SPLIT_OFFSET', 'INVALID_MERGE_TARGET'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '结构操作未执行' })
  })
  const failure = failedToolResultSchema.safeParse(receipt.result)
  const result = z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result)
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return failure.success ? { ...failure.data.toolResult, outcome: 'failed' } : result.toolResult as ToolResult
}
