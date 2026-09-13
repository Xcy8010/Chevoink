import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { commitNovelImport, getNovelImportStatus, preflightNovelImport } from '../novel-import-service.js'
import { novelImportWaitingSchema } from '../novel-import-origin.js'
import { assertOriginalImportAttachment, novelImportArguments } from './tools/import-tools.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import type { AgentTool, ToolContext, ToolResult } from './tools/types.js'
import { databaseNow, lockRunRoot, runtimeError, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { withLeaseHeartbeat } from './runtime-heartbeat.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import { prepareToolCursorOperation } from './runtime-tool-cursor.js'
import { assertCurrentToolPolicy, commitOperationEffect, recordToolFailure } from './runtime-operations.js'
import { failedToolResultSchema, reduceExecutionReceipt } from './runtime-reducer.js'

export const importCommitWaitingSchema = z.object({ version: z.literal(1), operationId: z.string(), callId: z.string(),
  jobId: z.string().uuid(), expiresAt: z.string().datetime() }).strict()
const terminal = ['failed', 'cancelled', 'expired']
const WAIT_MS = 30 * 60_000

export function importWaitingUrl(novelId: string, runId: string, payload: z.infer<typeof novelImportWaitingSchema> | z.infer<typeof importCommitWaitingSchema>) {
  const query: Record<string, string> = 'jobId' in payload ? { importJobId: payload.jobId }
    : { importRunId: runId, importCallId: payload.callId, importAttachmentUrl: payload.attachmentUrl }
  return `/studio/novel/${encodeURIComponent(novelId)}?${new URLSearchParams(query)}`
}

/** Called INSIDE the core service's actual commit transaction, not a preflight
 * check. Run/root locks serialize stop/takeover with manuscript replacement. */
export async function assertImportCommitExecution(tx: Prisma.TransactionClient, ctx: ToolContext, operationId: string, inputHash: string) {
  ctx.signal.throwIfAborted()
  const token = ctx.durableImport?.lease
  if (!token) return runtimeError('RUNTIME_SCOPE_MISMATCH', '导入缺少持久执行租约。')
  const { run, root } = await lockRunRoot(tx, ctx.userId, ctx.runId)
  const held = await tx.agentRunLease.findUnique({ where: { runId: run.id } })
  if (root.id !== token.taskRootId || root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId || root.status !== 'active'
    || root.authorizationMode !== 'legacy' || !['queued', 'running'].includes(run.status) || !held?.enabled
    || held.ownerId !== token.ownerId || held.claimId !== token.claimId || held.epoch !== token.epoch
    || !held.expiresAt || held.expiresAt <= await databaseNow(tx)) return runtimeError('RUNTIME_LEASE_LOST', '导入执行者已失去当前任务权限。')
  const { frame } = await readExecutionStateInTransaction(tx, root.id)
  const operation = await tx.agentOperation.findFirst({ where: { id: operationId, taskRootId: root.id,
    originRunId: run.id, kind: 'tool', action: 'novel_import', status: 'prepared' } })
  if (frame.state.phase !== 'awaiting_operation' || frame.state.pendingOperationId !== operationId || !operation
    || operation.inputHash !== inputHash || runtimeJson(operation.inputSnapshot).hash !== inputHash) return runtimeError('RUNTIME_STATE_CONFLICT', '导入提交不属于当前等待位置。')
  await assertCurrentToolPolicy(tx, token, operation)
}

export async function executeDurableImport(ctx: ToolContext, tool: AgentTool, raw: unknown) {
  const capability = ctx.durableImport
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '导入能力与原任务不一致。')
  ctx = { ...ctx, durableImport: { ...capability, lease: { ...capability.lease }, cursor: { ...capability.cursor } } }
  const args = novelImportArguments.parse(raw), lease = { ...capability.lease }
  const scope = { userId: ctx.userId, novelId: ctx.novelId }
  const prepared = await prepareToolCursorOperation(lease, capability.cursor, { key: capability.operationKey,
    action: 'novel_import', callId: ctx.callId, targetId: lease.taskRootId, effectDomain: 'import',
    effectiveArgs: args, normalize: value => tool.parameters.parse(value),
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args }).value })
  const finish = async (result: ToolResult, boundary = false) => {
    const receipt = result.outcome === 'failed'
      ? await recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash,
        code: 'IMPORT_NOT_COMMITTED', output: result.output, summary: result.summary ?? '未导入' })
      : await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash,
        async () => runtimeJson({ toolResult: result, ...(boundary ? { importBoundary: true } : {}) }).value)
    await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
    const failure = failedToolResultSchema.safeParse(receipt.result)
    return { kind: 'tool' as const, result: failure.success ? { ...failure.data.toolResult, outcome: 'failed' as const }
      : z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult }
  }
  try {
    if (args.action === 'status') return finish(await tool.execute({ ...ctx, durableImport: undefined }, args))
    if (process.env.NOVEL_IMPORT_ENABLED !== 'true') throw new DataAccessError(503, 'IMPORT_DISABLED', '作品导入尚未开放，未执行新的导入。')
    const saveRequest = async (tx: Prisma.TransactionClient) => {
      if (args.action === 'commit') {
        const job = await tx.novelImportJob.findFirst({ where: { id: args.jobId, userId: ctx.userId, novelId: ctx.novelId } })
        if (!job) throw new DataAccessError(404, 'IMPORT_NOT_FOUND', '未找到当前作品的导入任务。')
        if (job.agentRunId || job.agentToolCallId) {
          if (job.agentRunId !== ctx.runId || job.agentToolCallId !== ctx.callId) throw new DataAccessError(409, 'IMPORT_ORIGIN_CONFLICT', '此导入已绑定其他原始调用，请在原导入面板处理。')
        } else if (job.status !== 'succeeded' && !terminal.includes(job.status)) {
          if (!['ready', 'needs_review', 'awaiting_confirmation'].includes(job.status)) throw new DataAccessError(409, 'IMPORT_STATE_INVALID', '请先完成原文件解析，再请求提交。')
          const changed = await tx.novelImportJob.updateMany({ where: { id: job.id, userId: ctx.userId, novelId: ctx.novelId,
            agentRunId: null, agentToolCallId: null, jobVersion: job.jobVersion, status: job.status },
            data: { agentRunId: ctx.runId, agentToolCallId: ctx.callId, jobVersion: { increment: 1 } } })
          if (changed.count !== 1) throw new DataAccessError(409, 'IMPORT_ORIGIN_CONFLICT', '导入任务已变化，请刷新确认。')
        }
      }
      const key = `import:${prepared.operation.id}`
      const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: key } })
      const payloadSchema = args.action === 'prepare' ? novelImportWaitingSchema : importCommitWaitingSchema
      if (existing) {
        const payload = payloadSchema.parse(existing.payload)
        if (existing.taskRootId !== lease.taskRootId || existing.runId !== ctx.runId || existing.operationId !== prepared.operation.id
          || existing.type !== (args.action === 'prepare' ? 'import.requested' : 'import.commit_requested')
          || payload.operationId !== prepared.operation.id || payload.callId !== ctx.callId
          || ('attachmentUrl' in payload ? args.action !== 'prepare' || payload.attachmentUrl !== args.attachmentUrl
            : args.action !== 'commit' || payload.jobId !== args.jobId)) return runtimeError('RUNTIME_RECEIPT_INVALID', '导入等待事件与原调用不一致。')
        return existing
      }
      if (args.action === 'prepare') await assertOriginalImportAttachment({ ...ctx, transaction: tx }, args.attachmentUrl)
      await assertCurrentToolPolicy(tx, lease, prepared.operation)
      const now = await databaseNow(tx)
      return tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: ctx.runId,
        operationId: prepared.operation.id, eventKey: key, type: args.action === 'prepare' ? 'import.requested' : 'import.commit_requested',
        payload: { version: 1, operationId: prepared.operation.id, callId: ctx.callId,
          ...(args.action === 'prepare' ? { attachmentUrl: args.attachmentUrl } : { jobId: args.jobId }), expiresAt: new Date(now.getTime() + WAIT_MS).toISOString() } } })
    }
    const request = args.action === 'commit' ? await runtimeTransaction(async tx => {
      // Match the import service's novel -> run/root order; do not nest a new
      // lease transaction while holding the novel lock.
      await lockNovelActiveScope(tx, ctx.novelId)
      await assertImportCommitExecution(tx, ctx, prepared.operation.id, prepared.operation.inputHash)
      const saved = await saveRequest(tx)
      await assertImportCommitExecution(tx, ctx, prepared.operation.id, prepared.operation.inputHash)
      return saved
    }) : await withRunLease(lease, saveRequest)
    const state = await withRunLease(lease, async tx => {
      const job = await tx.novelImportJob.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId,
        ...(args.action === 'prepare' ? { agentRunId: ctx.runId, agentToolCallId: ctx.callId } : { id: args.jobId }) } })
      const commit = job ? await tx.novelImportCommit.findUnique({ where: { jobId: job.id } }) : null
      const now = await databaseNow(tx)
      const approval = job && !commit ? await tx.novelImportApproval.findFirst({ where: { jobId: job.id, userId: ctx.userId,
        kind: 'commit', consumedAt: null, expiresAt: { gt: now }, manifestHash: job.manifestHash ?? '',
        manifestRevision: job.manifestRevision, targetHash: job.targetHash }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }) : null
      return { job, commit, approval, expired: Date.parse(z.object({ expiresAt: z.string() }).parse(request.payload).expiresAt) <= now.getTime() }
    })
    if (state.commit && state.job?.status === 'succeeded') {
      const status = await getNovelImportStatus(scope, state.job.id)
      if (!status.receipt) return runtimeError('RUNTIME_RECEIPT_INVALID', '导入成功状态缺少真实提交回执。')
      return finish(importSuccess(status.receipt), true)
    }
    if (state.job && (terminal.includes(state.job.status) || state.job.expiresAt <= new Date())) {
      return finish({ outcome: 'failed', output: `导入未完成：${state.job.errorCode ?? state.job.status}。原任务已结束等待，不得换写作工具绕过。`, summary: '导入未完成' })
    }
    if (state.expired) return finish({ outcome: 'failed', output: '导入确认等待已过期，尚未确认导入。原文件与任务保留；请在导入面板重新核对，不把超时视为批准。', summary: '导入等待已过期' })
    if (args.action === 'prepare') {
      // Source remains an authorized chat attachment until the shared human UI
      // finishes intent confirmation. Do not create approvals or silently parse.
      if (!state.job) await preflightNovelImport(scope, { runId: ctx.runId, callId: ctx.callId })
    } else {
      if (!state.job) throw new DataAccessError(404, 'IMPORT_NOT_FOUND', '未找到当前作品的导入任务。')
      if (state.approval) {
        const receipt = await commitNovelImport(scope, state.job.id, { approvalId: state.approval.id,
          idempotencyKey: `agent-import:${state.job.id}:${state.approval.id}` }, {
          origin: { runId: ctx.runId, callId: ctx.callId },
          beforeWrite: tx => assertImportCommitExecution(tx, ctx, prepared.operation.id, prepared.operation.inputHash),
        })
        return finish(importSuccess(receipt), true)
      }
    }
    return { kind: 'waiting_import' as const, requestId: request.id }
  } catch (error) {
    // Unknown I/O/DB/lease failures remain prepared for receipt reconciliation;
    // only explicit domain refusals prove there was no manuscript commit.
    if (!(error instanceof DataAccessError) || !/^(IMPORT_|NOVEL_NOT_FOUND)/.test(error.code)) throw error
    // A simultaneous human commit may win after we selected an approval. Never
    // overwrite that success with a stale idempotency/approval failure report.
    const committed = await withRunLease(lease, tx => tx.novelImportJob.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId,
      status: 'succeeded', ...(args.action === 'prepare' ? { agentRunId: ctx.runId, agentToolCallId: ctx.callId } : { id: args.jobId }),
      commit: { isNot: null } }, select: { id: true } }))
    if (committed && args.action !== 'status') {
      const status = await getNovelImportStatus(scope, committed.id)
      if (status.receipt) return finish(importSuccess(status.receipt), true)
    }
    return finish({ outcome: 'failed', output: `${error.code}：${error.message} 未确认导入完成。`, summary: '导入需要处理' })
  }
}

