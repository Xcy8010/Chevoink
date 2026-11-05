import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webToolEndpoint } from '../../api/lib/web-tool-provider.js'
import { clearToolModelRuntimeCache, getToolModelRuntime } from '../../api/lib/tool-model-config.js'
import { randomUUID } from 'node:crypto'

const mocks = vi.hoisted(() => ({ find: vi.fn(), decrypt: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: { aiModelConfig: { findFirst: mocks.find } } }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: mocks.decrypt }))
beforeEach(() => { clearToolModelRuntimeCache(); mocks.find.mockReset(); mocks.decrypt.mockReset().mockImplementation((value: string) => `clear-${value}`) })
const record = (key: string) => ({ provider: 'deepseek', modelName: key, baseUrl: 'https://api.deepseek.com', apiKeyCiphertext: key })
it('loads enabled image fallback credentials in configured order only into the private runtime', async () => {
  const routes = ['first', 'disabled', 'last'].map(label => ({ id: randomUUID(), label, enabled: label !== 'disabled', provider: 'image-relay', modelName: label, baseUrl: `https://${label}.invalid/generate`, apiKeyCiphertext: label }))
  mocks.find.mockResolvedValue({ ...record('image'), metadata: { routes } })
  const runtime = await getToolModelRuntime('tool:image-generation')
  expect(runtime?.routes).toEqual([routes[0], routes[2]].map(({ id, provider, modelName, baseUrl, apiKeyCiphertext }) => ({ id, provider, modelName, baseUrl, apiKey: `clear-${apiKeyCiphertext}` })))
  expect(mocks.decrypt).not.toHaveBeenCalledWith('disabled')
})

describe('independent admin tool runtime configuration', () => {
  it('scopes Search and Fetch queries and caches their distinct credentials', async () => {
    mocks.find.mockImplementation(async ({ where }: { where: { key: string } }) => record(where.key))
    expect(await getToolModelRuntime('tool:web-search')).toMatchObject({ apiKey: 'clear-tool:web-search' })
    expect(await getToolModelRuntime('tool:web-fetch')).toMatchObject({ apiKey: 'clear-tool:web-fetch' })
    await getToolModelRuntime('tool:web-fetch')
    expect(mocks.find).toHaveBeenCalledTimes(2)
    expect(mocks.find).toHaveBeenCalledWith({ where: { key: 'tool:web-fetch', ownerUserId: null, archivedAt: null, enabled: true } })
  })
  it('reloads after admin cache invalidation including key rotation', async () => {
    mocks.find.mockResolvedValueOnce(record('old')).mockResolvedValueOnce(record('new'))
    expect(await getToolModelRuntime('tool:web-fetch')).toMatchObject({ apiKey: 'clear-old' })
    clearToolModelRuntimeCache()
    expect(await getToolModelRuntime('tool:web-fetch')).toMatchObject({ apiKey: 'clear-new' })
  })
  it('preserves opt-in direct behavior only when no enabled Fetch record exists', async () => {
    mocks.find.mockResolvedValue(null)
    expect(await getToolModelRuntime('tool:web-fetch')).toBeNull()
    expect(mocks.decrypt).not.toHaveBeenCalled()
  })
  it.each(['tool:web-search', 'tool:web-fetch'] as const)('reports unavailable config explicitly for %s instead of silent provider fallback', async key => {
    mocks.find.mockRejectedValue(new Error('private database details'))
    await expect(getToolModelRuntime(key)).rejects.toMatchObject({ code: 'TOOL_CONFIG_UNAVAILABLE', message: 'TOOL_CONFIG_UNAVAILABLE' })
  })
  it.each([{ ...record('fetch'), modelName: 'unconfigured' }, { ...record('fetch'), baseUrl: null }, { ...record('fetch'), apiKeyCiphertext: null }])('rejects enabled incomplete config before decryption', async value => {
    mocks.find.mockResolvedValue(value)
    await expect(getToolModelRuntime('tool:web-fetch')).rejects.toMatchObject({ code: 'TOOL_CONFIG_INCOMPLETE' })
    expect(mocks.decrypt).not.toHaveBeenCalled()
  })
})

it.each(['deepseek', 'bocha'] as const)('loads the explicit %s protocol alongside the unchanged custom supplier', async webToolProtocol => {
  mocks.find.mockResolvedValue({ ...record('search'), provider: 'custom_supplier', metadata: { webToolProtocol } })
  const runtime = await getToolModelRuntime('tool:web-search')
  expect(runtime).toMatchObject({ provider: 'custom_supplier', webToolProtocol })
  expect(webToolEndpoint(runtime!, 'search')).toBe(webToolProtocol === 'deepseek' ? 'https://api.deepseek.com/v1/tools/search' : 'https://api.deepseek.com/v1/web-search')
})

it.each(['unsupported', null])('rejects malformed stored protocol %j at the web boundary rather than silently using the supplier name', async webToolProtocol => {
  mocks.find.mockResolvedValue({ ...record('search'), metadata: { webToolProtocol } })
  const runtime = await getToolModelRuntime('tool:web-search')
  expect(() => webToolEndpoint(runtime!, 'search')).toThrow('WEB_TOOL_PROVIDER_UNSUPPORTED')
})

it('ignores web protocol metadata for ordinary image tools', async () => {
  mocks.find.mockResolvedValue({ ...record('image'), metadata: { webToolProtocol: 'unsupported' } })
  expect(await getToolModelRuntime('tool:image-generation')).not.toHaveProperty('webToolProtocol')
})
