import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildProviderCompatibilitySnapshot, providerCompatibilityCapabilities, providerCompatibilityFingerprint,
  type ProviderCompatibilityEvidence, type ProviderCompatibilityRoute,
} from '../../api/lib/agent/provider-compatibility.js'

// Local protocol fixtures only: no credentials, database or provider access.
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(), reserveTokenCredits: vi.fn(), consumeTokenCredits: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error {}, prisma: {} }))

const route: ProviderCompatibilityRoute = {
  source: 'builtin', provider: 'Ant Ling', baseUrl: 'https://api.ant-ling.com/v1', model: 'Ling-3.0-flash',
  executor: 'legacy', purpose: 'tool_turn', reasoningEffort: 'high', maxOutputTokens: 32768,
  toolsPresent: true, toolChoice: 'required', schemaFingerprint: 'schema-v1',
}
const observedAt = '2026-10-11T12:00:00.000Z'
const codeRevision = '6b09d2d-fixture'
const snapshot = (value = route, evidence: ProviderCompatibilityEvidence[] = []) => buildProviderCompatibilitySnapshot({
  route: value, observedAt, codeRevision, configurationPointers: ['fixture:resolved-route'], evidence,
})
const proof = (value = route, overrides: Partial<ProviderCompatibilityEvidence> = {}): ProviderCompatibilityEvidence => ({
  capability: 'non_thinking', kind: 'provider_observed', scope: 'provider_acceptance', status: 'supported',
  verifiedAt: observedAt, configurationFingerprint: providerCompatibilityFingerprint(value), codeRevision,
  pointers: ['fixture:synthetic-observation-record'], ...overrides,
})
afterEach(() => vi.unstubAllGlobals())

