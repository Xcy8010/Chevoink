import { z } from 'zod'
import { isAgent2FeatureEnabled } from '../../agent2-feature-flags.js'
import { assertCraftOutputSafe } from '../craft-library.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { commitOperationEffect, prepareOperation, recordToolFailure } from '../runtime-operations.js'
import { recordChapterBaseline } from '../baseline.js'
import { enqueueChapterMemoryExtraction } from '../story-memory.js'
import { recordStoryCompilerWrite } from '../story-compiler.js'
import { activeChapterScope, recalculateNovelStats } from '../../data/internal.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import type { ToolContext, ToolResult, AgentTool } from './types.js'
import { chapterWriteArguments, chapterAppendArguments, chapterEditArguments } from './chapter-arguments.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { reduceExecutionReceipt, failedToolResultSchema } from '../runtime-reducer.js'
import { DataAccessError } from '../../prisma.js'

type Action = 'chapter_write' | 'chapter_append' | 'chapter_edit_range'

export async function executeDurableChapterRename(ctx: ToolContext, tool: AgentTool, input: Record<string, unknown>): Promise<ToolResult> {
  const capability = ctx.durableContent && { ...ctx.durableContent, lease: { ...ctx.durableContent.lease },
    ...(ctx.durableContent.cursor ? { cursor: { ...ctx.durableContent.cursor } } : {}) }
  if (!capability?.cursor || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId || tool.name !== 'chapter_rename') return runtimeError('RUNTIME_SCOPE_MISMATCH', '章节改名缺少原始写入位置。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (raw: unknown) => {
    const parsed = tool.parameters.parse(raw) as { chapterId?: string; title: string }
    return { chapterId: parsed.chapterId?.trim() || capability.chapterId, title: parsed.title }
  }
  const args = normalize(input)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    targetId: capability.chapterId, normalize, effectiveArgs: args,
    operationInput: runtimeJson({ callId: ctx.callId, args, expectedRevision: capability.expectedRevision }).value })
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    await assertAgentManuscriptCurrent(tx, ctx)
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId || args.chapterId !== capability.chapterId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '章节改名范围与原任务不符。')
    const chapter = await tx.chapter.findFirst({ where: { id: args.chapterId, ...activeChapterScope(ctx.novelId), authorId: ctx.userId } })
    if (!chapter || chapter.revision !== capability.expectedRevision) return runtimeError('CHAPTER_REVISION_CONFLICT', '章节已变化或归档，请重新读取当前章节后改名。')
    const title = args.title.trim()
    if (!title) return runtimeError('CHAPTER_RENAME_INVALID', '章节标题不能为空。')
    const revision = chapter.revision + (chapter.title === title ? 0 : 1)
    if (revision !== chapter.revision) {
      const updated = await tx.chapter.updateMany({
        where: { id: chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId, revision: capability.expectedRevision },
        data: { title, revision: { increment: 1 } },
      })
      if (updated.count !== 1) runtimeError('CHAPTER_REVISION_CONFLICT', '章节已变化或归档，改名未执行。')
      await recalculateNovelStats(tx, ctx.novelId)
    }
    return runtimeJson({ renamedChapter: { id: chapter.id, title, content: chapter.content, revision },
      toolResult: { output: `已把章节《${chapter.title}》重命名为《${title}》。`, summary: `章节改名《${title}》`,
        observedState: { kind: 'chapter', id: chapter.id, revision },
        snapshot: { target: 'chapter', targetId: chapter.id, field: 'title', previousValue: chapter.title } } }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['CHAPTER_REVISION_CONFLICT', 'CHAPTER_RENAME_INVALID'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '章节未改名' })
  })
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return { ...failed.data.toolResult, outcome: 'failed' }
  return z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
const argsSchema = z.object({ chapterId: z.string().min(1).max(64), content: z.string().min(1).optional(),
  oldText: z.string().optional(), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(), newText: z.string().optional() }).strict()
