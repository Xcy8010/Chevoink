import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { AdminDiagnosticCheck, AdminDiagnosticStage, AdminModelDiagnosticRequest, AdminModelDiagnosticResult } from '../../shared/contracts/admin-model-diagnostics.js'
import { imageQualityConfigSchema } from '../../shared/contracts/image-model.js'
import { parseModelCapabilities } from './credits.js'
import { DataAccessError, prisma } from './prisma.js'
import { parsePublicHttpUrl } from './public-http.js'
import { webToolEndpoint } from './web-tool-provider.js'
import { AdminDiagnosticFailure, diagnosticEnvironmentRoute, prepareAdminModelConnection } from './admin-model-connection.js'

export { AdminDiagnosticFailure } from './admin-model-connection.js'
import type { WebToolProtocol } from '../../shared/contracts/web-tool.js'

export type DiagnosticModelSnapshot = {
  id: string; revision: string; modelName: string; provider: string; modelKind: AdminModelDiagnosticResult['modelKind']
  baseUrl: string | null; apiKeyConfigured: boolean; metadata: Prisma.JsonValue | null; archived: boolean
  environmentKey?: 'text' | 'vision' | 'image_generation' | 'web_search'
}
type Actor = { role: string; isSuperAdmin: boolean; bannedAt: Date | null }
export type DiagnosticRepository = {
  actor: (adminId: string) => Promise<Actor | null>
  model: (modelId: string) => Promise<DiagnosticModelSnapshot | null>
  find: (adminId: string, requestKey: string) => Promise<AdminModelDiagnosticResult | null>
  create: (adminId: string, result: AdminModelDiagnosticResult) => Promise<AdminModelDiagnosticResult>
  save: (result: AdminModelDiagnosticResult) => Promise<void>
}
export type DiagnosticAdapterEvent =
  | { type: 'phase'; stage: 'dns' | 'tls' | 'http' | 'authentication' | 'protocol' | 'generation' }
  | { type: 'headers'; status?: number }
  | { type: 'first_event' }
  | { type: 'thinking' | 'text'; bytes: number }
export type DiagnosticLimits = { timeoutMs: number; maxOutputTokens: number; maxOutputBytes: number; maximumCostMicros: number }
type DiagnosticResponse = {
  valid: boolean; outputTokens: number | null; generationDurationMs: number | null
  fee: { status: 'known' | 'unknown'; amountMicros: number | null }
}
export type PrepareDiagnosticConnection = (model: DiagnosticModelSnapshot, maxOutputTokens: number) => Promise<
  (signal: AbortSignal, emit: (event: DiagnosticAdapterEvent) => void) => Promise<DiagnosticResponse>>
export type DiagnosticAdapter = {
  /** Existing server adapters must supply a conservative quote before dispatch. */
  quote: (model: DiagnosticModelSnapshot, mode: 'gateway' | 'capability') => Promise<{ maximumCostMicros: number; currency: 'CNY' } | null>
  execute: (input: { model: DiagnosticModelSnapshot; mode: 'gateway' | 'capability'; signal: AbortSignal; limits: DiagnosticLimits; feeIdentity: string; emit: (event: DiagnosticAdapterEvent) => void }) => Promise<DiagnosticResponse>
}
const FAILURE_MESSAGES: Record<AdminDiagnosticStage, string> = {
  configuration: '配置检查未通过。', policy: '真实请求尚未开放。', dns: '公共地址解析失败。', tls: 'TLS 连接校验失败。', http: 'HTTP 请求未成功。',
  authentication: '上游鉴权未通过。', protocol: '上游返回未通过能力协议校验。', generation: '能力请求未完成。', cancelled: '诊断已取消；已发出请求的费用仍需核定。', timeout: '诊断已超时；未确认的费用保持未知。',
}
export const DEFAULT_DIAGNOSTIC_POLICY = { liveRequestsEnabled: false, maximumCostMicros: null as number | null }
const diagnosticTimeoutMs = (mode: AdminModelDiagnosticResult['mode'], kind: DiagnosticModelSnapshot['modelKind']) =>
  mode === 'connection' && kind === 'image_generation' ? 120000 : 15000

