import { beforeEach, expect, it, vi } from 'vitest'
import { Response } from 'undici'
import { prepareAdminModelConnection, diagnosticEnvironmentRoute } from '../../api/lib/admin-model-connection.js'
import type { DiagnosticModelSnapshot } from '../../api/lib/admin-model-diagnostics.js'
import { env } from '../../api/config/env.js'

const mocks = vi.hoisted(() => ({ find: vi.fn(), request: vi.fn(), close: vi.fn(), decrypt: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/prisma.js')>(),
  prisma: { aiModelConfig: { findFirst: mocks.find } },
}))
vi.mock('../../api/lib/public-http.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/public-http.js')>(),
  requestPublicProviderJson: mocks.request,
}))
vi.mock('../../api/lib/secret-box.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/secret-box.js')>(), decryptSecret: mocks.decrypt,
}))

const base: DiagnosticModelSnapshot = { id: 'synthetic-model', revision: '3', modelName: 'fixture', modelKind: 'text',
  provider: 'fixture', baseUrl: 'https://gateway.example.com/v1', apiKeyConfigured: true, metadata: null, archived: false }
const signal = new AbortController().signal

beforeEach(() => {
  vi.resetAllMocks()
  mocks.find.mockResolvedValue({ apiKeyCiphertext: 'encrypted-fixture' })
  mocks.decrypt.mockReturnValue('synthetic-secret')
})

it.each([
  { kind: 'text', endpoint: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'Reply with OK.' }] },
    response: { choices: [{ message: { content: 'OK' } }], usage: { completion_tokens: 2 } } },
  { kind: 'text', endpoint: '/v1/responses', body: { input: [{ role: 'user', content: 'Reply with OK.' }], max_output_tokens: 128, store: false },
    metadata: { toolCallingProtocol: 'responses', capabilityValidation: { protocol: 'responses', tools: 'verified' } },
    response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { output_tokens: 2 } } },
  { kind: 'vision', endpoint: '/v1/chat/completions', body: { messages: [{ role: 'user', content: [expect.objectContaining({ type: 'text' }), expect.objectContaining({ image_url: { url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'low' } })] }] },
    response: { choices: [{ message: { content: 'Blue' } }] } },
  { kind: 'image_generation', endpoint: '/v1/images/generations', body: { n: 1, size: '768x1024' },
    response: { data: [{ url: 'https://images.example.com/test.png' }] } },
  { kind: 'web_search', endpoint: '/v1/web-search', body: { count: 1, summary: false }, metadata: { webToolProtocol: 'bocha' },
    response: { code: 200, data: { webPages: { value: [] } } } },
  { kind: 'web_fetch', endpoint: '/v1/tools/fetch', body: { url: 'https://example.com/' }, metadata: { webToolProtocol: 'deepseek' },
    response: { title: 'Example Domain', content: 'Synthetic page' } },
] as const)('sends one configured $kind request to $endpoint', async row => {
  const origin = 'https://gateway.example.com'
  const model = { ...base, modelKind: row.kind, metadata: 'metadata' in row ? row.metadata : null,
    baseUrl: row.kind === 'image_generation' ? origin + row.endpoint : base.baseUrl }
  mocks.request.mockResolvedValue({ response: new Response(JSON.stringify(row.response)), close: mocks.close })
  const run = await prepareAdminModelConnection(model, 128)
  const emit = vi.fn()
  expect(await run(signal, emit)).toMatchObject({ valid: true, fee: { status: 'unknown', amountMicros: null } })
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(origin + row.endpoint, 'synthetic-secret', expect.objectContaining(row.body), signal)
  expect(emit).toHaveBeenCalledWith({ type: 'headers', status: 200 })
  expect(mocks.close).toHaveBeenCalledOnce()
})

it('reports upstream authorization without retry and rejects expired revisions before requesting', async () => {
  mocks.request.mockResolvedValue({ response: new Response('sensitive-upstream-body', { status: 401 }), close: mocks.close })
  const run = await prepareAdminModelConnection(base, 128)
  const emit = vi.fn()
  await expect(run(signal, emit)).rejects.toMatchObject({ stage: 'authentication', diagnosticCode: 'AUTH_FAILED' })
  expect(emit).toHaveBeenCalledWith({ type: 'headers', status: 401 })
  mocks.find.mockResolvedValue(null)
  await expect(prepareAdminModelConnection(base, 128)).rejects.toMatchObject({ diagnosticCode: 'DIAGNOSTIC_MODEL_CHANGED' })
  expect(mocks.find).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: base.id, revision: 3, ownerUserId: null, archivedAt: null } }))
  expect(mocks.request).toHaveBeenCalledOnce()
})

it('retains reported tokens on truncated text and rejects unusable image or search results', async () => {
  const truncated = { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: { completion_tokens: 128 } }
  mocks.request.mockResolvedValueOnce({ response: new Response(JSON.stringify(truncated)), close: mocks.close })
    .mockResolvedValueOnce({ response: new Response(JSON.stringify({ data: [{ url: 'not-an-image' }] })), close: mocks.close })
    .mockResolvedValueOnce({ response: new Response(JSON.stringify({ code: 200, data: { webPages: { value: [{ name: 'private', url: 'http://127.0.0.1/' }] } } })), close: mocks.close })
  expect(await (await prepareAdminModelConnection(base, 128))(signal, vi.fn())).toMatchObject({ valid: false, outputTokens: 128 })
  expect(await (await prepareAdminModelConnection({ ...base, modelKind: 'image_generation' }, 128))(signal, vi.fn())).toMatchObject({ valid: false })
  expect(await (await prepareAdminModelConnection({ ...base, modelKind: 'web_search', provider: 'bocha' }, 128))(signal, vi.fn())).toMatchObject({ valid: false })
})

it('never pairs a missing stored key with a different environment endpoint', () => {
  const configured = env.aiTextApiKeyConfigured
  env.aiTextApiKeyConfigured = true
  try {
    expect(diagnosticEnvironmentRoute({ ...base, apiKeyConfigured: false, baseUrl: env.aiTextBaseUrl }, 'speed')).toMatchObject({ environmentKey: 'text', baseUrl: env.aiTextBaseUrl })
    expect(diagnosticEnvironmentRoute({ ...base, apiKeyConfigured: false, baseUrl: 'https://other.example.com/v1' }, 'speed')).toEqual({})
  } finally { env.aiTextApiKeyConfigured = configured }
})
