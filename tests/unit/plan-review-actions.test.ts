import { afterEach, expect, it, vi } from 'vitest'
import { createPlanReviewActions } from '../../src/features/studio/components/plan-review-actions'

const mocks = vi.hoisted(() => ({ update: vi.fn(), accept: vi.fn() }))
vi.mock('../../src/features/studio/api', () => ({ updateNovelPlanFile: mocks.update }))
vi.mock('../../src/features/studio/agent/agentStore', () => ({
  useAgentStore: { getState: () => ({ markWorkspaceActivitiesAccepted: mocks.accept }) },
}))
afterEach(() => vi.resetAllMocks())
function fixture(overrides: Partial<Parameters<typeof createPlanReviewActions>[0]> = {}) {
  const options: Parameters<typeof createPlanReviewActions>[0] = {
    pendingPlanReview: { id: 'review', backendArtifactId: 'server', title: 'New', beforeTitle: 'Old', before: 'before', after: 'after', description: '', createdAt: '' },
    pendingPlanReviewBusy: false, setPendingPlanReview: vi.fn(), setPendingPlanReviewBusy: vi.fn(),
    setServerPlanFiles: vi.fn(), setAgentArtifacts: vi.fn(), setSelectedTreeItemId: vi.fn(),
    setChapterSaveState: vi.fn(), setChapterSaveMessage: vi.fn(), setWorkspaceDialog: vi.fn(),
    ...overrides,
  }
  return { options, actions: createPlanReviewActions(options) }
}
it('accepts without rewriting server content', () => {
  const { options, actions } = fixture()
  actions.handleKeepPendingPlanReview()
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.accept).toHaveBeenCalledWith({ toolNames: ['plan_save'] })
  expect(options.setPendingPlanReview).toHaveBeenCalledWith(null)
})
it.each([null, 'busy'])('does not act on absent or busy review (%s)', async (mode) => {
  const { options, actions } = fixture(mode === null ? { pendingPlanReview: null } : { pendingPlanReviewBusy: true })
  actions.handleKeepPendingPlanReview()
  actions.handleRequestRejectPendingPlanReview()
  actions.handleAcceptPlanReviewHunk(0)
  actions.handleRequestRejectPlanReviewHunk(0)
  await actions.handleRevertPendingPlanReview()
  expect(mocks.update).not.toHaveBeenCalled()
  expect(options.setWorkspaceDialog).not.toHaveBeenCalled()
  expect(options.setPendingPlanReview).not.toHaveBeenCalled()
})
it('confirms before restoring the original full plan', async () => {
  const { options, actions } = fixture()
  actions.handleRequestRejectPendingPlanReview()
  expect(mocks.update).not.toHaveBeenCalled()
  await vi.mocked(options.setWorkspaceDialog).mock.calls[0][0].onConfirm()
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith('server', { title: 'Old', content: 'before' })
  expect(options.setPendingPlanReview).toHaveBeenCalledWith(null)
  expect(options.setPendingPlanReviewBusy).toHaveBeenLastCalledWith(false)
})
it('removes newly created plans rather than saving an empty body', async () => {
  const setup = fixture()
  const { options, actions } = fixture({ pendingPlanReview: { ...setup.options.pendingPlanReview!, isCreate: true } })
  await actions.handleRevertPendingPlanReview()
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith('server', { saved: false })
  const update = vi.mocked(options.setSelectedTreeItemId).mock.calls[0][0]
  expect(typeof update === 'function' ? update('chapter:x') : update).toBe('chapter:x')
  expect(typeof update === 'function' ? update('plan:x') : update).toBe(null)
})
it('retains pending review after failed server write', async () => {
  mocks.update.mockRejectedValue(new Error('offline'))
  const { options, actions } = fixture()
  await actions.handleRevertPendingPlanReview()
  expect(options.setPendingPlanReview).not.toHaveBeenCalled()
  expect(options.setServerPlanFiles).not.toHaveBeenCalled()
  expect(options.setChapterSaveState).toHaveBeenCalledWith('error')
  expect(options.setPendingPlanReviewBusy).toHaveBeenLastCalledWith(false)
})
it('accepts the final hunk without mutating saved content', () => {
  const { options, actions } = fixture()
  actions.handleAcceptPlanReviewHunk(0)
  expect(options.setPendingPlanReview).toHaveBeenCalledWith(null)
  expect(mocks.update).not.toHaveBeenCalled()
})
it('confirms before rejecting a single hunk', async () => {
  const { options, actions } = fixture()
  actions.handleRequestRejectPlanReviewHunk(0)
  expect(mocks.update).not.toHaveBeenCalled()
  await vi.mocked(options.setWorkspaceDialog).mock.calls[0][0].onConfirm()
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith('server', { content: 'before' })
  expect(options.setPendingPlanReview).toHaveBeenCalledWith(null)
})


it('rolls back only against the observed plan hash and preserves exact whitespace', async () => {
  mocks.update.mockResolvedValue({ planHash: 'restored-hash' })
  const setup = fixture()
  const { options, actions } = fixture({ savedPlanFiles: [{ id: 'server-server', backendArtifactId: 'server', artifactId: 'local', title: 'New', content: 'after', createdAt: '', planHash: 'observed-hash' }], pendingPlanReview: { ...setup.options.pendingPlanReview!, before: '\nbefore\n' } })
  await actions.handleRevertPendingPlanReview()
  expect(mocks.update).toHaveBeenCalledWith('server', { title: 'Old', content: '\nbefore\n', expectedPlanHash: 'observed-hash' })
  const update = vi.mocked(options.setServerPlanFiles).mock.calls[0][0]
  expect(typeof update === 'function' ? update(options.savedPlanFiles!) : update).toEqual([expect.objectContaining({ content: '\nbefore\n', planHash: 'restored-hash' })])
})

it('ignores a late rollback response after switching novel scopes', async () => {
  let resolve!: () => void
  mocks.update.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
  let current = true
  const { options, actions } = fixture({ isCurrentNovel: () => current })
  const saving = actions.handleRevertPendingPlanReview()
  current = false; resolve()
  await saving
  expect(options.setPendingPlanReview).not.toHaveBeenCalled()
  expect(options.setServerPlanFiles).not.toHaveBeenCalled()
  expect(options.setPendingPlanReviewBusy).toHaveBeenCalledExactlyOnceWith(true)
})
