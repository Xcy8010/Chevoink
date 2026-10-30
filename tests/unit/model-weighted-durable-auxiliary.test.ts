import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { executeDurableDossier } from '../../api/lib/agent/tools/durable-research-dossier.js'
import { executeDurableCreative } from '../../api/lib/agent/tools/durable-creative.js'
import type { ToolContext, AgentTool } from '../../api/lib/agent/tools/types.js'
import { z } from 'zod'
const mocks = vi.hoisted(() => ({ runtime: vi.fn(), assigned: vi.fn(), capture: vi.fn(), old: null as unknown }))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: mocks.runtime }))
vi.mock('../../api/lib/model-weighted-config.js', () => ({ readWeightedRoutes: vi.fn() }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => 'key-' + value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/agent/model-assignment-context.js', () => ({ assignedTaskModel: mocks.assigned }))
vi.mock('../../api/lib/billing/resolve-token-price.js', () => ({ resolveDurableTokenPrice: async (_lease: unknown, _key: string, modelTier: string, multiplierBps: number) => ({ version: 'credits-v1-exact', modelTier, multiplierBps }) }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({
  withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work({ agentOperation: { findUnique: async () => mocks.old } }),
  withManuscriptRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work({ agentOperation: { findUnique: async () => mocks.old }, novel: { findFirst: async () => ({ title: 'Synthetic novel', summary: '' }) }, researchDossier: { findFirst: async () => null } }),
}))
vi.mock('../../api/lib/agent/tools/creative-review.js', async () => { const { z } = await import('zod'); return {
  creativeReviewWorkSchema: z.object({ system: z.string(), content: z.string(), temperature: z.number() }),
  prepareCreativeReview: async () => ({ system: 'rules', content: 'synthetic full chapter', temperature: 0.4 }),
  assertCreativeReviewCurrent: vi.fn(), saveCreativeReview: vi.fn(),
} })
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(), prepareToolCursorOperation: mocks.capture, readAdmittedToolOperation: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-dossier-contract.js', async () => { const { z } = await import('zod'); return {
  dossierWorkSchema: z.any(), dossierPredecessor: () => null, resolveDossierSearchRoute: async () => ({ route: { provider: 'fixture' } }),
  assertDossierBuildExclusive: vi.fn(), assertDossierForce: vi.fn(), assertDossierPredecessor: vi.fn(), dossierQueryIdentity: vi.fn(), dossierQueryRequest: vi.fn(), dossierSynthesisInput: vi.fn(), researchRefreshProof: vi.fn(),
} })
vi.mock('../../api/lib/agent/tools/research-dossier-tools.js', async () => { const { z } = await import('zod'); return { researchDossierBuildTool: { parameters: z.object({ topic: z.string(), genre: z.string(), triggerReason: z.string(), triggerSignals: z.array(z.string()), targetAudience: z.string(), targetPlatform: z.string().default(''), queries: z.array(z.string()), forceRefresh: z.boolean().optional() }) } } })
const lease = { userId: 'owner', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const tool = { name: 'creative_critique', parameters: z.object({}) } as AgentTool
const base = (tier: 'speed' | 'standard' = 'standard', multiplierBps = 12000): NonNullable<ToolContext['modelRuntime']> => ({ tier, provider: 'primary', modelName: 'main', baseUrl: 'https://main.invalid/v1', apiKey: 'main-key',
  reasoningEffort: 'high', reasoningEfforts: ['high'], multiplierBps, visionEnabled: false, contextWindowTokens: 128000,
  weightedRoutes: { primaryWeight: 0, candidates: [{ id: 'A', label: 'A', weight: 100, provider: 'relay', modelName: 'free-alias', baseUrl: 'https://relay.invalid/v1', apiKeyCiphertext: 'cipher-A' }] } })
function context(): ToolContext { return { userId: 'owner', novelId: 'novel', runId: 'run', sessionId: 'session', chapterId: null, callId: 'call', mode: 'review', creativeFreedom: 'bold', qualityMode: 'balanced',
  signal: new AbortController().signal, emit: vi.fn(), durableCreative: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: 'a'.repeat(64) } } } }
