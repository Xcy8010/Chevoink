import { createHash } from 'node:crypto'
import { buildProviderReasoningPayload, buildProviderToolChoice } from '../ai-service.js'
import type { ModelReasoningEffort } from '../../../shared/contracts/index.js'

export const providerCompatibilityCapabilities = [
  'native_tool_stream', 'argument_fragments', 'multi_call_association', 'strict_schema_subset',
  'tool_choice', 'reasoning_return', 'non_thinking', 'termination', 'truncation',
  'output_limit', 'cache_usage', 'usage', 'cancellation', 'idempotency', 'query',
] as const
export type ProviderCompatibilityCapability = typeof providerCompatibilityCapabilities[number]
export type CompatibilityStatus = 'supported' | 'unsupported' | 'unknown'
export type CompatibilityVerificationKind = 'configured' | 'encoder_fixture' | 'provider_observed' | 'unknown'

/** Already resolved server route. No credentials, DB lookup, dispatch or route fallback. */
export type ProviderCompatibilityRoute = {
  source: 'builtin' | 'byok' | 'proxy' | 'alias'
  provider: string
  /** Null when a sanitized inventory supplies only host/fingerprint. */
  baseUrl: string | null
  endpointHost?: string | null
  endpointFingerprint?: string
  model: string
  modality?: 'text' | 'image' | 'vision' | 'search'
  enabled?: boolean
  selectable?: boolean
  isDefault?: boolean
  tier?: string | null
  visionEnabled?: boolean
  contextWindowTokens?: number | null
  configurationUpdatedAt?: string
  executor: 'legacy' | 'durable'
  purpose: 'tool_turn' | 'bounded_tool_review' | 'quality_review'
  reasoningEffort: ModelReasoningEffort
  reasoningParameterMode?: 'native' | 'omit'
  thinkingEnabled?: boolean
  reasoningEfforts?: ModelReasoningEffort[]
  outputTokenParameter?: 'max_tokens' | 'max_completion_tokens'
  /** Null for inventory-only snapshots that have no resolved request budget. */
  maxOutputTokens: number | null
  toolsPresent: boolean | null
  toolChoice?: 'required'
  /** Bind strict/schema evidence to the actual offered schema, not a model name. */
  schemaFingerprint?: string
}

