import { createHash, randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { effectiveModelMultiplier, readModelPromotion, modelPromotionSchema } from '../../shared/model-promotion.js'

import type { AdminCreditsManagementPayload, AdminModelManagementPayload } from '../../shared/contracts/index.js'
import type { ModelReasoningEffort } from '../../shared/contracts/index.js'
import { BUILT_IN_MODEL_TIERS } from '../../shared/contracts/index.js'
import { buildNewCreditAccountData, ensureCreditAccount, getCreditWindow, parseModelCapabilities } from './credits.js'
import { getActiveRun, stopAgentRun, stopActiveRunsByUser, stopAllActiveRuns } from './agent/active-runs.js'
import { env } from '../config/env.js'
import { DataAccessError, prisma } from './prisma.js'
import { encryptSecret } from './secret-box.js'
import { getActiveTokenPrices } from './billing/rate-cards.js'
import { presentLedgerPrice } from './billing/ledger-presentation.js'
import { presentModelRoutes, saveModelRoutes } from './model-route-pool.js'
import type { ModelRouteInput } from '../../shared/contracts/model-routes.js'

const MILLI = 1000

async function stopCreditRuns(userIds?: string[], capturedIds?: string[]): Promise<number> {
  const runs = await prisma.agentRun.findMany({ where: { engine: 'loop', status: { in: ['queued', 'running', 'awaiting_approval'] },
    ...(capturedIds ? { id: { in: capturedIds } } : {}),
    ...(userIds ? { userId: { in: userIds } } : {}) }, select: { id: true, userId: true } })
  const localIds = new Set(runs.filter(run => getActiveRun(run.id)).map(run => run.id))
  const { stopLoopRun } = await import('./agent/run-service.js')
  let stoppedRemote = 0
  let stoppedLocal = 0
  try {
    for (const run of runs) {
      try {
        const result = await stopLoopRun(run.userId, run.id)
        if (result.stopped && !localIds.has(run.id)) stoppedRemote++
      } catch (error) {
        // A task can finish between the snapshot and its stop transaction.
        // Database/ownership failures must not be reported as a successful stop.
        if (!(error instanceof DataAccessError) || error.code !== 'RUN_NOT_ACTIVE') throw error
      }
    }
  } finally {
    // Preserve the existing local abort behavior, including non-loop engines.
    if (capturedIds) for (const runId of capturedIds) stoppedLocal += Number(stopAgentRun(runId))
    else if (userIds) for (const userId of userIds) stoppedLocal += stopActiveRunsByUser(userId)
    else stoppedLocal = stopAllActiveRuns()
  }
  return Math.max(localIds.size, stoppedLocal) + stoppedRemote
}

async function executeCreditReset(adminId: string, requestKey: string, scope: string[] | 'all',
  work: (tx: Prisma.TransactionClient) => Promise<number>): Promise<{ users: number; stoppedRuns: number }> {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey)) throw new DataAccessError(400, 'CREDIT_RESET_KEY_INVALID', '重置请求编号无效。')
  const id = createHash('sha256').update(JSON.stringify(['credit-reset', adminId, requestKey])).digest('hex')
  const requestHash = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await prisma.$transaction(async tx => {
        const receipt = await tx.adminAuditLog.findUnique({ where: { id } })
        if (receipt) {
          const detail = receipt.detail as Prisma.JsonObject
          if (receipt.adminId !== adminId || receipt.action !== 'credits.reset_receipt' || detail.requestHash !== requestHash
            || typeof detail.users !== 'number' || !Number.isSafeInteger(detail.users) || detail.users < 0) {
            throw new DataAccessError(409, 'CREDIT_RESET_IDENTITY_CONFLICT', '同一重置请求的目标已改变。')
          }
          const runIds = z.array(z.string().min(1).max(64)).safeParse(detail.runIds)
          if (!runIds.success) throw new DataAccessError(409, 'CREDIT_RESET_RECEIPT_INVALID', '原重置的任务快照无效，未重新推测停止范围。')
          return { users: detail.users, runIds: runIds.data }
        }
        const runs = await tx.agentRun.findMany({ where: { status: { in: ['queued', 'running', 'awaiting_approval'] },
          ...(scope === 'all' ? {} : { userId: { in: scope } }) }, select: { id: true } })
        const runIds = runs.map(run => run.id)
        const users = await work(tx)
        await tx.adminAuditLog.create({ data: { id, adminId, action: 'credits.reset_receipt', targetType: 'creditSystem',
          detail: { requestHash, users, runIds } } })
        return { users, runIds }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      const stopId = createHash('sha256').update(`${id}:stop`).digest('hex')
      if (await prisma.adminAuditLog.findUnique({ where: { id: stopId } })) return { users: result.users, stoppedRuns: 0 }
      const stoppedRuns = await stopCreditRuns(undefined, result.runIds)
      await prisma.adminAuditLog.upsert({ where: { id: stopId }, update: {}, create: { id: stopId, adminId,
        action: 'credits.reset_stop_receipt', targetType: 'creditSystem', detail: { resetReceiptId: id } } })
      return { users: result.users, stoppedRuns }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(error.code) && attempt < 2) continue
      throw error
    }
  }
  throw new DataAccessError(409, 'CREDIT_CONCURRENCY_CONFLICT', '额度更新冲突，请重试。')
}

