import { createHmac, randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { AdminYunshuModelUsage, AdminYunshuUsagePeriod } from '../../shared/contracts/admin-yunshu-usage.js'
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
})
type Source = { identity: string; key: string | null }
type Dependencies = { loadToken: () => Promise<string | null>; loadSources: () => Promise<Source[]>; fetch: typeof fetch; now: () => number }

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
  const cache = new Map<AdminYunshuUsagePeriod, { identity: string; at: number; value: AdminYunshuModelUsage }>()
  const active = new Map<AdminYunshuUsagePeriod, { identity: string; windowFrom: string; promise: Promise<AdminYunshuModelUsage> }>()
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
      if (!token) { scopeIdentity = ''; cache.clear(); return empty }
      sources = await deps.loadSources()
    } catch {
      scopeIdentity = ''; cache.clear()
      return { ...empty, state: 'error', lastAttemptAt: new Date(attemptedAt).toISOString(), message: '管理员只读凭据或平台来源配置不可用，未显示旧范围数据。' }
    }
    const identity = fingerprint([token, sources])
    callerSignal?.throwIfAborted()
    if (identity !== scopeIdentity) { cache.clear(); scopeIdentity = identity }
    const previous = cache.get(period)
    if (previous?.identity === identity && attemptedAt - previous.at < 60000 && previous.value.window.from === empty.window.from) return structuredClone(previous.value)
    const inFlight = active.get(period)
    let operation = inFlight?.identity === identity && inFlight.windowFrom === empty.window.from ? inFlight.promise : undefined
    if (!operation) {
      operation = (async () => {
        const signal = AbortSignal.timeout(20000)
        let totalBytes = 0
        async function get(path: '/api/log/' | '/api/log/token', credential: string, query?: URLSearchParams): Promise<unknown> {
          signal.throwIfAborted()
          const response = await deps.fetch(`${ORIGIN}${path}${query ? `?${query}` : ''}`, { method: 'GET', headers: { Authorization: `Bearer ${credential}` }, redirect: 'error', signal })
          if (!response.ok || !response.body) {
            await response.body?.cancel().catch(() => {})
            throw new Error('YUNSHU_READ_FAILED')
          }
          const reader = response.body.getReader()
          let size = 0
          const chunks: Uint8Array[] = []
          try {
            while (true) {
              signal.throwIfAborted()
              const chunk = await reader.read()
              if (chunk.done) break
              size += chunk.value.length; totalBytes += chunk.value.length
              if (size > 4 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) throw new Error('YUNSHU_SIZE_LIMIT')
              chunks.push(chunk.value)
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
          return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        }
        const unique = new Map<string, Source>()
        for (const source of sources) unique.set(source.key ? fingerprint(source.key) : source.identity, source)
        const status = { configured: unique.size, verified: 0, unresolved: 0 }
        const allowed = new Set<number>()
        try {
          for (const source of unique.values()) {
            if (!source.key?.trim()) { status.unresolved++; continue }
            const response = z.object({ success: z.literal(true), data: z.array(z.object({ token_id: count.positive() })).max(1000) }).parse(await get('/api/log/token', source.key))
            const ids = new Set(response.data.map(row => row.token_id))
            if (ids.size !== 1) { status.unresolved++; continue }
            allowed.add(response.data[0].token_id); status.verified++
          }
          empty.sources = status
          if (!allowed.size) return { ...empty, state: 'partial' as const, lastAttemptAt: new Date(attemptedAt).toISOString(), message: status.configured ? '平台令牌暂无可验证记录，来源未知；未查询全部网关数据。' : '没有可查询的云枢平台模型配置。' }
          const models = new Map<string, AdminYunshuModelUsage['models'][number]>()
          const seen = new Map<string, number>()
          let complete = false
          let uncertain = false
          let expectedTotal: number | null = null
          let received = 0
          for (let page = 1; page <= 100; page++) {
            const query = new URLSearchParams({ p: String(page), page_size: '100', start_timestamp: String(Math.floor(window.from.getTime() / 1000)), end_timestamp: String(Math.ceil(window.to.getTime() / 1000) - 1) })
            const response = z.object({ success: z.literal(true), data: z.object({ page: count.positive(), page_size: count.positive().max(100), total: count, items: z.array(wireLog).max(100) }) }).parse(await get('/api/log/', token!, query))
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
              if (row.type === 5) { model.errorCount++; continue }
              if (row.type === 6) { model.refundCount++; continue }
              model.requestCount++
              let other: Record<string, unknown> = {}
              try { const value: unknown = JSON.parse(row.other ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) other = value as Record<string, unknown> } catch { uncertain = true }
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
          cache.set(period, { identity, at: deps.now(), value })
          return value
        } catch {
          let currentIdentity: string | null = null
          try { currentIdentity = fingerprint([await deps.loadToken(), await deps.loadSources()]) } catch { /* Configuration failure invalidates prior scope. */ }
          if (currentIdentity !== identity || scopeIdentity !== identity) {
            for (const [cachedPeriod, snapshot] of cache) if (snapshot.identity === identity) cache.delete(cachedPeriod)
            if (scopeIdentity === identity) scopeIdentity = ''
            return { ...empty, state: 'error' as const, lastAttemptAt: new Date(attemptedAt).toISOString(), message: '管理员凭据或平台来源配置已变化或不可用，未显示旧范围数据。' }
          }
          if (scopeIdentity === identity && previous?.identity === identity && previous.value.window.from === empty.window.from) return { ...structuredClone(previous.value), state: 'stale' as const, lastAttemptAt: new Date(attemptedAt).toISOString(), message: '云枢只读查询失败或超时；保留上次成功快照，未重试。' }
          return { ...empty, sources: status, state: 'error' as const, lastAttemptAt: new Date(attemptedAt).toISOString(), message: '云枢只读查询失败、权限不足或返回无效；未显示估算值，未重试。' }
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
  return { read }
}
const service = createAdminYunshuUsageService()
export const getAdminYunshuModelUsage = service.read
