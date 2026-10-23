import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { env } from '../../../config/env.js'
import { prisma } from '../../prisma.js'
import { readBoundedPublicBody } from '../../public-http.js'
import { acquireVisionSlot, resolveVisionRuntime } from '../../vision-service.js'
import { syncGoalDurableUsage } from '../goal-budget.js'
import { withoutGoalEffects } from '../goal-context.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { withRunLease, type RunLeaseToken } from '../runtime-lease.js'
import { prepareToolCursorOperation, readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { assertCurrentToolPolicy, prepareOperationInTransaction, prepareProviderAttempt, markProviderDispatched,
  recordProviderResult, recordProviderUsage, lockOwnedAttempt, commitOperationEffect } from '../runtime-operations.js'
import { reduceExecutionReceipt } from '../runtime-reducer.js'
import { readViewImageInput, viewImageTool, type ViewImageInput } from './attachment-tools.js'
import { visionWorkSchema, visionResponseSchema, visionRawResponseSchema, visionProofSchema, visionRequest, inspectVisionResponse } from '../runtime-vision-contract.js'
import { normalizeToolInput } from './input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
type Work = Extract<z.infer<typeof visionWorkSchema>, { kind: 'vision' }>
type Observation = z.infer<typeof visionResponseSchema>
const pixelHash = (image: ViewImageInput['image']) => createHash('sha256').update(image.buffer).digest('hex')
const retryable = (result: Observation) => result.httpStatus === 429 || result.httpStatus >= 500
const completeUsage = (result: Observation) => result.promptTokens !== null && result.completionTokens !== null
const succeeded = (result: Observation) => result.httpStatus >= 200 && result.httpStatus < 300 && !result.invalid && !!result.description

async function prepareVisionAttempt(ctx: ToolContext, lease: RunLeaseToken, parentOperationId: string, work: Work, index: 0 | 1) {
  const operation = await withRunLease(lease, async tx => {
    const parent = await readAdmittedToolOperation(lease, { operationId: parentOperationId, action: 'view_image', novelId: ctx.novelId, callId: ctx.callId }, tx)
    if (parent.operation.status !== 'prepared' || runtimeJson(parent.input.work).hash !== runtimeJson(work).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '视觉请求与原图片工作不一致。')
    await assertCurrentToolPolicy(tx, lease, parent.operation)
    if (index === 1) {
      const previous = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: `vision:${parentOperationId}:0` } }, include: { attempts: { include: { usageReceipt: true } } } })
      const prior = previous?.attempts.length === 1 ? previous.attempts[0] : null
      const observed = prior?.status === 'failed' && prior.resultHash && runtimeJson(prior.result).hash === prior.resultHash
        ? z.object({ outcome: z.literal('failed'), result: visionRawResponseSchema }).safeParse(prior.result) : null
      const parsed = observed?.success ? inspectVisionResponse(observed.data.result.httpStatus, observed.data.result.body) : null
      if (!previous || previous.parentOperationId !== parentOperationId || runtimeJson(previous.inputSnapshot).hash !== previous.inputHash
        || !parsed || !retryable(parsed) || !completeUsage(parsed)
        || prior?.usageReceipt?.source !== 'reported') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '前次视觉请求或用量尚未核实，未发起第二次请求。')
    }
    const child = await prepareOperationInTransaction(tx, lease, { key: `vision:${parentOperationId}:${index}`, kind: 'provider', action: 'view_image_vision', parentOperationId,
      input: runtimeJson({ version: 1, parentInputHash: parent.operation.inputHash, workHash: runtimeJson(work).hash, index, request: visionRequest(work),
        usageLogId: createHash('sha256').update(`vision:${parentOperationId}:${index}`).digest('hex') }).value })
    const logId = z.object({ input: z.object({ usageLogId: z.string() }) }).parse(child.inputSnapshot).input.usageLogId
    await tx.aiUsageLog.upsert({ where: { id: logId }, update: {}, create: { id: logId, userId: ctx.userId, agentRunId: parent.operation.originRunId,
      targetType: 'agentRun', targetId: parent.operation.originRunId, providerType: 'image', providerMode: work.route.providerMode,
      modelName: work.route.modelName, action: 'view_image', durationMs: 0, requestTokens: null, responseTokens: null,
      billingStatus: 'prepared', usageSource: 'unknown', billingEvidence: { taskRootId: lease.taskRootId, operationId: child.id, billingPolicy: work.billingPolicy } } })
    return child
  })
  const request = z.object({ input: z.object({ request: z.record(z.string(), z.unknown()) }) }).parse(operation.inputSnapshot).input.request
  const attempt = await prepareProviderAttempt(lease, { operationId: operation.id, attemptKey: '1', provider: work.route.provider, model: work.route.modelName,
    request: runtimeJson(request).value })
  return { operation, attempt }
}

