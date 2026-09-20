import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), validate: vi.fn(),
  encrypt: vi.fn((value: string) => `encrypted:${value}`), decrypt: vi.fn(() => 'stored-test-key'),
}))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: { aiModelConfig: { count: mocks.count, create: mocks.create, findFirst: mocks.findFirst, updateMany: mocks.updateMany } },
  normalizeDataAccessError: () => ({ status: 500, code: 'DATA_ACCESS_ERROR', message: 'internal' }),
}))
vi.mock('../../api/lib/auth-session.js', () => ({ requireSessionUserId: () => 'owner' }))
vi.mock('../../api/lib/secret-box.js', () => ({ encryptSecret: mocks.encrypt, decryptSecret: mocks.decrypt }))
vi.mock('../../api/lib/custom-model-validation.js', () => ({ validateCustomModelCapabilities: mocks.validate }))
vi.mock('../../api/lib/credits.js', () => ({
  getCreditActivity: vi.fn(), getCreditSummary: vi.fn(), getCreditUsage: vi.fn(), getTaskCreditUsage: vi.fn(), getReferralPayload: vi.fn(),
  parseModelCapabilities: (metadata: Record<string, unknown>) => ({ ...metadata, contextWindowTokens: metadata.contextWindowTokens ?? null }),
}))
import router from '../../api/routes/credits.js'
import { DataAccessError } from '../../api/lib/prisma.js'

const app = express().use(express.json()).use('/credits', router)
const body = { provider: 'custom', displayName: 'my model', modelName: 'model', baseUrl: 'https://provider.example/v1/', apiKey: 'fixture-test-key' }
const verified = { reasoningEfforts: ['none'], defaultReasoningEffort: 'none', visionEnabled: false, reasoningParameterMode: 'omit',
  capabilityValidation: { version: 1, checkedAt: '2026-09-20T00:00:00Z', text: 'verified', reasoning: 'parameter_unsupported', vision: 'unsupported', tools: 'verified', requests: 4 } }
const target = { id: 'model-id', ownerUserId: 'owner', provider: 'custom', modelName: 'old-model', baseUrl: 'https://provider.example/v1',
  apiKeyCiphertext: 'ciphertext', updatedAt: new Date('2026-09-19T00:00:00Z'), metadata: { reasoningParameterMode: 'native', visionEnabled: true, contextWindowTokens: 32000, legacySetting: 'keep' } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.count.mockResolvedValue(0)
  mocks.create.mockResolvedValue({ id: 'created' })
  mocks.findFirst.mockResolvedValue(target)
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.validate.mockResolvedValue(verified)
})

describe('custom model routes capability validation', () => {
  it('persists server evidence rather than user-declared capabilities', async () => {
    const response = await request(app).post('/credits/models').send({ ...body, reasoningEfforts: ['max'], defaultReasoningEffort: 'max', visionEnabled: true,
      reasoningParameterMode: 'native', capabilities: { visionEnabled: true }, capabilityValidation: { text: 'verified' }, contextWindowTokens: 64000 }).expect(201)
    expect(response.body.data).toEqual({ id: 'created' })
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerUserId: 'owner', baseUrl: 'https://provider.example/v1',
      apiKeyCiphertext: 'encrypted:fixture-test-key', metadata: { ...verified, contextWindowTokens: 64000 } }) })
    expect(response.text).not.toContain('fixture-test-key')
    expect(mocks.validate.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal)
  })
  it.each(['post', 'patch'] as const)('does not persist a failed %s probe and allows a later attempt', async method => {
    mocks.validate.mockRejectedValueOnce(new DataAccessError(502, 'CUSTOM_MODEL_INVALID_RESPONSE', '模型响应不可核验'))
    const url = method === 'post' ? '/credits/models' : '/credits/models/model-id'
    const result = await request(app)[method](url).send(body).expect(502)
    expect(result.body.error.code).toBe('CUSTOM_MODEL_INVALID_RESPONSE')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    await request(app)[method](url).send(body).expect(method === 'post' ? 201 : 200)
  })
  it('does not probe or modify another user model', async () => {
    mocks.findFirst.mockResolvedValue(null)
    await request(app).patch('/credits/models/foreign').send({ displayName: 'stolen' }).expect(404)
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', ownerUserId: 'owner' } })
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.decrypt).not.toHaveBeenCalled()
  })
  it('uses stored credentials for partial edits and replaces stale capability declarations', async () => {
    await request(app).patch('/credits/models/model-id').send({ displayName: 'renamed', visionEnabled: true, reasoningEfforts: ['max'] }).expect(200)
    expect(mocks.validate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'custom', modelName: 'old-model', baseUrl: target.baseUrl, apiKey: 'stored-test-key' }))
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: target.id, ownerUserId: 'owner', updatedAt: target.updatedAt },
      data: expect.objectContaining({ displayName: 'renamed', apiKeyCiphertext: undefined, metadata: { ...target.metadata, ...verified } }) })
  })
  it('reports a concurrent edit conflict rather than applying a slow probe over newer configuration', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const response = await request(app).patch('/credits/models/model-id').send({ modelName: 'probed-model' }).expect(409)
    expect(response.body.error.code).toBe('CUSTOM_MODEL_CHANGED')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'model-id', ownerUserId: 'owner', updatedAt: target.updatedAt } }))
  })
  it('bounds concurrent probes per user without writing an unverified model', async () => {
    let started!: () => void
    let finish!: (value: typeof verified) => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    mocks.validate.mockImplementationOnce(() => { started(); return new Promise<typeof verified>(resolve => { finish = resolve }) })
    const first = request(app).post('/credits/models').send(body).then(response => response)
    await startedPromise
    try {
      const second = await request(app).post('/credits/models').send(body).expect(409)
      expect(second.body.error.code).toBe('CUSTOM_MODEL_VALIDATING')
      expect(mocks.validate).toHaveBeenCalledTimes(1)
      expect(mocks.create).not.toHaveBeenCalled()
    } finally { finish(verified) }
    expect((await first).status).toBe(201)
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })
  it('checks the model limit before issuing paid provider probes', async () => {
    mocks.count.mockResolvedValue(10)
    await request(app).post('/credits/models').send(body).expect(409)
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
