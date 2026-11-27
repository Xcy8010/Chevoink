// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useChapterPersistence } from '../../src/features/studio/components/use-chapter-persistence'

const api = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }))
vi.mock('../../src/features/studio/api', () => ({ createChapterDraft: api.create, updateChapterDraft: api.update }))
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers() })

function fixture(overrides: Partial<Parameters<typeof useChapterPersistence>[0]> = {}) {
  const draft = { id: 'chapter', title: 'Title', content: 'Body', summary: '', status: 'draft' as const, visibility: 'private' as const, orderIndex: 1, revision: 2, localOnly: false }
  const options: Parameters<typeof useChapterPersistence>[0] = {
    activeNovelId: 'a', chapterDraft: draft, chapterDirty: false,
    chapterDraftStateRef: { current: draft }, pendingChapterReviewsRef: { current: [] }, selectedChapterIdStateRef: { current: draft.id },
    promptConfirmPendingChapterReview: vi.fn(), setChapterSaveState: vi.fn(), setChapterSaveMessage: vi.fn(),
    setChapters: vi.fn(), setSelectedTreeItemId: vi.fn(), setSelectedChapterId: vi.fn(), setChapterDraft: vi.fn(),
    setChapterDirty: vi.fn(), setChapterLastSavedAt: vi.fn(), setCurrentNovel: vi.fn(), syncStudioPayload: vi.fn(), ...overrides,
  }
  const hook = renderHook(({ novelId }) => useChapterPersistence({ ...options, activeNovelId: novelId }), { initialProps: { novelId: 'a' } })
  return { ...hook, options, draft }
}

it('does not write a late save response into a different novel', async () => {
  let finish!: (value: unknown) => void
  api.update.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result, options, rerender, draft } = fixture()
  let pending!: Promise<void>
  act(() => { pending = result.current('manual') })
  rerender({ novelId: 'b' })
  await act(async () => { finish({ ...draft, revision: 3 }); await pending })
  expect(options.setChapters).not.toHaveBeenCalled()
  expect(options.setCurrentNovel).not.toHaveBeenCalled()
  expect(options.setChapterDraft).not.toHaveBeenCalled()
  expect(options.syncStudioPayload).not.toHaveBeenCalled()
})

it('preserves newer typing and advances only the saved revision', async () => {
  let finish!: (value: unknown) => void
  api.update.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result, options, draft } = fixture()
  let pending!: Promise<void>
  act(() => { pending = result.current('manual') })
  options.chapterDraftStateRef.current = { ...draft, content: 'New typing' }
  await act(async () => { finish({ ...draft, revision: 3, updatedAt: '2026-09-08T00:00:00Z', wordCount: 4 }); await pending })
  expect(options.setChapterDraft).toHaveBeenCalledWith({ ...draft, content: 'New typing', revision: 3 })
  expect(options.setChapterDirty).toHaveBeenCalledWith(true)
  expect(api.update).toHaveBeenCalledWith('a', 'chapter', expect.objectContaining({ expectedRevision: 2, content: 'Body' }))
})

it('serializes overlapping manual and automatic saves', async () => {
  let fail!: (error: Error) => void
  api.update.mockImplementation(() => new Promise((_, reject) => { fail = reject }))
  const { result, options } = fixture()
  let first!: Promise<void>, second!: Promise<void>
  act(() => { first = result.current('manual'); second = result.current('auto') })
  expect(api.update).toHaveBeenCalledTimes(1)
  await act(async () => { fail(new Error('offline')); await Promise.all([first, second]) })
  expect(options.setChapterSaveState).toHaveBeenCalledWith('error')
  expect(options.setChapterDraft).not.toHaveBeenCalled()
})

it('rejects an empty draft without issuing a mutation', async () => {
  const { result, options } = fixture()
  options.chapterDraftStateRef.current = { ...options.chapterDraft!, title: ' ' }
  await act(async () => { await result.current('manual') })
  expect(api.update).not.toHaveBeenCalled()
  expect(options.setChapterSaveMessage).toHaveBeenCalledWith('章节标题和正文都不能为空。')
})

it('surfaces a failed save for the open chapter and silences a late error after changing chapters', async () => {
  const onSaveError = vi.fn()
  const { result, options, draft } = fixture({ onSaveError })
  api.update.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { await result.current('manual') })
  expect(onSaveError).toHaveBeenCalledExactlyOnceWith('offline')
  let fail!: (error: Error) => void
  api.update.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
  let pending!: Promise<void>
  act(() => { pending = result.current('auto') })
  options.chapterDraftStateRef.current = { ...draft, id: 'other' }
  options.selectedChapterIdStateRef.current = 'other'
  await act(async () => { fail(new Error('late error')); await pending })
  expect(onSaveError).toHaveBeenCalledTimes(1)
})

it('skips absent drafts and keeps automatic empty saves silent', async () => {
  const { result, options, draft } = fixture()
  options.chapterDraftStateRef.current = null
  await act(async () => { await result.current('manual') })
  options.chapterDraftStateRef.current = { ...draft, content: ' ' }
  await act(async () => { await result.current('auto') })
  expect(api.update).not.toHaveBeenCalled()
  expect(options.setChapterSaveState).not.toHaveBeenCalled()
})

it('accepts a normal save and updates the owned cached payload', async () => {
  const { result, options, draft } = fixture()
  const saved = { ...draft, revision: 3, updatedAt: '2026-09-08T00:00:00Z', wordCount: 4 }
  api.update.mockResolvedValue(saved)
  await act(async () => { await result.current('manual') })
  expect(options.setChapterDirty).toHaveBeenCalledWith(false)
  expect(options.setChapterLastSavedAt).toHaveBeenCalledWith(saved.updatedAt)
  expect(options.syncStudioPayload).toHaveBeenCalledTimes(1)
  const update = vi.mocked(options.syncStudioPayload).mock.calls[0][0]
  expect(update(undefined)).toBeUndefined()
})

it('does not overwrite another chapter opened during the save', async () => {
  let finish!: (value: unknown) => void
  api.update.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result, options, draft } = fixture()
  let pending!: Promise<void>
  act(() => { pending = result.current('manual') })
  options.chapterDraftStateRef.current = { ...draft, id: 'other', content: 'Other chapter' }
  options.selectedChapterIdStateRef.current = 'other'
  await act(async () => { finish({ ...draft, revision: 3, updatedAt: '2026-09-08T00:00:00Z' }); await pending })
  expect(options.setChapterDraft).not.toHaveBeenCalled()
  expect(options.setSelectedChapterId).not.toHaveBeenCalled()
  expect(options.setChapterLastSavedAt).not.toHaveBeenCalled()
  expect(options.setChapters).toHaveBeenCalledTimes(1)
})

it('debounces automatic saving and cancels it on unmount', async () => {
  vi.useFakeTimers()
  api.update.mockResolvedValue({ id: 'chapter', title: 'Title', content: 'Body', revision: 3, updatedAt: '2026-09-08T00:00:00Z' })
  const first = fixture({ chapterDirty: true })
  await act(async () => { await vi.advanceTimersByTimeAsync(799) })
  expect(api.update).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(api.update).toHaveBeenCalledTimes(1)
  first.unmount()
  const second = fixture({ chapterDirty: true })
  second.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(800) })
  expect(api.update).toHaveBeenCalledTimes(1)
})
