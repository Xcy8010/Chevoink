import { afterEach, expect, it, vi } from 'vitest'
import { createPlanDocumentActions } from '../../src/features/studio/components/plan-document-actions'

const api = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }))
vi.mock('../../src/features/studio/api', () => ({ createNovelPlanFile: api.create, updateNovelPlanFile: api.update }))
afterEach(() => vi.clearAllMocks())
function fixture(overrides: Partial<Parameters<typeof createPlanDocumentActions>[0]> = {}) {
  const options: Parameters<typeof createPlanDocumentActions>[0] = {
    activeNovelId: 'novel', savedPlanFiles: [{ id: 'plan', title: 'Title', content: 'Body', createdAt: '', artifactId: 'plan', backendArtifactId: 'server' }],
    agentArtifacts: [], selectedTreeItemId: 'plan:plan', catalogPreview: { title: 'Catalog', content: 'Outline' },
    setSelectedTreeItemId: vi.fn(), setWorkViewer: vi.fn(), setMobileView: vi.fn(), setActiveAgentArtifactId: vi.fn(),
    setAgentArtifacts: vi.fn(), setServerPlanFiles: vi.fn(), setChapterSaveState: vi.fn(), setChapterSaveMessage: vi.fn(),
    setAgentRunState: vi.fn(), setWorkspaceDialog: vi.fn(), setCatalogDocument: vi.fn(), updateAgentArtifact: vi.fn(),
    schedulePlanServerSync: vi.fn(), ...overrides,
  }
  return { options, actions: createPlanDocumentActions(options) }
}

it('opens the selected plan in the document viewer', () => {
  const { options, actions } = fixture()
  actions.handleSelectPlanFromTree('plan')
  expect(options.setSelectedTreeItemId).toHaveBeenCalledWith('plan:plan')
  expect(options.setWorkViewer).toHaveBeenCalledWith('document')
  expect(options.setMobileView).toHaveBeenCalledWith('editor')
})

it('requires confirmation before creating a server-backed plan', async () => {
  api.create.mockResolvedValue({ id: 'new', title: 'New', content: '', createdAt: '', orderIndex: 1 })
  const { options, actions } = fixture()
  actions.handleRequestCreatePlan()
  expect(api.create).not.toHaveBeenCalled()
  await vi.mocked(options.setWorkspaceDialog).mock.calls[0][0].onConfirm()
  expect(api.create).toHaveBeenCalledExactlyOnceWith('novel', undefined, { planKind: 'outline' })
  expect(options.setSelectedTreeItemId).toHaveBeenCalledWith('plan:server-new')
})

it('requires confirmation before removing a saved plan', async () => {
  api.update.mockResolvedValue(undefined)
  const { options, actions } = fixture()
  actions.handleRequestDeletePlan('plan')
  expect(api.update).not.toHaveBeenCalled()
  expect(options.setServerPlanFiles).not.toHaveBeenCalled()
  await vi.mocked(options.setWorkspaceDialog).mock.calls[0][0].onConfirm()
  expect(api.update).toHaveBeenCalledExactlyOnceWith('server', { saved: false })
  const update = vi.mocked(options.setServerPlanFiles).mock.calls[0][0]
  expect(typeof update === 'function' ? update(options.savedPlanFiles) : update).toEqual([])
})

it('renames using the backend artifact id while retaining body content', () => {
  const { options, actions } = fixture()
  actions.handleRenamePlan('plan', ' Renamed ')
  expect(options.schedulePlanServerSync).toHaveBeenCalledWith('server', 'Renamed', undefined, undefined, 'novel')
  expect(options.updateAgentArtifact).toHaveBeenCalledWith('plan', expect.any(Function))
})

it('keeps manual catalog edits separate from plan server mutations', () => {
  const { options, actions } = fixture({ selectedTreeItemId: 'catalog' })
  actions.handleWorkspaceDocumentChange({ title: 'Edited', content: 'New outline' })
  const update = vi.mocked(options.setCatalogDocument).mock.calls[0][0]
  expect(typeof update === 'function' ? update(null) : update).toEqual({ title: 'Edited', content: 'New outline', manualTitle: true, manualContent: true })
  expect(options.schedulePlanServerSync).not.toHaveBeenCalled()
})

it('queues the full current plan text without changing chapter state', () => {
  const { options, actions } = fixture()
  actions.handleWorkspaceDocumentChange({ title: 'Title', content: 'New body' })
  expect(options.schedulePlanServerSync).toHaveBeenCalledWith('server', 'Title', 'New body', undefined, 'novel')
  expect(options.setCatalogDocument).not.toHaveBeenCalled()
})

