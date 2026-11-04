import { createHmac, randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { AdminYunshuCall, AdminYunshuModelUsage, AdminYunshuOperations, AdminYunshuOperationsQuery, AdminYunshuUsagePeriod } from '../../shared/contracts/admin-yunshu-usage.js'
import { env } from '../config/env.js'
import { prisma } from './prisma.js'
import { decryptSecret } from './secret-box.js'
import { readModelRoutes } from './model-route-pool.js'
import { readWeightedRoutes } from './model-weighted-config.js'
import { adminModelKind } from './model-lifecycle.js'
import { getToolModelRuntime } from './tool-model-config.js'
import { analyticsWindow } from './data/admin-analytics.js'

const ORIGIN = 'https://yunshu.chevolink.com'
const count = z.number().int().nonnegative().safe()
const wireLog = z.object({
  token_id: count, type: count, created_at: count, model_name: z.string().max(160),
  group: z.string().max(100).nullish(), request_id: z.string().max(128).optional(),
  prompt_tokens: count.nullish(), completion_tokens: count.nullish(), other: z.string().max(500000).nullish(),
  content: z.string().max(500000).optional(), quota: z.number().int().safe().optional(),
  use_time: count.optional(), is_stream: z.boolean().optional(),
})
type Source = { identity: string; key: string | null }
type Dependencies = { loadToken: () => Promise<string | null>; loadSources: () => Promise<Source[]>; fetch: typeof fetch; now: () => number }

/** Display conversion only; exact integer quota is retained separately. */
function displayQuota(quota: string | null, unit: { quotaPerUnit: number | null; type: string | null; rate: number | null }): string | null {
  if (quota === null || !unit.type) return null
  if (unit.type === 'TOKENS') return quota
  if (!unit.quotaPerUnit || !unit.rate) return null
  const fraction = (value: number) => {
    const [mantissa, exponent = '0'] = value.toString().split('e')
    const [integer, decimal = ''] = mantissa.split('.')
    const scale = decimal.length - Number(exponent)
    return { coefficient: BigInt(integer + decimal) * (scale < 0 ? 10n ** BigInt(-scale) : 1n), denominator: scale > 0 ? 10n ** BigInt(scale) : 1n }
  }
  const perUnit = fraction(unit.quotaPerUnit), rate = fraction(unit.rate)
  const numerator = BigInt(quota) * rate.coefficient * perUnit.denominator
  const denominator = perUnit.coefficient * rate.denominator
  const rounded = ((numerator < 0n ? -numerator : numerator) * 10n ** 12n + denominator / 2n) / denominator
  if (numerator !== 0n && rounded === 0n) return null
  const digits = rounded.toString().padStart(13, '0')
  const value = `${digits.slice(0, -12)}.${digits.slice(-12)}`.replace(/\.?0+$/, '')
  return numerator < 0n && rounded !== 0n ? `-${value}` : value
}

async function protectedToken(): Promise<string | null> {
  let value = env.yunshuAdminAccessToken.trim()
  if (env.yunshuAdminAccessTokenFile) {
    if (!isAbsolute(env.yunshuAdminAccessTokenFile)) throw new Error('YUNSHU_TOKEN_CONFIG')
    const file = await open(env.yunshuAdminAccessTokenFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('YUNSHU_TOKEN_CONFIG')
      value = (await file.readFile('utf8')).trim()
    } finally { await file.close() }
  }
  if (!value) return null
  if (!/^nap_[A-Za-z0-9_-]{16,200}$/.test(value)) throw new Error('YUNSHU_TOKEN_CONFIG')
  return value
}

async function platformSources(): Promise<Source[]> {
  const records = await prisma.aiModelConfig.findMany({ where: { ownerUserId: null, archivedAt: null, enabled: true } })
  const result: Source[] = []
  const add = (identity: string, baseUrl: string | null, ciphertext?: string | null, fallback = '') => {
    if (!baseUrl) return
    const url = new URL(baseUrl)
    if (url.origin !== ORIGIN || url.username || url.password) return
    result.push({ identity, key: ciphertext ? decryptSecret(ciphertext) : fallback || null })
  }
  for (const record of records) {
    const text = adminModelKind(record.metadata) === 'text' && Boolean(record.tier) && !record.key.startsWith('tool:') && !record.tier?.startsWith('tool_')
    add(`${record.id}:${record.revision}`, record.baseUrl ?? (text ? env.aiTextBaseUrl : null), record.apiKeyCiphertext, text ? env.aiTextApiKey : '')
    for (const route of readModelRoutes(record.metadata).filter(route => route.enabled)) add(`${record.id}:${record.revision}:${route.id}`, route.baseUrl, route.apiKeyCiphertext)
    for (const route of readWeightedRoutes(record.metadata)?.candidates ?? []) if (route.weight > 0) add(`${record.id}:${record.revision}:${route.id}`, route.baseUrl, route.apiKeyCiphertext)
  }
  if (await prisma.aiModelConfig.count({ where: { ownerUserId: null } }) === 0) add('env:text', env.aiTextBaseUrl, null, env.aiTextApiKey)
  // Tool runtimes retain their environment fallback when no complete platform config exists.
  for (const [key, baseUrl, apiKey] of [
    ['tool:image-generation', env.aiImageBaseUrl, env.aiImageApiKey],
    ['tool:image-vision', env.aiVisionBaseUrl, env.aiVisionApiKey],
  ] as const) {
    const runtime = await getToolModelRuntime(key)
    if (runtime) add(`runtime:${key}:${runtime.modelConfigId ?? ''}:${runtime.modelConfigRevision ?? ''}`, runtime.baseUrl, null, runtime.apiKey)
    else add(`env:${key}`, baseUrl, null, apiKey)
  }
  return result
}

/** Read-only gateway observations. This never reconciles or writes local billing. */
export function createAdminYunshuUsageService(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { loadToken: protectedToken, loadSources: platformSources, fetch: (...args) => fetch(...args), now: Date.now, ...overrides }
  const salt = randomBytes(32)
  const fingerprint = (value: unknown) => createHmac('sha256', salt).update(JSON.stringify(value)).digest('hex')
  const cache = new Map<AdminYunshuUsagePeriod, { identity: string; at: number; value: AdminYunshuModelUsage; records: AdminYunshuCall[] }>()
  const active = new Map<AdminYunshuUsagePeriod, { identity: string; windowFrom: string; promise: Promise<AdminYunshuModelUsage> }>()
  type Display = AdminYunshuOperations['cost']['display']
  type Balance = AdminYunshuOperations['balance']
  const emptyDisplay: Display = { state: 'not_requested', observedAt: null, message: '尚未读取云枢状态接口。', quotaPerUnit: null, type: null, rate: null, symbol: null, deduction: null, refund: null, net: null }
  const emptyBalance: Balance = { scope: 'management_account', state: 'not_requested', observedAt: null, message: '尚未读取云枢管理账号余额。', remainingQuota: null, usedQuota: null, displayRemaining: null, displayUsed: null }
  const auxCache = new Map<'display' | 'balance', { identity: string; at: number; value: Display | Balance }>()
  const auxActive = new Map<'display' | 'balance', { identity: string; promise: Promise<Display | Balance> }>()
  type Mapping = { allowed: Set<number>; status: AdminYunshuModelUsage['sources'] }
  let mappingCache: { identity: string; expiresAt: number; value: Mapping } | undefined
  let mappingActive: { identity: string; promise: Promise<Mapping> } | undefined
  let retryAt = 0
  const rateLimitMessage = () => `云枢查询触发频率限制，请在 ${new Date(retryAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（UTC+8）后刷新；等待期间不再请求云枢。`
  async function get(path: '/api/log/' | '/api/log/token' | '/api/status' | '/api/user/self', credential: string | null, signal: AbortSignal, query?: URLSearchParams, onBytes?: (size: number) => void): Promise<unknown> {
    signal.throwIfAborted()
    if (retryAt > deps.now()) throw new Error('YUNSHU_RATE_LIMITED')
    const response = await deps.fetch(`${ORIGIN}${path}${query ? `?${query}` : ''}`, { method: 'GET', headers: credential ? { Authorization: `Bearer ${credential}` } : {}, redirect: 'error', signal })
    if (response.status === 429) {
      const header = response.headers.get('Retry-After') ?? ''
      const seconds = /^\d+$/.test(header) ? Number(header) : NaN
      const wait = Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(deps.now() + seconds * 1000) && Number.isFinite(new Date(deps.now() + seconds * 1000).getTime()) ? seconds : 1200
      retryAt = Math.max(retryAt, deps.now() + wait * 1000)
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new Error(response.status === 403 ? 'YUNSHU_READ_FORBIDDEN' : 'YUNSHU_READ_FAILED')
    }
    const reader = response.body.getReader()
    let size = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 4 * 1024 * 1024) throw new Error('YUNSHU_SIZE_LIMIT')
        onBytes?.(chunk.value.length)
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
  let scopeIdentity = ''
  const read = async (period: AdminYunshuUsagePeriod, callerSignal?: AbortSignal): Promise<AdminYunshuModelUsage> => {
    callerSignal?.throwIfAborted()
    const attemptedAt = deps.now()
    const window = analyticsWindow(period === 'today' ? 'day' : period, new Date(attemptedAt))
    const empty: AdminYunshuModelUsage = { source: 'yunshu_admin_logs', scope: 'configured_platform_tokens', period,
      window: { from: window.from.toISOString(), to: window.to.toISOString() }, observedAt: null, state: 'unconfigured', coverage: 'partial',
      paginationComplete: false, message: '未配置云枢管理员只读凭据。', lastAttemptAt: null, sources: { configured: 0, verified: 0, unresolved: 0 }, models: [] }
    let token: string | null
    let sources: Source[]
    try {
      token = await deps.loadToken()
      if (!token) { scopeIdentity = ''; cache.clear(); auxCache.clear(); mappingCache = undefined; mappingActive = undefined; return empty }
      sources = await deps.loadSources()
    } catch {
      scopeIdentity = ''; cache.clear(); auxCache.clear(); mappingCache = undefined; mappingActive = undefined
      return { ...empty, state: 'error', lastAttemptAt: new Date(attemptedAt).toISOString(), message: '管理员只读凭据或平台来源配置不可用，未显示旧范围数据。' }
    }
    const identity = fingerprint([token, sources])
    callerSignal?.throwIfAborted()
    if (identity !== scopeIdentity) { cache.clear(); auxCache.clear(); mappingCache = undefined; mappingActive = undefined; scopeIdentity = identity }
    const previous = cache.get(period)
    if (retryAt > deps.now()) {
      if (previous?.identity === identity && previous.value.window.from === empty.window.from) return { ...structuredClone(previous.value), state: 'stale', lastAttemptAt: new Date(attemptedAt).toISOString(), message: rateLimitMessage() }
      return { ...empty, state: 'error', lastAttemptAt: new Date(attemptedAt).toISOString(), message: rateLimitMessage() }
    }
    if (previous?.identity === identity && attemptedAt - previous.at < 60000 && previous.value.window.from === empty.window.from) return structuredClone(previous.value)
    const inFlight = active.get(period)
    let operation = inFlight?.identity === identity && inFlight.windowFrom === empty.window.from ? inFlight.promise : undefined
    if (!operation) {
      operation = (async () => {
        const signal = AbortSignal.timeout(20000)
        let totalBytes = 0
        const accountBytes = (size: number) => {
          totalBytes += size
          if (totalBytes > 32 * 1024 * 1024) throw new Error('YUNSHU_SIZE_LIMIT')
        }
        const unique = new Map<string, Source>()
        for (const source of sources) unique.set(source.key ? fingerprint(source.key) : source.identity, source)
        const status = { configured: unique.size, verified: 0, unresolved: 0 }
        try {
          let mapping = mappingCache?.identity === identity && mappingCache.expiresAt > deps.now() ? mappingCache.value : undefined
          if (!mapping) {
            let pending = mappingActive?.identity === identity ? mappingActive.promise : undefined
            if (!pending) {
              pending = (async () => {
                const result: Mapping = { allowed: new Set(), status: { configured: unique.size, verified: 0, unresolved: 0 } }
                for (const source of unique.values()) {
                  if (!source.key?.trim()) { result.status.unresolved++; continue }
                  const response = z.object({ success: z.literal(true), data: z.array(z.object({ token_id: count.positive() })).max(1000) }).parse(await get('/api/log/token', source.key, signal, undefined, accountBytes))
                  const ids = new Set(response.data.map(row => row.token_id))
                  if (ids.size !== 1) { result.status.unresolved++; continue }
                  result.allowed.add(response.data[0].token_id); result.status.verified++
                }
                const currentIdentity = fingerprint([await deps.loadToken(), await deps.loadSources()])
                if (scopeIdentity !== identity || currentIdentity !== identity) throw new Error('YUNSHU_SCOPE_CHANGED')
                mappingCache = { identity, expiresAt: deps.now() + 30 * 60000, value: result }
                return result
              })()
              const entry = { identity, promise: pending }
              mappingActive = entry
              void pending.finally(() => { if (mappingActive === entry) mappingActive = undefined }).catch(() => {})
            }
            mapping = await pending
          }
          const allowed = mapping.allowed
          Object.assign(status, mapping.status)
          empty.sources = status
          if (!allowed.size) return { ...empty, state: 'partial' as const, lastAttemptAt: new Date(attemptedAt).toISOString(), message: status.configured ? '平台令牌暂无可验证记录，来源未知；未查询全部网关数据。' : '没有可查询的云枢平台模型配置。' }
          const models = new Map<string, AdminYunshuModelUsage['models'][number]>()
          const records: AdminYunshuCall[] = []
          const seen = new Map<string, number>()
          let complete = false
          let uncertain = false
          let expectedTotal: number | null = null
          let received = 0
          for (let page = 1; page <= 100; page++) {
            const query = new URLSearchParams({ p: String(page), page_size: '100', start_timestamp: String(Math.floor(window.from.getTime() / 1000)), end_timestamp: String(Math.ceil(window.to.getTime() / 1000) - 1) })
            const response = z.object({ success: z.literal(true), data: z.object({ page: count.positive(), page_size: count.positive().max(100), total: count, items: z.array(wireLog).max(100) }) }).parse(await get('/api/log/', token!, signal, query, accountBytes))
            const data = response.data
            if (data.page !== page || data.page_size !== 100) throw new Error('YUNSHU_PAGE_INVALID')
            if (expectedTotal !== null && expectedTotal !== data.total) uncertain = true
            expectedTotal ??= data.total
            received += data.items.length
            const pageOccurrences = new Map<string, number>()
            for (const row of data.items) {
              if (!allowed.has(row.token_id) || row.created_at * 1000 < window.from.getTime() || row.created_at * 1000 >= window.to.getTime()) continue
              if (![2, 5, 6].includes(row.type)) continue
              const dedupe = fingerprint(row)
              const occurrence = (pageOccurrences.get(dedupe) ?? 0) + 1
              pageOccurrences.set(dedupe, occurrence)
              // Preserve same-page multiplicity; across offset pages only the
              // maximum observed multiplicity is safe to count as new evidence.
              if (occurrence <= (seen.get(dedupe) ?? 0)) { uncertain = true; continue }
              if (!row.request_id) uncertain = true
              const key = JSON.stringify([row.model_name, row.group ?? null])
              let model = models.get(key)
              if (!model) { model = { modelName: row.model_name || '未知模型', group: row.group ?? null, requestCount: 0, requestTokens: 0, responseTokens: 0, cacheHitTokens: 0, cacheWriteTokens: 0, errorCount: 0, refundCount: 0 }; models.set(key, model) }
              let other: Record<string, unknown> = {}
              try { const value: unknown = JSON.parse(row.other ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) other = value as Record<string, unknown> } catch { uncertain = true }
              const stream = other.stream_status && typeof other.stream_status === 'object' && !Array.isArray(other.stream_status) ? other.stream_status as Record<string, unknown> : null
              const duration = row.use_time !== undefined && row.use_time > 0 && Number.isSafeInteger(row.use_time * 1000) ? row.use_time * 1000 : null
              records.push({ id: `${dedupe}:${occurrence}`, createdAt: new Date(row.created_at * 1000).toISOString(), modelName: model.modelName, group: model.group,
                kind: row.type === 2 ? 'consume' : row.type === 5 ? 'error' : 'refund', requestId: row.request_id && /^[A-Za-z0-9_.:-]{1,128}$/.test(row.request_id) ? row.request_id : null,
                requestTokens: row.type === 2 ? row.prompt_tokens ?? null : null, responseTokens: row.type === 2 ? row.completion_tokens ?? null : null,
                durationMs: duration, streamOutcome: row.is_stream && (stream?.status === 'ok' || stream?.status === 'error') ? stream.status : 'unknown',
                quota: row.quota !== undefined && row.quota >= 0 ? String(row.quota) : null })
              if (row.type === 5) { model.errorCount++; continue }
              if (row.type === 6) { model.refundCount++; continue }
              model.requestCount++
              const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
              const writes = tokenCount(other.cache_creation_tokens)
              const short = tokenCount(other.cache_creation_tokens_5m), long = tokenCount(other.cache_creation_tokens_1h)
              const values = { requestTokens: row.prompt_tokens ?? null, responseTokens: row.completion_tokens ?? null, cacheHitTokens: tokenCount(other.cache_tokens), cacheWriteTokens: writes ?? (short !== null || long !== null ? (short ?? 0) + (long ?? 0) : null) }
              for (const field of ['requestTokens', 'responseTokens', 'cacheHitTokens', 'cacheWriteTokens'] as const) {
                const value = values[field], old = model[field]
                model[field] = old !== null && value !== null && Number.isSafeInteger(old + value) ? old + value : null
              }
            }
            for (const [row, occurrences] of pageOccurrences) seen.set(row, Math.max(seen.get(row) ?? 0, occurrences))
            if (received >= data.total || data.items.length < 100) { complete = received === data.total; break }
          }
          const value: AdminYunshuModelUsage = { ...empty, state: 'partial', observedAt: new Date(deps.now()).toISOString(), lastAttemptAt: new Date(attemptedAt).toISOString(), sources: status,
            paginationComplete: complete && !uncertain, models: [...models.values()].sort((a, b) => b.requestCount - a.requestCount || a.modelName.localeCompare(b.modelName)),
            message: '来源为当前平台配置令牌的云枢实际日志；令牌可能共享，历史更换、日志保留及迟到退款覆盖未核实，不代表完整对账。' + (!complete || uncertain ? ' 本次分页或记录标识存在不完整情况。' : '') + (status.unresolved ? ' 部分配置来源未识别。' : '') }
          const currentIdentity = fingerprint([await deps.loadToken(), await deps.loadSources()])
          if (scopeIdentity !== identity || currentIdentity !== identity) { cache.clear(); return { ...empty, state: 'error', message: '平台来源配置已变化，请刷新后重新查询。' } }
          cache.set(period, { identity, at: deps.now(), value, records })
          return value
        } catch {
          let currentIdentity: string | null = null
          try { currentIdentity = fingerprint([await deps.loadToken(), await deps.loadSources()]) } catch { /* Configuration failure invalidates prior scope. */ }
          if (currentIdentity !== identity || scopeIdentity !== identity) {
            for (const [cachedPeriod, snapshot] of cache) if (snapshot.identity === identity) cache.delete(cachedPeriod)
            if (scopeIdentity === identity) scopeIdentity = ''
            if (mappingCache?.identity === identity) mappingCache = undefined
            if (mappingActive?.identity === identity) mappingActive = undefined
            return { ...empty, state: 'error' as const, lastAttemptAt: new Date(attemptedAt).toISOString(), message: '管理员凭据或平台来源配置已变化或不可用，未显示旧范围数据。' }
          }
          if (scopeIdentity === identity && previous?.identity === identity && previous.value.window.from === empty.window.from) return { ...structuredClone(previous.value), state: 'stale' as const, lastAttemptAt: new Date(attemptedAt).toISOString(), message: retryAt > deps.now() ? rateLimitMessage() : '云枢只读查询失败或超时；保留上次成功快照，未重试。' }
          return { ...empty, sources: status, state: 'error' as const, lastAttemptAt: new Date(attemptedAt).toISOString(), message: retryAt > deps.now() ? rateLimitMessage() : '云枢只读查询失败、权限不足或返回无效；未显示估算值，未重试。' }
        }
      })()
      const entry = { identity, windowFrom: empty.window.from, promise: operation }
      active.set(period, entry)
      void operation.finally(() => { if (active.get(period) === entry) active.delete(period) })
    }
    if (!callerSignal) return structuredClone(await operation)
    callerSignal.throwIfAborted()
    let abort: () => void = () => {}
    try {
      return structuredClone(await Promise.race([operation, new Promise<never>((_, reject) => { abort = () => reject(new Error('YUNSHU_CALLER_ABORTED')); callerSignal.addEventListener('abort', abort, { once: true }) })]))
    } finally { callerSignal.removeEventListener('abort', abort) }
  }
  const readAux = async (kind: 'display' | 'balance', identity: string): Promise<Display | Balance> => {
    const empty = kind === 'display' ? emptyDisplay : emptyBalance
    if (!identity) return { ...empty, state: 'unconfigured', message: '云枢保护凭据或平台来源未配置。' }
    const previous = auxCache.get(kind)
    if (retryAt > deps.now()) return previous?.identity === identity && previous.value.observedAt
      ? { ...structuredClone(previous.value), state: 'stale', message: rateLimitMessage() }
      : { ...empty, state: 'error', message: rateLimitMessage() }
    if (previous?.identity === identity && deps.now() - previous.at < 60000) return structuredClone(previous.value)
    const current = auxActive.get(kind)
    if (current?.identity === identity) return structuredClone(await current.promise)
    const operation = (async (): Promise<Display | Balance> => {
      try {
        const token = await deps.loadToken()
        if (!token || fingerprint([token, await deps.loadSources()]) !== identity || scopeIdentity !== identity) throw new Error('YUNSHU_SCOPE_CHANGED')
        const response = await get(kind === 'display' ? '/api/status' : '/api/user/self', kind === 'display' ? null : token, AbortSignal.timeout(10000))
        let value: Display | Balance
        if (kind === 'display') {
          const positive = z.number().finite().positive()
          const { data } = z.object({ success: z.literal(true), data: z.object({ quota_per_unit: positive, quota_display_type: z.enum(['USD', 'CNY', 'CUSTOM', 'TOKENS']), usd_exchange_rate: positive.optional(), custom_currency_symbol: z.string().min(1).max(20).optional(), custom_currency_exchange_rate: positive.optional() }) }).parse(response)
          const rate = data.quota_display_type === 'CNY' ? data.usd_exchange_rate : data.quota_display_type === 'CUSTOM' ? data.custom_currency_exchange_rate : 1
          const symbol = data.quota_display_type === 'CNY' ? '¥' : data.quota_display_type === 'CUSTOM' ? data.custom_currency_symbol : data.quota_display_type === 'TOKENS' ? '网关额度单位' : '$'
          if (!rate || !symbol) throw new Error('YUNSHU_UNIT_UNKNOWN')
          value = { ...emptyDisplay, state: 'ready', observedAt: new Date(deps.now()).toISOString(), message: '云枢状态接口可连接；按当前展示配置换算，最多12位小数，低于显示精度时保留原始额度。此状态不代表所有模型可用。', quotaPerUnit: data.quota_per_unit, type: data.quota_display_type, rate, symbol }
        } else {
          const { data } = z.object({ success: z.literal(true), data: z.object({ quota: z.number().int().safe(), used_quota: count }) }).parse(response)
          value = { ...emptyBalance, state: 'ready', observedAt: new Date(deps.now()).toISOString(), message: '当前云枢管理账号余额，可能由其他应用共享；不是墨域专属余额或供应商余额。', remainingQuota: String(data.quota), usedQuota: String(data.used_quota) }
        }
        if (scopeIdentity !== identity || fingerprint([await deps.loadToken(), await deps.loadSources()]) !== identity) throw new Error('YUNSHU_SCOPE_CHANGED')
        auxCache.set(kind, { identity, at: deps.now(), value })
        return value
      } catch (error) {
        let verified = false
        try { verified = scopeIdentity === identity && fingerprint([await deps.loadToken(), await deps.loadSources()]) === identity } catch { /* Never return a prior scope after configuration failure. */ }
        if (!verified) {
          if (auxCache.get(kind)?.identity === identity) auxCache.delete(kind)
          return { ...empty, state: 'error', message: '凭据或平台来源已变化或不可用，未显示旧范围数据。' }
        }
        const message = retryAt > deps.now() ? rateLimitMessage() : error instanceof Error && error.message === 'YUNSHU_READ_FORBIDDEN'
          ? kind === 'balance' ? '云枢管理账号余额读取被拒绝；现有凭据需要 profile:read，只读记录仍可用。' : '云枢状态接口拒绝读取；单位换算未知。'
          : kind === 'balance' ? '云枢管理账号余额读取失败；未用令牌额度或本地 Credits 替代。' : '云枢状态或单位配置读取失败；保留原始网关额度，换算未知。'
        const value: Display | Balance = previous?.identity === identity && previous.value.observedAt ? { ...structuredClone(previous.value), state: 'stale', message } : { ...empty, state: 'error', message }
        auxCache.set(kind, { identity, at: deps.now(), value })
        return value
      }
    })()
    const entry = { identity, promise: operation }
    auxActive.set(kind, entry)
    try { return structuredClone(await operation) }
    finally { if (auxActive.get(kind) === entry) auxActive.delete(kind) }
  }
  const operations = async (query: AdminYunshuOperationsQuery, signal?: AbortSignal): Promise<AdminYunshuOperations> => {
    const usage = await read(query.period, signal)
    const operationIdentity = scopeIdentity
    const snapshot = cache.get(query.period)
    const rows = snapshot?.identity === scopeIdentity && snapshot.value.observedAt === usage.observedAt ? snapshot.records : []
    const filtered = rows.filter(row => query.kind === 'all' || row.kind === query.kind)
    const totalPages = Math.max(1, Math.ceil(filtered.length / query.pageSize))
    const page = Math.min(query.page, totalPages)
    const consume = rows.filter(row => row.kind === 'consume'), errors = rows.filter(row => row.kind === 'error'), refunds = rows.filter(row => row.kind === 'refund')
    const streamOk = consume.filter(row => row.streamOutcome === 'ok').length, streamError = consume.filter(row => row.streamOutcome === 'error').length
    const samples = [...consume, ...errors].flatMap(row => row.durationMs === null ? [] : [row.durationMs]).sort((a, b) => a - b)
    const unknownDeductionCount = consume.filter(row => row.quota === null).length, unknownRefundCount = refunds.filter(row => row.quota === null).length
    const available = usage.observedAt !== null
    const deduction = available && !unknownDeductionCount ? consume.reduce((sum, row) => sum + BigInt(row.quota!), 0n).toString() : null
    const refund = available && !unknownRefundCount ? refunds.reduce((sum, row) => sum + BigInt(row.quota!), 0n).toString() : null
    const net = deduction !== null && refund !== null ? (BigInt(deduction) - BigInt(refund)).toString() : null
    let display: Display = { ...emptyDisplay }, balance: Balance = { ...emptyBalance }
    if (query.view !== 'records') {
      signal?.throwIfAborted()
      display = await readAux('display', scopeIdentity) as Display
    }
    if (query.view === 'cost') {
      signal?.throwIfAborted()
      balance = await readAux('balance', scopeIdentity) as Balance
    }
    signal?.throwIfAborted()
    const { models: _models, ...meta } = usage
    if (query.view !== 'records' && operationIdentity) {
      let verified = false
      try { verified = scopeIdentity === operationIdentity && fingerprint([await deps.loadToken(), await deps.loadSources()]) === operationIdentity } catch { /* A business error replaces client caches after scope loss. */ }
      if (!verified) {
        for (const [period, item] of cache) if (item.identity === operationIdentity) cache.delete(period)
        for (const [kind, item] of auxCache) if (item.identity === operationIdentity) auxCache.delete(kind)
        if (mappingCache?.identity === operationIdentity) mappingCache = undefined
        if (mappingActive?.identity === operationIdentity) mappingActive = undefined
        if (scopeIdentity === operationIdentity) scopeIdentity = ''
        const message = '云枢凭据或平台来源已变化或不可用，已清除旧范围数据，请刷新后重新读取。'
        return { ...meta, state: 'error', observedAt: null, lastAttemptAt: new Date(deps.now()).toISOString(), paginationComplete: false, message, sources: { configured: 0, verified: 0, unresolved: 0 },
          records: { items: [], page: 1, pageSize: query.pageSize, total: 0, totalPages: 1, hasMore: false, totalObserved: 0, kind: query.kind },
          health: { observation: 'no_samples', consumeCount: 0, errorCount: 0, refundCount: 0, streamSuccessCount: 0, streamErrorCount: 0, unknownOutcomeCount: 0, durationSamples: 0, p50Ms: null, p95Ms: null, lastSampleAt: null },
          cost: { deductionQuota: null, refundQuota: null, netQuota: null, unknownDeductionCount: 0, unknownRefundCount: 0, display: { ...emptyDisplay, state: 'error', message } },
          balance: { ...emptyBalance, state: 'error', message } }
      }
    }
    // A failed refresh may retain old raw metadata, but never uses stale currency rates for conversion.
    const liveUnit = display.state === 'ready' ? display : { quotaPerUnit: null, type: null, rate: null }
    display = { ...display, deduction: displayQuota(deduction, liveUnit), refund: displayQuota(refund, liveUnit), net: displayQuota(net, liveUnit) }
    balance = { ...balance, displayRemaining: displayQuota(balance.remainingQuota, liveUnit), displayUsed: displayQuota(balance.usedQuota, liveUnit) }
    return structuredClone({ ...meta,
      records: { items: filtered.slice((page - 1) * query.pageSize, page * query.pageSize), page, pageSize: query.pageSize, total: filtered.length, totalPages, hasMore: page < totalPages, totalObserved: rows.length, kind: query.kind },
      health: { observation: errors.length || streamError ? 'attention' : consume.length ? 'observed' : 'no_samples', consumeCount: consume.length, errorCount: errors.length, refundCount: refunds.length, streamSuccessCount: streamOk, streamErrorCount: streamError, unknownOutcomeCount: consume.length - streamOk - streamError,
        durationSamples: samples.length, p50Ms: samples.length ? samples[Math.ceil(samples.length * 0.5) - 1] : null, p95Ms: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null,
        lastSampleAt: [...consume, ...errors].reduce<string | null>((last, row) => last === null || row.createdAt > last ? row.createdAt : last, null) },
      cost: { deductionQuota: deduction, refundQuota: refund, netQuota: net, unknownDeductionCount, unknownRefundCount, display }, balance })
  }
  return { read, operations }
}
const service = createAdminYunshuUsageService()
export const getAdminYunshuModelUsage = service.read
export const getAdminYunshuOperations = service.operations