/** URL parsing and endpoint/capability validation only: no DNS, key decryption or upstream request. */
export function checkAdminModelConfiguration(model: DiagnosticModelSnapshot): AdminDiagnosticCheck[] {
  const metadata = model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata) ? model.metadata : {}
  let urlValid = false
  try { parsePublicHttpUrl(model.baseUrl ?? ''); urlValid = true } catch { /* Static field failure below. */ }
  let protocolValid = true
  if (model.modelKind === 'web_search' || model.modelKind === 'web_fetch') {
    try {
      webToolEndpoint({ provider: model.provider, modelName: model.modelName, baseUrl: model.baseUrl ?? '', apiKey: model.apiKeyConfigured ? 'configured' : '',
        ...(metadata.webToolProtocol !== undefined ? { webToolProtocol: metadata.webToolProtocol as WebToolProtocol } : {}) }, model.modelKind === 'web_search' ? 'search' : 'fetch')
    } catch { protocolValid = false }
  }
  const capabilities = parseModelCapabilities(model.metadata, model.provider)
  const imageQuality = metadata.imageQuality === undefined ? null : imageQualityConfigSchema.safeParse(metadata.imageQuality)
  const capabilitiesValid = (metadata.contextWindowTokens == null || capabilities.contextWindowTokens !== null)
    && (!imageQuality || (imageQuality.success && (imageQuality.data.defaultValue === null || imageQuality.data.supportedValues.includes(imageQuality.data.defaultValue))))
  return [
    { field: 'lifecycle', passed: !model.archived, message: model.archived ? '此模型已归档，不能发起新的诊断。' : '活动目录中的配置。' },
    { field: 'modelName', passed: Boolean(model.modelName.trim() && model.modelName !== 'unconfigured'), message: '模型 ID 必须已填写。' },
    { field: 'baseUrl', passed: urlValid, message: '地址需通过现有公共 HTTPS URL 静态校验；尚未解析 DNS。' },
    { field: 'apiKey', passed: model.apiKeyConfigured, message: '仅检查密钥配置状态，不解密或验证鉴权。' },
    { field: 'protocol', passed: protocolValid, message: 'Search / Fetch 使用独立协议和完整工具端点校验，不转成聊天请求。' },
    { field: 'capabilities', passed: capabilitiesValid, message: '上下文与图片参数按现有能力配置规则检查。' },
  ]
}

