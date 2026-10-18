import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ row: vi.fn(), request: vi.fn(), online: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } }, prisma: { aiModelConfig: { findUnique: mocks.row } } }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value }))
vi.mock('../../api/lib/local-model-broker.js', () => ({ localModelBroker: { request: mocks.request, online: mocks.online }, LocalModelTransportError: class extends Error { constructor(public dispatched: boolean, message: string) { super(message) } } }))
import { assertLocalModelReady, authenticateConnector, localModelFetch, newConnectorToken } from '../../api/lib/local-model-transport.js'
const token = newConnectorToken('model-id')
const row = { id: 'model-id', ownerUserId: 'owner', provider: 'local-openai', baseUrl: 'http://127.0.0.1:7863/v1', modelName: 'model', enabled: true,
  apiKeyCiphertext: token, owner: { tokenVersion: 2, bannedAt: null }, metadata: { connectorOwnerTokenVersion: 2, capabilityValidation: { tools: 'verified' } } }
const input = { userId: 'owner', provider: row.provider, baseUrl: row.baseUrl, apiKey: token, body: '{"model":"model","tools":[{}]}' }
beforeEach(() => { vi.clearAllMocks(); mocks.row.mockResolvedValue(row); mocks.online.mockReturnValue(true); mocks.request.mockResolvedValue(new Response('valid')) })
describe('local connector authority', () => {
  it('refuses offline admission before any provider attempt can be marked dispatched', async () => {
    mocks.online.mockReturnValue(false)
    await expect(assertLocalModelReady(input)).rejects.toMatchObject({ dispatched: false })
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('binds credentials to a current owned local model without sending API secrets', async () => {
    await expect(localModelFetch(input)).resolves.toBeInstanceOf(Response)
    expect(mocks.request).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), input.body, undefined)
    expect(JSON.stringify(mocks.request.mock.calls)).not.toContain(token)
  })
  it.each([{ userId: 'foreign' }, { provider: 'custom' }, { baseUrl: 'http://127.0.0.1:9999/v1' }, { body: '{"model":"different"}' }])('rejects changed scope before queueing %s', async patch => {
    await expect(localModelFetch({ ...input, ...patch })).rejects.toThrow()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it.each([{ owner: { tokenVersion: 3, bannedAt: null } }, { owner: { tokenVersion: 2, bannedAt: new Date() } }, { apiKeyCiphertext: newConnectorToken('model-id') }, { provider: 'custom' }, { ownerUserId: null }])('revokes changed or invalid credentials', async patch => {
    mocks.row.mockResolvedValue({ ...row, ...patch })
    await expect(authenticateConnector(token)).rejects.toMatchObject({ status: 401 })
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('requires verified tools for Agent calls, while allowing bounded validation of a disabled profile', async () => {
    mocks.row.mockResolvedValue({ ...row, enabled: false, metadata: { connectorOwnerTokenVersion: 2 } })
    await expect(localModelFetch(input)).rejects.toThrow()
    await expect(localModelFetch({ ...input, validation: true })).resolves.toBeInstanceOf(Response)
    expect(mocks.request).toHaveBeenCalledOnce()
  })
  it('rejects malformed credential tokens without any DB lookup', async () => {
    await expect(authenticateConnector('session-or-provider-key')).rejects.toMatchObject({ status: 401 })
    expect(mocks.row).not.toHaveBeenCalled()
  })
})