const resultSchema = z.object({
  toolResult: z.object({ output: z.string(), summary: z.string(), display: z.object({ kind: z.literal('chapterDiff'), chapterId: z.string(),
    chapterTitle: z.string(), before: z.string(), after: z.string(), appliedDirectly: z.literal(true), revision: z.number().int().positive() }),
  snapshot: z.object({ target: z.literal('chapter'), targetId: z.string(), field: z.literal('content'), previousValue: z.string() }) }),
  memoryJobId: z.string().nullable(),
})

/** Same actual chapter tools, opt-in durable admission. Stable request replay never appends twice. */
export async function executeDurableChapter(ctx: ToolContext, action: Action, input: unknown): Promise<ToolResult> {
  ctx = { ...ctx, protectedChapterIds: new Set(ctx.protectedChapterIds), toolAuthority: new Map(ctx.toolAuthority) }
  const capability = ctx.durableContent && { ...ctx.durableContent, lease: { ...ctx.durableContent.lease },
    ...(ctx.durableContent.cursor ? { cursor: { ...ctx.durableContent.cursor } } : {}) }
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '正文执行能力与任务身份不一致。')
  const lease = { ...capability.lease }, expectedRevision = capability.expectedRevision
  const grant = ctx.toolAuthority?.get(action)
  // A cursor-bound approval is checked against the frozen grant before preparation.
  // Legacy capabilities without a cursor cannot inherit that approval.
  if (ctx.mode !== 'build' || !grant || grant.permission === 'deny'
    || (!capability.cursor && (grant.permission !== 'allow' || grant.alwaysConfirm))) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '正文写入需要有效的服务端授权。')
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) runtimeError('RUNTIME_INPUT_INVALID', '缺少原始章节版本。')
  const parsed = argsSchema.safeParse(input)
  if (!parsed.success) return runtimeError('RUNTIME_INPUT_INVALID', '正文工具参数无效。')
  const args = parsed.data
  if (args.chapterId !== capability.chapterId) runtimeError('RUNTIME_SCOPE_MISMATCH', '正文目标与冻结的执行授权不一致。')
  if (ctx.protectedChapterIds?.has(args.chapterId)) runtimeError('AUTHOR_SCOPE_PROTECTED', '作者要求保持不变的章节不能写入。')
  ctx.signal.throwIfAborted()
  const candidate = action === 'chapter_edit_range' ? args.newText : args.content
  if (candidate === undefined) runtimeError('RUNTIME_INPUT_INVALID', '正文内容缺失。')
  if (isAgent2FeatureEnabled('craftLibrary', ctx.userId) && candidate.trim().length >= 80) {
    await assertCraftOutputSafe({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: args.chapterId, content: candidate })
  }
  const effectiveArgs = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
  const operationInput = runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, chapterId: args.chapterId, expectedRevision, args: effectiveArgs }).value
  const prepared = capability.cursor ? await prepareToolCursorOperation(lease, capability.cursor, { key: capability.operationKey, action,
    requireApproval: grant!.permission === 'ask' || grant!.alwaysConfirm,
    callId: ctx.callId, targetId: args.chapterId, operationInput, effectiveArgs, normalize: raw => {
      const schema = action === 'chapter_write' ? chapterWriteArguments : action === 'chapter_append' ? chapterAppendArguments : chapterEditArguments
      const parsed = schema.parse(raw)
      return Object.fromEntries(Object.entries({ ...parsed, chapterId: parsed.chapterId?.trim() || capability.chapterId }).filter(([, value]) => value !== undefined))
    } }).catch(async error => {
      if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
      const rejected = await rejectToolCursorCall(lease, capability.cursor!, ctx.callId)
      const failure = failedToolResultSchema.parse(rejected.receipt.result)
      await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
      return { rejected: { ...failure.toolResult, outcome: 'failed' as const } }
    }) : undefined
  if (prepared && 'rejected' in prepared) return prepared.rejected
  const operation = prepared?.operation ?? await prepareOperation(lease, { key: capability.operationKey, kind: 'tool', action, input: operationInput })
  const receipt = await commitOperationEffect(lease, operation.id, operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    await assertAgentManuscriptCurrent(tx, ctx)
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) runtimeError('RUNTIME_SCOPE_MISMATCH', '正文操作不属于原任务范围。')
    const chapter = await tx.chapter.findFirst({ where: { id: args.chapterId, ...activeChapterScope(ctx.novelId), authorId: ctx.userId } })
    if (!chapter) return runtimeError('CHAPTER_REVISION_CONFLICT', '章节已归档、不存在或不属于当前作品，请重新读取当前章节。')
    if (chapter.revision !== expectedRevision) runtimeError('CHAPTER_REVISION_CONFLICT', '章节已被修改，请重新读取后建立新操作，不能覆盖用户修改。')
    const before = chapter.content
    let after = candidate
    if (action === 'chapter_append') after = before.trim() ? `${before.replace(/\s+$/, '')}\n\n${candidate}` : candidate
    if (action === 'chapter_edit_range') {
      let start = args.start, end = args.end
      if (args.oldText) {
        start = before.indexOf(args.oldText)
        if (start < 0 || before.indexOf(args.oldText, start + args.oldText.length) !== -1) runtimeError('CHAPTER_ANCHOR_CONFLICT', '原文锚点必须唯一匹配。')
        end = start + args.oldText.length
      }
      if (start === undefined || end === undefined || end < start || start > before.length || end > before.length) return runtimeError('CHAPTER_ANCHOR_CONFLICT', '改写区间无效。')
      after = before.slice(0, start) + candidate + before.slice(end)
    }
    const changed = before !== after
    if (changed) {
      const updated = await tx.chapter.updateMany({ where: { id: chapter.id, authorId: ctx.userId, ...activeChapterScope(ctx.novelId), revision: expectedRevision },
        data: { content: after, wordCount: after.length, revision: { increment: 1 } } })
      if (updated.count !== 1) runtimeError('CHAPTER_REVISION_CONFLICT', '章节已变化或归档，正文写入未执行。')
      await recalculateNovelStats(tx, ctx.novelId)
    }
    const revision = expectedRevision + (changed ? 1 : 0)
    const memoryJobId = changed && isAgent2FeatureEnabled('memory2', ctx.userId)
      ? await enqueueChapterMemoryExtraction({ novelId: ctx.novelId, chapterId: chapter.id, chapterRevision: revision, before, after }, tx) : null
    if (changed && isAgent2FeatureEnabled('storyCompiler', ctx.userId)) await recordStoryCompilerWrite({ userId: ctx.userId, novelId: ctx.novelId,
      runId: ctx.runId, chapterId: chapter.id, chapterOrderIndex: chapter.orderIndex, chapterRevision: revision }, tx)
    ctx.signal.throwIfAborted()
    return { toolResult: { output: changed ? `已更新章节《${chapter.title}》，当前正文 ${after.length} 字。` : `章节《${chapter.title}》正文未变化。`,
      summary: `${changed ? '更新' : '未变化'}《${chapter.title}》 · ${after.length} 字`,
      display: { kind: 'chapterDiff', chapterId: chapter.id, chapterTitle: chapter.title, before, after, appliedDirectly: true, revision },
      snapshot: { target: 'chapter', targetId: chapter.id, field: 'content', previousValue: before } }, memoryJobId,
      progress: { kind: 'content_revision', targetId: chapter.id, beforeHash: runtimeJson({ content: before }).hash, afterHash: runtimeJson({ content: after }).hash } }
  }).catch(async error => {
    if (!prepared || !(error instanceof DataAccessError) || !['CHAPTER_REVISION_CONFLICT', 'CHAPTER_ANCHOR_CONFLICT'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: operation.id, inputHash: operation.inputHash, code: error.code,
      summary: '正文变更未执行', output: error.message })
  })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) {
    if (prepared) await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: operation.id })
    return { ...failed.data.toolResult, outcome: 'failed' }
  }
  const saved = resultSchema.safeParse(receipt.result)
  if (!saved.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '正文工具回执损坏。')
  recordChapterBaseline(ctx.runId, args.chapterId, saved.data.toolResult.display.revision)
  // The job is durable in the effect transaction. Do not launch the legacy
  // unfenced multi-write processor after losing/pausing this task's lease.
  ctx.signal.throwIfAborted()
  if (prepared) await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: operation.id })
  return saved.data.toolResult
}
