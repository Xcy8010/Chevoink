import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FIXED_NOVEL_COVER_SIZE } from '../../../../shared/contracts/index.js'
import { parseCoverImageResponse, requestCoverImages, resolveCoverImageRuntime } from '../../ai-service.js'
import { consumeCreditsInTransaction, recordImageRefundIntentInTransaction, reconcileCreditRefunds } from '../../credits.js'
import { createCoverAssetsInTransaction, recoverCoverAssetStorageData } from '../../data-access.js'
import { prisma } from '../../prisma.js'
import { withoutGoalEffects } from '../goal-context.js'
import { syncGoalDurableUsage } from '../goal-budget.js'
import { coverChildSchema, coverProjection, coverRequest, coverWorkSchema, type CoverWork } from '../runtime-cover-contract.js'
import { writeCoverUnit } from '../runtime-cover-accounting.js'
import { imageBlobSchema, prepareImageResponseStorage, readImageResponse, storeImageResponse } from '../provider-image-storage.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { withManuscriptRunLease, withRunLease, type RunLeaseToken } from '../runtime-lease.js'
import { prepareToolCursorOperation, readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { assertCurrentToolPolicy, prepareOperationInTransaction, prepareProviderAttempt, markProviderDispatchedInTransaction,
  recordProviderResult, lockOwnedAttempt, commitOperationEffect } from '../runtime-operations.js'
import { reduceExecutionReceipt } from '../runtime-reducer.js'
import { coverGenerateTool } from './cover-tools.js'
import { enforceCoverTitleInPrompt } from './cover-prompt.js'
import { normalizeToolInput } from './input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

function assertPublicRoute(route: CoverWork['route']) {
  const url = new URL(route.baseUrl)
  // Do not freeze embedded credentials into operation JSON. Legacy HTTP routes
  // retain their existing behavior; strict recovery must have a public identity.
  if (url.username || url.password || url.search || url.hash) return runtimeError('RUNTIME_INPUT_INVALID', '图片服务路由含不可持久化的认证参数。')
}

async function prepareImage(ctx: ToolContext, lease: RunLeaseToken, parentId: string, work: CoverWork) {
  const operation = await withRunLease(lease, async tx => {
    const parent = await readAdmittedToolOperation(lease, { operationId: parentId, action: 'cover_generate', novelId: ctx.novelId, callId: ctx.callId }, tx)
    if (parent.operation.status !== 'prepared' || runtimeJson(parent.input.work).hash !== runtimeJson(work).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '封面工作与原调用不一致。')
    await assertCurrentToolPolicy(tx, lease, parent.operation)
    return prepareOperationInTransaction(tx, lease, { key: `cover:${parentId}:0`, kind: 'provider', action: 'cover_generate_image', parentOperationId: parentId,
      input: runtimeJson({ version: 1, parentInputHash: parent.operation.inputHash, workHash: runtimeJson(work).hash, chargeKey: `image:${parentId}`,
        usageLogId: createHash('sha256').update(`cover:${parentId}:0`).digest('hex'), request: coverRequest(work) }).value })
  })
  const input = coverChildSchema.parse(z.object({ input: z.unknown() }).parse(operation.inputSnapshot).input)
  const attempt = await prepareProviderAttempt(lease, { operationId: operation.id, attemptKey: '1', provider: work.route.provider,
    model: work.route.modelName, request: runtimeJson(input.request).value })
  return { operation, input, attempt }
}

async function refundNoResult(userId: string, attemptId: string, requestHash: string, chargeKey: string, outcome: 'rejected' | 'empty' | 'unknown') {
  await withoutGoalEffects(() => prisma.$transaction(async tx => {
    const attempt = await lockOwnedAttempt(tx, userId, attemptId, requestHash)
    if (!attempt.dispatchedAt) return runtimeError('RUNTIME_RECEIPT_INVALID', '未派发图片调用不能创建退款。')
    await recordImageRefundIntentInTransaction(tx, userId, chargeKey, { outcome, deliveredImages: 0 })
  }))
  await withoutGoalEffects(() => reconcileCreditRefunds({ userId, limit: 10 })).catch(() => { /* Durable original obligation remains. */ })
}

async function generate(ctx: ToolContext, lease: RunLeaseToken, parentId: string, work: CoverWork) {
  const prepared = await prepareImage(ctx, lease, parentId, work)
  const identity = { userId: ctx.userId, attemptId: prepared.attempt.id, requestHash: prepared.attempt.requestHash }
  let saved: Awaited<ReturnType<typeof readImageResponse>>
  if (['succeeded', 'failed'].includes(prepared.attempt.status)) {
    if (!prepared.attempt.resultHash || runtimeJson(prepared.attempt.result).hash !== prepared.attempt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '封面原响应损坏。')
    const pointer = z.object({ result: imageBlobSchema }).parse(prepared.attempt.result).result
    saved = await readImageResponse(identity, pointer)
  } else if (['dispatched', 'unknown'].includes(prepared.attempt.status)) {
    // File publication can precede a lost DB reply. Reconcile only this one
    // complete, sealed original response; absence never authorizes HTTP.
    saved = await readImageResponse(identity)
    if (!saved) {
      // A process may have died immediately after atomic charge+dispatch, before
      // its catch could journal the original no-result refund obligation.
      await refundNoResult(ctx.userId, identity.attemptId, identity.requestHash, prepared.input.chargeKey, 'unknown')
      return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原封面请求结果未知，退款义务已记录；未重新生成或扣费。')
    }
    await recordProviderResult({ ...identity, outcome: saved.pointer.httpStatus >= 200 && saved.pointer.httpStatus < 300 ? 'succeeded' : 'failed', result: saved.pointer })
  } else {
    if (prepared.attempt.status !== 'prepared') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原封面调用已终止，未重新生成。')
    const runtime = await resolveCoverImageRuntime()
    if (runtimeJson(runtime.route).hash !== runtimeJson(work.route).hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '图片服务路由已变化，尚未派发。')
    ctx.signal.throwIfAborted()
    await prepareImageResponseStorage(identity)
    const permit = await withManuscriptRunLease(lease, async tx => {
      const parent = await readAdmittedToolOperation(lease, { operationId: parentId, action: 'cover_generate', novelId: ctx.novelId, callId: ctx.callId }, tx)
      await assertCurrentToolPolicy(tx, lease, parent.operation)
      if (!await tx.novel.findFirst({ where: { id: work.novelId, authorId: ctx.userId, status: { not: 'archived' } }, select: { id: true } })) return runtimeError('RUNTIME_SCOPE_MISMATCH', '作品已不可用于生成封面。')
      const current = await tx.agentProviderAttempt.findUniqueOrThrow({ where: { id: prepared.attempt.id } })
      if (current.status !== 'prepared') return { dispatchGranted: false }
      const binding = { version: 1, taskRootId: lease.taskRootId, parentOperationId: parentId, parentInputHash: parent.operation.inputHash,
        operationId: prepared.operation.id, requestHash: current.requestHash, workHash: runtimeJson(work).hash, tariff: work.tariff,
        amountMilli: work.amountMilli, chargeKey: prepared.input.chargeKey }
      if (await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: prepared.input.chargeKey } })) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原图片扣费与派发状态不一致，未重复扣费。')
      await consumeCreditsInTransaction(tx, { userId: ctx.userId, amountMilli: work.amountMilli, kind: 'usage', sourceType: 'image_generation',
        idempotencyKey: prepared.input.chargeKey, referenceId: prepared.operation.id, metadata: { novelId: work.novelId, agentCover: binding } })
      await tx.aiUsageLog.create({ data: { id: prepared.input.usageLogId, userId: ctx.userId, novelId: work.novelId, agentRunId: parent.operation.originRunId,
        providerType: 'image', providerMode: work.route.providerMode, modelName: work.route.modelName, action: 'generateCoverImage', durationMs: 0,
        targetType: 'imageCharge', targetId: prepared.input.chargeKey, creditChargeMilli: 6000, usageSource: 'unknown', billingStatus: 'pending_usage',
        billingEvidence: { taskRootId: lease.taskRootId, operationId: prepared.operation.id } } })
      const marked = await markProviderDispatchedInTransaction(tx, lease, current.id, 0)
      if (!marked.dispatchGranted) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原图片派发未能原子提交。')
      return marked
    })
    if (!permit.dispatchGranted) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原封面派发权已使用，未重复请求。')
    // No await/abort after the committed permit and before the single HTTP.
    // Transport/partial body/storage failure keeps the original attempt unknown.
    try {
      const response = await requestCoverImages(runtime, { prompt: work.prompt, size: work.size, count: work.count }, ctx.signal)
      saved = await storeImageResponse(identity, response.status, response.body ?? (async function* () { /* Complete empty HTTP body. */ })())
    } catch (error) {
      await refundNoResult(ctx.userId, identity.attemptId, identity.requestHash, prepared.input.chargeKey, 'unknown').catch(() => undefined)
      throw error
    }
    // Failure here is result reconciliation, never a no-result refund/retry.
    await recordProviderResult({ ...identity, outcome: saved.pointer.httpStatus >= 200 && saved.pointer.httpStatus < 300 ? 'succeeded' : 'failed', result: saved.pointer })
  }
  if (!saved) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原图片响应尚未恢复。')
  let urls: string[] = [], outcome: 'images' | 'empty' | 'rejected' | 'invalid' = 'images'
  try { urls = parseCoverImageResponse(saved.pointer.httpStatus, saved.body).slice(0, work.count) }
  catch (error) {
    outcome = saved.pointer.httpStatus < 200 || saved.pointer.httpStatus >= 300 ? 'rejected'
      : error instanceof Error && 'code' in error && error.code === 'AI_PROVIDER_EMPTY_RESPONSE' ? 'empty' : 'invalid'
  }
  await withoutGoalEffects(() => prisma.$transaction(async tx => {
    await lockOwnedAttempt(tx, ctx.userId, identity.attemptId, identity.requestHash)
    await writeCoverUnit(tx, identity.attemptId, outcome)
    if (outcome !== 'images') await recordImageRefundIntentInTransaction(tx, ctx.userId, prepared.input.chargeKey,
      { outcome: outcome === 'invalid' ? 'unknown' : outcome, deliveredImages: 0 })
  }))
  await syncGoalDurableUsage(identity.attemptId)
  if (outcome !== 'images') {
    await withoutGoalEffects(() => reconcileCreditRefunds({ userId: ctx.userId, limit: 10 })).catch(() => undefined)
    return { failure: true as const }
  }
  ctx.signal.throwIfAborted()
  const imageIds = work.assetIds.slice(0, urls.length)
  await withManuscriptRunLease(lease, async tx => {
    const parent = await readAdmittedToolOperation(lease, { operationId: parentId, action: 'cover_generate', novelId: ctx.novelId, callId: ctx.callId }, tx)
    await assertCurrentToolPolicy(tx, lease, parent.operation)
    const eventKey = `cover.assets:${parentId}`, payload = { operationId: parentId, providerOperationId: prepared.operation.id,
      resultHash: (await tx.agentProviderAttempt.findUniqueOrThrow({ where: { id: identity.attemptId } })).resultHash!,
      assetIds: imageIds, imageHashes: urls.map(url => createHash('sha256').update(url).digest('hex')) }
    const old = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
    if (old) {
      if (old.type !== 'cover.assets.persisted' || runtimeJson(old.payload).hash !== runtimeJson(payload).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '封面候选回执损坏。')
      const rows = await tx.coverAsset.findMany({ where: { id: { in: imageIds }, ownerUserId: ctx.userId, novelId: work.novelId } })
      if (rows.length !== imageIds.length || rows.some(row => row.prompt !== work.prompt || row.modelName !== work.route.modelName || row.sourceType !== 'ai_generated')) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原候选已删除或变化，未重新生成或补建。')
      return
    }
    await createCoverAssetsInTransaction(tx, { userId: ctx.userId, novelId: work.novelId, prompt: work.prompt, count: work.count,
      modelName: work.route.modelName, imageUrls: urls }, work.assetIds)
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, operationId: parentId,
      runId: parent.operation.originRunId, eventKey, type: 'cover.assets.persisted', payload } })
  })
  const images = []
  for (const id of imageIds) {
    ctx.signal.throwIfAborted()
    // Only existing owned candidates. Storage recovery never calls generation.
    images.push(await recoverCoverAssetStorageData(ctx.userId, id))
  }
  return { failure: false as const, images }
}

