import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { Prisma, type CreditLedgerEntry } from '@prisma/client'
import { z } from 'zod'

import { BUILT_IN_MODEL_TIERS, SERVER_MODEL_TIERS, taskSpecSchema } from '../../shared/contracts/index.js'
import type {
  CreditAccountSummary,
  CreditActivityPayload,
  CreditLedgerItem,
  CreditModelOption,
  CreditModelTier,
  CreditUsagePayload,
  TaskCreditUsagePayload,
  ModelReasoningEffort,
  ReferralPayload,
} from '../../shared/contracts/index.js'
import { DataAccessError, prisma } from './prisma.js'
import { decryptSecret } from './secret-box.js'
import { assertCreditInteger, BillingInputError, calculateV1ChargeMilli, calculateV2UserChargeMilli } from './billing/pricing.js'
import { equalLegacyMetadata, prepareCreditRequest, readCreditFingerprint } from './billing/credit-request.js'
import { getActiveTokenPrice, getActiveTokenPrices } from './billing/rate-cards.js'
import { tokenPriceSchema, type TokenPrice } from './billing/token-price.js'
import { fallbackUsageEvidenceSchema, FALLBACK_USAGE_POLICY, RESERVATION_TTL_MS, tokenReservationMilli } from './billing/reservation-policy.js'
import { presentLedgerPrice, readLedgerPriceMetadata } from './billing/ledger-presentation.js'

export const CREDIT_MILLI = 1000
export const PUBLIC_BETA_DAILY_MILLI = 450 * CREDIT_MILLI
export const REFERRER_REWARD_MILLI = 300 * CREDIT_MILLI
export const REFEREE_REWARD_MILLI = 120 * CREDIT_MILLI
export const IMAGE_CALL_MILLI = 6 * CREDIT_MILLI
export const WEB_SEARCH_CALL_MILLI = 2 * CREDIT_MILLI

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RESET_HOUR_UTC8 = 15
const GLOBAL_SETTING_ID = 'global'