export type ProviderCompatibilityEvidence = {
  capability: ProviderCompatibilityCapability
  kind: Exclude<CompatibilityVerificationKind, 'unknown'>
  scope: 'configuration' | 'request_encoding' | 'response_fixture' | 'provider_acceptance'
  status: CompatibilityStatus
  verifiedAt: string
  validUntil?: string
  configurationFingerprint: string
  codeRevision: string
  pointers: string[]
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** URL query/fragment and userinfo can carry credentials. Their values never
 * enter evidence or hashes. Query-bearing routes therefore cannot reuse proof. */
function safeEndpoint(baseUrl: string | null): { endpoint: string | null; host: string | null; reusable: boolean } {
  try {
    if (baseUrl === null) return { endpoint: null, host: null, reusable: false }
    const url = new URL(baseUrl)
    const reusable = !url.search && !url.hash && !url.username && !url.password
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return { endpoint: `${url.toString().replace(/\/$/, '')}/chat/completions`, host: url.hostname, reusable }
  } catch { return { endpoint: null, host: null, reusable: false } }
}

/** Whitelist fields: spreading a runtime object would leak apiKey/auth metadata. */
function snapshotRoute(route: ProviderCompatibilityRoute) {
  const endpoint = safeEndpoint(route.baseUrl)
  return {
    source: route.source, provider: route.provider, endpoint: endpoint.endpoint, model: route.model,
    endpointHost: endpoint.host ?? route.endpointHost ?? null, endpointFingerprint: route.endpointFingerprint ?? null,
    modality: route.modality ?? 'text', enabled: route.enabled ?? true, selectable: route.selectable ?? null,
    isDefault: route.isDefault ?? null, tier: route.tier ?? null, visionEnabled: route.visionEnabled ?? null,
    contextWindowTokens: route.contextWindowTokens ?? null, configurationUpdatedAt: route.configurationUpdatedAt ?? null,
    executor: route.executor, purpose: route.purpose, reasoningEffort: route.reasoningEffort,
    reasoningParameterMode: route.reasoningParameterMode ?? null,
    thinkingEnabled: route.thinkingEnabled ?? null,
    reasoningEfforts: route.reasoningEfforts ? [...route.reasoningEfforts] : null,
    outputTokenParameter: route.outputTokenParameter ?? null, maxOutputTokens: route.maxOutputTokens,
    toolsPresent: route.toolsPresent, toolChoice: route.toolChoice ?? null,
    schemaFingerprint: route.schemaFingerprint ?? null, evidenceReusable: endpoint.reusable,
  }
}

export function providerCompatibilityFingerprint(route: ProviderCompatibilityRoute): string {
  return hash(snapshotRoute(route))
}

/** Evidence only. This module never authorizes execution, retries or billing.
 * Provider support is never inferred from encoder heuristics or offline mocks.
 * The private quality encoder/prepared durable body must be observed in its
 * actual dispatch harness; a generic helper cannot certify its non-thinking. */
export function buildProviderCompatibilitySnapshot(input: {
  route: ProviderCompatibilityRoute
  observedAt: string
  codeRevision: string
  configurationPointers: string[]
  evidence?: ProviderCompatibilityEvidence[]
}) {
  const observedTime = Date.parse(input.observedAt)
  if (!Number.isFinite(observedTime) || !input.codeRevision || !input.configurationPointers.length) {
    throw new Error('Provider compatibility requires date, revision and configuration evidence pointers.')
  }
  const route = snapshotRoute(input.route)
  const configurationFingerprint = hash(route)
  const applicable = (input.evidence ?? []).filter(evidence => {
    const date = Date.parse(evidence.verifiedAt)
    const expiry = evidence.validUntil === undefined ? Infinity : Date.parse(evidence.validUntil)
    const validScope = evidence.kind === 'configured' ? evidence.scope === 'configuration'
      : evidence.kind === 'provider_observed' ? evidence.scope === 'provider_acceptance'
        : evidence.scope === 'request_encoding' || evidence.scope === 'response_fixture'
    return route.evidenceReusable && validScope && evidence.pointers.length > 0
      && evidence.configurationFingerprint === configurationFingerprint && evidence.codeRevision === input.codeRevision
      && Number.isFinite(date) && date <= observedTime && expiry >= observedTime
  })
  const capabilities = Object.fromEntries(providerCompatibilityCapabilities.map(capability => {
    const evidence = applicable.filter(item => item.capability === capability).map(item => ({ ...item, pointers: [...item.pointers] }))
    const providerEvidence = evidence.filter(item => item.kind === 'provider_observed')
    const statuses = new Set(providerEvidence.map(item => item.status))
    const status: CompatibilityStatus = statuses.size === 1 ? providerEvidence[0].status : 'unknown'
    return [capability, {
      status,
      verificationKind: providerEvidence.length && statuses.size === 1 ? 'provider_observed' as const : 'unknown' as const,
      verifiedAt: providerEvidence.length && statuses.size === 1
        ? providerEvidence.reduce((latest, item) => Date.parse(item.verifiedAt) > Date.parse(latest.verifiedAt) ? item : latest).verifiedAt : null,
      observedAt: input.observedAt, configurationPointers: [...input.configurationPointers], configurationFingerprint, evidence,
    }]
  })) as Record<ProviderCompatibilityCapability, {
    status: CompatibilityStatus
    verificationKind: 'provider_observed' | 'unknown'
    verifiedAt: string | null
    observedAt: string
    configurationPointers: string[]
    configurationFingerprint: string
    evidence: ProviderCompatibilityEvidence[]
  }>
  const encoderInput = {
    provider: input.route.provider, providerBaseUrl: input.route.baseUrl, model: input.route.model,
    reasoningEffort: input.route.reasoningEffort, reasoningParameterMode: input.route.reasoningParameterMode,
    thinkingEnabled: input.route.thinkingEnabled, boundedReview: input.route.purpose === 'bounded_tool_review',
  }
  return {
    version: 1 as const, observedAt: input.observedAt, codeRevision: input.codeRevision,
    configurationFingerprint, route,
    configuration: { verificationKind: 'configured' as const, pointers: [...input.configurationPointers] },
    // chatWithTools uses its explicit output parameter/default directly. It
    // does not use the text-completion budget heuristic; preserve that fact.
    requestEncoding: input.route.purpose === 'quality_review' || route.modality !== 'text' || !route.enabled
      || !route.endpoint || route.maxOutputTokens === null || route.toolsPresent === null ? null : {
      verificationKind: 'configured' as const,
      reasoning: buildProviderReasoningPayload(encoderInput),
      toolChoice: input.route.toolsPresent ? buildProviderToolChoice(encoderInput, input.route.toolChoice) : {},
      outputLimit: { [input.route.outputTokenParameter ?? 'max_tokens']: input.route.maxOutputTokens },
      pointers: ['api/lib/ai-service.ts#chatWithToolsImpl', 'api/lib/ai-service.ts#buildProviderReasoningPayload', 'api/lib/ai-service.ts#buildProviderToolChoice'],
    },
    capabilities,
    excludedEvidenceCount: (input.evidence ?? []).length - applicable.length,
  }
}
