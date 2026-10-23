import { z } from 'zod'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import { collectDurableToolEvidence } from './runtime-evidence.js'
import { prepareOperationInTransaction, commitOperationEffectInTransaction } from './runtime-operations.js'
import { applyMemoryExtractionJob } from './story-memory.js'
import type { ProjectMemoryEntry } from '@prisma/client'
import type { ToolContext, AgentTool, ToolResult } from './tools/types.js'
import { prepareToolCursorOperation } from './runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from './runtime-operations.js'
import { readObservedBaseline } from './runtime-observed-baseline.js'
import { normalizeToolInput } from './tools/input-validation.js'
import { reduceExecutionReceipt, failedToolResultSchema } from './runtime-reducer.js'
import { DataAccessError } from '../prisma.js'

export function memoryTargetHash(item: ProjectMemoryEntry) {
  return runtimeJson({ id: item.id, novelId: item.novelId, title: item.title, content: item.content, version: item.version,
    memoryType: item.memoryType, layer: item.layer, status: item.status, reviewStatus: item.reviewStatus,
    sourceChapterId: item.sourceChapterId, importance: item.importance, confidence: item.confidence }).hash
}

/** Explicit memory_save shares the same fenced transaction as its receipt.
 * Existing cards must have been observed by this task before replacement. */
export async function executeDurableMemorySave(ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>): Promise<ToolResult> {
  const capability = ctx.durableMemory
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId || !['memory_save', 'memory_event_save', 'memory_relation_save'].includes(tool.name)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '记忆保存缺少原任务能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (raw: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, raw)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const effective = normalize(args)
  ctx.signal.throwIfAborted()
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    targetId: lease.taskRootId, effectDomain: 'memory', normalize, effectiveArgs: effective,
    operationInput: runtimeJson({ callId: ctx.callId, args: effective }).value })
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '记忆保存不属于原作品和会话。')
    const memoryId = typeof effective.memoryId === 'string' ? effective.memoryId : null
    const title = tool.name === 'memory_relation_save' ? `${effective.fromName}→${effective.toName}:${effective.relationType}` : String(effective.title).trim()
    const memoryType = tool.name === 'memory_relation_save' ? 'relationshipState' : tool.name === 'memory_event_save' ? 'timelineEvent' : effective.memoryType as ProjectMemoryEntry['memoryType']
    const target = await tx.projectMemoryEntry.findFirst({ where: { novelId: root.novelId,
      ...(memoryId ? { id: memoryId } : { title, memoryType, status: { notIn: ['superseded', 'invalid'] } }) }, orderBy: { updatedAt: 'desc' } })
    if (memoryId && !target) return runtimeError('MEMORY_TARGET_MISSING', '原卡片不存在或不属于本作品，不能改为新建。')
    if (target) {
      const observed = await readObservedBaseline(tx, root.id, cursor.expectedRevision, { kind: 'memory', id: target.id })
      if (observed?.kind !== 'memory' || observed.hash !== memoryTargetHash(target)) return runtimeError('MEMORY_BASELINE_REQUIRED', '请先检索并读取原记忆最新内容，再保存修改；未覆盖当前卡片。')
    }
    if (typeof effective.sourceChapterId === 'string') {
      const chapter = await tx.chapter.findFirst({ where: { id: effective.sourceChapterId, novelId: root.novelId, authorId: root.userId } })
      const observed = chapter ? await readObservedBaseline(tx, root.id, cursor.expectedRevision, { kind: 'chapter', id: chapter.id }) : null
      if (!chapter || observed?.kind !== 'chapter' || observed.revision !== chapter.revision) return runtimeError('MEMORY_SOURCE_REQUIRED', '来源正文缺失或已变化，请先读取当前正文再沉淀记忆。')
    }
    const result = await tool.execute({ ...ctx, durableMemory: undefined, transaction: tx }, effective)
    const saved = result.savedMemoryId ? await tx.projectMemoryEntry.findFirst({ where: { id: result.savedMemoryId, novelId: root.novelId } }) : null
    if (!saved) return runtimeError('RUNTIME_RECEIPT_INVALID', '记忆写入未返回本作品可核对的卡片。')
    ctx.signal.throwIfAborted()
    return runtimeJson({ toolResult: { ...result, summary: result.summary ?? '记忆已保存',
      observedMemories: [{ kind: 'memory', id: saved.id, hash: memoryTargetHash(saved) }] } }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['MEMORY_TARGET_MISSING', 'MEMORY_BASELINE_REQUIRED', 'MEMORY_SOURCE_REQUIRED', 'MEMORY_DELETED', 'MEMORY_EVIDENCE_MISMATCH'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '记忆未写入' })
  })
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return { ...failed.data.toolResult, outcome: 'failed' }
  return z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}