/** This proof is solely the original platform-paid vision policy. It never
 * certifies missing Token measurements or settles another provider action. */

async function finalizeVisionObservation(lease: RunLeaseToken, attemptId: string, requestHash: string, result: Observation, durationMs: number) {
  await recordProviderUsage({ userId: lease.userId, attemptId, requestHash, revision: 1, usage: { source: completeUsage(result) ? 'reported' : 'unknown',
    promptTokens: result.promptTokens, completionTokens: result.completionTokens, cacheHitTokens: null, cacheMissTokens: null } })
  // Raw provider evidence is already durable. Late accounting has no lease and
  // no manuscript/cursor authority; cancellation cannot erase the observation.
  await withoutGoalEffects(() => prisma.$transaction(async tx => {
    const attempt = await lockOwnedAttempt(tx, lease.userId, attemptId, requestHash)
    const operation = attempt.operation
    const child = z.object({ input: z.object({ usageLogId: z.string(), parentInputHash: hash }) }).parse(operation.inputSnapshot).input
    if (operation.action !== 'view_image_vision' || !operation.parentOperationId) return runtimeError('RUNTIME_RECEIPT_INVALID', '视觉用量缺少原工具。')
    const payload = visionProofSchema.parse({ operationId: operation.id, attemptId, parentOperationId: operation.parentOperationId,
      parentInputHash: child.parentInputHash, requestHash, policy: 'platform_vision_v1', chargedMilli: 0 })
    const eventKey = `settlement:${operation.id}`
    const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
    if (existing && (existing.type !== 'credit.exempt' || runtimeJson(existing.payload).hash !== runtimeJson(payload).hash)) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '视觉费用政策已有其他回执。')
    if (!existing) await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: operation.taskRootId, operationId: operation.id,
      runId: attempt.runId, eventKey, type: 'credit.exempt', payload } })
    if (completeUsage(result)) await tx.agentProviderUsageReceipt.update({ where: { attemptId }, data: { settlementStatus: 'exempt' } })
    await tx.aiUsageLog.update({ where: { id: child.usageLogId }, data: { requestTokens: result.promptTokens, responseTokens: result.completionTokens,
      ...(durationMs > 0 ? { durationMs: Math.min(2147483647, durationMs) } : {}), billingStatus: completeUsage(result) ? 'exempt' : 'pending_usage', usageSource: completeUsage(result) ? 'reported' : 'unknown' } })
  }))
  await syncGoalDurableUsage(attemptId)
}

