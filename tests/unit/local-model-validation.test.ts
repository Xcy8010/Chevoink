import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } } }))
vi.mock('../../api/lib/local-model-transport.js', () => ({ localModelFetch: mocks.local }))
vi.mock('undici', () => ({ fetch: mocks.remote, Agent: class { destroy() { return Promise.resolve() } } }))
import { validateCustomModelCapabilities } from '../../api/lib/custom-model-validation.js'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.local.mockImplementation(async input => {
    const body = JSON.parse(input.body)
    const content = body.messages[0].content
    if (body.tools || Array.isArray(content)) return new Response(JSON.stringify({ error: { param: body.tools ? 'tools' : 'image', message: 'Unsupported parameter: ' + (body.tools ? 'tools' : 'image') } }), { status: 400 })
    return new Response(JSON.stringify({ choices: [{ message: { content: content.split(': ').at(-1) }, finish_reason: 'stop' }] }))
  })
})
it('keeps local validation on its bound owner and checks explicit none within seven calls', async () => {
  const result = await validateCustomModelCapabilities({ userId: 'owner', provider: 'local-openai', modelName: 'model', baseUrl: 'http://127.0.0.1:7863/v1', apiKey: 'dedicated-connector-credential' })
  expect(result.reasoningEfforts).toContain('none')
  expect(result.capabilityValidation.requests).toBe(7)
  expect(result.capabilityValidation.tools).toBe('unsupported')
  expect(mocks.remote).not.toHaveBeenCalled()
  expect(mocks.local.mock.calls.every(([input]) => input.userId === 'owner' && input.validation === true && input.apiKey === 'dedicated-connector-credential')).toBe(true)
})
it('does not certify non-thinking when the local model exposes actual reasoning', async () => {
  const previous = mocks.local.getMockImplementation()!
  mocks.local.mockImplementation(async input => {
    if (JSON.parse(input.body).reasoning_effort !== 'none') return previous(input)
    const body = JSON.parse(input.body)
    return new Response(JSON.stringify({ choices: [{ message: { content: body.messages[0].content.split(': ').at(-1), reasoning_content: 'still thinking' } }] }))
  })
  const result = await validateCustomModelCapabilities({ userId: 'owner', provider: 'local-openai', modelName: 'model', baseUrl: 'http://127.0.0.1:7863/v1', apiKey: 'dedicated-connector-credential' })
  expect(result.reasoningEfforts).not.toContain('none')
  expect(result.capabilityValidation.requests).toBe(7)
})
