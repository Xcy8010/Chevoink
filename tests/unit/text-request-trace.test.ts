import { describe, expect, it } from 'vitest'
import { beginTextRequest, consumeTextRequestRecovery, createTextRequestTrace, recordTextRequestFailure,
  textRequestsFinished, withTextRequestTrace } from '../../api/lib/text-request-trace.js'

describe('exact auxiliary request trace', () => {
  it('keeps a later unknown recovery from certifying the completed primary chain', async () => {
    const trace = createTextRequestTrace()
    await withTextRequestTrace(trace, async () => {
      Object.assign(beginTextRequest('primary').record, { status: 'terminal', billingKnown: true })
      Object.assign(beginTextRequest('recovery').record, { status: 'unknown', billingKnown: false })
    })
    expect(trace.records.map(row => row.usageId)).toEqual(['primary', 'recovery'])
    expect(textRequestsFinished(trace)).toBe(false)
  })
  it('isolates concurrent tool chains and accepts known failure without inventing report success', async () => {
    const first = createTextRequestTrace(), other = createTextRequestTrace()
    await Promise.all([withTextRequestTrace(first, async () => {
      await Promise.resolve()
      Object.assign(beginTextRequest('settled-failed-report').record, { status: 'terminal', billingKnown: true })
    }), withTextRequestTrace(other, async () => { beginTextRequest('pending') })])
    expect(textRequestsFinished(first)).toBe(true)
    expect(textRequestsFinished(other)).toBe(false)
    expect(first.records).toHaveLength(1)
    expect(textRequestsFinished(createTextRequestTrace())).toBe(false)
  })
  it('binds and consumes recovery proof to the exact original input and author', () => {
    const error = new Error('terminal failure')
    const options = { userId: 'author', action: 'agent3HumanityCritic', targetId: 'chapter' }
    recordTextRequestFailure(error, { usageId: 'original', status: 'terminal', billingKnown: true }, 'rules', 'body', options)
    expect(consumeTextRequestRecovery(error, 'rules', 'changed body', options)).toBe(false)
    expect(consumeTextRequestRecovery(error, 'rules', 'body', { ...options, userId: 'foreign' })).toBe(false)
    expect(consumeTextRequestRecovery(error, 'rules', 'body', options)).toBe(true)
    expect(consumeTextRequestRecovery(error, 'rules', 'body', options)).toBe(false)
  })
  it.each(['prepared', 'unknown'] as const)('never retries a %s request by its error alone', status => {
    const error = new Error('failure'), options = { userId: 'author', action: 'check' }
    recordTextRequestFailure(error, { usageId: 'original', status, billingKnown: false }, 'rules', 'body', options)
    expect(consumeTextRequestRecovery(error, 'rules', 'body', options)).toBe(false)
  })
})
