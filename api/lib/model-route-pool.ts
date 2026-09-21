import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { modelRoutesInputSchema, type ModelRouteInput } from '../../shared/contracts/model-routes.js'
import { encryptSecret, decryptSecret } from './secret-box.js'
import { DataAccessError, prisma } from './prisma.js'
import type { ChatWithToolsParams } from './ai-service.js'
import { env } from '../config/env.js'

const storedSchema = z.array(z.object({ id: z.string().uuid(), label: z.string(), provider: z.string(), modelName: z.string(), baseUrl: z.string(), apiKeyCiphertext: z.string(), enabled: z.boolean(), reasoningEfforts: z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).optional(), contextWindowTokens: z.number().optional(), visionEnabled: z.boolean().optional() })).max(7)
export function readModelRoutes(metadata: unknown) {
  const value = metadata && typeof metadata === 'object' && 'routes' in metadata ? metadata.routes : []
  const parsed = storedSchema.safeParse(value)
  if (!parsed.success) throw new DataAccessError(409, 'MODEL_ROUTES_INVALID', '模型线路配置无效，请管理员检查。')
  return parsed.data
}
export function presentModelRoutes(metadata: unknown) {
  return readModelRoutes(metadata).map(({ apiKeyCiphertext, ...route }) => ({ ...route, apiKeyConfigured: Boolean(apiKeyCiphertext) }))
}
export function saveModelRoutes(input: ModelRouteInput[], metadata: unknown, efforts: string[], capabilities?: { contextWindowTokens: number | null; visionEnabled: boolean }) {
  const previous = new Map(readModelRoutes(metadata).map(route => [route.id, route]))
  const routes = modelRoutesInputSchema.parse(input)
  const ids = routes.flatMap(route => route.id ? [route.id] : [])
  if (new Set(ids).size !== ids.length) throw new DataAccessError(400, 'MODEL_ROUTES_INVALID', '线路编号不能重复。')
  return routes.map(route => {
    if (route.id && !previous.has(route.id)) throw new DataAccessError(409, 'MODEL_ROUTES_INVALID', '线路已变化，请刷新后重试。')
    const deepseek = route.provider.toLowerCase() === 'deepseek' || /deepseek/i.test(route.modelName) || /(^|\.)deepseek\.com$/i.test(new URL(route.baseUrl).hostname)
    if (route.enabled && deepseek && efforts.some(effort => !['low', 'high', 'max'].includes(effort))) throw new DataAccessError(400, 'REASONING_EFFORT_UNSUPPORTED', '线路必须支持此内置模型的全部推理强度。')
    if (route.enabled && ((route.reasoningEfforts && efforts.some(effort => !route.reasoningEfforts!.some(value => value === effort)))
      || capabilities?.visionEnabled && route.visionEnabled === false
      || route.contextWindowTokens && capabilities?.contextWindowTokens && route.contextWindowTokens < capabilities.contextWindowTokens)) {
      throw new DataAccessError(400, 'MODEL_ROUTE_CAPABILITIES', '启用线路的推理强度、上下文窗口及图片能力必须覆盖内置模型声明的能力。')
    }
    const apiKeyCiphertext = route.apiKey ? encryptSecret(route.apiKey) : route.id ? previous.get(route.id)?.apiKeyCiphertext : undefined
    if (!apiKeyCiphertext) throw new DataAccessError(400, 'MODEL_CONFIG_INCOMPLETE', '新增线路必须填写 API Key。')
    const { apiKey: _secret, ...fields } = route
    return { ...fields, id: route.id ?? randomUUID(), apiKeyCiphertext }
  })
}

export class ModelRouteRejected extends DataAccessError {
  readonly cooldownMs: number
  constructor(readonly upstreamStatus: number, retryAfter?: string | null, message = '模型服务暂时不可用。') {
    super(502, upstreamStatus === 504 ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_ERROR', upstreamStatus === 429
      ? '模型服务触发了每分钟请求或 Token 限制。系统将等待限流窗口后安全重试一次。'
      : message)
    const delay = retryAfter ? /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : 0
    // 没有 Retry-After 时，TPM/RPM 的滑动窗口通常至少要等一分钟；30 秒会在
    // 仍被限流时再次发同一请求。服务端明确给出的更长等待时间必须保留。
    const minimum = upstreamStatus === 429 ? 60_000 : 30_000
    this.cooldownMs = Math.max(minimum, Math.min(300_000, Number.isFinite(delay) ? delay : 0))
  }
}
export const routeRetryableStatus = (status: number) => [429, 500, 502, 503, 504].includes(status)
export const routeRejectionMayRetry = (status: number, prompt: number | undefined, completion: number | undefined) => routeRetryableStatus(status)
  && (prompt == null && completion == null || prompt === 0 && completion === 0)
const cursors = new Map<string, number>()
const cooldowns = new Map<string, number>()
const byokCooldowns = new Map<string, number>()
type Route = { id: string; provider: string; modelName: string; baseUrl: string; apiKey: string }

function waitForRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function byokCooldownKey(params: ChatWithToolsParams): string {
  // 不把 API Key 放入进程内映射或日志。所有者、端点和模型足以让同一 BYOK
  // 配置在供应商限流窗口内串行等待。
  const accountFingerprint = createHash('sha256').update(params.providerApiKey ?? '').digest('hex')
  return [params.usageLog.userId, params.providerBaseUrl ?? '', params.model ?? '', accountFingerprint].join('\u0000')
}

async function invokeByokWithRateLimitRetry<T>(params: ChatWithToolsParams, invoke: (params: ChatWithToolsParams) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([...(params.signal ? [params.signal] : []), AbortSignal.timeout(360_000)])
  const key = byokCooldownKey(params)
  if (byokCooldowns.size > 512) byokCooldowns.clear()
  const existingCooldown = byokCooldowns.get(key)
  if (existingCooldown && existingCooldown > Date.now()) await waitForRetry(signal, existingCooldown - Date.now())
  if (existingCooldown && byokCooldowns.get(key) === existingCooldown) byokCooldowns.delete(key)
  try {
    return await invoke({ ...params, signal })
  } catch (error) {
    if (!(error instanceof ModelRouteRejected) || error.upstreamStatus !== 429 || signal.aborted) throw error
    const retryAt = Date.now() + error.cooldownMs
    byokCooldowns.set(key, retryAt)
    await waitForRetry(signal, error.cooldownMs)
    if (byokCooldowns.get(key) === retryAt) byokCooldowns.delete(key)
    try {
      return await invoke({ ...params, signal })
    } catch (retryError) {
      if (retryError instanceof ModelRouteRejected && retryError.upstreamStatus === 429) {
        byokCooldowns.set(key, Date.now() + retryError.cooldownMs)
        throw new DataAccessError(502, 'AI_PROVIDER_ERROR', '模型服务仍受每分钟请求或 Token 限制。系统已等待后安全重试一次；未执行工具或重复扣费。请约一分钟后继续，或提高该供应商账号的 TPM/RPM 限额。')
      }
      throw retryError
    }
  }
}

/** Only server-configured routes of the exact bound built-in tier are eligible.
 * Unknown network/stream outcomes never replay; BYOK keeps its exact model/account. */
export async function withModelRoutePool<T>(params: ChatWithToolsParams, invoke: (params: ChatWithToolsParams) => Promise<T>): Promise<T> {
  const tier = params.usageLog.modelTier
  if (!tier || params.durableExecution) return invoke(params)
  // BYOK never switches models or accounts. A 429 without reported usage is
  // safe to replay once after its explicit/default cooldown.
  if (tier === 'custom') return invokeByokWithRateLimitRetry(params, invoke)
  const config = await prisma.aiModelConfig.findFirst({ where: { ownerUserId: null, tier, enabled: true } })
  if (!config) return invoke(params)
  const configured = readModelRoutes(config.metadata).filter(route => route.enabled)
  if (!configured.length) return invoke(params)
  const primary = { id: config.id, provider: config.provider, modelName: config.modelName, baseUrl: config.baseUrl ?? env.aiTextBaseUrl, apiKey: config.apiKeyCiphertext ? decryptSecret(config.apiKeyCiphertext) : env.aiTextApiKey }
  // An auxiliary caller with an explicit different model must not be rerouted by its billing label.
  if ((params.model ?? env.aiTextModel) !== primary.modelName || (params.providerBaseUrl ?? env.aiTextBaseUrl) !== primary.baseUrl || (params.providerApiKey ?? env.aiTextApiKey) !== primary.apiKey) return invoke(params)
  const routes: Route[] = [primary, ...configured.map(({ apiKeyCiphertext, ...route }) => ({ ...route, apiKey: decryptSecret(apiKeyCiphertext) }))]
  if (cursors.size > 64) cursors.clear()
  for (const [id, until] of cooldowns) if (until <= Date.now()) cooldowns.delete(id)
  const cursor = cursors.get(tier) ?? 0
  cursors.set(tier, (cursor + 1) % routes.length)
  const ordered = routes.map((_, index) => routes[(index + cursor) % routes.length])
  const ready = ordered.filter(route => !cooldowns.has(route.id))
  const candidates = (ready.length ? ready : ordered.slice(0, 1)).slice(0, 3)
  const signal = AbortSignal.any([...(params.signal ? [params.signal] : []), AbortSignal.timeout(360_000)])
  let failure: unknown
  for (const route of candidates) {
    signal.throwIfAborted()
    try {
      return await invoke({ ...params, signal, provider: route.provider, model: route.modelName, providerBaseUrl: route.baseUrl, providerApiKey: route.apiKey })
    } catch (error) {
      if (!(error instanceof ModelRouteRejected) || !routeRetryableStatus(error.upstreamStatus) || signal.aborted) throw error
      failure = error
      if (cooldowns.size > 512) cooldowns.clear()
      cooldowns.set(route.id, Date.now() + error.cooldownMs)
    }
  }
  throw failure
}