it('writes and renames a canonical plan through its original local artifact id', () => {
  const {options, actions} = fixture({
    selectedTreeItemId: 'plan:server-backend',
    savedPlanFiles: [{id: 'server-backend', artifactId: 'history-local', backendArtifactId: 'backend', title: 'Title', content: 'Body', createdAt: ''}],
  })
  actions.handleWorkspaceDocumentChange({title: 'Title', content: 'Edited'})
  actions.handleRenamePlan('server-backend', 'Renamed')
  expect(options.updateAgentArtifact).toHaveBeenCalledWith('history-local', expect.any(Function))
  expect(options.updateAgentArtifact).not.toHaveBeenCalledWith('server-backend', expect.any(Function))
  expect(options.schedulePlanServerSync).toHaveBeenCalledWith('backend', 'Title', 'Edited', undefined, 'novel')
})


it('creates an empty detail draft only after the type selector requests it', async () => {
  api.create.mockResolvedValue({ id: 'detail', title: '细纲', content: '', createdAt: '', planKind: 'detail', reviewState: 'unlinked' })
  const onRequestCreate = vi.fn()
  const { options, actions } = fixture({ onRequestCreate })
  actions.handleRequestCreatePlan()
  expect(onRequestCreate).toHaveBeenCalledOnce()
  expect(api.create).not.toHaveBeenCalled()
  await actions.handleCreatePlanFile('detail')
  expect(api.create).toHaveBeenCalledWith('novel', undefined, { planKind: 'detail' })
  expect(options.setWorkViewer).toHaveBeenCalledWith('document')
})

it('does not apply a late create result after leaving its novel scope', async () => {
  let resolve!: (value: object) => void
  api.create.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  let current = true
  const { options, actions } = fixture({ isCurrentNovel: () => current })
  const saving = actions.handleCreatePlanFile('detail')
  current = false
  resolve({ id: 'old', title: 'Old novel', content: '', createdAt: '' })
  await saving
  expect(options.setServerPlanFiles).not.toHaveBeenCalled()
  expect(options.setSelectedTreeItemId).not.toHaveBeenCalled()
})

it('retains the create and deletion failure for their dialogs without removing the plan', async () => {
  api.create.mockRejectedValueOnce(new Error('create failed'))
  api.update.mockRejectedValueOnce(new Error('delete failed'))
  const { options, actions } = fixture()
  await expect(actions.handleCreatePlanFile('detail')).rejects.toThrow('create failed')
  actions.handleRequestDeletePlan('plan')
  await expect(vi.mocked(options.setWorkspaceDialog).mock.calls[0][0].onConfirm()).rejects.toThrow('delete failed')
  expect(options.setServerPlanFiles).not.toHaveBeenCalled()
})

it('carries the observed semantic version with body edits and explicit settings saves', async () => {
  const savePlanMetadata = vi.fn().mockResolvedValue({})
  const base = fixture().options.savedPlanFiles[0]
  const { options, actions } = fixture({ savedPlanFiles: [{ ...base, planKind: 'detail', planHash: 'observed' }], savePlanMetadata, syncScope: 'novel:3' })
  actions.handleWorkspaceDocumentChange({ title: 'Title', content: '\nBody\n' })
  expect(options.schedulePlanServerSync).toHaveBeenCalledWith('server', 'Title', '\nBody\n', 'observed', 'novel:3')
  await actions.handleSavePlanSettings('plan', { parentPlanId: 'parent', expectedParentPlanHash: 'parent-version' })
  expect(savePlanMetadata).toHaveBeenCalledWith('server', { parentPlanId: 'parent', expectedParentPlanHash: 'parent-version', expectedPlanHash: 'observed' }, 'novel:3')
})


it('marks a body draft with the observed baseline instead of a newer response already in server state', () => {
  const setup = fixture()
  const observed = { ...setup.options.savedPlanFiles[0], planHash: 'v1' }
  const remote = { ...observed, content: 'remote v2', planHash: 'v2' }
  const { options, actions } = fixture({ savedPlanFiles: [observed] })
  actions.handleWorkspaceDocumentChange({ title: 'Title', content: '\nlocal draft\n' })
  const update = vi.mocked(options.setServerPlanFiles).mock.calls[0][0]
  const next = typeof update === 'function' ? update([remote]) : update
  expect(next[0]).toMatchObject({ content: '\nlocal draft\n', planHash: 'v1', localDraft: { basePlanHash: 'v1' }, hasRemoteConflict: true, savedSnapshot: { content: 'remote v2', planHash: 'v2' } })
  expect(options.schedulePlanServerSync).toHaveBeenCalledWith('server', 'Title', '\nlocal draft\n', 'v1', 'novel')
})
