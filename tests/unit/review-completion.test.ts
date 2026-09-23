import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const complete = vi.hoisted(() => vi.fn())
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: complete }))
import { env } from '../../api/config/env.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { generateReviewCompletion } from '../../api/lib/agent/review-completion.js'

beforeEach(() => { complete.mockReset() })
afterEach(() => vi.useRealTimers())
const options = { userId: 'user', action: 'agent3HumanityCritic', reasoningEffort: 'low' as const }
describe('bounded review completion recovery', () => {
  it('recovers confirmed truncation once with the complete input and larger allowance', async () => {
    complete.mockRejectedValueOnce(new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'length')).mockResolvedValueOnce('{"findings":[]}')
    const signal = new AbortController().signal
    await expect(generateReviewCompletion('审查规则', '正文首\n完整原文\n正文尾', { ...options, signal })).resolves.toBe('{"findings":[]}')
    expect(complete.mock.calls).toEqual([
      ['审查规则', '正文首\n完整原文\n正文尾', { ...options, signal: expect.any(AbortSignal), maxOutputTokens: 16_384, boundedReview: true }],
      ['审查规则', '正文首\n完整原文\n正文尾', { ...options, signal: expect.any(AbortSignal), action: 'agent3HumanityCriticOutputRecovery', maxOutputTokens: 32_768, boundedReview: true }],
    ])
    expect(complete.mock.calls[0][2].signal).toBe(complete.mock.calls[1][2].signal)
  })
  it('never makes a third paid call when the larger allowance also truncates', async () => {
    complete.mockRejectedValue(new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'length'))
    await expect(generateReviewCompletion('s', 'c', options)).rejects.toMatchObject({ code: 'AI_PROVIDER_OUTPUT_LIMIT' })
    expect(complete).toHaveBeenCalledTimes(2)
  })
  it('aborts a hanging provider without resetting the shared deadline for recovery', async () => {
    vi.useFakeTimers()
    complete.mockImplementationOnce(() => new Promise((_resolve, reject) => setTimeout(() => reject(new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'length')), 120_000)))
      .mockImplementationOnce((_system, _content, input) => new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })))
    const result = generateReviewCompletion('s', 'c', options)
    const assertion = expect(result).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' })
    // 等待上限跟随 env（默认 4 分钟）：不再叠加旧的 180s 硬帽
    await vi.advanceTimersByTimeAsync(env.aiTextTimeoutMs)
    await assertion
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0][2].signal).toBe(complete.mock.calls[1][2].signal)
    expect(complete.mock.calls[1][2].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['AI_PROVIDER_TRANSPORT', 'AI_PROVIDER_TIMEOUT', 'AI_PROVIDER_INCOMPLETE', 'CREDITS_EXHAUSTED'])('does not redispatch uncertain/credit failure %s', async code => {
    complete.mockRejectedValue(new DataAccessError(502, code, 'failure'))
    await expect(generateReviewCompletion('s', 'c', options)).rejects.toMatchObject({ code })
    expect(complete).toHaveBeenCalledOnce()
  })
  it('honors cancellation between attempts and keeps the same cancellation deadline', async () => {
    const controller = new AbortController()
    complete.mockImplementationOnce(async () => { controller.abort(); throw new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'length') })
    await expect(generateReviewCompletion('s', 'c', { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(complete).toHaveBeenCalledOnce()
  })
  it('does not retry a valid result and preserves an explicitly selected custom model', async () => {
    complete.mockResolvedValue('{"findings":[]}')
    const modelRuntime = { tier: 'custom' as const, provider: 'fixture', apiKey: 'fixture-only', modelName: 'chosen', baseUrl: 'https://model.invalid', reasoningEffort: 'low' as const, multiplierBps: 0, visionEnabled: false, contextWindowTokens: null }
    await generateReviewCompletion('s', 'c', { ...options, modelRuntime })
    expect(complete).toHaveBeenCalledExactlyOnceWith('s', 'c', expect.objectContaining({ modelRuntime, maxOutputTokens: 16_384 }))
  })
  it('does not spend on a recovery after the caller reports a stale revision', async () => {
    complete.mockRejectedValue(new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'length'))
    const beforeRecovery = vi.fn(async () => { throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', 'stale') })
    await expect(generateReviewCompletion('s', 'c', options, beforeRecovery)).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
    expect(beforeRecovery).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })
})