const MODEL_FALLBACKS: CreditModelOption[] = [
  { tier: 'lite', label: '轻量', multiplier: 0, available: false, selectedByDefault: false, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', visionEnabled: false },
  { tier: 'speed', label: '极速', multiplier: 1, available: true, selectedByDefault: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', visionEnabled: false },
  { tier: 'standard', label: '标准', multiplier: 1.1, available: false, selectedByDefault: false, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false },
  { tier: 'performance', label: '性能', multiplier: 1.8, available: false, selectedByDefault: false, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false },
  { tier: 'ultimate', label: '极致', multiplier: 4.8, available: false, selectedByDefault: false, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false },
]

const MODEL_REASONING_EFFORTS = new Set<ModelReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const CREDIT_ACTIVITY_MODEL_LABELS: Record<CreditModelTier, string> = {
  lite: '轻量',
  speed: '极速',
  standard: '标准',
  performance: '性能',
  ultimate: '极致',
  basic: '基础',
  custom: '自定义模型',
}

/** 个人资料属于用户侧产品界面，只显示产品档位，绝不返回供应商模型 ID。 */
export function getCreditActivityModelLabel(providerType: 'text' | 'image', modelTier: string | null): string {
  if (providerType === 'image') return '生图'
  return modelTier && modelTier in CREDIT_ACTIVITY_MODEL_LABELS
    ? CREDIT_ACTIVITY_MODEL_LABELS[modelTier as CreditModelTier]
    : '历史模型'
}

export type ModelCapabilities = {
  reasoningEfforts: ModelReasoningEffort[]
  defaultReasoningEffort: ModelReasoningEffort
  visionEnabled: boolean
  contextWindowTokens: number | null
}

export function parseModelCapabilities(metadata: Prisma.JsonValue | null | undefined, provider = ''): ModelCapabilities {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
  const declared = Array.isArray(record.reasoningEfforts)
    ? record.reasoningEfforts.filter((item): item is ModelReasoningEffort => typeof item === 'string' && MODEL_REASONING_EFFORTS.has(item as ModelReasoningEffort))
    : []
  const reasoningEfforts: ModelReasoningEffort[] = declared.length > 0
    ? [...new Set(declared)]
    : provider.toLowerCase() === 'deepseek' ? ['low', 'high', 'max'] : ['high']
  const configuredDefault = typeof record.defaultReasoningEffort === 'string' && MODEL_REASONING_EFFORTS.has(record.defaultReasoningEffort as ModelReasoningEffort)
    ? record.defaultReasoningEffort as ModelReasoningEffort
    : 'high'
  return {
    reasoningEfforts,
    defaultReasoningEffort: reasoningEfforts.includes(configuredDefault) ? configuredDefault : reasoningEfforts[0] ?? 'high',
    visionEnabled: record.visionEnabled === true,
    contextWindowTokens: typeof record.contextWindowTokens === 'number'
      && Number.isInteger(record.contextWindowTokens)
      && record.contextWindowTokens >= 16_000
      && record.contextWindowTokens <= 4_000_000
      ? record.contextWindowTokens
      : null,
  }
}

function isConfiguredBuiltIn(item: { tier: string | null; modelName: string; baseUrl: string | null; apiKeyCiphertext: string | null }): boolean {
  if (item.tier === 'speed') return item.modelName !== 'unconfigured'
  return item.modelName !== 'unconfigured' && Boolean(item.baseUrl && item.apiKeyCiphertext)
}

type CreditDb = Prisma.TransactionClient | typeof prisma

type CreditWindow = { startedAt: Date; endsAt: Date }

export function getCreditWindow(now = new Date(), resetHourUtc8 = DEFAULT_RESET_HOUR_UTC8): CreditWindow {
  const local = new Date(now.getTime() + UTC8_OFFSET_MS)
  let localResetMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    resetHourUtc8,
  )
  if (local.getTime() < localResetMs) localResetMs -= 24 * 60 * 60 * 1000
  return {
    startedAt: new Date(localResetMs - UTC8_OFFSET_MS),
    endsAt: new Date(localResetMs - UTC8_OFFSET_MS + 24 * 60 * 60 * 1000),
  }
}

function makeReferralCode(seed?: string): string {
  const source = seed ? createHash('sha256').update(seed).digest('base64url') : randomBytes(9).toString('base64url')
  return source.replace(/[-_]/g, '').toUpperCase().slice(0, 12)
}

async function getGlobalSetting(db: CreditDb) {
  // Hot-path admission/settlement reads must not initialize the singleton on
  // every request. Do not cache: administrative pause/limits stay current.
  const existing = await db.creditSystemSetting.findUnique({ where: { id: GLOBAL_SETTING_ID } })
  if (existing) return existing
  return db.creditSystemSetting.upsert({
    where: { id: GLOBAL_SETTING_ID },
    create: {
      id: GLOBAL_SETTING_ID,
      globallyPaused: false,
      dailyAllowanceMilli: PUBLIC_BETA_DAILY_MILLI,
      resetHourUtc8: DEFAULT_RESET_HOUR_UTC8,
    },
    update: {},
  })
}

/**
 * 新账户默认值的唯一入口：全局暂停期间新账户必须继承暂停状态。
 * 所有建账点（注册事务、懒加载 ensure、管理端批量建账）都必须经过这里，
 * 结构性防止再出现遗漏 suspendedAt 而绕过门禁的新建账路径。
 */
export function buildNewCreditAccountData(
  userId: string,
  setting: { dailyAllowanceMilli: number; globallyPaused: boolean },
  window: CreditWindow,
  now = new Date(),
) {
  return {
    userId,
    dailyAllowanceMilli: setting.dailyAllowanceMilli,
    dailyUsedMilli: 0,
    bonusBalanceMilli: 0,
    periodStartedAt: window.startedAt,
    periodEndsAt: window.endsAt,
    suspendedAt: setting.globallyPaused ? now : null,
  }
}

async function ensureAccountWithDb(db: CreditDb, userId: string, now = new Date()) {
  const setting = await getGlobalSetting(db)
  const window = getCreditWindow(now, setting.resetHourUtc8)
  await db.creditAccount.upsert({
    where: { userId },
    create: buildNewCreditAccountData(userId, setting, window, now),
    update: {},
  })
  await db.creditAccount.updateMany({
    where: { userId, periodEndsAt: { lte: now } },
    data: {
      dailyAllowanceMilli: setting.dailyAllowanceMilli,
      dailyUsedMilli: 0,
      periodStartedAt: window.startedAt,
      periodEndsAt: window.endsAt,
    },
  })
  const account = await db.creditAccount.findUniqueOrThrow({ where: { userId } })
  return { account, setting }
}

export async function ensureCreditAccount(userId: string, now = new Date()) {
  return ensureAccountWithDb(prisma, userId, now)
}

async function listPublicModelOptions(): Promise<CreditModelOption[]> {
  const configs = await prisma.aiModelConfig.findMany({
    where: { ownerUserId: null, tier: { not: null } },
    select: { tier: true, provider: true, displayName: true, modelName: true, baseUrl: true, apiKeyCiphertext: true, multiplierBps: true, enabled: true, selectable: true, isDefault: true, metadata: true },
  })
  const activePrices = await getActiveTokenPrices([...BUILT_IN_MODEL_TIERS])
  if (configs.length === 0) return MODEL_FALLBACKS.map(item => {
    const price = activePrices.get(item.tier)
    return { ...item, pricing: price ? presentLedgerPrice({ pricingVersion: price.version, rateCardId: price.rateCardId, rates: price.rates, v1CeilingBps: price.v1CeilingBps }).pricing : null }
  })
  return configs.flatMap((item) => {
    if (!item.tier || !['lite', 'speed', 'standard', 'performance', 'ultimate'].includes(item.tier)) return []
    const capabilities = parseModelCapabilities(item.metadata, item.provider)
    const price = activePrices.get(item.tier)
    return [{
      pricing: price ? presentLedgerPrice({ pricingVersion: price.version, rateCardId: price.rateCardId, rates: price.rates, v1CeilingBps: price.v1CeilingBps }).pricing : null,
      tier: item.tier as CreditModelOption['tier'],
      label: item.displayName,
      multiplier: item.multiplierBps / 10000,
      available: item.enabled && item.selectable && isConfiguredBuiltIn(item),
      selectedByDefault: item.isDefault,
      ...capabilities,
    }]
  }).sort((left, right) => {
    const order = (tier: CreditModelTier) => {
      const index = BUILT_IN_MODEL_TIERS.indexOf(tier as typeof BUILT_IN_MODEL_TIERS[number])
      return index >= 0 ? index : BUILT_IN_MODEL_TIERS.length
    }
    return order(left.tier) - order(right.tier)
  })
}

function milliToCredits(value: number): number {
  return Math.round(value) / CREDIT_MILLI
}

function utc8DateKey(now = new Date()): string {
  return new Date(now.getTime() + UTC8_OFFSET_MS).toISOString().slice(0, 10)
}

function shiftDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`)
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

/** 当前连续天数允许最后一次活动停在昨天，避免当天尚未使用时在 00:00 立即归零。 */
export function calculateCreditActivityStreaks(activityDates: string[], todayKey = utc8DateKey()): {
  current: number
  longest: number
} {
  const dates = [...new Set(activityDates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort()
  const active = new Set(dates)
  let longest = 0
  let running = 0
  let previous: string | null = null
  for (const date of dates) {
    running = previous && shiftDateKey(previous, 1) === date ? running + 1 : 1
    longest = Math.max(longest, running)
    previous = date
  }

  const yesterdayKey = shiftDateKey(todayKey, -1)
  let cursor = active.has(todayKey) ? todayKey : active.has(yesterdayKey) ? yesterdayKey : null
  let current = 0
  while (cursor && active.has(cursor)) {
    current += 1
    cursor = shiftDateKey(cursor, -1)
  }
  return { current, longest }
}

async function toCreditSummary(
  account: Awaited<ReturnType<typeof ensureAccountWithDb>>['account'],
  setting: Awaited<ReturnType<typeof getGlobalSetting>>,
): Promise<CreditAccountSummary> {
  const dailyRemainingMilli = Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli)
  const totalRemainingMilli = dailyRemainingMilli + Math.max(0, account.bonusBalanceMilli)
  const reservedMilli = await reservedTokenCredits(prisma, account.userId)
  const usedPercent = account.dailyAllowanceMilli > 0
    ? Math.min(100, Math.round((account.dailyUsedMilli / account.dailyAllowanceMilli) * 1000) / 10)
    : 100
  return {
    plan: 'public_beta',
    planLabel: '公测版',
    dailyAllowance: milliToCredits(account.dailyAllowanceMilli),
    dailyUsed: milliToCredits(account.dailyUsedMilli),
    dailyRemaining: milliToCredits(dailyRemainingMilli),
    bonusRemaining: milliToCredits(account.bonusBalanceMilli),
    totalRemaining: milliToCredits(Math.max(0, totalRemainingMilli - reservedMilli)),
    reserved: milliToCredits(reservedMilli),
    balance: milliToCredits(totalRemainingMilli),
    usedPercent,
    periodStartedAt: account.periodStartedAt.toISOString(),
    resetsAt: account.periodEndsAt.toISOString(),
    resetTimeZone: 'UTC+8',
    globallyPaused: setting.globallyPaused,
    suspended: Boolean(account.suspendedAt),
    models: await listPublicModelOptions(),
  }
}

export async function getCreditSummary(userId: string): Promise<CreditAccountSummary> {
  const { account, setting } = await ensureCreditAccount(userId)
  return toCreditSummary(account, setting)
}

export async function getCreditUsage(userId: string, take = 100): Promise<CreditUsagePayload> {
  const [account, entries] = await Promise.all([
    getCreditSummary(userId),
    prisma.creditLedgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 300),
    }),
  ])
  return { account, ledger: await presentCreditLedgerEntries(prisma, entries) }
}

async function presentCreditLedgerEntries(db: Prisma.TransactionClient, entries: CreditLedgerEntry[]): Promise<CreditLedgerItem[]> {
  // Exact usage linkage, shared by account and task views; never expose metadata.
  const originalKey = (entry: CreditLedgerEntry) => entry.kind === 'refund' ? entry.idempotencyKey.replace(/^refund:/, '') : entry.idempotencyKey
  const usageLogIds = entries
    .filter((entry) => originalKey(entry).startsWith('usage:'))
    .map((entry) => originalKey(entry).slice('usage:'.length))
  const cacheByLogId = new Map<string, { hit: number; miss: number }>()
  const taskByLogId = new Map<string, string>()
  if (usageLogIds.length > 0) {
    const usageLogs = await db.aiUsageLog.findMany({
      where: { id: { in: usageLogIds }, userId: { in: [...new Set(entries.map(entry => entry.userId))] } },
      select: { id: true, agentRunId: true, promptCacheHitTokens: true, promptCacheMissTokens: true },
    })
    for (const log of usageLogs) {
      if (log.promptCacheHitTokens != null) cacheByLogId.set(log.id, { hit: log.promptCacheHitTokens, miss: log.promptCacheMissTokens ?? 0 })
      if (log.agentRunId) taskByLogId.set(log.id, log.agentRunId)
    }
  }
  const candidateRunIds = [...new Set([...taskByLogId.values(), ...entries.flatMap(entry => entry.referenceId ? [entry.referenceId] : [])])]
  const runs = candidateRunIds.length ? await db.agentRun.findMany({ where: { id: { in: candidateRunIds },
    userId: { in: [...new Set(entries.map(entry => entry.userId))] } }, select: { id: true, userId: true } }) : []
  const runOwners = new Map(runs.map(run => [run.id, run.userId]))
  const ledger: CreditLedgerItem[] = entries.map((entry) => {
    const originalPrice = presentLedgerPrice(entry.metadata)
    const logId = originalKey(entry).slice('usage:'.length)
    const candidateRun = taskByLogId.get(logId) ?? entry.referenceId
    return {
    id: entry.id,
    delta: milliToCredits(entry.deltaMilli),
    kind: entry.kind,
    sourceType: entry.sourceType,
    referenceId: entry.referenceId,
    taskRunId: candidateRun && runOwners.get(candidateRun) === entry.userId ? candidateRun : null,
    modelTier: entry.modelTier as CreditModelTier | null,
    multiplier: entry.multiplierBps / 10000,
    requestTokens: entry.requestTokens,
    responseTokens: entry.responseTokens,
    pricing: originalPrice.pricing,
    estimatedUsage: Boolean(entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata) && entry.metadata.estimated === true),
    promptCacheHitTokens: originalPrice.hit ?? cacheByLogId.get(logId)?.hit ?? null,
    promptCacheMissTokens: originalPrice.miss ?? cacheByLogId.get(logId)?.miss ?? null,
    createdAt: entry.createdAt.toISOString(),
  } })
  return ledger
}

const taskCreditCursorSchema = z.object({ runId: z.string().min(1).max(64), asOf: z.string().datetime(),
  createdAt: z.string().datetime(), id: z.string().min(1).max(64) }).strict()

/** Scope by task lineage, not by all tasks in the same novel/session. Each page
 * and its totals use one read snapshot; the cursor retains the original cutoff. */
export async function getTaskCreditUsage(userId: string, runId: string, input: { cursor?: string; take?: number } = {}): Promise<TaskCreditUsagePayload> {
  const take = input.take ?? 30
  if (!Number.isSafeInteger(take) || take < 1 || take > 100) throw new DataAccessError(400, 'CREDIT_PAGE_INVALID', '费用分页大小无效。')
  let cursor: z.infer<typeof taskCreditCursorSchema> | null = null
  if (input.cursor) {
    try {
      if (input.cursor.length > 1024) throw new Error('cursor too long')
      cursor = taskCreditCursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
      if (cursor.runId !== runId || Date.parse(cursor.asOf) > Date.now() || Date.parse(cursor.createdAt) > Date.parse(cursor.asOf)) throw new Error('cursor scope invalid')
    } catch { throw new DataAccessError(400, 'CREDIT_CURSOR_INVALID', '费用游标无效或属于其他任务。') }
  }
  const page = cursor
  return prisma.$transaction(async tx => {
    const run = await tx.agentRun.findFirst({ where: { id: runId, userId, novel: { authorId: userId } } })
    if (!run) throw new DataAccessError(404, 'AGENT_RUN_NOT_FOUND', '任务不存在或无权查看。')
    const spec = run.taskSpec == null ? null : taskSpecSchema.safeParse(run.taskSpec)
    if (spec && (!spec.success || spec.data.scope.novelId !== run.novelId)) throw new DataAccessError(409, 'CREDIT_TASK_SCOPE_INVALID', '原任务身份异常，未合并历史账单。')
    const taskKey = run.taskRootId ?? (spec?.success ? spec.data.id : null)
    const asOf = page ? new Date(page.asOf) : new Date()
    // Prisma DateTime columns are UTC timestamp-without-time-zone. Bind their
    // ISO wall time explicitly; timestamptz comparison shifts the cutoff under
    // a non-UTC database session and can include refunds from later pages.
    const cutoff = asOf.toISOString()
    const scope = Prisma.sql`l.user_id = ${userId} AND l.created_at <= ${cutoff}::timestamp
      AND l.kind IN ('usage', 'refund') AND (
        EXISTS (SELECT 1 FROM agent_runs r WHERE r.user_id = ${userId} AND r.session_id = ${run.sessionId}
          AND r.novel_id = ${run.novelId} AND r.id = l.reference_id AND
          (r.id = ${runId} OR (${taskKey}::text IS NOT NULL AND COALESCE(r.task_root_id, r.task_spec->>'id') = ${taskKey})))
        OR (${run.taskRootId}::text IS NOT NULL AND EXISTS (SELECT 1 FROM agent_operations o
          WHERE o.task_root_id = ${run.taskRootId} AND o.id = l.reference_id))
        OR EXISTS (SELECT 1 FROM ai_usage_logs u JOIN agent_runs r ON r.id = u.agent_run_id
          WHERE u.user_id = ${userId} AND r.user_id = ${userId} AND r.session_id = ${run.sessionId}
          AND r.novel_id = ${run.novelId}
          AND l.idempotency_key IN ('usage:' || u.id, 'refund:usage:' || u.id)
          AND (r.id = ${runId} OR (${taskKey}::text IS NOT NULL AND COALESCE(r.task_root_id, r.task_spec->>'id') = ${taskKey})))
      )`
    const after = page ? Prisma.sql`AND (l.created_at < ${page.createdAt}::timestamp OR (l.created_at = ${page.createdAt}::timestamp AND l.id < ${page.id}))` : Prisma.empty
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT l.id FROM credit_ledger_entries l WHERE ${scope} ${after}
      ORDER BY l.created_at DESC, l.id DESC LIMIT ${take + 1}`)
    const totals = await tx.$queryRaw<Array<{ charged: bigint; refunded: bigint; pending: bigint }>>(Prisma.sql`
      SELECT COALESCE(SUM(CASE WHEN l.delta_milli < 0 THEN -l.delta_milli::bigint ELSE 0 END),0)::bigint AS charged,
        COALESCE(SUM(CASE WHEN l.kind = 'refund' AND l.delta_milli > 0 THEN l.delta_milli::bigint ELSE 0 END),0)::bigint AS refunded,
        COALESCE(SUM(CASE WHEN l.delta_milli < 0 AND EXISTS (SELECT 1 FROM credit_refund_intents f
          WHERE f.original_entry_id = l.id AND f.created_at <= ${cutoff}::timestamp AND (f.settled_at IS NULL OR f.settled_at > ${cutoff}::timestamp)) THEN -l.delta_milli::bigint ELSE 0 END),0)::bigint AS pending
      FROM credit_ledger_entries l WHERE ${scope}`)
    const entries = await tx.creditLedgerEntry.findMany({ where: { userId, id: { in: rows.slice(0, take).map(row => row.id) } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const credits = (value: bigint) => {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new DataAccessError(409, 'CREDIT_TOTAL_TOO_LARGE', '费用汇总超出安全数值范围。')
      return milliToCredits(Number(value))
    }
    const total = totals[0], last = entries.at(-1)
    const unresolvedProviderAttempts = run.taskRootId ? await tx.agentProviderAttempt.count({ where: {
      operation: { taskRootId: run.taskRootId }, createdAt: { lte: asOf }, dispatchedAt: { not: null },
      OR: [{ status: { in: ['dispatched', 'unknown'] } }, { usageReceipt: null }, { usageReceipt: { settlementStatus: 'pending' } }],
    } }) : null
    const [unsettled] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM ai_usage_logs u JOIN agent_runs r ON r.id = u.agent_run_id
      WHERE u.user_id = ${userId} AND r.user_id = ${userId} AND r.session_id = ${run.sessionId} AND r.novel_id = ${run.novelId}
        AND u.created_at <= ${cutoff}::timestamp AND u.billing_snapshot IS NOT NULL
        AND u.billing_status IS DISTINCT FROM 'not_dispatched'
        AND u.billing_snapshot->>'version' <> 'byok-exempt'
        AND (r.id = ${runId} OR (${taskKey}::text IS NOT NULL AND COALESCE(r.task_root_id, r.task_spec->>'id') = ${taskKey}))
        AND NOT EXISTS (SELECT 1 FROM credit_ledger_entries paid WHERE paid.user_id = ${userId}
          AND paid.idempotency_key = 'usage:' || u.id AND paid.created_at <= ${cutoff}::timestamp)`)
    return { runId, asOf: asOf.toISOString(), charged: credits(total.charged), refunded: credits(total.refunded),
      netCharged: credits(total.charged - total.refunded), pendingRefund: credits(total.pending), unresolvedProviderAttempts,
      pendingModelSettlements: Number(unsettled.count),
      ledger: await presentCreditLedgerEntries(tx, entries),
      nextCursor: rows.length > take && last ? Buffer.from(JSON.stringify({ runId, asOf: asOf.toISOString(), createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

type CreditActivityDbRow = {
  date: string
  spentMilli: bigint | number
  eventCount: bigint | number
}

/**
 * 个人资料页的真实 Credits/Agent 使用画像。
 * 日聚合在数据库完成，最多只把“一天一行”传回应用层，不随调用日志数量线性增长。
 */
export async function getCreditActivity(userId: string, now = new Date()): Promise<CreditActivityPayload> {
  const [account, dailyRows, earned, aiTotals, modelGroups, imageSpend, agentRuns] = await Promise.all([
    getCreditSummary(userId),
    prisma.$queryRaw<CreditActivityDbRow[]>`
      SELECT
        TO_CHAR(("created_at" + INTERVAL '8 hours')::date, 'YYYY-MM-DD') AS "date",
        SUM(-"delta_milli")::bigint AS "spentMilli",
        COUNT(*)::bigint AS "eventCount"
      FROM "credit_ledger_entries"
      WHERE "user_id" = ${userId} AND "delta_milli" < 0
      GROUP BY ("created_at" + INTERVAL '8 hours')::date
      ORDER BY ("created_at" + INTERVAL '8 hours')::date ASC
    `,
    prisma.creditLedgerEntry.aggregate({ where: { userId, deltaMilli: { gt: 0 } }, _sum: { deltaMilli: true } }),
    prisma.aiUsageLog.aggregate({
      where: { userId },
      _count: { _all: true },
      _sum: { requestTokens: true, responseTokens: true, promptCacheHitTokens: true, promptCacheMissTokens: true },
    }),
    prisma.aiUsageLog.groupBy({
      by: ['providerType', 'modelTier'],
      where: { userId },
      _count: { _all: true },
      _sum: { requestTokens: true, responseTokens: true, creditChargeMilli: true },
    }),
    prisma.creditLedgerEntry.aggregate({
      where: { userId, sourceType: 'image_generation', deltaMilli: { lt: 0 } },
      _sum: { deltaMilli: true },
    }),
    prisma.agentRun.count({ where: { userId } }),
  ])

  const daily = dailyRows.map((row) => ({
    date: row.date,
    spentMilli: Number(row.spentMilli),
    eventCount: Number(row.eventCount),
  }))
  const todayKey = utc8DateKey(now)
  const activityStartedAt = shiftDateKey(todayKey, -364)
  const streaks = calculateCreditActivityStreaks(daily.map((row) => row.date), todayKey)
  const hitTokens = aiTotals._sum.promptCacheHitTokens ?? 0
  const missTokens = aiTotals._sum.promptCacheMissTokens ?? 0
  const cacheTokens = hitTokens + missTokens
  const imageSpentMilli = Math.max(0, -(imageSpend._sum.deltaMilli ?? 0))
  const modelUsageByLabel = new Map<string, { label: string; calls: number; creditsSpentMilli: number; tokens: number }>()
  for (const group of modelGroups) {
    const label = getCreditActivityModelLabel(group.providerType, group.modelTier)
    const current = modelUsageByLabel.get(label) ?? { label, calls: 0, creditsSpentMilli: 0, tokens: 0 }
    current.calls += group._count._all
    current.creditsSpentMilli += group.providerType === 'image' ? 0 : group._sum.creditChargeMilli ?? 0
    current.tokens += (group._sum.requestTokens ?? 0) + (group._sum.responseTokens ?? 0)
    modelUsageByLabel.set(label, current)
  }
  const imageUsage = modelUsageByLabel.get('生图')
  if (imageUsage) imageUsage.creditsSpentMilli = imageSpentMilli

  return {
    account,
    stats: {
      generatedAt: now.toISOString(),
      ledgerStartedAt: daily[0]?.date ?? null,
      activityStartedAt,
      activityEndsAt: todayKey,
      cumulativeSpent: milliToCredits(daily.reduce((sum, row) => sum + row.spentMilli, 0)),
      cumulativeEarned: milliToCredits(earned._sum.deltaMilli ?? 0),
      peakDailySpent: milliToCredits(daily.reduce((peak, row) => Math.max(peak, row.spentMilli), 0)),
      totalTokens: (aiTotals._sum.requestTokens ?? 0) + (aiTotals._sum.responseTokens ?? 0),
      totalModelCalls: aiTotals._count._all,
      agentRuns,
      activeDays: daily.length,
      currentStreakDays: streaks.current,
      longestStreakDays: streaks.longest,
      cacheHitRate: cacheTokens > 0 ? Math.round((hitTokens / cacheTokens) * 1000) / 10 : null,
      activity: daily
        .filter((row) => row.date >= activityStartedAt && row.date <= todayKey)
        .map((row) => ({ date: row.date, creditsSpent: milliToCredits(row.spentMilli), eventCount: row.eventCount })),
      modelUsage: [...modelUsageByLabel.values()]
        .map((group) => ({
          label: group.label,
          calls: group.calls,
          creditsSpent: milliToCredits(group.creditsSpentMilli),
          tokens: group.tokens,
        }))
        .sort((left, right) => right.calls - left.calls || right.tokens - left.tokens)
        .slice(0, 5),
    },
  }
}

async function reservedTokenCredits(db: Pick<Prisma.TransactionClient, 'aiUsageLog'>, userId: string, excludeId?: string) {
  const held = await db.aiUsageLog.aggregate({ where: { userId, reservedCreditMilli: { gt: 0 },
    reservationExpiresAt: { gt: new Date() }, ...(excludeId ? { id: { not: excludeId } } : {}) }, _sum: { reservedCreditMilli: true } })
  return held._sum.reservedCreditMilli ?? 0
}

/** Serializable admission prevents concurrent calls from reserving the same credit. */
export async function reserveTokenCredits(userId: string, usageId: string, inputEstimate: number, maxOutput: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        const usage = await tx.aiUsageLog.findFirstOrThrow({ where: { id: usageId, userId } })
        if (usage.modelTier === 'custom' || usage.reservedCreditMilli > 0) return
        if (usage.billingStatus !== 'prepared') throw new DataAccessError(409, 'CREDIT_USAGE_MISMATCH', '不能为已执行请求重复预留额度。')
        const price = tokenPriceSchema.parse(usage.billingSnapshot)
        const { account, setting } = await ensureAccountWithDb(tx, userId)
        if (account.suspendedAt) throw new DataAccessError(423, setting.globallyPaused ? 'CREDITS_GLOBALLY_PAUSED' : 'CREDITS_ACCOUNT_SUSPENDED', '当前模型服务已暂停。')
        const balance = Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli) + account.bonusBalanceMilli
        const available = Math.max(0, balance - await reservedTokenCredits(tx, userId))
        if (available <= 0) throw new DataAccessError(402, balance > 0 ? 'CREDITS_RESERVED' : 'CREDITS_EXHAUSTED', balance > 0 ? '可用额度暂被进行中或待核调用预留，请等待结算或预留释放。' : '今日额度已用尽。')
        const unknown = await tx.aiUsageLog.count({ where: { userId, modelName: usage.modelName, modelTier: usage.modelTier,
          billingStatus: 'pending_usage', usageSource: 'unknown', createdAt: { gte: new Date(Date.now() - RESERVATION_TTL_MS) } } })
        if (unknown >= 3) throw new DataAccessError(429, 'CREDITS_PROVIDER_UNSTABLE', '此模型近期多次未返回用量，暂缓新调用；可切换其他模型或使用自定义模型，30分钟窗口过后可重试。')
        const held = tokenReservationMilli(price, inputEstimate, maxOutput, balance, available)
        await tx.aiUsageLog.update({ where: { id: usageId }, data: { reservedCreditMilli: held,
          reservationExpiresAt: new Date(Math.min(Date.now() + RESERVATION_TTL_MS, account.periodEndsAt.getTime())) } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2002') && attempt < 2) continue
      throw error
    }
  }
}

export async function assertCreditAccess(userId: string, tier: CreditModelTier = 'speed', requireSelectable = true): Promise<void> {
  const { account, setting } = await ensureCreditAccount(userId)
  if (account.suspendedAt) {
    throw new DataAccessError(423, setting.globallyPaused ? 'CREDITS_GLOBALLY_PAUSED' : 'CREDITS_ACCOUNT_SUSPENDED', setting.globallyPaused ? '公测模型服务已由管理员暂停，请稍后再试。' : '当前账户的模型使用权限已暂停。')
  }
  if (tier === 'custom') return
  const remaining = Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli) + account.bonusBalanceMilli
  if (remaining <= 0) {
    throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '今日额度已用尽，可邀请好友获得额外额度。')
  }
  if (remaining <= await reservedTokenCredits(prisma, userId)) throw new DataAccessError(409, 'CREDITS_RESERVED', '额度暂被进行中或待核调用预留，请等待结算或预留释放。')
  const model = await prisma.aiModelConfig.findFirst({
    where: { ownerUserId: null, tier, enabled: true, ...(requireSelectable ? { selectable: true } : {}) },
    select: { tier: true, modelName: true, baseUrl: true, apiKeyCiphertext: true },
  })
  if (!model || !isConfiguredBuiltIn(model)) {
    const configuredModels = await prisma.aiModelConfig.count({ where: { ownerUserId: null } })
    // 仅兼容迁移尚未应用的旧库；只要已有模型配置，就严格服从 enabled/selectable。
    if (tier === 'speed' && configuredModels === 0) return
    throw new DataAccessError(409, 'MODEL_TIER_UNAVAILABLE', '该模型档位尚未开放。')
  }
}

/** Standalone text helpers have no run selector. Prefer the owner's most recently
 * updated enabled BYOK model; never use another owner's model or fall back to a
 * paid provider when that selected custom configuration is invalid. */
export async function getAuxiliaryModelRuntime(userId: string) {
  const custom = await prisma.aiModelConfig.findFirst({
    where: { ownerUserId: userId, enabled: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    select: { id: true },
  })
  return getModelTierRuntime(custom ? 'custom' : 'basic', userId, custom?.id)
}

export async function getModelTierRuntime(tier: CreditModelTier = 'speed', userId?: string, customModelId?: string | null, requestedReasoningEffort?: ModelReasoningEffort): Promise<{
  tier: CreditModelTier
  tokenPrice?: TokenPrice
  multiplierBps: number
  provider: string
  modelName: string | null
  baseUrl: string | null
  apiKey: string | null
  reasoningEffort: ModelReasoningEffort
  reasoningEfforts: ModelReasoningEffort[]
  visionEnabled: boolean
  contextWindowTokens: number | null
}> {
  if (tier === 'custom') {
    if (!userId || !customModelId) throw new DataAccessError(400, 'CUSTOM_MODEL_REQUIRED', '请选择一个已配置的自定义模型。')
    const custom = await prisma.aiModelConfig.findFirst({
      where: { id: customModelId, ownerUserId: userId, enabled: true },
      select: { provider: true, modelName: true, baseUrl: true, apiKeyCiphertext: true, metadata: true },
    })
    if (!custom || !custom.baseUrl || !custom.apiKeyCiphertext) throw new DataAccessError(404, 'CUSTOM_MODEL_NOT_FOUND', '自定义模型不存在、未启用或配置不完整。')
    const capabilities = parseModelCapabilities(custom.metadata, custom.provider)
    const reasoningEffort = requestedReasoningEffort ?? capabilities.defaultReasoningEffort
    if (!capabilities.reasoningEfforts.includes(reasoningEffort)) throw new DataAccessError(400, 'REASONING_EFFORT_UNSUPPORTED', '该模型不支持所选推理强度。')
    return { tier, multiplierBps: 0, provider: custom.provider, modelName: custom.modelName, baseUrl: custom.baseUrl, apiKey: decryptSecret(custom.apiKeyCiphertext), reasoningEffort, ...capabilities }
  }
  const config = await prisma.aiModelConfig.findFirst({
    where: { ownerUserId: null, tier, enabled: true },
    select: { tier: true, provider: true, modelName: true, multiplierBps: true, baseUrl: true, apiKeyCiphertext: true, metadata: true },
  })
  if (!config) {
    const configuredModels = await prisma.aiModelConfig.count({ where: { ownerUserId: null } })
    if (tier === 'speed' && configuredModels === 0) return { tier, multiplierBps: 10000, provider: 'deepseek', modelName: null, baseUrl: null, apiKey: null, reasoningEffort: requestedReasoningEffort ?? 'high', reasoningEfforts: ['low', 'high', 'max'], visionEnabled: false, contextWindowTokens: null }
    // 基础模型档未建行/未启用时回退极速档：后台轻任务（关系网/导出建议）不因可选配置缺失而整体失败
    if (tier === 'basic') return getModelTierRuntime('speed', userId, customModelId, requestedReasoningEffort ?? 'low')
    throw new DataAccessError(409, 'MODEL_TIER_UNAVAILABLE', '该模型档位尚未开放。')
  }
  if (!isConfiguredBuiltIn(config)) {
    // 基础模型档存在但服务配置不完整时同样回退极速档；回退后计费也按极速档记录
    if (tier === 'basic') return getModelTierRuntime('speed', userId, customModelId, requestedReasoningEffort ?? 'low')
    throw new DataAccessError(409, 'MODEL_TIER_UNAVAILABLE', '该模型档位尚未完成服务配置。')
  }
  const capabilities = parseModelCapabilities(config.metadata, config.provider)
  const reasoningEffort = requestedReasoningEffort ?? capabilities.defaultReasoningEffort
  if (!capabilities.reasoningEfforts.includes(reasoningEffort)) throw new DataAccessError(400, 'REASONING_EFFORT_UNSUPPORTED', '该模型不支持所选推理强度。')
  return {
    tier,
    multiplierBps: config.multiplierBps,
    tokenPrice: await getActiveTokenPrice(tier) ?? undefined,
    provider: config.provider,
    modelName: config.modelName === 'unconfigured' ? null : config.modelName,
    baseUrl: config.baseUrl,
    apiKey: config.apiKeyCiphertext ? decryptSecret(config.apiKeyCiphertext) : null,
    reasoningEffort,
    ...capabilities,
  }
}

export type ConsumeCreditInput = {
  userId: string
  amountMilli: number
  kind: string
  sourceType: string
  idempotencyKey: string
  referenceId?: string | null
  modelTier?: CreditModelTier | null
  multiplierBps?: number
  requestTokens?: number | null
  responseTokens?: number | null
  metadata?: Prisma.InputJsonValue
  /** Token 调用已发生时允许扣完剩余额度；固定价工具不可开启。 */
  allowPartialOnExhaustion?: boolean
}

export type CreditChargeResult = { chargedMilli: number; remainingMilli: number; exhausted: boolean; pendingUsage?: boolean }

function validateBillingInput<T>(validate: () => T): T {
  try { return validate() } catch (error) {
    if (error instanceof BillingInputError) throw new DataAccessError(400, 'CREDIT_INPUT_INVALID', error.message)
    throw error
  }
}

function assertChargeReplay(existing: Prisma.CreditLedgerEntryGetPayload<Record<string, never>>, input: ConsumeCreditInput, fingerprint: string): void {
  const conflict = () => { throw new DataAccessError(409, 'CREDIT_IDEMPOTENCY_CONFLICT', '收费请求身份不一致，需要核对原记录。') }
  if (existing.userId !== input.userId || existing.kind !== input.kind || existing.sourceType !== input.sourceType
    || existing.referenceId !== (input.referenceId ?? null) || existing.modelTier !== (input.modelTier ?? null)
    || existing.multiplierBps !== (input.multiplierBps ?? 10000) || existing.requestTokens !== (input.requestTokens ?? null)
    || existing.responseTokens !== (input.responseTokens ?? null) || existing.deltaMilli > 0) conflict()
  const stored = readCreditFingerprint(existing.metadata)
  if (stored !== null) {
    if (stored !== fingerprint) conflict()
    return
  }
  // Old rows are immutable. Reconstruct only the three known historical charge policies.
  if (!equalLegacyMetadata(existing.metadata, input.metadata) || existing.kind !== 'usage') conflict()
  if (existing.sourceType === 'model_tokens') {
    if (input.allowPartialOnExhaustion !== true || existing.requestTokens === null || existing.responseTokens === null) conflict()
    const expected = calculateTokenChargeMilli(existing.requestTokens!, existing.responseTokens!, existing.multiplierBps)
    if (expected !== input.amountMilli || -existing.deltaMilli > expected) conflict()
  } else if ((existing.sourceType === 'web_search' || existing.sourceType === 'image_generation') && !input.allowPartialOnExhaustion) {
    if (-existing.deltaMilli !== input.amountMilli) conflict()
  } else conflict()
}

/** Caller owns the Serializable transaction and retries the whole unit, never just this debit. */
export async function consumeCreditsInTransaction(tx: Prisma.TransactionClient, input: ConsumeCreditInput): Promise<CreditChargeResult> {
  const request = validateBillingInput(() => prepareCreditRequest(input))
  // Async transactions and retries must use exactly the input that was fingerprinted.
  input = request.snapshot
  const amountMilli = input.amountMilli

  const existing = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (existing) {
    assertChargeReplay(existing, input, request.fingerprint)
    const { account } = await ensureAccountWithDb(tx, input.userId)
    return {
      chargedMilli: Math.max(0, -existing.deltaMilli),
      remainingMilli: Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli) + account.bonusBalanceMilli,
      exhausted: amountMilli > 0 && (Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli) + account.bonusBalanceMilli <= 0 || -existing.deltaMilli < amountMilli),
    }
  }

  const { account, setting } = await ensureAccountWithDb(tx, input.userId)
  if (account.suspendedAt) throw new DataAccessError(423, setting.globallyPaused ? 'CREDITS_GLOBALLY_PAUSED' : 'CREDITS_ACCOUNT_SUSPENDED', setting.globallyPaused ? '公测模型服务已由管理员暂停，请稍后再试。' : '当前账户的模型使用权限已暂停。')

  const dailyRemaining = Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli)
  const ownUsageId = input.sourceType === 'model_tokens' && input.idempotencyKey.startsWith('usage:') ? input.idempotencyKey.slice(6) : undefined
  const otherReservations = await reservedTokenCredits(tx, input.userId, ownUsageId)
  const totalRemaining = Math.max(0, dailyRemaining + account.bonusBalanceMilli - otherReservations)
  if (totalRemaining < amountMilli && !input.allowPartialOnExhaustion) {
    if (otherReservations > 0 && dailyRemaining + account.bonusBalanceMilli >= amountMilli) {
      throw new DataAccessError(409, 'CREDITS_RESERVED', '可用额度暂被进行中或待核调用预留，请等待结算或预留释放。')
    }
    throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '今日额度已用尽，可邀请好友获得额外额度。')
  }
  const actualCharge = Math.min(totalRemaining, amountMilli)
  const dailyCharge = Math.min(dailyRemaining, actualCharge)
  const bonusCharge = actualCharge - dailyCharge
  const updated = await tx.creditAccount.update({
    where: { userId: input.userId },
    data: {
      dailyUsedMilli: { increment: dailyCharge },
      bonusBalanceMilli: { decrement: bonusCharge },
    },
  })
  await tx.creditLedgerEntry.create({
    data: {
      id: randomUUID(),
      userId: input.userId,
      deltaMilli: -actualCharge,
      dailyDeltaMilli: -dailyCharge,
      bonusDeltaMilli: -bonusCharge,
      kind: input.kind,
      sourceType: input.sourceType,
      referenceId: input.referenceId ?? null,
      idempotencyKey: input.idempotencyKey,
      modelTier: input.modelTier ?? null,
      multiplierBps: input.multiplierBps ?? 10000,
      requestTokens: input.requestTokens ?? null,
      responseTokens: input.responseTokens ?? null,
      metadata: request.metadata,
    },
  })
  return {
    chargedMilli: actualCharge,
    remainingMilli: Math.max(0, updated.dailyAllowanceMilli - updated.dailyUsedMilli) + updated.bonusBalanceMilli,
    exhausted: amountMilli > 0 && (actualCharge < amountMilli || (
      Math.max(0, updated.dailyAllowanceMilli - updated.dailyUsedMilli) + updated.bonusBalanceMilli <= 0
    )),
  }
}

export async function consumeCredits(input: ConsumeCreditInput): Promise<CreditChargeResult> {
  const captured = validateBillingInput(() => prepareCreditRequest(input)).snapshot
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(tx => consumeCreditsInTransaction(tx, captured), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2002') && attempt < 2) continue
      throw error
    }
  }
  throw new DataAccessError(409, 'CREDIT_CONCURRENCY_CONFLICT', '额度更新冲突，请重试。')
}

/** Only a proven search-service failure creates this obligation; provider cost
 * remains separate. This is deliberately not an arbitrary public refund API. */
const searchRefundEvidenceSchema = z.object({ attempts: z.array(z.object({
  provider: z.enum(['bocha', 'sogou', 'bing']), outcome: z.enum(['failed', 'aborted']), durationMs: z.number().int().nonnegative(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  providerRequestId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).optional(),
  providerCode: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).optional(),
}).strict()).min(1).max(3) }).strict()

export async function recordSearchRefundIntent(userId: string, originalIdempotencyKey: string, evidence: {
  attempts: Array<{ provider: string; outcome: string; durationMs: number; httpStatus?: number; providerRequestId?: string; providerCode?: string }>
}) {
  const parsed = searchRefundEvidenceSchema.safeParse(evidence)
  if (!parsed.success) {
    throw new DataAccessError(409, 'CREDIT_REFUND_EVIDENCE_INVALID', '搜索退款缺少有效失败记录。')
  }
  const { attempts } = parsed.data
  return prisma.$transaction(async tx => {
    const original = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: originalIdempotencyKey } })
    if (!original || original.userId !== userId || original.kind !== 'usage' || original.sourceType !== 'web_search' || original.deltaMilli >= 0) {
      throw new DataAccessError(409, 'CREDIT_REFUND_IDENTITY_INVALID', '未找到匹配的原搜索收费，不能创建退款。')
    }
    return tx.creditRefundIntent.upsert({ where: { originalEntryId: original.id }, update: {}, create: {
      originalEntryId: original.id, reason: 'search_service_unavailable', evidence: { attempts },
    } })
  })
}

export async function getSearchRefundState(userId: string, originalIdempotencyKey: string) {
  const intent = await prisma.creditRefundIntent.findFirst({ where: { originalEntry: { userId, idempotencyKey: originalIdempotencyKey, sourceType: 'web_search' } } })
  return intent ? intent.settledAt ? 'settled' as const : 'pending' as const : null
}

const imageRefundEvidenceSchema = z.object({
  outcome: z.enum(['rejected', 'empty', 'unknown']),
  deliveredImages: z.literal(0),
}).strict()

/** No delivered result: refund the user without claiming that an upstream
 * timeout incurred zero provider cost. Generated assets use delivery recovery. */
export async function recordImageRefundIntent(userId: string, originalIdempotencyKey: string,
  evidence: z.infer<typeof imageRefundEvidenceSchema>) {
  const parsed = imageRefundEvidenceSchema.safeParse(evidence)
  if (!parsed.success) throw new DataAccessError(409, 'CREDIT_REFUND_EVIDENCE_INVALID', '图片退款缺少有效失败记录。')
  return prisma.$transaction(async tx => {
    const original = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: originalIdempotencyKey } })
    if (!original || original.userId !== userId || original.kind !== 'usage' || original.sourceType !== 'image_generation' || original.deltaMilli >= 0) {
      throw new DataAccessError(409, 'CREDIT_REFUND_IDENTITY_INVALID', '未找到匹配的原图片收费，不能创建退款。')
    }
    return tx.creditRefundIntent.upsert({ where: { originalEntryId: original.id }, update: {}, create: {
      originalEntryId: original.id, reason: 'image_generation_unavailable', evidence: parsed.data,
    } })
  })
}

/** Bounded retry over durable obligations; wallet, refund row and completion
 * marker commit together in refundCreditCharge. Replaying never pays twice. */
export async function reconcileCreditRefunds(input: { limit?: number; userId?: string } = {}) {
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DataAccessError(400, 'CREDIT_REFUND_BATCH_INVALID', '退款批次大小无效。')
  const pending = await prisma.creditRefundIntent.findMany({ where: { settledAt: null, nextAttemptAt: { lte: new Date() },
    ...(input.userId ? { originalEntry: { userId: input.userId } } : {}) }, orderBy: [{ nextAttemptAt: 'asc' }, { originalEntryId: 'asc' }], take: limit, include: { originalEntry: true } })
  let settled = 0
  for (const intent of pending) {
    try {
      const validSearch = intent.reason === 'search_service_unavailable' && intent.originalEntry.sourceType === 'web_search'
        && searchRefundEvidenceSchema.safeParse(intent.evidence).success
      const validImage = intent.reason === 'image_generation_unavailable' && intent.originalEntry.sourceType === 'image_generation'
        && imageRefundEvidenceSchema.safeParse(intent.evidence).success
      if (!validSearch && !validImage) throw new Error('Unsupported refund intent')
      await refundCreditCharge(intent.originalEntry.userId, intent.originalEntry.idempotencyKey, intent.reason)
      settled++
    } catch {
      await prisma.creditRefundIntent.updateMany({ where: { originalEntryId: intent.originalEntryId, settledAt: null }, data: {
        attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(intent.attempts, 7))),
      } })
    }
  }
  return { examined: pending.length, settled }
}

/** Retry only saved observations, never redispatch a model to recover its fee. */
export async function reconcileTokenSettlements(limit = 25) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DataAccessError(400, 'CREDIT_SETTLEMENT_BATCH_INVALID', '结算批次大小无效。')
  const pending = await prisma.aiUsageLog.findMany({ where: { providerType: 'text',
    AND: [{ OR: [{ modelTier: null }, { modelTier: { not: 'custom' } }] }, { OR: [
      { billingStatus: { in: ['observed', 'pending_settlement'] } },
      { billingStatus: 'pending_usage', usageSource: 'reported', requestTokens: { not: null }, responseTokens: { not: null },
        billingSnapshot: { path: ['version'], equals: 'credits-v2-itemized' } },
      { billingStatus: 'pending_usage', billingEvidence: { path: ['responseObserved'], equals: true } },
      { billingStatus: 'prepared', reservationExpiresAt: { lte: new Date() }, billingEvidence: { path: ['responseObserved'], equals: true } },
    ] }, { OR: [{ billingRetryAt: null }, { billingRetryAt: { lte: new Date() } }] }] },
    orderBy: [{ billingRetryAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: limit })
  for (const usage of pending) {
    try {
      const tier = usage.modelTier ?? 'speed'
      if (!(SERVER_MODEL_TIERS as readonly string[]).includes(tier)) throw new Error('Unsupported model tier')
      await consumeTokenCredits({ userId: usage.userId, usageLogId: usage.id,
        requestTokens: usage.requestTokens ?? 0, responseTokens: usage.responseTokens ?? 0,
        modelTier: tier as CreditModelTier, multiplierBps: usage.multiplierBps, referenceId: usage.targetId ?? usage.id })
    } catch {
      await prisma.aiUsageLog.updateMany({ where: { id: usage.id, billingStatus: { in: ['observed', 'pending_settlement', 'pending_usage'] } },
        data: { billingStatus: 'pending_settlement', billingRetryAt: new Date(Date.now() + 60_000) } })
    }
  }
}

export async function refundCreditCharge(userId: string, originalIdempotencyKey: string, reason: string): Promise<void> {
  const refundKey = `refund:${originalIdempotencyKey}`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        const original = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: originalIdempotencyKey } })
        const existingRefund = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: refundKey } })
        if (original && original.userId !== userId) {
          throw new DataAccessError(409, 'CREDIT_IDEMPOTENCY_CONFLICT', '退款请求身份不一致，需要核对原记录。')
        }
        if (existingRefund) {
          const metadata = existingRefund.metadata
          if (existingRefund.userId !== userId || existingRefund.kind !== 'refund' || !original
            || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.originalEntryId !== original.id
            || existingRefund.deltaMilli !== -original.deltaMilli) {
            throw new DataAccessError(409, 'CREDIT_IDEMPOTENCY_CONFLICT', '退款请求身份不一致，需要核对原记录。')
          }
          await tx.creditRefundIntent.updateMany({ where: { originalEntryId: original.id, settledAt: null }, data: { settledAt: new Date() } })
          return
        }
        if (!original || original.deltaMilli >= 0) return
        const { account } = await ensureAccountWithDb(tx, userId)
        const dailyRefund = Math.max(0, -original.dailyDeltaMilli)
        const originalBelongsToCurrentWindow = original.createdAt >= account.periodStartedAt
          && original.createdAt < account.periodEndsAt
        // Old-window refunds go to bonus; never decrement an already-reset daily counter.
        const currentWindowDailyRefund = originalBelongsToCurrentWindow
          ? Math.min(account.dailyUsedMilli, dailyRefund)
          : 0
        const bonusRefund = Math.max(0, -original.bonusDeltaMilli) + (dailyRefund - currentWindowDailyRefund)
        validateBillingInput(() => assertCreditInteger(account.bonusBalanceMilli + bonusRefund))
        await tx.creditAccount.update({
          where: { userId },
          data: {
            dailyUsedMilli: { decrement: currentWindowDailyRefund },
            bonusBalanceMilli: { increment: bonusRefund },
          },
        })
        await tx.creditLedgerEntry.create({
          data: {
            id: randomUUID(), userId,
            deltaMilli: -original.deltaMilli,
            dailyDeltaMilli: currentWindowDailyRefund,
            bonusDeltaMilli: bonusRefund,
            kind: 'refund', sourceType: original.sourceType,
            referenceId: original.referenceId, idempotencyKey: refundKey,
            modelTier: original.modelTier, multiplierBps: original.multiplierBps,
            requestTokens: original.requestTokens, responseTokens: original.responseTokens,
            metadata: { ...(readLedgerPriceMetadata(original.metadata) ?? {}), reason, originalEntryId: original.id },
          },
        })
        await tx.creditRefundIntent.updateMany({ where: { originalEntryId: original.id, settledAt: null }, data: { settledAt: new Date() } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2002') && attempt < 2) continue
      throw error
    }
  }
}

/** 1 Credit 同时包含 10,000 输入 Token 与 1,000 输出 Token；按两池占用率较高者扣减。 */
export function calculateTokenChargeMilli(requestTokens: number, responseTokens: number, multiplierBps = 10000): number {
  return validateBillingInput(() => calculateV1ChargeMilli(requestTokens, responseTokens, multiplierBps))
}

export async function consumeTokenCredits(input: {
  userId: string
  usageLogId: string
  requestTokens: number
  responseTokens: number
  modelTier?: CreditModelTier
  multiplierBps?: number
  referenceId?: string | null
}, transaction?: Prisma.TransactionClient): Promise<CreditChargeResult> {
  input = { ...input }
  const multiplierBps = input.multiplierBps ?? 10000
  const request: ConsumeCreditInput = {
    userId: input.userId,
    amountMilli: 0, // Resolved from the operation's saved price inside the settlement transaction.
    kind: 'usage',
    sourceType: 'model_tokens',
    idempotencyKey: `usage:${input.usageLogId}`,
    referenceId: input.referenceId ?? input.usageLogId,
    modelTier: input.modelTier ?? 'speed',
    multiplierBps,
    requestTokens: input.requestTokens,
    responseTokens: input.responseTokens,
    allowPartialOnExhaustion: true,
  }
  const settle = async (tx: Prisma.TransactionClient) => {
    const usage = await tx.aiUsageLog.findFirst({ where: { id: input.usageLogId, userId: input.userId, providerType: 'text' } })
    if (!usage || (usage.requestTokens ?? 0) !== input.requestTokens || (usage.responseTokens ?? 0) !== input.responseTokens
      || (usage.modelTier ?? 'speed') !== (input.modelTier ?? 'speed') || usage.multiplierBps !== multiplierBps) {
      throw new DataAccessError(409, 'CREDIT_USAGE_MISMATCH', '用量记录与结算请求不一致，未扣款。')
    }
    const price = usage.billingSnapshot == null ? null : tokenPriceSchema.safeParse(usage.billingSnapshot)
    if (price && (!price.success || price.data.modelTier !== (input.modelTier ?? 'speed'))) {
      throw new DataAccessError(409, 'CREDIT_PRICE_INVALID', '原调用的费率快照无效，未采用当前价格替代。')
    }
    const frozen = price?.success ? price.data : null
    const evidence = fallbackUsageEvidenceSchema.safeParse(usage.billingEvidence)
    const estimated = usage.usageSource !== 'reported' && evidence.success && evidence.data.responseObserved
    const billedInput = estimated ? usage.requestTokens ?? evidence.data.inputEstimate : input.requestTokens
    const billedOutput = estimated ? usage.responseTokens ?? evidence.data.outputEstimate : input.responseTokens
    let amountMilli: number
    let metadata: Prisma.InputJsonValue | undefined
    if (frozen?.version === 'credits-v2-itemized') {
      // Estimated/missing usage is not an invoice, nor is unknown cache a miss.
      // Keep the generated result and original observation for reconciliation.
      if (!estimated && (usage.usageSource !== 'reported' || usage.requestTokens === null || usage.responseTokens === null)) {
        const { account } = await ensureAccountWithDb(tx, input.userId)
        await tx.aiUsageLog.update({ where: { id: usage.id }, data: { billingStatus: 'pending_usage', billingRetryAt: null } })
        return { chargedMilli: 0, remainingMilli: Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli) + account.bonusBalanceMilli,
          exhausted: false, pendingUsage: true }
      }
      // Later cache evidence must not claw back an already granted concession.
      // Reuse its original metadata; the ledger's normal identity checks still
      // validate owner, tokens, frozen rates and reference before replaying.
      const original = usage.billingStatus === 'settled'
        ? await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: request.idempotencyKey }, select: { userId: true, metadata: true } }) : null
      const originalMetadata = original?.userId === input.userId && original.metadata && typeof original.metadata === 'object' && !Array.isArray(original.metadata)
        ? original.metadata : null
      const retainedDiscount = originalMetadata?.cachePricingPolicy === 'unknown-cache-discount-2026-09-09'
      const cacheHitTokens = retainedDiscount ? null : usage.promptCacheHitTokens
      amountMilli = validateBillingInput(() => calculateV2UserChargeMilli(billedInput, billedOutput, cacheHitTokens, frozen.rates, frozen.v1CeilingBps))
      metadata = { pricingVersion: frozen.version, rateCardId: frozen.rateCardId, rates: frozen.rates,
        cacheHitTokens, cacheMissTokens: retainedDiscount ? originalMetadata!.cacheMissTokens : usage.promptCacheMissTokens,
        ...(cacheHitTokens === null ? { cachePricingPolicy: 'unknown-cache-discount-2026-09-09', platformAbsorbsDifference: true } : {}),
        ...(estimated ? { usagePolicy: FALLBACK_USAGE_POLICY, estimated: true } : {}),
        ...(frozen.v1CeilingBps !== undefined ? { v1CeilingBps: frozen.v1CeilingBps } : {}) }
    } else {
      if (frozen && frozen.multiplierBps !== multiplierBps) throw new DataAccessError(409, 'CREDIT_PRICE_INVALID', '原调用倍率与用量记录不一致。')
      amountMilli = calculateTokenChargeMilli(billedInput, billedOutput, multiplierBps)
      if (estimated) metadata = { usagePolicy: FALLBACK_USAGE_POLICY, estimated: true }
    }
    const charged = await consumeCreditsInTransaction(tx, { ...request, amountMilli, requestTokens: billedInput, responseTokens: billedOutput,
      multiplierBps: frozen?.multiplierBps ?? multiplierBps, metadata })
    // CR03: ledger, wallet and displayed charge commit together. The previously
    // saved usage observation survives rollback and keeps its stable retry key.
    await tx.aiUsageLog.update({ where: { id: usage.id }, data: { creditChargeMilli: charged.chargedMilli, billingStatus: 'settled', billingRetryAt: null, reservedCreditMilli: 0, reservationExpiresAt: null } })
    return charged
  }
  if (transaction) return settle(transaction)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await prisma.$transaction(settle, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }) }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2002') && attempt < 2) continue
      throw error
    }
  }
  throw new DataAccessError(409, 'CREDIT_CONCURRENCY_CONFLICT', '额度更新冲突，请重试。')
}

export async function initializeNewUserCredits(
  tx: Prisma.TransactionClient,
  userId: string,
  referralCode?: string | null,
): Promise<void> {
  const setting = await getGlobalSetting(tx)
  const now = new Date()
  const window = getCreditWindow(now, setting.resetHourUtc8)
  // 注册即建账：暂停期间注册的新用户必须继承全局暂停，否则将绕过计费门禁。
  await tx.creditAccount.create({ data: buildNewCreditAccountData(userId, setting, window, now) })
  await tx.referralCode.create({ data: { userId, code: makeReferralCode(userId) } })

  const normalizedCode = referralCode?.trim().toUpperCase()
  if (!normalizedCode) return
  const source = await tx.referralCode.findUnique({ where: { code: normalizedCode } })
  if (!source || source.userId === userId) {
    throw new DataAccessError(400, 'REFERRAL_INVALID', '邀请链接无效或已失效。')
  }
  await ensureAccountWithDb(tx, source.userId)
  await tx.referralRedemption.create({
    data: {
      id: randomUUID(),
      code: source.code,
      inviterUserId: source.userId,
      inviteeUserId: userId,
      inviterRewardMilli: REFERRER_REWARD_MILLI,
      inviteeRewardMilli: REFEREE_REWARD_MILLI,
    },
  })
  await tx.creditAccount.update({ where: { userId: source.userId }, data: { bonusBalanceMilli: { increment: REFERRER_REWARD_MILLI } } })
  await tx.creditAccount.update({ where: { userId }, data: { bonusBalanceMilli: { increment: REFEREE_REWARD_MILLI } } })
  await tx.creditLedgerEntry.createMany({
    data: [
      {
        id: randomUUID(), userId: source.userId, deltaMilli: REFERRER_REWARD_MILLI, bonusDeltaMilli: REFERRER_REWARD_MILLI,
        kind: 'reward', sourceType: 'referral_inviter', referenceId: userId, idempotencyKey: `referral:inviter:${userId}`,
      },
      {
        id: randomUUID(), userId, deltaMilli: REFEREE_REWARD_MILLI, bonusDeltaMilli: REFEREE_REWARD_MILLI,
        kind: 'reward', sourceType: 'referral_invitee', referenceId: source.userId, idempotencyKey: `referral:invitee:${userId}`,
      },
    ],
  })
}

async function ensureReferralCode(userId: string) {
  const existing = await prisma.referralCode.findUnique({ where: { userId } })
  if (existing) return existing
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.referralCode.create({ data: { userId, code: makeReferralCode() } })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue
      throw error
    }
  }
  throw new DataAccessError(500, 'REFERRAL_CODE_FAILED', '暂时无法生成邀请链接，请稍后重试。')
}

export async function getReferralPayload(userId: string, publicOrigin: string): Promise<ReferralPayload> {
  await ensureCreditAccount(userId)
  const code = await ensureReferralCode(userId)
  const [successfulInvites, rewards] = await Promise.all([
    prisma.referralRedemption.count({ where: { inviterUserId: userId } }),
    prisma.creditLedgerEntry.aggregate({ where: { userId, sourceType: 'referral_inviter' }, _sum: { deltaMilli: true } }),
  ])
  return {
    code: code.code,
    inviteUrl: `${publicOrigin.replace(/\/$/, '')}/register?ref=${encodeURIComponent(code.code)}`,
    inviterReward: 300,
    inviteeReward: 120,
    successfulInvites,
    totalEarned: milliToCredits(rewards._sum.deltaMilli ?? 0),
  }
}