async function ensureAllPublicBetaAccounts(setting: { dailyAllowanceMilli: number; resetHourUtc8: number; globallyPaused: boolean }) {
  const now = new Date()
  const window = getCreditWindow(now, setting.resetHourUtc8)
  const users = await prisma.user.findMany({ select: { id: true } })
  if (users.length > 0) {
    await prisma.creditAccount.createMany({
      data: users.map((user) => buildNewCreditAccountData(user.id, setting, window, now)),
      skipDuplicates: true,
    })
  }
  await prisma.creditAccount.updateMany({
    where: { periodEndsAt: { lte: now } },
    data: {
      dailyAllowanceMilli: setting.dailyAllowanceMilli,
      dailyUsedMilli: 0,
      periodStartedAt: window.startedAt,
      periodEndsAt: window.endsAt,
    },
  })
}

export async function getAdminCreditsManagement(): Promise<AdminCreditsManagementPayload> {
  const setting = await prisma.creditSystemSetting.upsert({
    where: { id: 'global' },
    create: { id: 'global', dailyAllowanceMilli: 450_000, resetHourUtc8: 15 },
    update: {},
  })
  // 公测上线前已存在的用户没有 CreditAccount；管理页必须覆盖“所有用户”，
  // 同时在读取前兑现已到期的 UTC+8 15:00 重置，避免显示昨日旧用量。
  await ensureAllPublicBetaAccounts(setting)
  const accounts = await prisma.creditAccount.findMany({
    include: { user: { select: { id: true, nickname: true, avatarUrl: true } } },
    orderBy: [{ dailyUsedMilli: 'desc' }, { updatedAt: 'desc' }],
  })
  const users = accounts.map((account) => {
    const dailyRemaining = Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli)
    const totalRemaining = dailyRemaining + Math.max(0, account.bonusBalanceMilli)
    return {
      user: account.user,
      planLabel: '公测版' as const,
      dailyAllowance: account.dailyAllowanceMilli / MILLI,
      dailyUsed: account.dailyUsedMilli / MILLI,
      dailyRemaining: dailyRemaining / MILLI,
      bonusBalance: account.bonusBalanceMilli / MILLI,
      totalRemaining: totalRemaining / MILLI,
      usedPercent: account.dailyAllowanceMilli > 0 ? Math.min(100, Math.round(account.dailyUsedMilli / account.dailyAllowanceMilli * 1000) / 10) : 100,
      resetsAt: account.periodEndsAt.toISOString(),
      suspended: Boolean(account.suspendedAt),
    }
  })
  return {
    summary: {
      globallyPaused: setting.globallyPaused,
      users: users.length,
      dailyAllowance: users.reduce((sum, item) => sum + item.dailyAllowance, 0),
      dailyUsed: users.reduce((sum, item) => sum + item.dailyUsed, 0),
      bonusBalance: users.reduce((sum, item) => sum + item.bonusBalance, 0),
      exhaustedUsers: users.filter((item) => item.totalRemaining <= 0).length,
    },
    users,
  }
}