function importSuccess(receipt: Awaited<ReturnType<typeof commitNovelImport>>): ToolResult {
  const url = `/studio/novel/${encodeURIComponent(receipt.novelId)}?importJobId=${encodeURIComponent(receipt.jobId)}`
  const output = `导入已提交：${receipt.volumeCount} 卷、${receipt.chapterCount} 章、${receipt.wordCount} 字。未自动发布。\n[查看导入报告](${url})\n稿件已更换，本任务旧写入队列不会自动继续。`
  return { output, summary: '导入已提交，待核对新稿', display: { kind: 'markdown', markdown: output } }
}

/** Bounded DB polling wakes the saved cursor; never asks a model to poll and
 * never treats an approval row as authority outside the core commit service. */
export async function waitForDurableImport(token: RunLeaseToken, signal: AbortSignal, requestId: string) {
  await withLeaseHeartbeat(token, signal, async ownedSignal => {
    for (;;) {
      ownedSignal.throwIfAborted()
      const remaining = await withRunLease(token, async tx => {
        const request = await tx.agentExecutionOutbox.findUnique({ where: { id: requestId } })
        if (!request || request.taskRootId !== token.taskRootId || !['import.requested', 'import.commit_requested'].includes(request.type)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导入等待位置不存在。')
        const payload = request.type === 'import.requested' ? novelImportWaitingSchema.parse(request.payload) : importCommitWaitingSchema.parse(request.payload)
        const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: token.taskRootId } })
        const job = await tx.novelImportJob.findFirst({ where: { userId: token.userId, novelId: root.novelId,
          ...('jobId' in payload ? { id: payload.jobId } : { agentRunId: request.runId, agentToolCallId: payload.callId }) } })
        const now = await databaseNow(tx)
        if (process.env.NOVEL_IMPORT_ENABLED !== 'true' || (job && (terminal.includes(job.status) || job.status === 'succeeded' || job.expiresAt <= now))) return 0
        if ('jobId' in payload && job && await tx.novelImportApproval.count({ where: { jobId: job.id, userId: token.userId,
          kind: 'commit', consumedAt: null, expiresAt: { gt: now }, manifestRevision: job.manifestRevision,
          manifestHash: job.manifestHash ?? '', targetHash: job.targetHash } })) return 0
        return Date.parse(payload.expiresAt) - now.getTime()
      })
      if (remaining <= 0) return
      await delay(Math.min(1000, remaining), undefined, { signal: ownedSignal })
    }
  })
}

