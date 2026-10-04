import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentModelSelectionSchema, modelAssignmentsSchema, patchModelAssignmentsSchema } from '../../shared/contracts/agent-model-assignments.js'
const mocks = vi.hoisted(() => ({ novel: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), runtime: vi.fn(), credit: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => {
  const db = { novel: { findFirst: mocks.novel }, agentModelAssignment: { findMany: mocks.findMany, findUnique: mocks.findUnique, create: mocks.create, updateMany: mocks.updateMany } }
  return { DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
    prisma: { ...db, $transaction: (work: (tx: typeof db) => unknown) => work(db) } }
})
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: mocks.runtime, assertCreditAccess: mocks.credit,
  resolveCustomReasoningEffort: (effort: string, supported: string[]) => supported.includes(effort) ? effort : supported[0] }))
import { freezeModelAssignments, getModelAssignments, patchModelAssignments, resolveAssignedModel } from '../../api/lib/agent/model-assignments.js'
import { assignedTaskModel, withModelAssignmentContext } from '../../api/lib/agent/model-assignment-context.js'

beforeEach(() => {
  vi.clearAllMocks(); mocks.novel.mockResolvedValue({ id: 'novel' }); mocks.findMany.mockResolvedValue([]); mocks.findUnique.mockResolvedValue(null)
  mocks.updateMany.mockResolvedValue({ count: 1 }); mocks.create.mockResolvedValue({ id: 'new' })
  mocks.runtime.mockImplementation(async (tier, _user, _custom, effort) => ({ tier, reasoningEffort: effort ?? 'high', reasoningEfforts: ['low', 'medium', 'high'], visionEnabled: false }))
})
describe('owned sparse model assignments', () => {
  it('rejects unknown purposes, incompatible custom identity and scope framing', () => {
    expect(modelAssignmentsSchema.safeParse({ export: { modelTier: 'speed' } }).success).toBe(false)
    expect(agentModelSelectionSchema.safeParse({ modelTier: 'custom' }).success).toBe(false)
    expect(agentModelSelectionSchema.safeParse({ modelTier: 'speed', customModelId: 'foreign' }).success).toBe(false)
    expect(patchModelAssignmentsSchema.safeParse({ scope: 'global', novelId: 'novel', expectedRevision: 0, assignments: {} }).success).toBe(false)
  })
  it('projects empty/default without inventing overrides or provider calls', async () => {
    expect(await getModelAssignments('owner', 'novel')).toEqual({ version: 1, global: { revision: 0, assignments: {} }, novel: { revision: 0, assignments: {} }, effective: {} })
    expect(await freezeModelAssignments('owner', 'novel')).toBeUndefined()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
  it('merges novel over global per purpose and freezes an independent copy', async () => {
    mocks.findMany.mockResolvedValue([{ scopeKey: '', revision: 2, assignments: { main: { modelTier: 'speed', reasoningEffort: 'high' }, quality: { modelTier: 'ultimate' } } },
      { scopeKey: 'novel', revision: 3, assignments: { main: { modelTier: 'custom', customModelId: 'owned', reasoningEffort: 'medium' } } }])
    const frozen = await freezeModelAssignments('owner', 'novel')
    expect(frozen).toEqual({ version: 1, globalRevision: 2, novelRevision: 3, assignments: { main: { modelTier: 'custom', customModelId: 'owned', reasoningEffort: 'medium' }, quality: { modelTier: 'ultimate' } }, sources: { main: 'novel', quality: 'global' } })
    mocks.findMany.mockResolvedValue([])
    await withModelAssignmentContext({ userId: 'owner', novelId: 'novel', frozen }, async () => {
      expect((await assignedTaskModel('owner', 'novel', 'main'))?.selection.customModelId).toBe('owned')
      expect(await assignedTaskModel('owner', 'novel', 'continuity')).toBeUndefined()
    })
  })
  it('denies another novel before reads or preference writes', async () => {
    mocks.novel.mockResolvedValue(null)
    await expect(patchModelAssignments('owner', { scope: 'novel', novelId: 'other', expectedRevision: 0, assignments: { main: { modelTier: 'speed' } } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.findUnique).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled()
  })
  it('uses the configured model default, not medium or a sorted middle effort', async () => {
    expect((await resolveAssignedModel('owner', { modelTier: 'speed' })).selection.reasoningEffort).toBe('high')
    expect((await resolveAssignedModel('owner', { modelTier: 'speed', reasoningEffort: 'high' })).selection.reasoningEffort).toBe('high')
    mocks.runtime.mockImplementation(async (tier, _user, _custom, effort) => ({ tier, reasoningEffort: effort ?? 'max', reasoningEfforts: ['max', 'low', 'medium', 'high'], visionEnabled: true }))
    expect((await resolveAssignedModel('owner', { modelTier: 'custom', customModelId: 'owned' })).selection.reasoningEffort).toBe('max')
    expect((await resolveAssignedModel('owner', { modelTier: 'custom', customModelId: 'owned', reasoningEffort: 'low' })).selection.reasoningEffort).toBe('low')
  })
  it('rejects stale revisions and CAS races without write fallback', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'row', revision: 2, assignments: {} })
    await expect(patchModelAssignments('owner', { scope: 'global', expectedRevision: 1, assignments: {} })).rejects.toMatchObject({ code: 'MODEL_ASSIGNMENT_CONFLICT' })
    expect(mocks.updateMany).not.toHaveBeenCalled()
    mocks.updateMany.mockResolvedValue({ count: 0 })
    await expect(patchModelAssignments('owner', { scope: 'global', expectedRevision: 2, assignments: {} })).rejects.toMatchObject({ code: 'MODEL_ASSIGNMENT_CONFLICT' })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('removes only requested override and preserves other tasks', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'row', revision: 1, assignments: { main: { modelTier: 'speed' }, quality: { modelTier: 'ultimate' } } })
    await patchModelAssignments('owner', { scope: 'global', expectedRevision: 1, assignments: { main: null } })
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: 'row', userId: 'owner', revision: 1 }, data: { assignments: { quality: { modelTier: 'ultimate' } }, revision: { increment: 1 } } })
  })
  it('refuses non-vision custom models without writing or paid validation', async () => {
    await expect(resolveAssignedModel('owner', { modelTier: 'custom', customModelId: 'owned' }, true)).rejects.toMatchObject({ code: 'MODEL_VISION_REQUIRED' })
    expect(mocks.credit).not.toHaveBeenCalled()
  })
})