export function createAdminModelDiagnosticService(deps: {
  repository: DiagnosticRepository
  policy?: { liveRequestsEnabled: boolean; maximumCostMicros: number | null }
  adapter?: DiagnosticAdapter
  prepareConnection?: PrepareDiagnosticConnection
  now?: () => number
}) {
  const repository = deps.repository
  const now = deps.now ?? Date.now
  const policy = deps.policy ?? DEFAULT_DIAGNOSTIC_POLICY
  const active = new Map<string, { controller: AbortController; done: Promise<AdminModelDiagnosticResult>; adminId: string }>()
  const starts = new Map<string, Promise<AdminModelDiagnosticResult>>()
  const admissions = new Set<string>()
  const terminal = (result: AdminModelDiagnosticResult) => result.status !== 'running'
  const assertActor = async (adminId: string) => {
    const actor = await repository.actor(adminId)
    if (!actor || actor.role !== 'admin' || actor.bannedAt) throw new DataAccessError(403, 'ADMIN_REQUIRED', '需要有效管理员身份。')
    return actor
  }
  const ownedResult = async (adminId: string, modelId: string, requestKey: string) => {
    await assertActor(adminId)
    const result = await repository.find(adminId, requestKey)
    if (!result || result.modelConfigId !== modelId) throw new DataAccessError(404, 'MODEL_DIAGNOSTIC_NOT_FOUND', '未找到此管理员的诊断记录。')
    return result
  }
  const withStaleness = async (result: AdminModelDiagnosticResult) => {
    const model = await repository.model(result.modelConfigId)
    return { ...result, stale: !model || model.revision !== result.configRevision || model.archived }
  }
  const complete = async (result: AdminModelDiagnosticResult, started: number | null) => {
    result.finishedAt = new Date(now()).toISOString()
    result.metrics.totalMs = started === null ? null : Math.max(0, now() - started)
    const current = await withStaleness(result)
    await repository.save(current)
    return current
  }
  const fail = (result: AdminModelDiagnosticResult, stage: AdminDiagnosticStage, code: string) => {
    result.failure = { stage, code, message: FAILURE_MESSAGES[stage] }
  }
  async function execute(result: AdminModelDiagnosticResult, model: DiagnosticModelSnapshot, controller: AbortController): Promise<AdminModelDiagnosticResult> {
    let requestStarted: number | null = null
    let dispatched = false
    let bytes = 0
    let stage: AdminDiagnosticStage = 'policy'
    const connection = result.mode === 'connection'
    const limits: DiagnosticLimits = { timeoutMs: diagnosticTimeoutMs(result.mode, model.modelKind),
      maxOutputTokens: connection ? 128 : 16, maxOutputBytes: 4096, maximumCostMicros: policy.maximumCostMicros! }
    const timeout = setTimeout(() => controller.abort(new AdminDiagnosticFailure('timeout', 'DIAGNOSTIC_TIMEOUT')), limits.timeoutMs)
    try {
      const aborted = new Promise<never>((_, reject) => {
        const rejectAbort = () => reject(controller.signal.reason)
        if (controller.signal.aborted) rejectAbort()
        else controller.signal.addEventListener('abort', rejectAbort, { once: true })
      })
      const work = async () => {
        const probe = connection ? await deps.prepareConnection!(model, limits.maxOutputTokens) : null
        controller.signal.throwIfAborted()
        if (!probe) {
          const quote = await deps.adapter!.quote(model, result.mode as 'gateway' | 'capability')
          controller.signal.throwIfAborted()
          if (!quote || !Number.isSafeInteger(quote.maximumCostMicros) || quote.maximumCostMicros < 0 || quote.maximumCostMicros > limits.maximumCostMicros || quote.currency !== 'CNY') {
            result.status = 'blocked'; fail(result, 'policy', 'COST_QUOTE_UNAVAILABLE_OR_OVER_CAP'); return
          }
        }
        result.fee.status = 'unknown'
        await repository.save(result)
        controller.signal.throwIfAborted()
        dispatched = true
        stage = 'http'
        requestStarted = now()
        const emit = (event: DiagnosticAdapterEvent) => {
          controller.signal.throwIfAborted()
          if (event.type === 'phase') { stage = event.stage; return }
          const elapsed = Math.max(0, now() - requestStarted!)
          if (event.type === 'headers') {
            result.metrics.responseHeadersMs ??= elapsed
            if (event.status !== undefined) result.upstreamHttpStatus = event.status
          }
          if (event.type === 'first_event') result.metrics.firstEventMs ??= elapsed
          if (event.type === 'text' || event.type === 'thinking') {
            if (!Number.isSafeInteger(event.bytes) || event.bytes < 0 || bytes + event.bytes > limits.maxOutputBytes) {
              controller.abort(new AdminDiagnosticFailure('generation', 'DIAGNOSTIC_OUTPUT_LIMIT')); controller.signal.throwIfAborted()
            }
            bytes += event.bytes
            if (result.mode === 'gateway') throw new AdminDiagnosticFailure('protocol', 'GATEWAY_CHECK_RETURNED_GENERATION')
            if (event.bytes > 0 && event.type === 'text') result.metrics.firstTextMs ??= elapsed
            if (event.bytes > 0 && event.type === 'thinking') result.metrics.firstThinkingMs ??= elapsed
          }
        }
        const response = probe ? await probe(controller.signal, emit)
          : await deps.adapter!.execute({ model, mode: result.mode as 'gateway' | 'capability', signal: controller.signal, limits, feeIdentity: result.fee.identity, emit })
        controller.signal.throwIfAborted()
        if (response.fee.status === 'known' && Number.isSafeInteger(response.fee.amountMicros) && response.fee.amountMicros! >= 0) {
          result.fee.status = 'known'; result.fee.amountMicros = response.fee.amountMicros
          if (!connection && response.fee.amountMicros! > limits.maximumCostMicros) throw new AdminDiagnosticFailure('generation', 'DIAGNOSTIC_COST_LIMIT_EXCEEDED')
        }
        const tokens = response.outputTokens
        if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new AdminDiagnosticFailure('protocol', 'CAPABILITY_RESPONSE_INVALID')
        result.metrics.outputTokens = tokens
        if (tokens !== null && tokens > limits.maxOutputTokens) throw new AdminDiagnosticFailure('generation', 'DIAGNOSTIC_OUTPUT_LIMIT')
        if (!response.valid) throw new AdminDiagnosticFailure('protocol', 'CAPABILITY_RESPONSE_INVALID')
        if ((model.modelKind === 'text' || model.modelKind === 'vision') && result.metrics.firstTextMs !== null && tokens !== null && response.generationDurationMs !== null && Number.isFinite(response.generationDurationMs) && response.generationDurationMs > 0) {
          result.metrics.tokensPerSecond = tokens * 1000 / response.generationDurationMs
        }
        result.status = 'succeeded'
      }
      await Promise.race([work(), aborted])
    } catch (error) {
      const failure = error instanceof AdminDiagnosticFailure ? error : new AdminDiagnosticFailure(stage, 'DIAGNOSTIC_ADAPTER_FAILED')
      result.status = failure.stage === 'cancelled' ? 'cancelled' : failure.stage === 'timeout' ? 'unknown' : 'failed'
      if (dispatched && result.fee.status !== 'known') result.fee.status = 'unknown'
      if (!dispatched) { result.fee.status = 'not_requested'; result.fee.amountMicros = null }
      fail(result, failure.stage, failure.diagnosticCode)
    } finally { clearTimeout(timeout) }
    return complete(result, requestStarted)
  }
  const actions = {
    async start(adminId: string, modelId: string, input: AdminModelDiagnosticRequest) {
      const actor = await assertActor(adminId)
      const existing = await repository.find(adminId, input.requestKey)
      const assertIdentity = (result: AdminModelDiagnosticResult) => {
        if (result.modelConfigId !== modelId || result.mode !== input.mode || result.configRevision !== input.expectedRevision) throw new DataAccessError(409, 'MODEL_DIAGNOSTIC_IDENTITY_CONFLICT', '同一诊断请求的模型、模式或配置版本已改变。')
      }
      if (existing) { assertIdentity(existing); return withStaleness(existing) }
      const model = await repository.model(modelId)
      if (!model) throw new DataAccessError(404, 'MODEL_NOT_FOUND', '平台模型不存在。')
      if (model.revision !== input.expectedRevision) throw new DataAccessError(409, 'MODEL_DIAGNOSTIC_CONFIG_CHANGED', '模型配置已变化，请刷新后检查。')
      if ((input.mode === 'gateway' || input.mode === 'capability') && !actor.isSuperAdmin) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '真实请求诊断仅限超级管理员。')
      const started = now()
      const checks = checkAdminModelConfiguration(model)
      const connection = input.mode === 'connection'
      const liveEnabled = connection ? Boolean(deps.prepareConnection)
        : actor.isSuperAdmin && policy.liveRequestsEnabled && Number.isSafeInteger(policy.maximumCostMicros) && policy.maximumCostMicros! >= 0 && Boolean(deps.adapter)
      const maximumCostMicros = connection ? null : policy.maximumCostMicros
      const result: AdminModelDiagnosticResult = {
        id: randomUUID(), requestKey: input.requestKey, modelConfigId: model.id, configRevision: model.revision, modelName: model.modelName, provider: model.provider, modelKind: model.modelKind,
        mode: input.mode, status: 'running', stale: false, createdAt: new Date(started).toISOString(), finishedAt: null, checks, failure: null,
        metrics: { responseHeadersMs: null, firstEventMs: null, firstThinkingMs: null, firstTextMs: null, totalMs: null, outputTokens: null, tokensPerSecond: null },
        fee: { identity: `admin-diagnostic:${randomUUID()}`, owner: 'platform', status: 'not_requested', currency: 'CNY', amountMicros: null, maximumMicros: maximumCostMicros },
        livePolicy: { enabled: liveEnabled, maximumCostMicros, blockedReason: liveEnabled ? null : connection ? '连接测试暂不可用。' : !actor.isSuperAdmin ? '真实请求诊断仅限超级管理员；当前身份可执行本地配置检查。' : '平台测试费用上限及真实适配器未启用；目前仅开放本地配置检查。' },
      }
      if (checks.some(check => !check.passed)) { result.status = 'failed'; fail(result, 'configuration', 'MODEL_CONFIGURATION_INVALID') }
      else if (input.mode === 'configuration') result.status = 'configuration_passed'
      else if (!liveEnabled) { result.status = 'blocked'; fail(result, 'policy', 'LIVE_DIAGNOSTIC_DISABLED') }
      else if (!connection && model.modelKind === 'image_generation' && !input.costConfirmed) { result.status = 'blocked'; fail(result, 'policy', 'IMAGE_TEST_COST_CONFIRMATION_REQUIRED') }
      if (terminal(result)) { result.finishedAt = new Date(now()).toISOString(); result.metrics.totalMs = input.mode === 'configuration' ? Math.max(0, now() - started) : null }
      const reserve = !terminal(result)
      if (reserve && (active.size + admissions.size >= 4 || admissions.has(adminId) || [...active.values()].some(item => item.adminId === adminId))) throw new DataAccessError(429, 'MODEL_DIAGNOSTIC_BUSY', '已有诊断进行中，请等待或取消。')
      if (reserve) admissions.add(adminId)
      let claimed: AdminModelDiagnosticResult
      try { claimed = await repository.create(adminId, result) } finally { if (reserve) admissions.delete(adminId) }
      assertIdentity(claimed)
      if (claimed.id !== result.id || terminal(result)) return withStaleness(claimed)
      const controller = new AbortController()
      const done = Promise.resolve().then(() => execute(result, model, controller)).finally(() => active.delete(result.id))
      active.set(result.id, { controller, done, adminId })
      // Persistence failure is left observable by GET; never replay a dispatched request.
      void done.catch(() => {})
      return { ...result }
    },
    async get(adminId: string, modelId: string, requestKey: string) {
      const result = await ownedResult(adminId, modelId, requestKey)
      if (result.status === 'running' && now() - Date.parse(result.createdAt) > diagnosticTimeoutMs(result.mode, result.modelKind) + 1000 && !active.has(result.id)) {
        result.status = 'unknown'; result.finishedAt = new Date(now()).toISOString(); result.fee.status = 'unknown'; fail(result, 'timeout', 'DIAGNOSTIC_RESULT_UNKNOWN'); await repository.save(result)
      }
      return withStaleness(result)
    },
    async cancel(adminId: string, modelId: string, requestKey: string) {
      const result = await ownedResult(adminId, modelId, requestKey)
      const running = active.get(result.id)
      if (running) { running.controller.abort(new AdminDiagnosticFailure('cancelled', 'DIAGNOSTIC_CANCELLED')); return withStaleness(await running.done) }
      if (result.status === 'running') { result.status = 'unknown'; result.fee.status = 'unknown'; result.finishedAt = new Date(now()).toISOString(); fail(result, 'cancelled', 'DIAGNOSTIC_CANCELLATION_UNCONFIRMED'); await repository.save(result) }
      return withStaleness(result)
    },
  }
  return { ...actions, async start(adminId: string, modelId: string, input: AdminModelDiagnosticRequest) {
    const key = `${adminId}:${input.requestKey}`
    const existing = starts.get(key)
    if (existing) {
      const result = await existing
      if (result.modelConfigId !== modelId || result.mode !== input.mode || result.configRevision !== input.expectedRevision) throw new DataAccessError(409, 'MODEL_DIAGNOSTIC_IDENTITY_CONFLICT', '同一诊断请求的模型、模式或配置版本已改变。')
      return result
    }
    if (starts.size >= 4) throw new DataAccessError(429, 'MODEL_DIAGNOSTIC_BUSY', '已有诊断请求处理中。')
    const operation = actions.start(adminId, modelId, input).finally(() => starts.delete(key))
    starts.set(key, operation)
    return operation
  } }
}

