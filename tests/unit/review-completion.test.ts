import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const complete = vi.hoisted(() => vi.fn())
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: complete }))
import { env } from '../../api/config/env.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { generateReviewCompletion } from '../../api/lib/agent/review-completion.js'
import { recordTextRequestFailure } from '../../api/lib/text-request-trace.js'

beforeEach(() => { complete.mockReset() })
afterEach(() => vi.useRealTimers())
const options = { userId: 'user', action: 'agent3HumanityCritic', reasoningEffort: 'low' as const }
function knownFailure(code = 'AI_PROVIDER_OUTPUT_LIMIT') {
  const error = new DataAccessError(502, code, 'fixture terminal failure')
  recordTextRequestFailure(error, { usageId: 'settled-original', status: 'terminal', billingKnown: true }, 's', 'c', options)
  return error
}
describe('bounded review completion recovery', () => {
  it.each(['agent3HumanityCritic', 'agent3ContinuityCritic'] as const)('paid %s output recovery retains the same selected runtime and explicit family selection', async action => {
    const modelRuntime = { tier: 'builtin_1234567890abcdef' as const, provider: 'Xiaomi', modelName: 'mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'fixture-only',
      multiplierBps: 15000, reasoningEffort: 'high' as const, reasoningEfforts: ['none', 'high'] as Array<'none' | 'high'>, visionEnabled: false, contextWindowTokens: 128000 }
    const selected = { ...options, action, modelRuntime, explicitModelSelection: true }
    const failure = new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'known ceiling')
    recordTextRequestFailure(failure, { usageId: 'settled-original', status: 'terminal', billingKnown: true }, 's', 'c', selected)
    complete.mockRejectedValueOnce(failure).mockResolvedValueOnce('{"findings":[]}')
    await generateReviewCompletion('s', 'c', selected)
    expect(complete.mock.calls.map(call => call[2].action)).toEqual([action, action + 'OutputRecovery'])
    for (const call of complete.mock.calls) {
      expect(call[2].modelRuntime).toBe(modelRuntime)
      expect(call[2]).toMatchObject({ explicitModelSelection: true, boundedReview: true, responseFormat: 'json_object' })
    }
  })
  it('recovers confirmed truncation once with the complete input and larger allowance', async () => {
    const failure = knownFailure()
    recordTextRequestFailure(failure, { usageId: 'settled-original', status: 'terminal', billingKnown: true }, '审查规则', '正文首\n完整原文\n正文尾', options)
    complete.mockRejectedValueOnce(failure).mockResolvedValueOnce('{"findings":[]}')
    const signal = new AbortController().signal
    await expect(generateReviewCompletion('审查规则', '正文首\n完整原文\n正文尾', { ...options, signal })).resolves.toBe('{"findings":[]}')
    expect(complete.mock.calls).toEqual([
      ['审查规则', '正文首\n完整原文\n正文尾', { ...options, signal: expect.any(AbortSignal), maxOutputTokens: 16_384, boundedReview: true, responseFormat: 'json_object' }],
      [expect.stringContaining('响应恢复'), '正文首\n完整原文\n正文尾', { ...options, signal: expect.any(AbortSignal), action: 'agent3HumanityCriticOutputRecovery', maxOutputTokens: 32_768, boundedReview: true, responseFormat: 'json_object' }],
    ])
    expect(complete.mock.calls[0][2].signal).toBe(complete.mock.calls[1][2].signal)
  })
  it('never makes a third paid call when the larger allowance also truncates', async () => {
    complete.mockRejectedValueOnce(knownFailure()).mockRejectedValueOnce(new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'length'))
    await expect(generateReviewCompletion('s', 'c', options)).rejects.toMatchObject({ code: 'AI_PROVIDER_OUTPUT_LIMIT' })
    expect(complete).toHaveBeenCalledTimes(2)
  })
  it('allows recovery after the former aggregate deadline while preserving author cancellation', async () => {
    vi.useFakeTimers()
    const author = new AbortController()
    complete.mockImplementationOnce(() => new Promise((_resolve, reject) => setTimeout(() => reject(knownFailure()), env.aiTextTimeoutMs / 2)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve('{"findings":[]}'), env.aiTextTimeoutMs)))
    const result = generateReviewCompletion('s', 'c', { ...options, signal: author.signal })
    await vi.advanceTimersByTimeAsync(env.aiTextTimeoutMs * 1.5)
    await expect(result).resolves.toBe('{"findings":[]}')
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0][2].signal).toBe(author.signal)
    expect(complete.mock.calls[1][2].signal).toBe(author.signal)
    expect(author.signal.aborted).toBe(false)
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
  it.each(['AI_PROVIDER_OUTPUT_LIMIT', 'AI_PROVIDER_EMPTY_RESPONSE'])('does not retry %s without an original settled request proof', async code => {
    complete.mockRejectedValue(new DataAccessError(502, code, 'no receipt'))
    await expect(generateReviewCompletion('s', 'c', options)).rejects.toMatchObject({ code })
    expect(complete).toHaveBeenCalledOnce()
  })
  it('does not spend on a recovery after the caller reports a stale revision', async () => {
    complete.mockRejectedValueOnce(knownFailure()).mockRejectedValueOnce(new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'length'))
    const beforeRecovery = vi.fn(async () => { throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', 'stale') })
    await expect(generateReviewCompletion('s', 'c', options, beforeRecovery)).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
    expect(beforeRecovery).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })
})

describe('review cancellation after returned output', () => {
  it('preserves the actual author stop instead of accepting a late result', async () => {
    const author = new AbortController()
    const cancellation = new Error('author cancelled')
    complete.mockImplementationOnce(async () => { author.abort(cancellation); return '{"findings":[]}' })
    await expect(generateReviewCompletion('s', 'c', { ...options, signal: author.signal })).rejects.toBe(cancellation)
    expect(complete).toHaveBeenCalledOnce()
  })
})
