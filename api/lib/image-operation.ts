import { currentGoalExecution, withoutGoalEffects } from './agent/goal-context.js'
import { assertGoalProviderAdmission, reserveGoalUsageInTransaction, syncGoalLegacyUsage } from './agent/goal-budget.js'
import { assertGoalFence } from './agent/goal-fence.js'
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma, DataAccessError } from './prisma.js'
import { creditTransaction } from './credit-policy.js'
import { consumeCreditsInTransaction, recordImageRefundIntentInTransaction, reconcileCreditRefunds } from './credits.js'
import { createCoverAssetsInTransaction, recoverCoverAssetStorageData } from './data-access.js'
import { runtimeJson } from './agent/runtime-common.js'
import { coverRouteSchema } from './agent/runtime-cover-contract.js'
import { imagePriceSchema } from './billing/image-price.js'
import { imageBlobSchema, prepareImageResponseStorage, readImageResponse, storeImageResponse } from './agent/provider-image-storage.js'
import { coverImageFailureMayRetry, parseCoverImageResponse, requestCoverImages, resolveCoverImageRuntime } from './ai-service.js'
import { env } from '../config/env.js'
import type { GenerateCoverImageRequest, GenerateCoverImageResponse } from '../../shared/contracts/index.js'

const inputSchema = z.object({ prompt: z.string(), size: z.string(), count: z.number().int().min(1).max(4), novelId: z.string().nullable(), negativePrompt: z.string().nullable() }).strict()
const goalSchema = z.object({ goalId: z.string(), revision: z.number().int(), epoch: z.string().regex(/^\d+$/), userId: z.string(), novelId: z.string(), sessionId: z.string(), runId: z.string() }).strict()
const snapshotSchema = z.object({ version: z.literal(1), request: inputSchema, routes: z.array(coverRouteSchema).min(1).max(8),
  goal: goalSchema.optional(),
  attempts: z.array(z.string().uuid()).min(1).max(8), assetIds: z.array(z.string().uuid()).min(1).max(4), price: imagePriceSchema.optional(), amountMilli: z.number().int().min(0).max(2147483647),
}).strict().refine(value => value.routes.length === value.attempts.length && value.assetIds.length === value.request.count && value.amountMilli === (value.price?.amountMilli ?? 6000))
const reconciliation = () => new DataAccessError(409, 'IMAGE_RECONCILIATION_REQUIRED', '原图片请求需要核对，未重新生成。')
const chargeKey = (id: string) => 'image:http:' + id
async function lock(tx: Prisma.TransactionClient, userId: string, operationId: string) {
  const key = userId + ':' + operationId
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${key}))`
}
function publicRoute(route: z.infer<typeof coverRouteSchema>) {
  const url = new URL(route.baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DataAccessError(409, 'MODEL_ROUTES_INVALID', '图片线路地址不可用。')
  return route
}
/** Used dispatch permits recover sealed responses; they never grant another HTTP. */
export async function executeImageOperation(userId: string, input: GenerateCoverImageRequest & { negativePrompt?: string | null }, signal?: AbortSignal): Promise<GenerateCoverImageResponse['data']> {
  return withoutGoalEffects(async () => {
  const goal = currentGoalExecution()
  if (goal && (goal.userId !== userId || goal.novelId !== input.novelId)) throw new DataAccessError(409, 'GOAL_SCOPE_MISMATCH', '图片请求与目标归属不一致。')
  const originalGoal = goal ? { ...goal, epoch: goal.epoch.toString() } : undefined
  const operationId = z.string().min(1).max(100).regex(/^[A-Za-z0-9:_-]+$/).parse(input.operationId)
  const request = inputSchema.parse({ prompt: input.prompt, size: input.size, count: input.count, novelId: input.novelId ?? null, negativePrompt: input.negativePrompt ?? null })
  const requestHash = runtimeJson(request).hash
  let operation = await creditTransaction(async tx => {
    await lock(tx, userId, operationId)
    const old = await tx.imageOperation.findUnique({ where: { userId_operationId: { userId, operationId } } })
    if (old) {
      if (old.requestHash !== requestHash) throw new DataAccessError(409, 'IMAGE_OPERATION_CONFLICT', '原操作编号已绑定不同图片请求。')
      return old
    }
    const runtime = await resolveCoverImageRuntime()
    const routes = [runtime, ...(runtime.fallbackRuntimes ?? [])].map(value => publicRoute(value.route))
    const snapshot = snapshotSchema.parse({ version: 1, request, routes, ...(originalGoal ? { goal: originalGoal } : {}), attempts: routes.map(() => randomUUID()), assetIds: Array.from({ length: input.count }, () => randomUUID()),
      ...(runtime.price ? { price: runtime.price } : {}), amountMilli: runtime.price?.amountMilli ?? 6000 })
    return tx.imageOperation.create({ data: { userId, operationId, requestHash, inputSnapshot: runtimeJson({ work: snapshot, hash: runtimeJson(snapshot).hash }).value } })
  }).catch(async error => {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const saved = await prisma.imageOperation.findUnique({ where: { userId_operationId: { userId, operationId } } })
    if (!saved) throw error
    if (saved.requestHash !== requestHash) throw new DataAccessError(409, 'IMAGE_OPERATION_CONFLICT', '原操作编号已绑定不同图片请求。')
    return saved
  })
  const envelope = z.object({ work: snapshotSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(operation.inputSnapshot)
  const work = envelope.work
  if (runtimeJson({ goal: work.goal ?? null }).hash !== runtimeJson({ goal: originalGoal ?? null }).hash) throw new DataAccessError(409, 'GOAL_SCOPE_MISMATCH', '原图片请求的目标执行身份不一致。')
  if (runtimeJson(work).hash !== envelope.hash) throw reconciliation()
  if (runtimeJson(work.request).hash !== requestHash) throw reconciliation()
  if (operation.state === 'succeeded') return operation.result as GenerateCoverImageResponse['data']
  if (operation.state === 'failed') throw new DataAccessError(502, operation.errorCode ?? 'IMAGE_GENERATION_FAILED', '图片生成未得到可用结果，原费用及退款已保留。')
  try {
  while (operation.routeIndex < work.routes.length) {
    const index = operation.routeIndex, route = work.routes[index], key = chargeKey(operation.id)
    const identity = { userId, attemptId: work.attempts[index], requestHash: createHash('sha256').update(requestHash + ':' + index + ':' + runtimeJson(route).hash).digest('hex') }
    if (operation.state === 'assets_saved') {
      const ids = z.object({ assetIds: z.array(z.string().uuid()).min(1).max(4) }).parse(operation.result).assetIds
      const images = []
      for (const id of ids) { signal?.throwIfAborted(); images.push(await recoverCoverAssetStorageData(userId, id)) }
      const result = { images, providerMode: env.aiProviderMode }
      await prisma.imageOperation.update({ where: { id: operation.id }, data: { state: 'succeeded', result: runtimeJson(result).value } })
      return result
    }
    let saved: Awaited<ReturnType<typeof readImageResponse>> = null
    if (['dispatched', 'unknown', 'received', 'route_failed'].includes(operation.state)) {
      const pointer = imageBlobSchema.safeParse(operation.result)
      saved = await readImageResponse(identity, pointer.success ? pointer.data : undefined)
      if (!saved) throw reconciliation()
    }
    if (operation.state === 'prepared') {
      signal?.throwIfAborted()
      await assertGoalProviderAdmission(goal)
      const runtime = await resolveCoverImageRuntime(route)
      const { modelConfigId: _id, modelConfigRevision: _revision, ...legacy } = runtime.route
      if (runtimeJson(route.modelConfigId ? runtime.route : legacy).hash !== runtimeJson(route).hash) throw reconciliation()
      await prepareImageResponseStorage(identity)
      const permit = await creditTransaction(async tx => {
        await lock(tx, userId, operationId)
        const current = await tx.imageOperation.findUniqueOrThrow({ where: { id: operation.id } })
        if (current.state !== 'prepared' || current.routeIndex !== index) return false
        if (request.novelId && !await tx.novel.findFirst({ where: { id: request.novelId, authorId: userId, status: { not: 'archived' } }, select: { id: true } })) throw new DataAccessError(404, 'NOT_FOUND', '作品不存在或无权访问。')
        signal?.throwIfAborted()
        if (goal) {
          await reserveGoalUsageInTransaction(tx, 'legacy:' + work.attempts[index], 0, goal)
          const currentGoal = await tx.agentGoal.findUniqueOrThrow({ where: { id: goal.goalId } })
          if (['awaiting_input', 'awaiting_approval'].includes(currentGoal.phase)) throw new DataAccessError(409, 'GOAL_AUTHOR_INPUT_REQUIRED', '目标等待作者决定，不能派发新模型请求。')
        }
        if (index === 0) await consumeCreditsInTransaction(tx, { userId, amountMilli: work.amountMilli, kind: 'usage', sourceType: 'image_generation', idempotencyKey: key,
          referenceId: operation.id, ...(work.price ? { multiplierBps: work.price.effectiveMultiplierBps } : {}), metadata: { imageOperationId: operation.id, requestHash, routeIndex: index, ...(work.price ? { price: work.price, ...(work.price.activity ? { activity: work.price.activity } : {}) } : {}) } })
        await tx.aiUsageLog.create({ data: { id: work.attempts[index], userId, novelId: request.novelId, agentRunId: goal?.runId, providerType: 'image', providerMode: route.providerMode,
          providerName: route.provider, modelName: route.modelName, action: 'generateCoverImage', targetType: 'imageCharge', targetId: key, durationMs: 0,
          creditChargeMilli: 0, billingStatus: 'pending_usage', usageSource: 'unknown', billingSnapshot: runtimeJson({ amountMilli: work.amountMilli, ...(work.price ? { price: work.price } : {}) }).value } })
        await tx.imageOperation.update({ where: { id: operation.id }, data: { state: 'dispatched' } })
        return true
      })
      if (!permit) throw reconciliation()
      // One committed permit, one HTTP, with no intervening await.
      try {
        const response = await requestCoverImages(runtime, request, signal)
        saved = await storeImageResponse(identity, response.status, response.body ?? (async function* () {})())
      } catch (error) {
        await creditTransaction(async tx => {
          await lock(tx, userId, operationId)
          await tx.imageOperation.update({ where: { id: operation.id }, data: { state: 'unknown', errorCode: 'IMAGE_RESULT_UNKNOWN' } })
          await tx.aiUsageLog.update({ where: { id: work.attempts[index] }, data: { billingStatus: 'pending_usage', usageSource: 'unknown' } })
          if (work.amountMilli > 0) await recordImageRefundIntentInTransaction(tx, userId, key, { outcome: 'unknown', deliveredImages: 0 })
        })
        if (goal) await syncGoalLegacyUsage(work.attempts[index])
        await reconcileCreditRefunds({ userId, limit: 10 }).catch(() => undefined)
        throw error
      }
      await creditTransaction(async tx => {
        await lock(tx, userId, operationId)
        const current = await tx.imageOperation.findUniqueOrThrow({ where: { id: operation.id } })
        if (current.routeIndex !== index || !['dispatched', 'unknown'].includes(current.state)) throw reconciliation()
        await tx.imageOperation.update({ where: { id: operation.id }, data: { state: 'received', result: saved!.pointer } })
      })
    }
    if (!saved) throw reconciliation()
    let urls: string[] = [], failure: DataAccessError | null = null
    try { urls = parseCoverImageResponse(saved.pointer.httpStatus, saved.body).slice(0, request.count) }
    catch (error) { if (!(error instanceof DataAccessError)) throw error; failure = error }
    if (failure) {
      const retryable = coverImageFailureMayRetry(saved.pointer.httpStatus, failure.code), empty = failure.code === 'AI_PROVIDER_EMPTY_RESPONSE'
      const unknown = failure.code === 'AI_PROVIDER_TIMEOUT' || failure.code === 'AI_PROVIDER_INVALID_RESPONSE'
      const terminal = !retryable || index === work.routes.length - 1 || Boolean(signal?.aborted)
      await creditTransaction(async tx => {
        await lock(tx, userId, operationId)
        const current = await tx.imageOperation.findUniqueOrThrow({ where: { id: operation.id } })
        if (current.routeIndex !== index || !['dispatched', 'unknown', 'received', 'route_failed'].includes(current.state)) throw reconciliation()
        await tx.imageOperation.update({ where: { id: operation.id }, data: { state: unknown ? 'unknown' : terminal ? 'failed' : 'route_failed', result: saved!.pointer, errorCode: failure!.code } })
        await tx.aiUsageLog.update({ where: { id: work.attempts[index] }, data: { billingStatus: unknown ? 'pending_usage' : 'provider_rejected', usageSource: unknown ? 'unknown' : 'fixed_unit', requestTokens: unknown ? null : 0, responseTokens: unknown ? null : 0 } })
        if (terminal && work.amountMilli > 0) await recordImageRefundIntentInTransaction(tx, userId, key, { outcome: unknown ? 'unknown' : empty ? 'empty' : 'rejected', deliveredImages: 0 })
      })
      if (goal) await syncGoalLegacyUsage(work.attempts[index])
      await reconcileCreditRefunds({ userId, limit: 10 }).catch(() => undefined)
      signal?.throwIfAborted()
      if (unknown) throw reconciliation()
      if (terminal) throw failure
      operation = await creditTransaction(async tx => {
        await lock(tx, userId, operationId)
        const current = await tx.imageOperation.findUniqueOrThrow({ where: { id: operation.id } })
        if (current.routeIndex !== index || current.state !== 'route_failed') throw reconciliation()
        const debit = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: key } })
        if (!debit || debit.userId !== userId || debit.deltaMilli !== -work.amountMilli) throw reconciliation()
        return tx.imageOperation.update({ where: { id: operation.id }, data: { routeIndex: index + 1, state: 'prepared', result: Prisma.DbNull, errorCode: null } })
      })
      continue
    }
    signal?.throwIfAborted()
    const ids = work.assetIds.slice(0, urls.length)
    operation = await creditTransaction(async tx => {
      await lock(tx, userId, operationId)
      const current = await tx.imageOperation.findUniqueOrThrow({ where: { id: operation.id } })
      if (current.state === 'assets_saved' || current.state === 'succeeded') return current
      if (current.routeIndex !== index || !['dispatched', 'unknown', 'received'].includes(current.state)) throw reconciliation()
      signal?.throwIfAborted()
      if (goal) await assertGoalFence(tx, goal)
      await createCoverAssetsInTransaction(tx, { userId, ...request, imageUrls: urls, modelName: route.modelName }, work.assetIds)
      await tx.aiUsageLog.update({ where: { id: work.attempts[index] }, data: { creditChargeMilli: work.amountMilli, billingStatus: 'observed', usageSource: 'fixed_unit', requestTokens: goal ? 0 : null, responseTokens: goal ? 0 : null } })
      return tx.imageOperation.update({ where: { id: operation.id }, data: { state: 'assets_saved', result: { assetIds: ids } } })
    })
    if (goal) await syncGoalLegacyUsage(work.attempts[index])
    if (operation.state === 'succeeded') return operation.result as GenerateCoverImageResponse['data']
  }
  throw reconciliation()
  } catch (error) {
    if (goal && error instanceof DataAccessError && ['GOAL_EXECUTION_FENCED', 'GOAL_BUDGET_EXHAUSTED', 'GOAL_AUTHOR_INPUT_REQUIRED'].includes(error.code)) {
      await creditTransaction(async tx => {
        await lock(tx, userId, operationId)
        const current = await tx.imageOperation.findUniqueOrThrow({ where: { id: operation.id } })
        // A prepared route has no dispatch permit. A previous complete rejection
        // may share the one original debit; stop it without another HTTP.
        if (current.state !== 'prepared') return
        await tx.imageOperation.update({ where: { id: operation.id }, data: { state: 'failed', errorCode: error.code } })
        const key = chargeKey(operation.id), debit = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: key } })
        if (debit && work.amountMilli > 0) await recordImageRefundIntentInTransaction(tx, userId, key, { outcome: 'rejected', deliveredImages: 0 })
      })
      await reconcileCreditRefunds({ userId, limit: 10 }).catch(() => undefined)
    }
    if (signal?.aborted) {
      await creditTransaction(async tx => {
        await lock(tx, userId, operationId)
        const current = await tx.imageOperation.findUniqueOrThrow({ where: { id: operation.id } })
        if (['succeeded', 'assets_saved'].includes(current.state)) return
        if (current.state === 'unknown') return
        await tx.imageOperation.update({ where: { id: operation.id }, data: { state: 'failed', errorCode: 'IMAGE_CANCELLED' } })
        const key = chargeKey(operation.id), debit = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: key } })
        if (debit && work.amountMilli > 0) await recordImageRefundIntentInTransaction(tx, userId, key, { outcome: 'unknown', deliveredImages: 0 })
      })
      await reconcileCreditRefunds({ userId, limit: 10 }).catch(() => undefined)
    }
    throw error
  }
  })
}
