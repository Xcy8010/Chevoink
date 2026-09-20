import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), destroy: vi.fn(async () => undefined), agent: vi.fn() }))
vi.mock('undici', () => ({ fetch: mocks.fetch, Agent: class { constructor(options: unknown) { mocks.agent(options) } destroy = mocks.destroy } }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
} }))
import { validateCustomModelCapabilities } from '../../api/lib/custom-model-validation.js'
import { publicEgressLookup } from '../../api/lib/public-http.js'

const input = { provider: 'compatible', modelName: 'arbitrary-model', baseUrl: 'https://models.example.com/v1', apiKey: 'secret-for-tests-only' }
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
type Body = { reasoning_effort?: string; messages: Array<{ content: string | Array<{ type: string; image_url?: { url: string } }> }>; tools?: unknown[] }
const bodyOf = (init: { body: string }) => JSON.parse(init.body) as Body
const textResult = (body: Body) => response({ choices: [{ message: { content: String(body.messages[0].content).split(': ').at(-1) }, finish_reason: 'stop' }] })
const unsupported = (field = 'reasoning_effort') => response({ error: { message: `Unsupported parameter: ${field}`, param: field } }, 400)
async function successfulProbe(_url: URL, init: { body: string }) {
  const body = bodyOf(init)
  if (body.tools) {
    const token = String(body.messages[0].content).match(/token (\w+)/)?.[1]
    return response({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'capability_probe', arguments: JSON.stringify({ token }) } }] } }] })
  }
  if (Array.isArray(body.messages[0].content)) {
    const url = body.messages[0].content.find(part => part.type === 'image_url')?.image_url?.url ?? ''
    const pixels = await sharp(Buffer.from(url.split(',')[1], 'base64')).removeAlpha().raw().toBuffer()
    const colors: Record<string, string> = { '255,0,0': 'red', '0,160,0': 'green', '0,0,255': 'blue', '255,255,0': 'yellow', '0,0,0': 'black', '255,255,255': 'white', '255,136,0': 'orange', '128,0,128': 'purple' }
    const answer = [0, 32, 64, 96].map(x => colors[[...pixels.subarray(x * 3, x * 3 + 3)].join(',')]).join(',')
    return response({ choices: [{ message: { content: answer } }] })
  }
  return textResult(body)
}
beforeEach(() => { vi.clearAllMocks(); mocks.fetch.mockImplementation(successfulProbe) })
afterEach(() => vi.useRealTimers())