export async function resetAdminUserCredits(userId: string, adminId: string, requestKey: string = randomUUID()): Promise<{ stoppedRuns: number }> {
  const result = await resetAdminUsersCredits([userId], adminId, requestKey)
  return { stoppedRuns: result.stoppedRuns }
}

export async function resetAdminUsersCredits(userIds: string[], adminId: string, requestKey: string = randomUUID()): Promise<{ users: number; stoppedRuns: number }> {
  const normalized = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))].sort()
  if (normalized.length > 200) throw new DataAccessError(400, 'VALIDATION_ERROR', '一次最多重置200位用户。')
  if (normalized.length === 0) throw new DataAccessError(400, 'VALIDATION_ERROR', '请选择至少一个用户。')
  await Promise.all(normalized.map((userId) => ensureCreditAccount(userId)))
  const result = await executeCreditReset(adminId, requestKey, normalized, async (tx) => {
    const setting = await tx.creditSystemSetting.findUnique({ where: { id: 'global' } })
    const window = getCreditWindow(new Date(), setting?.resetHourUtc8 ?? 15)
    const accounts = await tx.creditAccount.findMany({ where: { userId: { in: normalized } }, select: { userId: true, dailyUsedMilli: true } })
    await tx.creditAccount.updateMany({
      where: { userId: { in: normalized } },
      data: { dailyUsedMilli: 0, dailyAllowanceMilli: setting?.dailyAllowanceMilli ?? 450_000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt },
    })
    const charged = accounts.filter((account) => account.dailyUsedMilli > 0)
    if (charged.length > 0) {
      await tx.creditLedgerEntry.createMany({ data: charged.map((account) => ({
        id: randomUUID(), userId: account.userId, deltaMilli: account.dailyUsedMilli, dailyDeltaMilli: account.dailyUsedMilli,
        kind: 'admin_reset', sourceType: normalized.length === 1 ? 'admin_reset' : 'admin_reset_batch', referenceId: adminId,
        idempotencyKey: `admin-reset:${account.userId}:${randomUUID()}`,
      })) })
    }
    return accounts.length
  })
  return result
}

export async function setAdminUsersSuspended(userIds: string[], paused: boolean): Promise<{ users: number; paused: boolean; stoppedRuns: number }> {
  const normalized = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))].slice(0, 200)
  if (normalized.length === 0) throw new DataAccessError(400, 'VALIDATION_ERROR', '请选择至少一个用户。')
  await Promise.all(normalized.map((userId) => ensureCreditAccount(userId)))
  const updated = await prisma.creditAccount.updateMany({
    where: { userId: { in: normalized } },
    data: { suspendedAt: paused ? new Date() : null },
  })
  return {
    users: updated.count,
    paused,
    stoppedRuns: paused ? await stopCreditRuns(normalized) : 0,
  }
}