describe('offline provider compatibility evidence', () => {
  // Names/settings from the current sanitized inventory. Endpoint paths here
  // are representative synthetic inputs, not reconstructed production URLs.
  it.each([
    { tier: 'lite', provider: 'openrouter', model: 'inclusionai/ling-3.0-flash-vl:free', baseUrl: 'https://openrouter.ai/api/v1', reasoningEffort: 'medium', reasoning: { reasoning_effort: 'medium' } },
    { tier: 'speed', provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', reasoningEffort: 'high', reasoning: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
    { tier: 'basic', provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', reasoningEffort: 'high', selectable: false, reasoning: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
    { tier: 'additional', provider: 'Ant Ling', model: 'Ling-3.0-flash', baseUrl: 'https://api.ant-ling.com/v1', reasoningEffort: 'high', reasoning: { thinking: { type: 'enabled' } } },
    { tier: 'standard', provider: 'Xiaomi', model: 'mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1', reasoningEffort: 'medium', reasoning: { thinking: { type: 'enabled' } } },
    { tier: 'performance', provider: 'Xiaomi', model: 'mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1', reasoningEffort: 'medium', reasoning: { thinking: { type: 'enabled' } } },
    { tier: 'ultimate', provider: 'Zhipu AI', model: 'glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', reasoningEffort: 'high', reasoning: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
    { tier: 'custom', source: 'byok', provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', reasoningEffort: 'high', thinkingEnabled: true, reasoningParameterMode: 'native', outputTokenParameter: 'max_tokens', reasoning: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
  ] satisfies Array<Partial<ProviderCompatibilityRoute> & { reasoning: Record<string, unknown> }>)('covers inventory settings for $tier across both executors without certifying the synthetic endpoint', input => {
    for (const executor of ['legacy', 'durable'] as const) {
      const result = snapshot({ ...route, ...input, executor })
      expect(result.requestEncoding?.reasoning).toEqual(input.reasoning)
      expect(result.route.reasoningEffort).toBe(input.reasoningEffort)
      expect(result.capabilities.native_tool_stream.status).toBe('unknown')
      expect(result.capabilities.non_thinking.status).toBe('unknown')
    }
  })

  it.each([
    { modality: 'image', model: 'gpt-image-2', provider: 'openai-compatible', enabled: true, endpointHost: 'www.hohoapi.com' },
    { modality: 'vision', model: 'unconfigured', provider: 'unconfigured', enabled: false, endpointHost: null },
    { modality: 'search', model: 'unconfigured', provider: 'unconfigured', enabled: false, endpointHost: null },
    { modality: 'text', model: 'deepseek-flash', provider: 'deepseek', enabled: true, endpointHost: 'api.deepseek.com' },
  ] satisfies Array<Partial<ProviderCompatibilityRoute>>)('keeps $modality sanitized inventory rows without claiming chat encoding for unavailable URLs', input => {
    const result = snapshot({ ...route, ...input, baseUrl: null, endpointFingerprint: 'sanitized-endpoint-hash' })
    expect(result.route.endpointHost).toBe(input.endpointHost)
    expect(result.route.endpointFingerprint).toBe('sanitized-endpoint-hash')
    expect(result.route.enabled).toBe(input.enabled)
    expect(result.requestEncoding).toBeNull()
    expect(Object.values(result.capabilities).every(cell => cell.status === 'unknown')).toBe(true)
  })

  it('does not run a chat encoder for image routes or disabled text routes even with a URL', () => {
    expect(snapshot({ ...route, modality: 'image' }).requestEncoding).toBeNull()
    expect(snapshot({ ...route, enabled: false }).requestEncoding).toBeNull()
    expect(snapshot({ ...route, maxOutputTokens: null }).requestEncoding).toBeNull()
    expect(snapshot({ ...route, toolsPresent: null }).requestEncoding).toBeNull()
  })

  it.each([
    { source: 'builtin' as const, provider: 'Ant Ling', baseUrl: 'https://api.ant-ling.com/v1', model: 'Ling-3.0-flash', reasoning: { thinking: { type: 'enabled' } } },
    { source: 'byok' as const, provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', reasoning: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
    { source: 'proxy' as const, provider: 'deepseek', baseUrl: 'https://proxy.example/v1', model: 'deepseek-v4-flash', reasoning: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
    { source: 'proxy' as const, provider: 'Ant Ling', baseUrl: 'https://api.ant-ling.com.example/v1', model: 'Ling-3.0-flash', reasoning: { reasoning_effort: 'high' } },
    { source: 'alias' as const, provider: 'opaque', baseUrl: 'https://proxy.example/v1', model: 'author-model', reasoning: { reasoning_effort: 'high' } },
  ])('records actual $source encoder behavior without claiming provider support', value => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline matrix must never probe') }))
    const input = { ...route, ...value }
    const before = structuredClone(input)
    const result = snapshot(input)
    expect(result.requestEncoding?.reasoning).toEqual(value.reasoning)
    expect(result.configuration.verificationKind).toBe('configured')
    expect(Object.keys(result.capabilities)).toEqual([...providerCompatibilityCapabilities])
    for (const cell of Object.values(result.capabilities)) {
      expect(cell.status).toBe('unknown')
      expect(cell.verificationKind).toBe('unknown')
      expect(cell.configurationFingerprint).toBe(result.configurationFingerprint)
    }
    expect(input).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['legacy', 'durable'] as const)('preserves high and explicit native/omit settings for %s', executor => {
    for (const reasoningParameterMode of ['native', 'omit'] as const) {
      for (const thinkingEnabled of [true, false, undefined]) {
        const result = snapshot({ ...route, executor, reasoningParameterMode, thinkingEnabled })
        expect(result.route.reasoningEffort).toBe('high')
        expect(result.requestEncoding?.reasoning).toEqual({
          ...(thinkingEnabled ? { thinking: { type: 'enabled' } } : {}),
          ...(reasoningParameterMode === 'native' ? { reasoning_effort: 'high' } : {}),
        })
        expect(result.capabilities.non_thinking.status).toBe('unknown')
      }
    }
    const bounded = snapshot({ ...route, executor, purpose: 'bounded_tool_review', provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', reasoningParameterMode: 'native', thinkingEnabled: true })
    expect(bounded.requestEncoding?.reasoning).toEqual({ thinking: { type: 'disabled' } })
    expect(bounded.route.reasoningEffort).toBe('high')
    expect(bounded.requestEncoding?.toolChoice).toEqual({})
    // Isolated quality calls use a separate actual-dispatch fixture, never a
    // duplicate approximation of the private non-thinking admission helper.
    expect(snapshot({ ...route, executor, purpose: 'quality_review' }).requestEncoding).toBeNull()
  })

  it('records tool-free choice omission and explicit output parameter without text-budget heuristics', () => {
    const result = snapshot({ ...route, provider: 'xiaomi', model: 'mimo-v2.6', toolsPresent: false })
    expect(result.requestEncoding?.toolChoice).toEqual({})
    expect(result.requestEncoding?.outputLimit).toEqual({ max_tokens: 32768 })
    expect(snapshot({ ...route, outputTokenParameter: 'max_completion_tokens', maxOutputTokens: 2000 })
      .requestEncoding?.outputLimit).toEqual({ max_completion_tokens: 2000 })
  })

  it.each(['source', 'provider', 'baseUrl', 'model', 'executor', 'purpose', 'reasoningEffort', 'reasoningParameterMode',
    'thinkingEnabled', 'reasoningEfforts', 'outputTokenParameter', 'maxOutputTokens', 'toolsPresent', 'toolChoice', 'schemaFingerprint'] as const)('invalidates evidence after %s changes', key => {
    const changes: ProviderCompatibilityRoute = { source: 'byok', provider: 'changed', baseUrl: 'https://different.example/v2',
      model: 'different', executor: 'durable', purpose: 'bounded_tool_review', reasoningEffort: 'none', reasoningParameterMode: 'omit',
      thinkingEnabled: false, reasoningEfforts: ['none'], outputTokenParameter: 'max_completion_tokens', maxOutputTokens: 99,
      toolsPresent: false, toolChoice: undefined, schemaFingerprint: 'schema-v2' }
    const result = snapshot({ ...route, [key]: changes[key] }, [proof()])
    expect(result.configurationFingerprint).not.toBe(providerCompatibilityFingerprint(route))
    expect(result.capabilities.non_thinking.status).toBe('unknown')
    expect(result.excludedEvidenceCount).toBe(1)
  })

  it('keeps encoder fixture evidence separate from provider acceptance and recovery capabilities', () => {
    const evidence = proof(route, { kind: 'encoder_fixture', scope: 'request_encoding' })
    const result = snapshot(route, [evidence])
    expect(result.capabilities.non_thinking.status).toBe('unknown')
    expect(result.capabilities.non_thinking.evidence).toContainEqual(evidence)
    expect(result.capabilities.idempotency.status).toBe('unknown')
    expect(result.capabilities.query.status).toBe('unknown')
    evidence.pointers.push('mutated')
    expect(result.capabilities.non_thinking.evidence[0].pointers).toEqual(['fixture:synthetic-observation-record'])
  })

  it.each(['supported', 'unsupported', 'unknown'] as const)('uses only bound provider observations for %s acceptance', status => {
    const result = snapshot(route, [proof(route, { status })])
    expect(result.capabilities.non_thinking).toMatchObject({ status, verificationKind: 'provider_observed', verifiedAt: observedAt })
    expect(result.capabilities.native_tool_stream.status).toBe('unknown')
  })

  it.each([
    { codeRevision: 'old-revision' }, { verifiedAt: 'bad-date' }, { verifiedAt: '2026-10-12T00:00:00Z' },
    { validUntil: '2026-10-10T00:00:00Z' }, { validUntil: 'bad-date' }, { pointers: [] },
    { kind: 'encoder_fixture' as const, scope: 'provider_acceptance' as const },
    { kind: 'configured' as const, scope: 'provider_acceptance' as const },
    { kind: 'provider_observed' as const, scope: 'request_encoding' as const },
  ])('excludes stale, incomplete or incorrectly scoped evidence: %j', overrides => {
    const result = snapshot(route, [proof(route, overrides)])
    expect(result.excludedEvidenceCount).toBe(1)
    expect(result.capabilities.non_thinking.status).toBe('unknown')
  })

  it('retains conflicting observations as unknown instead of silently certifying either', () => {
    const result = snapshot(route, [proof(), proof(route, { status: 'unsupported' })])
    expect(result.capabilities.non_thinking.status).toBe('unknown')
    expect(result.capabilities.non_thinking.evidence).toHaveLength(2)
  })

  it('never copies runtime credentials or credential URL values into snapshots/fingerprints', () => {
    const input = { ...route, apiKey: 'TOP-SECRET', baseUrl: 'https://user:password@proxy.example/v1?api_key=secret#secret' }
    const result = snapshot(input, [proof(input)])
    const serialized = JSON.stringify(result)
    for (const secret of ['TOP-SECRET', 'password', 'api_key', 'secret', 'user:']) expect(serialized).not.toContain(secret)
    expect(result.route.endpoint).toBe('https://proxy.example/v1/chat/completions')
    expect(result.route.evidenceReusable).toBe(false)
    expect(result.excludedEvidenceCount).toBe(1)
    expect(providerCompatibilityFingerprint({ ...input, apiKey: 'rotated', baseUrl: 'https://other:rotated@proxy.example/v1?token=rotated#rotated' }))
      .toBe(result.configurationFingerprint)
    expect(snapshot({ ...route, baseUrl: 'invalid-secret' }).route.endpoint).toBeNull()
  })

  it('requires explicit date/revision/source rather than manufacturing verification metadata', () => {
    expect(() => buildProviderCompatibilitySnapshot({ route, observedAt: 'invalid', codeRevision, configurationPointers: ['fixture'] })).toThrow()
    expect(() => buildProviderCompatibilitySnapshot({ route, observedAt, codeRevision: '', configurationPointers: ['fixture'] })).toThrow()
    expect(() => buildProviderCompatibilitySnapshot({ route, observedAt, codeRevision, configurationPointers: [] })).toThrow()
  })
})
