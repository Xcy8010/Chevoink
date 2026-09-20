import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { ToolContext, ToolResult } from './types.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { DataAccessError } from '../../prisma.js'

type PlanArgs = { title?: string; content?: string; planId?: string; mode?: 'replace' | 'append'; expectedContentHash?: string }
export const planTargetHash = (plan: { id: string; title: string; content: string; metadata: Prisma.JsonValue }) => runtimeJson({ id: plan.id, title: plan.title, content: plan.content, metadata: plan.metadata }).hash

/** Real plan_save implementation executes through the same tx as receipt/outbox. */
export async function executeDurablePlanSave(ctx: ToolContext, args: PlanArgs, normalize: (raw: unknown) => unknown,
  write: (tx: Prisma.TransactionClient) => Promise<ToolResult>, action: 'plan_save' | 'plan_rename' | 'plan_delete' = 'plan_save'): Promise<ToolResult> {
  const capability = ctx.durablePlan && { ...ctx.durablePlan, lease: { ...ctx.durablePlan.lease }, cursor: { ...ctx.durablePlan.cursor }, expected: { ...ctx.durablePlan.expected } }
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '计划写入能力与原任务不一致。')
  const grant = ctx.toolAuthority?.get(action)
  if (!grant || grant.permission === 'deny' || !['plan', 'build'].includes(ctx.mode)) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '当前任务不允许计划写入。')
  const expected = capability.expected
  if ((expected.id === null) !== (expected.hash === null) || (expected.hash !== null && !/^[a-f0-9]{64}$/.test(expected.hash))) runtimeError('RUNTIME_INPUT_INVALID', '计划基线无效。')
  const effectiveArgs = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
  const { lease, cursor } = capability
  ctx.signal.throwIfAborted()
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action, callId: ctx.callId,
    targetId: expected.id ?? ctx.novelId, effectDomain: 'plan', requireApproval: grant.permission === 'ask' || grant.alwaysConfirm,
    effectiveArgs, normalize, operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args: effectiveArgs, expected }).value }).catch(async error => {
      if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
      const rejected = await rejectToolCursorCall(lease, cursor, ctx.callId)
      await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
      return { rejected: { ...failedToolResultSchema.parse(rejected.receipt.result).toolResult, outcome: 'failed' as const } }
    })
  if ('rejected' in prepared) return prepared.rejected
  const receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) runtimeError('RUNTIME_SCOPE_MISMATCH', '计划写入不属于原任务范围。')
    const target = await tx.agentArtifact.findFirst({ where: { artifactType: 'chapterPlan', run: { userId: ctx.userId, novelId: ctx.novelId },
      ...(args.planId ? { id: args.planId } : { title: args.title?.trim() ?? '', metadata: { path: ['savedAsPlan'], equals: true } }) }, orderBy: { updatedAt: 'desc' } })
    if ((target?.id ?? null) !== expected.id || (target ? planTargetHash(target) : null) !== expected.hash) runtimeError('PLAN_REVISION_CONFLICT', '计划已被修改，请重新读取后建立新操作，未覆盖作者修改。')
    const result = await write(tx)
    if (result.outcome === 'failed') throw new DataAccessError(409, 'PLAN_WRITE_REJECTED', result.output)
    const artifactId = result.display && 'artifactId' in result.display ? result.display.artifactId : undefined
    const saved = artifactId ? await tx.agentArtifact.findFirst({ where: { id: artifactId, run: { userId: ctx.userId, novelId: ctx.novelId } } }) : null
    if (!saved) return runtimeError('RUNTIME_RECEIPT_INVALID', '计划写入没有可核对的产物。')
    ctx.signal.throwIfAborted()
    return runtimeJson({ toolResult: { ...result, observedState: { kind: 'plan', id: saved.id, hash: planTargetHash(saved) } },
      planAfter: { id: saved.id, title: saved.title, content: saved.content, removed: action === 'plan_delete' }, progress: { kind: 'content_revision', targetId: saved.id,
      beforeHash: runtimeJson({ content: target?.content ?? '' }).hash, afterHash: runtimeJson({ content: saved.content }).hash } }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['PLAN_REVISION_CONFLICT', 'PLAN_WRITE_REJECTED'].includes(error.code)) throw error
    return recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '计划写入未执行' })
  })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  const parsed = z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }).passthrough() }).parse(receipt.result)
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return failed.success ? { ...failed.data.toolResult, outcome: 'failed' } : parsed.toolResult as ToolResult
}