export async function executeDurableCover(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableCover
  if (!capability || tool.name !== 'cover_generate' || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '封面生成缺少原任务能力。')
  const lease = { ...capability.lease }, normalize = (value: unknown) => Object.fromEntries(Object.entries(coverGenerateTool.parameters.parse(normalizeToolInput(tool, value))).filter(([, value]) => value !== undefined))
  const args = normalize(raw)
  let work = await withRunLease(lease, async tx => {
    const old = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: capability.operationKey } } })
    if (!old) return null
    if (runtimeJson(old.inputSnapshot).hash !== old.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '封面原工作损坏。')
    return z.object({ input: z.object({ work: coverWorkSchema }) }).parse(old.inputSnapshot).input.work
  })
  if (!work) {
    const novel = await prisma.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId }, select: { title: true, displayTitle: true } })
    if (!novel) return runtimeError('RUNTIME_SCOPE_MISMATCH', '作品不存在或无权访问。')
    const runtime = await resolveCoverImageRuntime(); assertPublicRoute(runtime.route)
    const parsed = coverGenerateTool.parameters.parse(args), count = parsed.count ?? 1
    work = coverWorkSchema.parse({ version: 1, novelId: ctx.novelId, ...novel, prompt: enforceCoverTitleInPrompt(parsed.prompt.trim(), novel.title, novel.displayTitle),
      count, size: FIXED_NOVEL_COVER_SIZE, assetIds: Array.from({ length: count }, () => randomUUID()), tariff: 'image_call_6000_v1', amountMilli: 6000, route: runtime.route })
  }
  const prepared = await prepareToolCursorOperation(lease, capability.cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: 'metadata', targetId: lease.taskRootId, effectiveArgs: args, normalize, operationInput: runtimeJson({ novelId: ctx.novelId, callId: ctx.callId, args, work }).value })
  const admitted = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId })
  const frozen = coverWorkSchema.parse(admitted.input.work)
  let receipt = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } }))
  if (!receipt) {
    const generated = await generate(ctx, lease, prepared.operation.id, frozen)
    ctx.signal.throwIfAborted()
    const result: ToolResult = generated.failure ? { outcome: 'failed', failureCode: 'IMAGE_GENERATION_FAILED', output: '封面生成未得到可用图片，原响应及退款记录已保留；未重复生成。', summary: '封面生成未完成' }
      : coverProjection(generated.images)
    receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async () => runtimeJson({ toolResult: result }).value)
  }
  if (runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '封面投影回执损坏。')
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