type Effects = Awaited<ReturnType<typeof collectDurableToolEvidence>>['effects']
const bodySchema = z.object({ id: z.string(), revision: z.number().int().positive(), content: z.string() })
const resultSchema = z.object({ memoryJobId: z.string().nullable().optional(), memoryJobIds: z.array(z.string()).optional(),
  contentAfter: z.array(bodySchema).optional(), toolResult: z.object({ display: z.unknown().optional() }), progress: z.unknown().optional() })
const diffSchema = z.object({ kind: z.literal('chapterDiff'), chapterId: z.string(), revision: z.number().int().positive(), after: z.string(), appliedDirectly: z.literal(true) })
const memoryReceiptSchema = z.object({ jobId: z.string(), status: z.enum(['applied', 'stale']), memories: z.array(z.object({ id: z.string(), version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) })) }).strict()

/** Source receipt ownership, body identity and the original reducer observation
 * are checked before a queued job is admitted. No novel-wide pending-job scan. */
export async function collectDurableMemoryWork(tx: RuntimeTx, root: { id: string; novelId: string }, effects: Effects) {
  const work = []
  const seen = new Set<string>()
  for (const source of effects) {
    if (!['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'continuity_validate', 'quality_analyze', 'chapter_split', 'chapter_merge', 'chapter_move', 'chapter_move_to_volume', 'volume_move', 'volume_update', 'volume_delete'].includes(source.action)) continue
    const receipt = await tx.agentEffectReceipt.findUnique({ where: { operationId: source.operationId } })
    if (!receipt || runtimeJson(receipt.result).hash !== source.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '派生任务缺少原效果回执。')
    const parsed = resultSchema.safeParse(receipt.result)
    if (!parsed.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '派生任务来源格式无效。')
    const value = parsed.data
    const display = diffSchema.safeParse(value.toolResult.display)
    const bodies = [...(value.contentAfter ?? []), ...(display.success ? [{ id: display.data.chapterId, revision: display.data.revision, content: display.data.after }] : [])]
    const ids = [...(value.memoryJobIds ?? []), ...(value.memoryJobId ? [value.memoryJobId] : [])]
    // Transitional receipts written before explicit job IDs were added. Only
    // newly authored content can bind a revision-keyed job, never a no-op read.
    if (value.memoryJobId === undefined && ['chapter_create', 'quality_analyze'].includes(source.action) && value.progress && display.success) {
      const job = await tx.memoryExtractionJob.findUnique({ where: { idempotencyKey: `${display.data.chapterId}:${display.data.revision}` }, select: { id: true } })
      if (job) ids.push(job.id)
    }
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const job = await tx.memoryExtractionJob.findUnique({ where: { id } })
      const body = job && bodies.find(item => item.id === job.chapterId && item.revision === job.chapterRevision)
      if (!job || job.novelId !== root.novelId || !body || job.idempotencyKey !== `${body.id}:${body.revision}`
        || !job.diff || typeof job.diff !== 'object' || Array.isArray(job.diff) || job.diff.after !== body.content) return runtimeError('RUNTIME_RECEIPT_INVALID', '派生任务与原效果的正文/版本不一致。')
      if (job.diff.durableTaskRootId && (job.diff.durableTaskRootId !== root.id || job.diff.durableOperationId !== source.operationId)) return runtimeError('RUNTIME_RECEIPT_INVALID', '派生任务的持久归属与来源不符。')
      const input = runtimeJson({ sourceOperationId: source.operationId, sourceResultHash: source.resultHash,
        jobId: job.id, chapterId: job.chapterId, chapterRevision: job.chapterRevision, diffHash: runtimeJson(job.diff).hash })
      const operation = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: root.id, operationKey: `memory:${job.id}` } }, include: { effectReceipt: true } })
      let completed = false
      if (operation) {
        if (operation.inputHash !== runtimeJson({ kind: 'internal', action: 'memory_extract', parentOperationId: source.operationId, input: input.value }).hash
          || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '记忆操作身份与原始来源不符。')
        const receipt = operation.effectReceipt
        if (receipt) {
          const saved = memoryReceiptSchema.safeParse(receipt.result)
          const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${operation.id}` } })
          if (!saved.success || saved.data.jobId !== job.id || (saved.data.status === 'applied' ? saved.data.memories.length < 2 : saved.data.memories.length !== 0)
            || operation.status !== 'succeeded' || runtimeJson(receipt.result).hash !== receipt.resultHash || !event || event.taskRootId !== root.id
            || event.operationId !== operation.id || event.type !== 'effect.committed'
            || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash || job.status !== 'completed') return runtimeError('RUNTIME_RECEIPT_INVALID', '记忆回执、事件或任务状态损坏。')
          completed = true
        }
      }
      work.push({ job, source, input, completed })
    }
  }
  return work
}

/** One bounded DB-only derivative per scheduler step. Lease + effects + receipt
 * share one serializable transaction; an interrupted transaction changes none. */
export async function advanceDurableMemory(token: RunLeaseToken) {
  const lease = { ...token }
  return withRunLease(lease, async tx => {
    // Even non-memory tool receipts must pass the original integrity gate
    // before another native call. Only a root with no successful tools is empty.
    if (!await tx.agentOperation.count({ where: { taskRootId: lease.taskRootId, kind: 'tool', status: 'succeeded' } })) return null
    const state = await readExecutionStateInTransaction(tx, lease.taskRootId)
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    const effects = await collectDurableToolEvidence(tx, root.id, state.frame.revision)
    const work = (await collectDurableMemoryWork(tx, root, effects.effects)).find(item => !item.completed)
    if (!work) return null
    if (work.job.status === 'processing') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原记忆任务仍被旧处理器占用，不能并发接管。')
    const operation = await prepareOperationInTransaction(tx, lease, { key: `memory:${work.job.id}`, kind: 'internal', action: 'memory_extract',
      parentOperationId: work.source.operationId, input: work.input.value })
    const receipt = await commitOperationEffectInTransaction(tx, lease, operation.id, operation.inputHash, async tx => {
      await tx.memoryExtractionJob.update({ where: { id: work.job.id }, data: { status: 'processing', attempts: { increment: 1 }, errorMessage: null, leaseUntil: null } })
      const result = await applyMemoryExtractionJob(tx, work.job.id, { userId: root.userId, novelId: root.novelId, runId: lease.runId, taskRootId: root.id })
      const memories = await tx.projectMemoryEntry.findMany({ where: { id: { in: result.memoryIds }, novelId: root.novelId }, orderBy: { id: 'asc' },
        select: { id: true, title: true, content: true, version: true } })
      return runtimeJson({ jobId: work.job.id, status: result.status, memories: memories.map(item => ({ id: item.id, version: item.version, hash: runtimeJson({ title: item.title, content: item.content }).hash })) }).value
    })
    return { kind: 'memory' as const, operationId: operation.id, result: receipt.result }
  })
}
