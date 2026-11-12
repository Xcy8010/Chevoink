import type { AdminDiagnosticStage } from '../../shared/contracts/admin-model-diagnostics.js'
import { FIXED_NOVEL_COVER_SIZE } from '../../shared/contracts/index.js'
import { imageQualityConfigSchema } from '../../shared/contracts/image-model.js'
import type { WebToolProtocol } from '../../shared/contracts/web-tool.js'
import { env } from '../config/env.js'
import { toolEnvironmentFallback } from './admin-credit-model.js'
import type { DiagnosticModelSnapshot, PrepareDiagnosticConnection } from './admin-model-diagnostics.js'
import { resolveResponsesEndpoint } from './ai-responses-route.js'
import { buildResponsesToolRequest } from './ai-responses-tools.js'
import { buildProviderReasoningPayload, parseCoverImageResponse, resolveTextOutputTokenParameter } from './ai-service.js'
import { parseModelCapabilities } from './credits.js'
import { prisma } from './prisma.js'
import { parsePublicHttpUrl, readBoundedPublicBody, requestPublicProviderJson } from './public-http.js'
import { decryptSecret } from './secret-box.js'
import { bochaResponseSchema, deepseekSearchSchema } from './web-search-service.js'
import { resolveWebToolProtocol, webToolEndpoint } from './web-tool-provider.js'

export class AdminDiagnosticFailure extends Error {
  constructor(readonly stage: AdminDiagnosticStage, readonly diagnosticCode: 'DNS_FAILED' | 'TLS_FAILED' | 'HTTP_FAILED' | 'AUTH_FAILED' | 'PROTOCOL_FAILED' | 'DIAGNOSTIC_TIMEOUT' | 'DIAGNOSTIC_OUTPUT_LIMIT' | 'GATEWAY_CHECK_RETURNED_GENERATION' | 'CAPABILITY_RESPONSE_INVALID' | 'DIAGNOSTIC_ADAPTER_FAILED' | 'DIAGNOSTIC_CANCELLED' | 'DIAGNOSTIC_COST_LIMIT_EXCEEDED' | 'DIAGNOSTIC_MODEL_CHANGED' | 'DIAGNOSTIC_CREDENTIAL_INVALID') { super(diagnosticCode); this.name = 'AdminDiagnosticFailure' }
}

const prompt = 'Reply with OK.'
const blueSquare = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWNgYPhPImIY1cAwGkr/h2fSAACS2/8B4hCvVAAAAABJRU5ErkJggg=='

export function diagnosticEnvironmentRoute(model: DiagnosticModelSnapshot, tier: string | null): Partial<DiagnosticModelSnapshot> {
  if (model.archived || model.apiKeyConfigured && model.baseUrl && model.modelName !== 'unconfigured') return {}
  if (model.modelKind === 'text' && tier === 'speed' && model.modelName !== 'unconfigured') {
    // Only the exact environment endpoint may receive its environment key.
    if (!model.apiKeyConfigured && (!model.baseUrl || model.baseUrl === env.aiTextBaseUrl) && env.aiTextApiKeyConfigured) {
      return { baseUrl: env.aiTextBaseUrl, apiKeyConfigured: true, environmentKey: 'text' }
    }
    if (model.apiKeyConfigured && !model.baseUrl) return { baseUrl: env.aiTextBaseUrl }
  }
  const fallback = toolEnvironmentFallback(model.modelKind)
  if (fallback?.apiKeyConfigured && fallback.baseUrl && model.modelKind !== 'text' && model.modelKind !== 'web_fetch') {
    return { ...fallback, environmentKey: model.modelKind, ...(model.modelKind === 'web_search' ? { metadata: { webToolProtocol: 'bocha' } } : {}) }
  }
  return {}
}

function isPublicResultUrl(value: string): boolean {
  try { parsePublicHttpUrl(value, true); return true }
  catch { return false }
}

/** One synthetic request on the saved primary endpoint. No fallback, retries,
 * uploaded media, manuscript data, or author wallet operations. */