const repository: DiagnosticRepository = {
  actor: adminId => prisma.user.findUnique({ where: { id: adminId }, select: { role: true, isSuperAdmin: true, bannedAt: true } }),
  async model(modelId) {
    const row = await prisma.aiModelConfig.findFirst({ where: { id: modelId, ownerUserId: null }, select: { id: true, revision: true, modelName: true, provider: true, key: true, tier: true, baseUrl: true, apiKeyCiphertext: true, metadata: true, archivedAt: true } })
    if (!row) return null
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
    const kind = metadata.modelKind
    const modelKind = kind === 'vision' || kind === 'image_generation' || kind === 'web_search' || kind === 'web_fetch' ? kind : row.key === 'tool:web-search' ? 'web_search' : row.key === 'tool:web-fetch' ? 'web_fetch' : row.key === 'tool:image-generation' ? 'image_generation' : row.key === 'tool:image-vision' ? 'vision' : 'text'
    const model: DiagnosticModelSnapshot = { id: row.id, revision: String(row.revision), modelName: row.modelName, provider: row.provider, modelKind, baseUrl: row.baseUrl,
      apiKeyConfigured: Boolean(row.apiKeyCiphertext), metadata: row.metadata, archived: Boolean(row.archivedAt) }
    return { ...model, ...diagnosticEnvironmentRoute(model, row.tier) }
  },
  async find(adminId, requestKey) { const row = await prisma.adminModelDiagnostic.findUnique({ where: { adminId_requestKey: { adminId, requestKey } } }); return row ? row.result as unknown as AdminModelDiagnosticResult : null },
  async create(adminId, result) {
    const row = await prisma.adminModelDiagnostic.upsert({ where: { adminId_requestKey: { adminId, requestKey: result.requestKey } }, update: {}, create: {
      id: result.id, adminId, modelConfigId: result.modelConfigId, configRevision: result.configRevision, requestKey: result.requestKey, mode: result.mode, status: result.status,
      feeIdentity: result.fee.identity, feeOwner: 'platform', feeStatus: result.fee.status, result: result as unknown as Prisma.InputJsonValue,
    } })
    return row.result as unknown as AdminModelDiagnosticResult
  },
  async save(result) { await prisma.adminModelDiagnostic.update({ where: { id: result.id }, data: { status: result.status, feeStatus: result.fee.status, result: result as unknown as Prisma.InputJsonValue } }) },
}
const service = createAdminModelDiagnosticService({ repository, prepareConnection: prepareAdminModelConnection })
export const startAdminModelDiagnostic = service.start
export const getAdminModelDiagnostic = service.get
export const cancelAdminModelDiagnostic = service.cancel
