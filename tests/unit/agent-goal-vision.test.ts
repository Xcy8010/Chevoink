import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withGoalExecutionContext } from '../../api/lib/agent/goal-context.js'

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), reserve: vi.fn(), admit: vi.fn(), sync: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error {}, prisma: { aiUsageLog: { create: mocks.create, update: mocks.update } } }))
vi.mock('../../api/lib/agent/goal-budget.js', () => ({ reserveGoalUsage: mocks.reserve, assertGoalProviderAdmission: mocks.admit, syncGoalLegacyUsage: mocks.sync }))
vi.mock('../../api/lib/tool-model-config.js', () => ({ getToolModelRuntime: async () => ({ baseUrl: 'https://vision.example/v1', apiKey: 'fixture-only', modelName: 'vision' }) }))
import { describeImageWithVision } from '../../api/lib/vision-service.js'

const context = { goalId: 'goal', revision: 1, epoch: 1n, runId: 'run', userId: 'user', novelId: 'novel', sessionId: 'session' }
const request = (signal = new AbortController().signal) => withGoalExecutionContext(context, () => describeImageWithVision(
  { buffer: Buffer.from('fixture'), mime: 'image/png' }, '描述图片', { userId: 'user', runId: 'run', signal },
))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.create.mockResolvedValue({ id: 'usage' })
  mocks.update.mockResolvedValue({ id: 'usage' })
})
afterEach(() => vi.unstubAllGlobals())

describe('goal vision provider boundary', () => {
  it('reserves before dispatch and counts reported internal usage without charging user text Credits', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(mocks.reserve).toHaveBeenCalledWith('legacy:usage', expect.any(Number))
      expect(mocks.admit).toHaveBeenCalledOnce()
      expect(JSON.parse(String(init.body))).toMatchObject({ max_tokens: 4096 })
      return new Response(JSON.stringify({ choices: [{ message: { content: '图片描述' } }], usage: { prompt_tokens: 1200, completion_tokens: 30 } }))
    }))
    expect(await request()).toBe('图片描述')
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: 1200, responseTokens: 30, billingStatus: 'exempt', usageSource: 'reported' }) }))
    expect(mocks.sync).toHaveBeenCalledWith('usage')
  })
  it('does not contact the provider when admission is fenced after reservation', async () => {
    mocks.admit.mockRejectedValue(new Error('goal cancelled'))
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(request()).rejects.toThrow('goal cancelled')
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ billingStatus: 'not_dispatched' }) }))
  })
  it('records usage after cancellation and does not turn unknown usage into zero', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw new Error('connection closed') }))
    await expect(request(controller.signal)).rejects.toThrow('connection closed')
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestTokens: null, responseTokens: null, billingStatus: 'pending_usage' }) }))
    expect(mocks.sync).toHaveBeenCalledWith('usage')
  })
})
