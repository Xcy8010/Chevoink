import { beforeEach, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
import { runtimeJsonHash } from '../../api/lib/agent/runtime-common.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { callDurableContextSummary } from '../../api/lib/agent/runtime-semantic-call.js'
import { SEMANTIC_ACTION } from '../../api/lib/agent/runtime-semantic-cursor.js'

const mocks = vi.hoisted(() => ({ op: vi.fn(), state: vi.fn(), chat: vi.fn(), begin: vi.fn(), budget: vi.fn() }))
vi.mock('../../api/lib/ai-service.js', () => ({ chatWithTools: mocks.chat, resolveTextOutputTokenParameter: () => 'max_tokens' }))
vi.mock('../../api/lib/agent/runtime-provider.js', () => ({ beginDurableChat: mocks.begin }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLease: (_lease: unknown, work: (tx: unknown) => unknown) => work({ agentOperation: { findUnique: mocks.op } }) }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionStateInTransaction: mocks.state }))
vi.mock('../../api/lib/agent/runtime-budget.js', () => ({ assertProviderBudget: mocks.budget }))

const price = { version: 'credits-v1-exact' as const, modelTier: 'speed' as const, multiplierBps: 10000 }
const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' as const }
const source = { revision: 2, snapshotHash: 'd'.repeat(64), configurationHash: 'c'.repeat(64), planHash: runtimeJsonHash({ system: '摘要', content: '资料' }) }
const request = { endpoint: route.endpoint, body: { model: 'fixture', messages: [{ role: 'system', content: '摘要' }, { role: 'user', content: '资料' }] } }
const ok = { content: '选句', finishReason: 'stop', toolCalls: [], billing: { status: 'settled' } }
const input: Parameters<typeof callDurableContextSummary>[0] = { lease: { userId: 'user', runId: 'run', taskRootId: 'root', epoch: 1n, ownerId: 'owner', claimId: 'claim' },
  source, system: '摘要', content: '资料', window: 258000, maxOutputTokens: 10000, signal: new AbortController().signal,
  model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route), tokenPrice: price },
  runtime: { tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fake', reasoningEfforts: ['low', 'high'],
    reasoningEffort: 'high', contextWindowTokens: 258000, visionEnabled: false, multiplierBps: 10000 } }

function saved(status: string) {
  const inputSnapshot = { input: { source, request, billing: price } }
  return { kind: 'provider', action: SEMANTIC_ACTION, parentOperationId: null, status, inputSnapshot, inputHash: runtimeJsonHash(inputSnapshot) }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.op.mockResolvedValue(null)
  mocks.state.mockResolvedValue({ frame: { state: { phase: 'idle' }, revision: 2, snapshotHash: source.snapshotHash }, head: { configurationHash: source.configurationHash } })
  mocks.chat.mockResolvedValue(ok)
})

it('skips missing original price or insufficient input allowance and refuses a different route', async () => {
  expect(await callDurableContextSummary({ ...input, model: { ...input.model, tokenPrice: undefined } })).toBeNull()
  expect(await callDurableContextSummary({ ...input, window: 100 })).toBeNull()
  await expect(callDurableContextSummary({ ...input, runtime: { ...input.runtime, baseUrl: 'https://other.invalid' } })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
  expect(mocks.chat).not.toHaveBeenCalled()
})

it('uses the original prepared body, offers no tools, caps output, and preserves the frozen price', async () => {
  mocks.op.mockResolvedValue(saved('prepared'))
  expect(await callDurableContextSummary(input)).toBe(ok.content)
  expect(mocks.chat).toHaveBeenCalledWith(expect.objectContaining({ preparedAuxiliaryRequest: request, tools: [], maxOutputTokens: 8192,
    semanticCompaction: true, messages: request.body.messages, durableExecution: expect.objectContaining({ price, summarySource: source, attemptKey: '1' }) }))
})

it('requires the original BYOK revision for a new dispatch and can still reconcile its frozen result without live credentials', async () => {
  const price = { ...input.model.tokenPrice!, modelTier: 'custom' as const, multiplierBps: 0 }
  const custom = { ...input, model: { ...input.model, tier: 'custom', customModelId: 'byok', tokenPrice: price },
    runtime: { ...input.runtime, tier: 'custom' as const, customModelRevision: 9, multiplierBps: 0 } }
  expect(await callDurableContextSummary(custom)).toBeNull()
  expect(await callDurableContextSummary({ ...custom, model: { ...custom.model, customModelRevision: 8 } })).toBeNull()
  expect(mocks.chat).not.toHaveBeenCalled()
  expect(await callDurableContextSummary({ ...custom, model: { ...custom.model, customModelRevision: 9 } })).toBe(ok.content)
  const op = saved('succeeded')
  const inputSnapshot = { input: { source, request, billing: price } }
  mocks.op.mockResolvedValue({ ...op, inputSnapshot, inputHash: runtimeJsonHash(inputSnapshot) })
  mocks.begin.mockResolvedValue({ replay: ok })
  expect(await callDurableContextSummary({ ...custom, runtime: { ...custom.runtime, baseUrl: 'https://changed.invalid', apiKey: null } })).toBe(ok.content)
  expect(mocks.chat).toHaveBeenCalledOnce()
})

it('uses only stored receipts for a known result and propagates an unknown dispatch', async () => {
  mocks.op.mockResolvedValue(saved('succeeded'))
  mocks.begin.mockResolvedValue({ replay: ok })
  expect(await callDurableContextSummary(input)).toBe(ok.content)
  await expect(mocks.begin.mock.calls[0][0].admit()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
  mocks.op.mockResolvedValue(saved('unknown'))
  mocks.begin.mockRejectedValue(new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', '未确认'))
  await expect(callDurableContextSummary(input)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
  expect(mocks.chat).not.toHaveBeenCalled()
})

it('ignores truncated and tool-producing results and requires confirmed usage before applying a result', async () => {
  mocks.chat.mockResolvedValueOnce({ ...ok, finishReason: 'length' }).mockResolvedValueOnce({ ...ok, toolCalls: [{}] })
    .mockResolvedValueOnce({ ...ok, billing: { status: 'pending' } })
  expect(await callDurableContextSummary(input)).toBeNull()
  expect(await callDurableContextSummary(input)).toBeNull()
  await expect(callDurableContextSummary(input)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
})

it('continues after a measured terminal rejection and stops for unresolved spending', async () => {
  mocks.op.mockResolvedValueOnce(null).mockResolvedValueOnce(saved('failed')).mockResolvedValueOnce(null).mockResolvedValueOnce(saved('failed'))
  mocks.chat.mockRejectedValue(new DataAccessError(502, 'AI_PROVIDER_ERROR', '拒绝'))
  mocks.budget.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', '未计量'))
  expect(await callDurableContextSummary(input)).toBeNull()
  await expect(callDurableContextSummary(input)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
})
