import { beforeEach, describe, expect, it, vi } from 'vitest'
import { patchAgentWindowConfigurationSchema } from '../../shared/contracts/agent-window-configuration.js'
const mocks = vi.hoisted(() => ({ session: vi.fn(), latest: vi.fn(), history: vi.fn(), read: vi.fn(), create: vi.fn(), update: vi.fn(), resolve: vi.fn() }))
const policies = new Map<string, unknown>()
vi.mock('../../api/lib/prisma.js', () => {
  const db = { agentSession: { findFirst: mocks.session, updateMany: mocks.update }, agentRun: { findFirst: mocks.latest }, agentConfigurationChange: { findMany: mocks.history },
    agentModelAssignment: { findUnique: mocks.read, create: mocks.create } }
  return { DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
    prisma: { ...db, $transaction: (work: (tx: typeof db) => unknown) => work(db) } }
})
vi.mock('../../api/lib/agent/model-assignments.js', () => ({ resolveAssignedModel: mocks.resolve }))
import { getWindowConfiguration, patchWindowConfiguration, readRunWindowConfiguration } from '../../api/lib/agent/window-configuration.js'

beforeEach(() => {
  vi.clearAllMocks()
  policies.clear()
  mocks.session.mockImplementation(async ({ where }) => where.userId === 'owner' && where.id !== 'foreign'
    ? { id: where.id, novelId: 'novel', title: where.id, toolPolicy: policies.get(where.id) ?? null } : null)
  mocks.read.mockResolvedValue(null)
  mocks.latest.mockResolvedValue(null)
  mocks.history.mockResolvedValue([])
  mocks.update.mockResolvedValue({ count: 1 })
  mocks.resolve.mockImplementation(async (_user, selection) => ({ selection: { ...selection, reasoningEffort: selection.reasoningEffort ?? 'medium' } }))
})
describe('owned independent window configuration', () => {
  it('classifies active selection from immutable admission and same-root controls without consulting future preferences', async () => {
    const run = { id: 'run-a', userId: 'owner', novelId: 'novel', sessionId: 'window-a', taskRootId: 'root',
      startRequest: { modelSelectionExplicit: true }, taskSpec: { creativeFreedom: 'stable' } }
    const db = { agentConfigurationChange: { findMany: mocks.history } } as unknown as Parameters<typeof readRunWindowConfiguration>[0]
    expect(await readRunWindowConfiguration(db, run)).toMatchObject({ modelSelectionSource: 'explicit', creativeFreedom: 'stable' })
    mocks.history.mockResolvedValue([{ response: { modelAssignments: {}, configuration: { modelSelectionExplicit: true } } }])
    expect(await readRunWindowConfiguration(db, run)).toMatchObject({ modelSelectionSource: 'inherited' })
    mocks.history.mockResolvedValue([{ response: { modelSelectionExplicit: true, creativeFreedom: 'bold' } },
      { response: { modelAssignments: {}, configuration: { modelSelectionExplicit: true } } }])
    expect(await readRunWindowConfiguration(db, run)).toMatchObject({ modelSelectionSource: 'explicit', creativeFreedom: 'bold' })
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('restores a resumed task from same-root receipts and preserves the latest model-setting source', async () => {
    mocks.latest.mockResolvedValue({ modelTier: 'custom', customModelId: 'model-b', reasoningEffort: 'high', taskRootId: 'root',
      startRequest: { modelAssignments: { assignments: { main: { modelTier: 'custom', customModelId: 'model-a' } } } }, taskSpec: { creativeFreedom: 'stable' }, configurationChanges: [] })
    mocks.history.mockResolvedValue([{ response: { modelTier: 'custom', customModelId: 'model-b', modelSelectionExplicit: true, creativeFreedom: 'bold' } }])
    expect(await getWindowConfiguration('owner', 'window-a')).toMatchObject({ revision: 0, modelSelectionSource: 'explicit',
      configuration: { model: { customModelId: 'model-b' }, creativeFreedom: 'bold' } })
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ where: { run: { taskRootId: 'root', userId: 'owner', sessionId: 'window-a', novelId: 'novel' } } }))
    const assigned = { modelAssignments: { assignments: { main: { modelTier: 'custom', customModelId: 'model-b' } } },
      configuration: { modelSelectionExplicit: true, creativeFreedom: 'balanced' } }
    mocks.history.mockResolvedValue([{ response: assigned }])
    expect(await getWindowConfiguration('owner', 'window-a')).toMatchObject({ modelSelectionSource: 'inherited', configuration: { model: null, creativeFreedom: 'balanced' } })
    mocks.history.mockResolvedValue([{ response: { modelSelectionExplicit: true, creativeFreedom: 'bold' } }, { response: assigned }])
    expect(await getWindowConfiguration('owner', 'window-a')).toMatchObject({ modelSelectionSource: 'explicit', configuration: { model: { customModelId: 'model-b' } } })
  })
  it('restores the latest owned main-run choice and applied mode without claiming unknown legacy intent was explicit', async () => {
    mocks.latest.mockResolvedValue({ modelTier: 'custom', customModelId: 'owned', reasoningEffort: 'medium',
      startRequest: {}, taskSpec: { creativeFreedom: 'stable' }, configurationChanges: [{ response: { appliesToRun: false, creativeFreedom: 'bold' } }] })
    expect(await getWindowConfiguration('owner', 'window-a')).toMatchObject({ revision: 0, source: 'last_run', modelSelectionSource: 'unknown',
      configuration: { model: { modelTier: 'custom', customModelId: 'owned', reasoningEffort: 'medium' }, creativeFreedom: 'stable' } })
    expect(mocks.latest.mock.calls[0][0].where).toMatchObject({ sessionId: 'window-a', userId: 'owner', novelId: 'novel' })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('keeps known inheritance and an explicitly saved null preference instead of pinning a historical resolved model', async () => {
    mocks.latest.mockResolvedValue({ modelTier: 'ultimate', reasoningEffort: 'high', startRequest: { modelAssignments: { assignments: { main: { modelTier: 'ultimate' } } } },
      taskSpec: {}, configurationChanges: [] })
    expect(await getWindowConfiguration('owner', 'window-a')).toMatchObject({ modelSelectionSource: 'inherited', configuration: { model: null } })
    mocks.latest.mockClear()
    policies.set('window-a', { windowConfiguration: { revision: 3, configuration: { model: null, creativeFreedom: 'bold' } } })
    expect(await getWindowConfiguration('owner', 'window-a')).toMatchObject({ revision: 3, source: 'saved', configuration: { model: null, creativeFreedom: 'bold' } })
    expect(mocks.latest).not.toHaveBeenCalled()
  })
  it('reads an unconfigured window without model dispatch and separates same-novel windows', async () => {
    const a = await getWindowConfiguration('owner', 'window-a')
    const b = await getWindowConfiguration('owner', 'window-b')
    expect(a.configuration).toEqual({ model: null, creativeFreedom: 'balanced' })
    expect(b.configuration).toEqual(a.configuration)
    expect(mocks.session.mock.calls.map(([query]) => query.where.id)).toEqual(['window-a', 'window-b'])
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('checks ownership before reading preferences or resolving a selected model', async () => {
    await expect(patchWindowConfiguration('owner', 'foreign', { expectedRevision: 0, model: { modelTier: 'speed' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('stores resolved model effort and mode without global/novel assignments or active-run writes', async () => {
    policies.set('window-a', { network: 'deny', contentWrite: 'ask', publish: 'deny' })
    const result = await patchWindowConfiguration('owner', 'window-a', { expectedRevision: 0, model: { modelTier: 'speed' }, creativeFreedom: 'bold' })
    expect(result).toMatchObject({ sessionId: 'window-a', revision: 1, configuration: { model: { modelTier: 'speed', reasoningEffort: 'medium' }, creativeFreedom: 'bold' } })
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'window-a', userId: 'owner', toolPolicy: { equals: { network: 'deny', contentWrite: 'ask', publish: 'deny' } } },
      data: { toolPolicy: { network: 'deny', contentWrite: 'ask', publish: 'deny', windowConfiguration: { revision: 1, configuration: result.configuration } } } })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('preserves model on a partial mode change and supports returning to inherited model', async () => {
    policies.set('window-a', { windowConfiguration: { revision: 4, configuration: { model: { modelTier: 'ultimate', reasoningEffort: 'max' }, creativeFreedom: 'stable' } } })
    expect((await patchWindowConfiguration('owner', 'window-a', { expectedRevision: 4, creativeFreedom: 'bold' })).configuration)
      .toEqual({ model: { modelTier: 'ultimate', reasoningEffort: 'max' }, creativeFreedom: 'bold' })
    expect((await patchWindowConfiguration('owner', 'window-a', { expectedRevision: 4, model: null })).configuration)
      .toEqual({ model: null, creativeFreedom: 'stable' })
  })
  it('rejects stale or concurrently updated preferences without overwriting', async () => {
    policies.set('window-a', { windowConfiguration: { revision: 2, configuration: { model: null, creativeFreedom: 'balanced' } } })
    await expect(patchWindowConfiguration('owner', 'window-a', { expectedRevision: 1, creativeFreedom: 'bold' })).rejects.toMatchObject({ code: 'WINDOW_CONFIGURATION_CONFLICT' })
    expect(mocks.update).not.toHaveBeenCalled()
    mocks.update.mockResolvedValue({ count: 0 })
    await expect(patchWindowConfiguration('owner', 'window-a', { expectedRevision: 2, creativeFreedom: 'bold' })).rejects.toMatchObject({ code: 'WINDOW_CONFIGURATION_CONFLICT' })
  })
  it('validates at the HTTP boundary without accepting custom identity on a built-in model', () => {
    expect(patchAgentWindowConfigurationSchema.safeParse({ expectedRevision: 0 }).success).toBe(false)
    expect(patchAgentWindowConfigurationSchema.safeParse({ expectedRevision: 0, model: { modelTier: 'speed', customModelId: 'x' } }).success).toBe(false)
    expect(patchAgentWindowConfigurationSchema.safeParse({ expectedRevision: 0, creativeFreedom: 'bold', userId: 'other' }).success).toBe(false)
  })
})