/** A committed replacement invalidates the rest of this model's old queue.
 * Check persisted evidence before dispatch, also after crash/reduction replay. */
export async function readDurableImportBoundary(token: RunLeaseToken) {
  return withRunLease(token, async tx => {
    const boundary = await tx.agentEffectReceipt.findFirst({ where: { operation: { taskRootId: token.taskRootId, action: 'novel_import' },
      OR: [{ result: { path: ['importBoundary'], equals: true } },
        { operation: { status: 'failed', inputSnapshot: { path: ['input', 'args', 'action'], equals: 'prepare' } } },
        { operation: { status: 'failed', inputSnapshot: { path: ['input', 'args', 'action'], equals: 'commit' } } }] } })
    if (!boundary) return null
    if (runtimeJson(boundary.result).hash !== boundary.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '导入边界回执损坏。')
    const { frame } = await readExecutionStateInTransaction(tx, token.taskRootId)
    // Let the original confirmed receipt reduce first, never repeat the import.
    if (frame.state.pendingOperationId === boundary.operationId) return null
    return { kind: 'needs_attention' as const, importBoundary: true, reason: '导入等待已结束；原任务写入队列已暂停，请核对导入报告后重新发起任务。', frame, blockers: ['IMPORT_WORKFLOW_ENDED'] }
  })
}