beforeEach(() => { vi.clearAllMocks(); mocks.old = null; mocks.assigned.mockResolvedValue(undefined); mocks.runtime.mockImplementation(async (tier: 'speed' | 'standard') => base(tier));
  mocks.capture.mockImplementation(async () => { throw new Error('captured before admission/send') }) })
afterEach(() => vi.restoreAllMocks())
const capturedWork = () => mocks.capture.mock.calls[0][2].operationInput.work
it('inherits a frozen free candidate before the existing creative identity check, without a redraw', async () => {
  mocks.runtime.mockResolvedValue(base('standard', 0))
  const ctx = context(); ctx.modelSelection = { tier: 'standard', customModelId: null, reasoningEffort: 'high', provider: 'relay', modelName: 'free-alias',
    routeRevision: 'b'.repeat(64), weightedRoute: { source: 'candidate', candidateId: 'A' } }
  const random = vi.spyOn(Math, 'random')
  await expect(executeDurableCreative(ctx, tool, {})).rejects.toThrow('captured before admission/send')
  expect(capturedWork()).toMatchObject({ route: { provider: 'relay', model: 'free-alias', weightedRoute: { source: 'candidate', candidateId: 'A' } }, price: { modelTier: 'standard', multiplierBps: 0 } })
  expect(random).not.toHaveBeenCalled()
})
it.each(['assigned', 'fallback'] as const)('selects a fresh %s builtin creative work once before freezing its exact route', async source => {
  if (source === 'assigned') mocks.assigned.mockResolvedValue({ runtime: base(), selection: { modelTier: 'standard' } })
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.8)
  await expect(executeDurableCreative(context(), tool, {})).rejects.toThrow('captured before admission/send')
  expect(capturedWork()).toMatchObject({ route: { provider: 'relay', model: 'free-alias', weightedRoute: { source: 'candidate', candidateId: 'A' } }, price: { modelTier: source === 'assigned' ? 'standard' : 'speed', multiplierBps: 12000 } })
  expect(random).toHaveBeenCalledOnce()
})
it('restores an already frozen work before consulting today’s weighted candidates', async () => {
  const work = { kind: 'creative', version: 1, review: { system: 'rules', content: 'synthetic full chapter', temperature: 0.4 },
    route: { tier: 'standard', customModelId: null, reasoningEffort: 'high', provider: 'old-provider', model: 'old-model', baseUrl: 'https://old.invalid/v1', maxOutputTokens: 16384 },
    price: { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 } }
  const inputSnapshot = { input: { work } }; mocks.old = { inputSnapshot, inputHash: runtimeJson(inputSnapshot).hash }
  const random = vi.spyOn(Math, 'random')
  await expect(executeDurableCreative(context(), tool, {})).rejects.toThrow('captured before admission/send')
  expect(capturedWork()).toEqual(work)
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.assigned).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled()
})

it('selects the context of an inherited free dossier before comparing its resolved route, without rejecting its own new choice', async () => {
  mocks.runtime.mockResolvedValue(base('standard', 0))
  const ctx = context(); ctx.modelRuntime = base('standard', 0); ctx.durableDossier = { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: 'a'.repeat(64) } }
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.8)
  const args = { topic: 'Synthetic topic', genre: '冒险', triggerReason: 'new_book', triggerSignals: ['Synthetic detail'], targetAudience: '成年读者', queries: ['Synthetic query'] }
  await expect(executeDurableDossier(ctx, { ...tool, name: 'research_dossier_build' }, args)).rejects.toThrow('captured before admission/send')
  expect(capturedWork()).toMatchObject({ route: { provider: 'relay', model: 'free-alias', weightedRoute: { source: 'candidate', candidateId: 'A' } }, price: { modelTier: 'standard', multiplierBps: 0 } })
  expect(random).toHaveBeenCalledOnce()
})
