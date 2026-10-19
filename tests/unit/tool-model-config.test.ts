import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToolModelRuntimeCache, getToolModelRuntime } from '../../api/lib/tool-model-config.js'

const mocks = vi.hoisted(() => ({ find: vi.fn(), decrypt: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { aiModelConfig: { findFirst: mocks.find } } }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: mocks.decrypt }))
beforeEach(() => { clearToolModelRuntimeCache(); mocks.find.mockReset(); mocks.decrypt.mockReset().mockImplementation((value: string) => `clear-${value}`) })
const record = (key: string) => ({ provider: 'deepseek', modelName: key, baseUrl: 'https://api.deepseek.com', apiKeyCiphertext: key })

describe('independent admin tool runtime configuration', () => {
  it('scopes Search and Fetch queries and caches their distinct credentials', async () => {
    mocks.find.mockImplementation(async ({ where }: { where: { key: string } }) => record(where.key))
    expect(await getToolModelRuntime('tool:web-search')).toMatchObject({ apiKey: 'clear-tool:web-search' })
    expect(await getToolModelRuntime('tool:web-fetch')).toMatchObject({ apiKey: 'clear-tool:web-fetch' })
    await getToolModelRuntime('tool:web-fetch')
    expect(mocks.find).toHaveBeenCalledTimes(2)
    expect(mocks.find).toHaveBeenCalledWith({ where: { key: 'tool:web-fetch', ownerUserId: null, enabled: true } })
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