describe('custom account capability validation', () => {
  it('tests all four native efforts and verifies actual image and native tool responses', async () => {
    const result = await validateCustomModelCapabilities(input)
    expect(result).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoningEffort: 'high',
      reasoningParameterMode: 'native', outputTokenParameter: 'max_tokens', visionEnabled: true,
      capabilityValidation: { text: 'verified', reasoning: 'parameter_accepted', vision: 'verified', tools: 'verified', requests: 6 } })
    expect(mocks.fetch.mock.calls.slice(0, 4).map(([, init]) => bodyOf(init).reasoning_effort)).toEqual(['high', 'medium', 'low', 'max'])
    expect(mocks.fetch.mock.calls.every(([url, init]) => url.href === 'https://models.example.com/v1/chat/completions'
      && init.method === 'POST' && init.redirect === 'manual' && JSON.parse(init.body).max_tokens === 256)).toBe(true)
    expect(mocks.agent).toHaveBeenCalledWith(expect.objectContaining({ connect: { lookup: publicEgressLookup, timeout: 8000 } }))
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  it('keeps only accepted strengths rather than guessing from provider/model names', async () => {
    mocks.fetch.mockImplementation((url, init) => ['medium', 'max'].includes(bodyOf(init).reasoning_effort ?? '') ? unsupported() : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities({ ...input, provider: 'unknown', modelName: 'deepseek-sounding-but-different' }))
      .toMatchObject({ reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', reasoningParameterMode: 'native' })
  })

  it('tries omission only after explicit rejection, bounded to seven requests', async () => {
    mocks.fetch.mockImplementation((url, init) => bodyOf(init).reasoning_effort ? unsupported() : successfulProbe(url, init))
    const result = await validateCustomModelCapabilities(input)
    expect(result).toMatchObject({ reasoningEfforts: ['none'], defaultReasoningEffort: 'none', reasoningParameterMode: 'omit', capabilityValidation: { requests: 7 } })
    expect(mocks.fetch.mock.calls.slice(4).every(([, init]) => !('reasoning_effort' in JSON.parse(init.body)))).toBe(true)
  })

  it.each([[401, 'CUSTOM_MODEL_AUTH_FAILED'], [403, 'CUSTOM_MODEL_AUTH_FAILED'], [429, 'CUSTOM_MODEL_RATE_LIMITED'], [500, 'CUSTOM_MODEL_PROVIDER_UNAVAILABLE'], [503, 'CUSTOM_MODEL_PROVIDER_UNAVAILABLE']])('does not classify HTTP %s as unsupported or leak provider errors', async (status, code) => {
      mocks.fetch.mockResolvedValue(response({ error: { message: `${input.apiKey} unsupported reasoning_effort` } }, Number(status)))
      await expect(validateCustomModelCapabilities(input)).rejects.toMatchObject({ code })
      expect(mocks.fetch).toHaveBeenCalledOnce()
      expect(mocks.destroy).toHaveBeenCalledOnce()
    })

  it.each([response({ error: { message: 'invalid model' } }, 400), response({ choices: [{ message: { content: 'OK' } }] }), response({ error: { message: 'reasoning_effort unsupported' } })])('does not treat generic 400, canned 200 or embedded error as capability evidence', async rejected => {
      mocks.fetch.mockResolvedValue(rejected)
      await expect(validateCustomModelCapabilities(input)).rejects.toMatchObject({ code: 'CUSTOM_MODEL_INVALID_RESPONSE' })
      expect(mocks.fetch).toHaveBeenCalledOnce()
    })

  it('does not enable vision on a 200 response without the correct image answer', async () => {
    mocks.fetch.mockImplementation((url, init) => Array.isArray(bodyOf(init).messages[0].content)
      ? response({ choices: [{ message: { content: 'I can see images.' } }] }) : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities(input)).toMatchObject({ visionEnabled: false, capabilityValidation: { vision: 'unconfirmed', tools: 'verified' } })
  })

  it('keeps a usable text model when vision is explicitly unsupported', async () => {
    mocks.fetch.mockImplementation((url, init) => Array.isArray(bodyOf(init).messages[0].content) ? unsupported('image_url') : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities(input)).toMatchObject({ visionEnabled: false, capabilityValidation: { vision: 'unsupported' } })
  })

  it('keeps optional provider failures unconfirmed rather than unsupported', async () => {
    mocks.fetch.mockImplementation((url, init) => bodyOf(init).tools || Array.isArray(bodyOf(init).messages[0].content)
      ? response({ error: { message: 'unavailable' } }, 503) : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities(input)).toMatchObject({ visionEnabled: false, capabilityValidation: { vision: 'unconfirmed', tools: 'unconfirmed' } })
  })

  it('rejects redirects without forwarding the key or following the location', async () => {
    mocks.fetch.mockResolvedValue(new Response('', { status: 307, headers: { location: 'https://other.example.com' } }))
    await expect(validateCustomModelCapabilities(input)).rejects.toMatchObject({ code: 'CUSTOM_MODEL_REDIRECT_REJECTED' })
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it.each(['http://127.0.0.1/v1', 'http://localhost/v1', 'http://public.example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=x'])('rejects unsafe or ambiguous endpoint %s before dispatch', async baseUrl => {
      await expect(validateCustomModelCapabilities({ ...input, baseUrl })).rejects.toMatchObject({ code: 'CUSTOM_MODEL_URL_INVALID' })
      expect(mocks.fetch).not.toHaveBeenCalled()
    })

  it('bounds error response bodies', async () => {
    mocks.fetch.mockResolvedValue(new Response('x'.repeat(65537), { status: 400 }))
    await expect(validateCustomModelCapabilities(input)).rejects.toMatchObject({ code: 'CUSTOM_MODEL_CONNECTION_FAILED' })
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('stops on cancellation without attempting fallback', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(validateCustomModelCapabilities({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'CUSTOM_MODEL_VALIDATION_CANCELLED' })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('bounds each attempt to twelve seconds without labeling timeout unsupported', async () => {
    vi.useFakeTimers()
    mocks.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    const assertion = expect(validateCustomModelCapabilities(input)).rejects.toMatchObject({ code: 'CUSTOM_MODEL_VALIDATION_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(12_001)
    await assertion
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('accepts opaque high/max thinking truncated by the small probe, with text verified by low', async () => {
    mocks.fetch.mockImplementation((url, init) => ['high', 'max'].includes(bodyOf(init).reasoning_effort ?? '')
      ? response({ choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { prompt_tokens: 40, completion_tokens: 256 } })
      : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities(input)).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high', capabilityValidation: { text: 'verified', reasoning: 'parameter_accepted' } })
  })

  it('uses a no-parameter nonce probe to verify text without mislabeling accepted reasoning unsupported', async () => {
    mocks.fetch.mockImplementation((url, init) => bodyOf(init).reasoning_effort
      ? response({ choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { prompt_tokens: 40, completion_tokens: 256 } })
      : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities(input)).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high', 'max'],
      reasoningParameterMode: 'native', capabilityValidation: { text: 'verified', reasoning: 'parameter_accepted', requests: 7 } })
  })

  it('does not label truncated private reasoning as verified text without a real nonce reply', async () => {
    // A fresh body is needed for each bounded read.
    mocks.fetch.mockImplementation(async () => response({ choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { prompt_tokens: 40, completion_tokens: 256 } }))
    await expect(validateCustomModelCapabilities(input)).rejects.toMatchObject({ code: 'CUSTOM_MODEL_INVALID_RESPONSE' })
    expect(mocks.fetch).toHaveBeenCalledTimes(5)
  })

  it('negotiates max_completion_tokens only from an explicit replacement error and uses it thereafter', async () => {
    mocks.fetch.mockImplementation((url, init) => 'max_tokens' in JSON.parse(init.body)
      ? response({ error: { param: 'max_tokens', message: 'Unsupported parameter: max_tokens. Use max_completion_tokens instead.' } }, 400)
      : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities(input)).toMatchObject({ outputTokenParameter: 'max_completion_tokens', capabilityValidation: { requests: 7 } })
    expect(mocks.fetch.mock.calls.slice(1).every(([, init]) => JSON.parse(init.body).max_completion_tokens === 256 && !('max_tokens' in JSON.parse(init.body)))).toBe(true)
    expect(mocks.fetch.mock.calls.every(([, init]) => !('temperature' in JSON.parse(init.body)))).toBe(true)
  })

  it('keeps the seven-request limit when both output-parameter negotiation and reasoning omission are needed', async () => {
    mocks.fetch.mockImplementation((url, init) => 'max_tokens' in JSON.parse(init.body)
      ? response({ error: { param: 'max_tokens', message: 'max_tokens is unsupported; use max_completion_tokens.' } }, 422)
      : bodyOf(init).reasoning_effort ? unsupported() : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities(input)).toMatchObject({ outputTokenParameter: 'max_completion_tokens',
      reasoningParameterMode: 'omit', capabilityValidation: { requests: 7, vision: 'verified', tools: 'unconfirmed' } })
    expect(mocks.fetch).toHaveBeenCalledTimes(7)
  })

  it('does not retry a generic output rejection or an ambiguous replacement suggestion', async () => {
    mocks.fetch.mockImplementation(async () => response({ error: { message: 'Request invalid; try max_completion_tokens.' } }, 400))
    await expect(validateCustomModelCapabilities(input)).rejects.toMatchObject({ code: 'CUSTOM_MODEL_INVALID_RESPONSE' })
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('preserves the explicitly selected DeepSeek thinking protocol in every probe', async () => {
    expect(await validateCustomModelCapabilities({ ...input, provider: 'deepseek' })).toMatchObject({ thinkingEnabled: true, reasoningParameterMode: 'native' })
    expect(mocks.fetch.mock.calls.every(([, init]) => JSON.parse(init.body).thinking?.type === 'enabled')).toBe(true)
  })

  it('does not infer the thinking switch from a model name or URL', async () => {
    expect(await validateCustomModelCapabilities({ ...input, modelName: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' })).toMatchObject({ thinkingEnabled: false })
    expect(mocks.fetch.mock.calls.every(([, init]) => !('thinking' in JSON.parse(init.body)))).toBe(true)
  })

  it('omits an explicitly rejected thinking field in one bounded retry and all subsequent probes', async () => {
    mocks.fetch.mockImplementation((url, init) => 'thinking' in JSON.parse(init.body) ? unsupported('thinking') : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities({ ...input, provider: 'deepseek' })).toMatchObject({ thinkingEnabled: false, capabilityValidation: { requests: 7 } })
    expect(mocks.fetch.mock.calls.slice(1).every(([, init]) => !('thinking' in JSON.parse(init.body)))).toBe(true)
  })

  it('retains accepted thinking when only reasoning_effort is unsupported', async () => {
    mocks.fetch.mockImplementation((url, init) => bodyOf(init).reasoning_effort ? unsupported() : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities({ ...input, provider: 'deepseek' })).toMatchObject({ thinkingEnabled: true, reasoningParameterMode: 'omit', reasoningEfforts: ['none'] })
    expect(mocks.fetch.mock.calls.every(([, init]) => JSON.parse(init.body).thinking?.type === 'enabled')).toBe(true)
  })

  it.each([401, 429, 503])('never disables thinking after HTTP %s', async status => {
    mocks.fetch.mockImplementation(async () => response({ error: { message: 'thinking unsupported' } }, status))
    await expect(validateCustomModelCapabilities({ ...input, provider: 'deepseek' })).rejects.toBeInstanceOf(Error)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).thinking).toEqual({ type: 'enabled' })
  })

  it('shares seven requests across both protocol negotiations and skips optional probes when exhausted', async () => {
    mocks.fetch.mockImplementation((url, init) => 'thinking' in JSON.parse(init.body) ? unsupported('thinking')
      : 'max_tokens' in JSON.parse(init.body) ? response({ error: { message: 'max_tokens unsupported, use max_completion_tokens.' } }, 400)
        : successfulProbe(url, init))
    expect(await validateCustomModelCapabilities({ ...input, provider: 'deepseek' })).toMatchObject({ thinkingEnabled: false,
      outputTokenParameter: 'max_completion_tokens', capabilityValidation: { requests: 7, tools: 'unconfirmed' } })
    expect(mocks.fetch).toHaveBeenCalledTimes(7)
  })
})