export const prepareAdminModelConnection: PrepareDiagnosticConnection = async (model, maxOutputTokens) => {
  const row = await prisma.aiModelConfig.findFirst({
    where: { id: model.id, revision: Number(model.revision), ownerUserId: null, archivedAt: null },
    select: { apiKeyCiphertext: true },
  })
  if (!row) throw new AdminDiagnosticFailure('configuration', 'DIAGNOSTIC_MODEL_CHANGED')
  let apiKey: string
  try {
    const environmentKeys = { text: env.aiTextApiKey, vision: env.aiVisionApiKey, image_generation: env.aiImageApiKey, web_search: env.webSearchBochaApiKey }
    apiKey = model.environmentKey ? environmentKeys[model.environmentKey] : decryptSecret(row.apiKeyCiphertext ?? '')
  }
  catch { throw new AdminDiagnosticFailure('configuration', 'DIAGNOSTIC_CREDENTIAL_INVALID') }
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new AdminDiagnosticFailure('configuration', 'DIAGNOSTIC_CREDENTIAL_INVALID')

  const base = parsePublicHttpUrl(model.baseUrl ?? '')
  if (base.search || new URL(model.baseUrl!).hash) throw new AdminDiagnosticFailure('configuration', 'PROTOCOL_FAILED')
  const metadata = model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata) ? model.metadata : {}
  const kind = model.modelKind
  let endpoint: string
  let body: Record<string, unknown>
  let responses = false
  let bocha = false
  if (kind === 'image_generation') {
    const quality = imageQualityConfigSchema.safeParse(metadata.imageQuality)
    const value = quality.success ? (quality.data.supportedValues.includes('low') ? 'low' : quality.data.defaultValue) : null
    endpoint = base.href
    body = { model: model.modelName, prompt: 'A solid blue square.', size: FIXED_NOVEL_COVER_SIZE, n: 1, ...(value ? { quality: value } : {}) }
  } else if (kind === 'web_search' || kind === 'web_fetch') {
    const operation = kind === 'web_search' ? 'search' : 'fetch'
    const config = { provider: model.provider, modelName: model.modelName, baseUrl: base.href, apiKey, webToolProtocol: metadata.webToolProtocol as WebToolProtocol | undefined }
    endpoint = webToolEndpoint(config, operation)
    bocha = resolveWebToolProtocol(config, operation) === 'bocha'
    body = operation === 'fetch' ? { url: 'https://example.com/' }
      : { query: 'IANA Example Domain', count: 1, ...(bocha ? { summary: false } : { need_content: false }) }
  } else {
    const capabilities = parseModelCapabilities(model.metadata, model.provider)
    const effort = (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const)
      .find(value => capabilities.reasoningEfforts.includes(value)) ?? capabilities.defaultReasoningEffort
    const route = { provider: model.provider, model: model.modelName, providerBaseUrl: base.href }
    const nativeEndpoint = resolveResponsesEndpoint({ ...route, baseUrl: base.href, reasoningEffort: effort,
      reasoningParameterMode: capabilities.reasoningParameterMode, toolCallingProtocol: capabilities.toolCallingProtocol })
    const messages = [{ role: 'user', content: kind === 'vision'
      ? [{ type: 'text', text: 'Name the color in this image in one word.' }, { type: 'image_url', image_url: { url: blueSquare, detail: 'low' } }]
      : prompt }]
    if (nativeEndpoint) {
      responses = true
      endpoint = nativeEndpoint
      body = buildResponsesToolRequest({ model: model.modelName, messages, tools: [], maxOutputTokens,
        reasoningEffort: capabilities.reasoningParameterMode === 'omit' ? undefined : effort })
      delete body.include
      body.stream = false
    } else {
      base.pathname = base.pathname.replace(/\/+$/, '') + '/chat/completions'
      endpoint = base.href
      body = { model: model.modelName, messages, stream: false,
        [resolveTextOutputTokenParameter(capabilities.outputTokenParameter, route, true)]: maxOutputTokens,
        ...(kind === 'text' || capabilities.reasoningParameterMode !== undefined || capabilities.thinkingEnabled !== undefined
          ? buildProviderReasoningPayload({ ...route, reasoningEffort: effort, reasoningParameterMode: capabilities.reasoningParameterMode,
            thinkingEnabled: capabilities.thinkingEnabled }) : {}) }
    }
  }

  return async (signal, emit) => {
    const request = await requestPublicProviderJson(endpoint, apiKey, body, signal).catch(error => {
      const code = (error as { cause?: { code?: string } })?.cause?.code ?? ''
      if (['PUBLIC_EGRESS_DENIED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new AdminDiagnosticFailure('dns', 'DNS_FAILED')
      if (/^(?:ERR_TLS_|CERT_|UNABLE_TO_VERIFY_|DEPTH_ZERO_)/.test(code)) throw new AdminDiagnosticFailure('tls', 'TLS_FAILED')
      throw error
    })
    try {
      const { response } = request
      emit({ type: 'headers', status: response.status })
      if ([401, 403].includes(response.status)) throw new AdminDiagnosticFailure('authentication', 'AUTH_FAILED')
      if (!response.ok) throw new AdminDiagnosticFailure('http', 'HTTP_FAILED')
      emit({ type: 'phase', stage: 'protocol' })
      const maxBytes = kind === 'image_generation' ? 12 * 1024 * 1024 : kind.startsWith('web_') ? 2 * 1024 * 1024 : 64 * 1024
      const raw = (await readBoundedPublicBody(response, maxBytes)).toString('utf8')
      const payload = JSON.parse(raw)
      let valid: boolean
      let outputTokens: number | null = null
      if (kind === 'image_generation') {
        const images = parseCoverImageResponse(response.status, raw)
        valid = images.length === 1 && (isPublicResultUrl(images[0]) || /^data:image\/png;base64,[a-z0-9+/]{16,}={0,2}$/i.test(images[0]))
      } else if (kind === 'web_search') {
        const result = bocha ? bochaResponseSchema.safeParse(payload) : deepseekSearchSchema.safeParse(payload)
        const items = result.success ? ('results' in result.data ? result.data.results : result.data.data.webPages.value) : null
        valid = items !== null && (!items.length || items.some(item => ('title' in item ? item.title : item.name).trim() && isPublicResultUrl(item.url)))
      } else if (kind === 'web_fetch') {
        valid = typeof payload?.title === 'string' && typeof payload?.content === 'string' && Boolean(payload.content.trim())
      } else {
        const content: unknown = responses
          ? (Array.isArray(payload?.output) ? payload.output : []).flatMap((item: { type?: string; content?: unknown[] }) =>
            item?.type === 'message' && Array.isArray(item.content) ? item.content : [])
            .flatMap((part: { type?: string; text?: unknown }) => part?.type === 'output_text' && typeof part.text === 'string' ? [part.text] : []).join('')
          : payload?.choices?.[0]?.message?.content
        valid = typeof content === 'string' && Boolean(content.trim()) && !payload?.error
          && (responses ? payload.status === 'completed' : payload?.choices?.[0]?.finish_reason !== 'length')
        const tokens: unknown = responses ? payload?.usage?.output_tokens : payload?.usage?.completion_tokens
        if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) outputTokens = tokens
      }
      return { valid, outputTokens, generationDurationMs: null, fee: { status: 'unknown', amountMicros: null } }
    } finally { await request.close() }
  }
}
