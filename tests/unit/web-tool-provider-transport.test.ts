import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockAgent, type Agent } from 'undici'

const state = vi.hoisted(() => ({ offline: null as MockAgent | null, created: [] as Agent[], origins: [] as string[] }))
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, Agent: class extends actual.Agent {
    constructor(options: Agent.Options) {
      super({ ...options, factory: origin => { state.origins.push(String(origin)); return state.offline!.get(String(origin)) } })
      state.created.push(this)
    }
  } }
})

import { requestWebTool } from '../../api/lib/web-tool-provider.js'

beforeEach(() => { state.offline = new MockAgent(); state.offline.disableNetConnect(); state.created = []; state.origins = [] })
afterEach(async () => {
  for (const agent of state.created) await agent.destroy()
  // Agent.destroy already owns/destroys every mocked pool. MockAgent.close
  // would close those destroyed clients again; no socket exists in this test.
  if (!state.created.length) await state.offline!.close()
})

describe('installed web-tool dispatcher transport contract (offline)', () => {
  it('delivers the real installed fetch/Agent protocol without Node built-in fetch incompatibility', async () => {
    state.offline!.get('https://example.com').intercept({ path: '/v1/tools/search', method: 'POST' }).reply(200, { results: [] })
    const request = await requestWebTool('https://example.com/v1/tools/search', 'synthetic-not-a-secret',
      { query: 'synthetic', count: 1 }, AbortSignal.timeout(1000))
    expect(request.response.status).toBe(200)
    expect(await request.response.json()).toEqual({ results: [] })
    await request.close()
    state.offline!.assertNoPendingInterceptors()
    expect(state.created[0].destroyed).toBe(true)
  })
  it('preserves provider refusal and closes the actual dispatcher without a retry', async () => {
    state.offline!.get('https://example.com').intercept({ path: '/v1/tools/fetch', method: 'POST' }).reply(401, { error: 'synthetic' })
    const request = await requestWebTool('https://example.com/v1/tools/fetch', 'synthetic-not-a-secret', {}, AbortSignal.timeout(1000))
    expect(request.response.status).toBe(401)
    await request.close()
    state.offline!.assertNoPendingInterceptors()
    expect(state.created).toHaveLength(1)
    expect(state.created[0].destroyed).toBe(true)
  })
  it('rejects cancellation before constructing or dispatching a request', async () => {
    const controller = new AbortController(); controller.abort(new Error('synthetic cancellation'))
    await expect(requestWebTool('https://example.com/v1/tools/search', 'synthetic', {}, controller.signal)).rejects.toThrow('synthetic cancellation')
    expect(state.created).toHaveLength(0)
  })
  it('does not follow a provider redirect to a second credential destination', async () => {
    state.offline!.get('https://example.com').intercept({ path: '/v1/tools/search', method: 'POST' })
      .reply(302, '', { headers: { location: 'https://example.org/other' } })
    await expect(requestWebTool('https://example.com/v1/tools/search', 'synthetic-not-a-secret', {}, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ cause: { message: 'unexpected redirect' } })
    expect(state.origins).toEqual(['https://example.com'])
    expect(state.created[0].destroyed).toBe(true)
  })
})