async function callVision(ctx: ToolContext, lease: RunLeaseToken, parentOperationId: string, work: Work, initialPixels?: ViewImageInput) {
  for (const index of [0, 1] as const) {
    const prepared = await prepareVisionAttempt(ctx, lease, parentOperationId, work, index)
    let observed: Observation
    let durationMs = 0
    if (['succeeded', 'failed'].includes(prepared.attempt.status)) {
      if (!prepared.attempt.resultHash || runtimeJson(prepared.attempt.result).hash !== prepared.attempt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '视觉原响应损坏。')
      const raw = z.object({ outcome: z.enum(['succeeded', 'failed']), result: visionRawResponseSchema }).parse(prepared.attempt.result).result
      observed = inspectVisionResponse(raw.httpStatus, raw.body)
    } else {
      if (prepared.attempt.status !== 'prepared') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原视觉请求结果尚未确认，未重新请求。')
      const pixels = initialPixels ?? await readViewImageInput(ctx, viewImageTool.parameters.parse(z.object({ input: z.object({ args: z.unknown() }) }).parse(
        (await readAdmittedToolOperation(lease, { operationId: parentOperationId, action: 'view_image', novelId: ctx.novelId, callId: ctx.callId })).operation.inputSnapshot).input.args))
      if ('output' in pixels || pixelHash(pixels.image) !== work.pixelHash || pixels.image.mime !== work.mime) return runtimeError('VISION_INPUT_CHANGED', '原图片已变化或不可访问，未替换像素重新请求。')
      const runtime = await resolveVisionRuntime({ userId: ctx.userId, runId: ctx.runId, novelId: ctx.novelId, signal: ctx.signal, modelAssignments: ctx.modelAssignments })
      if (runtimeJson(runtime.route).hash !== runtimeJson(work.route).hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '视觉路由已变化，未替换原模型请求。')
      const release = await acquireVisionSlot(ctx.signal), started = Date.now()
      try {
        ctx.signal.throwIfAborted()
        const dispatch = await markProviderDispatched(lease, prepared.attempt.id, 32768 + work.question.length + work.maxOutputTokens)
        if (!dispatch.dispatchGranted) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原视觉派发已有记录，未重新请求。')
        // No await between the committed permit and fetch. A transport/body-read
        // failure leaves this exact attempt dispatched for reconciliation.
        const response = await fetch(`${work.route.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}` },
          body: JSON.stringify({ model: work.route.modelName, ...work.route.options,
            ...('max_completion_tokens' in work.route.options ? { max_completion_tokens: work.maxOutputTokens } : { max_tokens: work.maxOutputTokens }),
            messages: [{ role: 'user', content: [{ type: 'text', text: work.question },
              { type: 'image_url', image_url: { url: `data:${work.mime};base64,${pixels.image.buffer.toString('base64')}` } }] }] }),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(env.aiVisionTimeoutMs)]) })
        const raw = { httpStatus: response.status, body: (await readBoundedPublicBody(response, 2 * 1024 * 1024)).toString('utf8') }
        await recordProviderResult({ userId: ctx.userId, attemptId: prepared.attempt.id, requestHash: prepared.attempt.requestHash,
          outcome: response.ok ? 'succeeded' : 'failed', result: runtimeJson(raw).value })
        observed = inspectVisionResponse(raw.httpStatus, raw.body)
        durationMs = Date.now() - started
      } finally { release() }
    }
    // Also repair a crash between raw result, usage and exempt-policy receipt.
    await finalizeVisionObservation(lease, prepared.attempt.id, prepared.attempt.requestHash, observed, durationMs)
    if (succeeded(observed)) return { output: `图片观察结果：${observed.description}`, summary: '查看 1 张图片',
      display: { kind: 'viewedImage' as const, images: [{ id: path.basename(work.displayUrl), url: work.displayUrl }], description: observed.description! } }
    if (retryable(observed) && index === 0 && completeUsage(observed)) { await delay(2000, undefined, { signal: ctx.signal }); continue }
    return { outcome: 'failed' as const, failureCode: 'VISION_ERROR', output: `view_image 未完成：视觉服务${observed.invalid ? '未返回完整描述' : `返回 ${observed.httpStatus}`}。原响应及实际用量已保留。`, summary: '图片查看未完成' }
  }
  return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '视觉请求已达原有重试边界。')
}

export async function executeDurableVision(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableVision
  if (!capability || tool.name !== 'view_image' || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '视觉读取缺少原任务能力。')
  const lease = { ...capability.lease }, normalize = (value: unknown) => Object.fromEntries(Object.entries(viewImageTool.parameters.parse(normalizeToolInput(tool, value))).filter(([, value]) => value !== undefined))
  const args = normalize(raw)
  const old = await withRunLease(lease, async tx => {
    const operation = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: capability.operationKey } } })
    if (!operation) return null
    if (runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '视觉原输入损坏。')
    return z.object({ input: z.object({ work: visionWorkSchema }) }).parse(operation.inputSnapshot).input.work
  })
  let work = old, pixels: ViewImageInput | undefined
  if (!work) {
    const read = await readViewImageInput(ctx, viewImageTool.parameters.parse(args))
    if ('output' in read) work = { kind: 'unavailable', result: { ...read, outcome: 'failed' } }
    else {
      pixels = read
      if (read.image.buffer.length > 8 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(read.image.mime)) return runtimeError('VISION_INPUT_CHANGED', '图片超过视觉输入上限或格式不受支持，尚未派发。')
      const runtime = await resolveVisionRuntime({ userId: ctx.userId, runId: ctx.runId, novelId: ctx.novelId, signal: ctx.signal, modelAssignments: ctx.modelAssignments })
      work = { kind: 'vision', version: 1, route: runtime.route, pixelHash: pixelHash(read.image), mime: read.image.mime, displayUrl: read.displayUrl,
        question: read.question, maxOutputTokens: 4096, billingPolicy: 'platform_vision_v1' }
    }
  }
  work = visionWorkSchema.parse(work)
  const prepared = await prepareToolCursorOperation(lease, capability.cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: 'read', targetId: ctx.novelId, effectiveArgs: args, normalize,
    operationInput: runtimeJson({ novelId: ctx.novelId, callId: ctx.callId, args, work }).value })
  const admitted = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId })
  const frozen = z.object({ work: visionWorkSchema }).parse(admitted.input).work
  let receipt = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } }))
  if (!receipt) {
    const result = frozen.kind === 'unavailable' ? frozen.result : await callVision(ctx, lease, prepared.operation.id, frozen, pixels)
    ctx.signal.throwIfAborted()
    receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async () => runtimeJson({ toolResult: result }).value)
  }
  if (runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '视觉结果回执损坏。')
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
