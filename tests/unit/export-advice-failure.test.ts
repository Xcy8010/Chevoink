import { describe, expect, it, vi } from 'vitest'
import { readKnownExportAdviceFailure } from '../../api/lib/agent/tools/durable-export.js'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import type { ExportWork } from '../../api/lib/agent/runtime-export-contract.js'

const price = { version: 'credits-v1-exact' as const, modelTier: 'lite' as const, multiplierBps: 10000 }
const work: ExportWork = { version: 1, novelId: 'novel', exportId: '7c39ed86-51b1-4a45-9429-1051394e027f', fileName: 'test.zip', summary: '合成稿',
  identity: { userId: 'owner', taskRootId: 'root', operationKey: 'exec:0', sourceHash: 'a'.repeat(64), argsHash: 'b'.repeat(64) },
  source: { key: 'c'.repeat(64) + '.source', sha256: 'd'.repeat(64), bytes: 300, bodyBytes: 20 },
  advice: { kind: 'generate', input: { novelId: 'novel', title: '合成稿', summary: '', genre: '', tags: [], sampleText: '原样章' }, system: 's', content: 'u', price,
    route: { provider: 'fixture', model: 'original-advice', baseUrl: 'https://fixture.invalid/v1', maxOutputTokens: 1000, tier: 'lite', reasoningEffort: 'low' } } }

function original(dispatched = true, status = dispatched ? 'failed' : 'cancelled', quota = false) {
  // Same nested request envelope as prepareProviderAttempt, not a naked HTTP
  // body; this reproduces both original CI fallback failures without a DB.
  const request = { endpoint: 'https://fixture.invalid/v1/chat/completions', body: { model: 'original-advice', stream: true, messages: [{ role: 'user', content: 'original' }] } }
  const input = runtimeJson({ kind: 'provider', action: 'publish_advice', input: { billing: price, request } })
  const attemptRequest = runtimeJson({ provider: 'fixture', model: 'original-advice', request })
  const result = runtimeJson(dispatched ? { outcome: status, result: { httpStatus: quota ? 429 : 400, ...(quota ? { code: 'AI_PROVIDER_QUOTA_EXCEEDED' } : {}) } }
    : { outcome: status, result: { code: 'CREDITS_EXHAUSTED', dispatched: false } })
  const attempt = { id: 'attempt', provider: 'fixture', model: 'original-advice', requestSnapshot: attemptRequest.value, requestHash: attemptRequest.hash,
    result: result.value, resultHash: result.hash, status, dispatchedAt: dispatched ? new Date() : null, usageReceipt: null as null | object }
  const child = { id: 'child', kind: 'provider', action: 'publish_advice', parentOperationId: 'parent', taskRootId: 'root', inputSnapshot: input.value, inputHash: input.hash, status, attempts: [attempt] }
  const event = { taskRootId: 'root', operationId: 'child', type: dispatched ? 'provider.result.recorded' : 'provider.not_dispatched',
    payload: dispatched ? { attemptId: 'attempt', status, resultHash: result.hash } : { attemptId: 'attempt', requestHash: attemptRequest.hash, code: 'CREDITS_EXHAUSTED', resultHash: result.hash } }
  const tx = { agentOperation: { findUnique: vi.fn(async () => child) }, agentExecutionOutbox: { findUnique: vi.fn(async () => event) } }
  return { child, attempt, event, tx: tx as unknown as RuntimeTx }
}

describe('original provider envelope and evidence decide optional export advice failure', () => {
  it('recognizes an authenticated definite HTTP rejection while retaining its original accounting', async () => {
    const saved = original()
    expect(await readKnownExportAdviceFailure(saved.tx, 'parent', work)).toEqual({ kind: 'unavailable' })
    expect(saved.attempt.usageReceipt).toBeNull()
    expect(saved.attempt.status).toBe('failed')
  })
  it('recognizes the exact before-dispatch credit failure and event', async () => {
    const saved = original(false)
    expect(await readKnownExportAdviceFailure(saved.tx, 'parent', work)).toEqual({ kind: 'credits_exhausted' })
    saved.event.payload = { attemptId: 'attempt', requestHash: 'f'.repeat(64), code: 'CREDITS_EXHAUSTED', resultHash: saved.attempt.resultHash }
    expect(await readKnownExportAdviceFailure(saved.tx, 'parent', work)).toBeNull()
  })
  it.each(['wrong-price', 'naked-request', 'changed-request', 'other-parent', 'other-model', 'missing-event', 'quota', 'observed-usage', 'unknown', '500'] as const)('holds %s rather than publishing or classifying a zero charge', async change => {
    const saved = original(true, change === 'unknown' ? 'unknown' : 'failed', change === 'quota')
    if (change === 'wrong-price') {
      const input = saved.child.inputSnapshot as { input: { billing: typeof price } }
      input.input.billing = { ...price, multiplierBps: 0 }; saved.child.inputHash = runtimeJson(input).hash
    }
    if (change === 'naked-request' || change === 'changed-request') {
      const envelope = saved.attempt.requestSnapshot as { request: { body: { model: string } } }
      if (change === 'changed-request') envelope.request.body.model = 'changed'
      else saved.attempt.requestSnapshot = envelope.request as typeof saved.attempt.requestSnapshot
      saved.attempt.requestHash = runtimeJson(saved.attempt.requestSnapshot).hash
    }
    if (change === 'other-parent') saved.child.parentOperationId = 'another'
    if (change === 'other-model') saved.attempt.model = 'other-advice'
    if (change === 'missing-event') saved.event.type = 'unrelated'
    if (change === 'observed-usage') saved.attempt.usageReceipt = { source: 'reported', promptTokens: 10, completionTokens: 0, settlementStatus: 'pending' }
    if (change === '500') {
      saved.attempt.result = { outcome: 'failed', result: { httpStatus: 500 } }; saved.attempt.resultHash = runtimeJson(saved.attempt.result).hash
      saved.event.payload = { attemptId: 'attempt', status: 'failed', resultHash: saved.attempt.resultHash }
    }
    expect(await readKnownExportAdviceFailure(saved.tx, 'parent', work)).toBeNull()
  })
})