export async function resetAllAdminCredits(adminId: string, requestKey: string = randomUUID()): Promise<{ users: number; stoppedRuns: number }> {
  const setting = await prisma.creditSystemSetting.upsert({ where: { id: 'global' }, create: { id: 'global', dailyAllowanceMilli: 450_000, resetHourUtc8: 15 }, update: {} })
  await ensureAllPublicBetaAccounts(setting)
  const result = await executeCreditReset(adminId, requestKey, 'all', async (tx) => {
    // Capture the amounts in the same serializable snapshot as the reset and
    // ledger. A pre-transaction read can miss a concurrent paid call and leave
    // the credited ledger amount different from the amount actually cleared.
    const currentSetting = await tx.creditSystemSetting.findUniqueOrThrow({ where: { id: 'global' } })
    const accounts = await tx.creditAccount.findMany({ select: { userId: true, dailyUsedMilli: true } })
    const window = getCreditWindow(new Date(), currentSetting.resetHourUtc8)
    await tx.creditAccount.updateMany({ data: { dailyUsedMilli: 0, dailyAllowanceMilli: currentSetting.dailyAllowanceMilli, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const chargedAccounts = accounts.filter((account) => account.dailyUsedMilli > 0)
    if (chargedAccounts.length > 0) {
      await tx.creditLedgerEntry.createMany({
        data: chargedAccounts.map((account) => ({
          id: randomUUID(), userId: account.userId, deltaMilli: Math.max(0, account.dailyUsedMilli), dailyDeltaMilli: Math.max(0, account.dailyUsedMilli),
          kind: 'admin_reset', sourceType: 'admin_reset_all', referenceId: adminId,
          idempotencyKey: `admin-reset-all:${account.userId}:${randomUUID()}`,
        })),
      })
    }
    return accounts.length
  })
  return result
}

export async function setCreditsGloballyPaused(paused: boolean): Promise<{ paused: boolean; stoppedRuns: number }> {
  // 把全局状态落到每个账户，而不只保存一个 UI 布尔值：这样新用户会继承暂停，
  // 管理员又可以在全局暂停期间单独恢复选中用户。再次切换全局状态时重新统一所有账户。
  await prisma.$transaction(async (tx) => {
    await tx.creditSystemSetting.upsert({
      where: { id: 'global' },
      create: { id: 'global', globallyPaused: paused, dailyAllowanceMilli: 450_000, resetHourUtc8: 15 },
      update: { globallyPaused: paused },
    })
    await tx.creditAccount.updateMany({ data: { suspendedAt: paused ? new Date() : null } })
  })
  return { paused, stoppedRuns: paused ? await stopCreditRuns() : 0 }
}

type ToolEnvironment = Pick<typeof env,
  'aiImageApiKeyConfigured' | 'aiImageProvider' | 'aiImageModel' | 'aiImageBaseUrl' |
  'aiVisionApiKeyConfigured' | 'aiVisionModel' | 'aiVisionBaseUrl' |
  'webSearchProvider' | 'webSearchBochaApiKeyConfigured'
>

export function toolEnvironmentFallback(modelKind: 'text' | 'image_generation' | 'vision' | 'web_search', config: ToolEnvironment = env) {
  if (modelKind === 'image_generation' && config.aiImageApiKeyConfigured) {
    return { provider: config.aiImageProvider, modelName: config.aiImageModel, baseUrl: config.aiImageBaseUrl, apiKeyConfigured: true }
  }
  if (modelKind === 'vision' && config.aiVisionApiKeyConfigured) {
    return { provider: 'openai-compatible', modelName: config.aiVisionModel, baseUrl: config.aiVisionBaseUrl, apiKeyConfigured: true }
  }
  if (modelKind === 'web_search' && config.webSearchProvider !== 'disabled') {
    const bocha = config.webSearchBochaApiKeyConfigured
    return {
      provider: bocha ? 'bocha' : 'auto',
      modelName: bocha ? 'bocha-web-search' : 'sogou-bing-fallback',
      baseUrl: bocha ? 'https://api.bochaai.com/v1/web-search' : null,
      // 无密钥搜索兜底本身也是完整配置，密钥状态仍如实显示。
      apiKeyConfigured: bocha,
    }
  }
  return null
}

export async function getAdminModelManagement(): Promise<AdminModelManagementPayload> {
  const usageWhere: Prisma.AiUsageLogWhereInput = {
    OR: [{ billingStatus: null }, { billingStatus: { notIn: ['prepared', 'not_dispatched'] } }],
  }
  const [models, usage, recent, prices] = await Promise.all([
    prisma.aiModelConfig.findMany({ where: { ownerUserId: null } }),
    prisma.aiUsageLog.groupBy({ by: ['modelTier'], where: { ...usageWhere, modelTier: { not: null } }, _sum: { requestTokens: true, responseTokens: true }, _count: { _all: true } }),
    prisma.aiUsageLog.findMany({ where: { ...usageWhere, createdAt: { gte: new Date(Date.now() - 13 * 86_400_000) } }, select: { createdAt: true, requestTokens: true, responseTokens: true } }),
    getActiveTokenPrices([...BUILT_IN_MODEL_TIERS]),
  ])
  const usageMap = new Map(usage.map((item) => [item.modelTier, item]))
  const trendMap = new Map<string, { requests: number; totalTokens: number }>()
  for (const item of recent) {
    const date = new Date(item.createdAt.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
    const row = trendMap.get(date) ?? { requests: 0, totalTokens: 0 }
    row.requests += 1
    row.totalTokens += (item.requestTokens ?? 0) + (item.responseTokens ?? 0)
    trendMap.set(date, row)
  }
  return {
    models: models.sort((left, right) => {
      const order = (tier: string | null) => {
        if (!tier) return BUILT_IN_MODEL_TIERS.length
        const index = BUILT_IN_MODEL_TIERS.indexOf(tier as typeof BUILT_IN_MODEL_TIERS[number])
        return index >= 0 ? index : BUILT_IN_MODEL_TIERS.length
      }
      return order(left.tier) - order(right.tier)
    }).map((model) => {
      const row = usageMap.get(model.tier)
      const capabilities = parseModelCapabilities(model.metadata, model.provider)
      const metadata = model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata) ? model.metadata as Record<string, unknown> : {}
      const modelKind = metadata.modelKind === 'image_generation' || metadata.modelKind === 'vision' || metadata.modelKind === 'web_search' ? metadata.modelKind : 'text'
      const databaseReady = model.modelName !== 'unconfigured' && Boolean(model.baseUrl && model.apiKeyCiphertext)
      const fallback = databaseReady ? null : toolEnvironmentFallback(modelKind)
      const configurationReady = databaseReady || Boolean(fallback) || (model.tier === 'speed' && model.modelName !== 'unconfigured')
      const price = modelKind === 'text' && model.tier && effectiveModelMultiplier(model) !== 0 && !readModelPromotion(model.metadata) ? prices.get(model.tier) : null
      return {
        routes: presentModelRoutes(model.metadata),
        pricing: price ? presentLedgerPrice({ pricingVersion: price.version, rateCardId: price.rateCardId, rates: price.rates, v1CeilingBps: price.v1CeilingBps }).pricing : null,
        id: model.id, tier: model.tier, modelKind, provider: fallback?.provider ?? model.provider, displayName: model.displayName,
        modelName: fallback?.modelName ?? model.modelName, baseUrl: fallback?.baseUrl ?? model.baseUrl, multiplier: effectiveModelMultiplier(model) / 10_000,
        freePromotion: readModelPromotion(model.metadata),
        enabled: model.enabled || Boolean(fallback), selectable: model.selectable, isDefault: model.isDefault,
        apiKeyConfigured: Boolean(model.apiKeyCiphertext) || Boolean(fallback?.apiKeyConfigured), requestCount: row?._count._all ?? 0,
        requestTokens: row?._sum.requestTokens ?? 0, responseTokens: row?._sum.responseTokens ?? 0,
        reasoningEfforts: capabilities.reasoningEfforts, defaultReasoningEffort: capabilities.defaultReasoningEffort,
        visionEnabled: capabilities.visionEnabled,
        contextWindowTokens: capabilities.contextWindowTokens,
        configurationReady,
        updatedAt: model.updatedAt.toISOString(),
      }
    }),
    trend: [...trendMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => ({ date, ...value })),
  }
}

export type UpdateAdminModelInput = {
  freePromotion?: import('../../shared/model-promotion.js').ModelPromotion | null
  routes?: ModelRouteInput[]
  provider?: string
  displayName?: string
  modelName?: string
  baseUrl?: string | null
  apiKey?: string
  multiplier?: number
  enabled?: boolean
  selectable?: boolean
  isDefault?: boolean
  reasoningEfforts?: ModelReasoningEffort[]
  defaultReasoningEffort?: ModelReasoningEffort
  visionEnabled?: boolean
  contextWindowTokens?: number
}

const DEEPSEEK_REASONING_EFFORTS = new Set<ModelReasoningEffort>(['low', 'high', 'max'])

function assertProviderReasoningEfforts(provider: string, reasoningEfforts: ModelReasoningEffort[]): void {
  if (provider.trim().toLowerCase() !== 'deepseek') return
  if (reasoningEfforts.some((effort) => !DEEPSEEK_REASONING_EFFORTS.has(effort))) {
    throw new DataAccessError(400, 'REASONING_EFFORT_UNSUPPORTED', 'DeepSeek 仅支持 low、high 和 max 推理强度。')
  }
}

export async function updateAdminModel(modelId: string, input: UpdateAdminModelInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const model = await tx.aiModelConfig.findFirstOrThrow({ where: { id: modelId, ownerUserId: null } })
    const freePromotion = input.freePromotion === undefined ? (input.multiplier === undefined ? readModelPromotion(model.metadata) : null) : input.freePromotion
    if (freePromotion) {
      const parsed = modelPromotionSchema.safeParse(freePromotion)
      if (!parsed.success || (input.multiplier ?? model.multiplierBps / 10000) !== 0
        || (input.freePromotion !== undefined && Date.parse(freePromotion.endsAt) <= Date.now())
        || !['lite', 'speed', 'standard', 'performance', 'ultimate', 'basic'].includes(model.tier ?? '')) {
        throw new DataAccessError(400, 'MODEL_PROMOTION_INVALID', '限时免费须使用 0 倍率、未来截止时间及有效的到期倍率。')
      }
    }
    const currentCapabilities = parseModelCapabilities(model.metadata, model.provider)
    const reasoningEfforts = input.reasoningEfforts ?? currentCapabilities.reasoningEfforts
    const defaultReasoningEffort = input.defaultReasoningEffort ?? currentCapabilities.defaultReasoningEffort
    const routes = saveModelRoutes(input.routes ?? presentModelRoutes(model.metadata).map(({ apiKeyConfigured: _configured, ...route }) => route), model.metadata, reasoningEfforts,
      { contextWindowTokens: input.contextWindowTokens ?? currentCapabilities.contextWindowTokens, visionEnabled: input.visionEnabled ?? currentCapabilities.visionEnabled })
    if (routes.length && !['lite', 'speed', 'standard', 'performance', 'ultimate', 'basic'].includes(model.tier ?? '')) throw new DataAccessError(400, 'MODEL_ROUTES_INVALID', '仅文本内置模型支持供应商线路。')
    assertProviderReasoningEfforts(input.provider ?? model.provider, reasoningEfforts)
    if (!reasoningEfforts.includes(defaultReasoningEffort)) throw new DataAccessError(400, 'VALIDATION_ERROR', '默认推理强度必须包含在模型支持档位中。')
    const nextModelName = input.modelName?.trim() || model.modelName
    const nextBaseUrl = input.baseUrl === undefined ? model.baseUrl : input.baseUrl?.trim() || null
    const nextHasApiKey = Boolean(input.apiKey?.trim() || model.apiKeyCiphertext)
    const nextEnabled = input.enabled ?? model.enabled
    const nextSelectable = input.selectable ?? model.selectable
    if (model.tier !== 'speed' && (nextEnabled || nextSelectable) && (nextModelName === 'unconfigured' || !nextBaseUrl || !nextHasApiKey)) {
      throw new DataAccessError(409, 'MODEL_CONFIG_INCOMPLETE', '该服务必须先完整配置模型 ID、Base URL 与 API Key，才能启用。')
    }
    if (input.isDefault) await tx.aiModelConfig.updateMany({ where: { ownerUserId: null, id: { not: model.id } }, data: { isDefault: false } })
    await tx.aiModelConfig.update({
      where: { id: model.id },
      data: {
        provider: input.provider?.trim() || undefined,
        displayName: input.displayName?.trim() || undefined,
        modelName: input.modelName?.trim() || undefined,
        baseUrl: input.baseUrl === undefined ? undefined : input.baseUrl?.trim() || null,
        apiKeyCiphertext: input.apiKey?.trim() ? encryptSecret(input.apiKey.trim()) : undefined,
        multiplierBps: input.multiplier === undefined
          ? (input.freePromotion === null ? effectiveModelMultiplier(model) : undefined)
          : Math.round(input.multiplier * 10_000),
        enabled: input.enabled,
        selectable: input.selectable,
        isDefault: input.isDefault,
        metadata: {
          ...(model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata) ? model.metadata : {}),
          ...(routes ? { routes } : {}),
          freePromotion,
          reasoningEfforts,
          defaultReasoningEffort,
          visionEnabled: input.visionEnabled ?? currentCapabilities.visionEnabled,
          contextWindowTokens: input.contextWindowTokens ?? currentCapabilities.contextWindowTokens,
        },
      },
    })
  })
}
