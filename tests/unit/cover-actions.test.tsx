// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastContext } from '../../src/components/ui/toast-context'
import { useCoverActions } from '../../src/features/studio/components/use-cover-actions'
import type { CoverAsset, Novel, StudioPayload } from '../../shared/contracts/index'

const api = vi.hoisted(() => ({ prompt: vi.fn(), images: vi.fn(), upload: vi.fn(), update: vi.fn() }))
const image = vi.hoisted(() => ({ crop: vi.fn(), shelf: vi.fn() }))
vi.mock('../../src/features/studio/cover-image', () => ({ buildFixedNovelCoverDataUrl: image.crop }))
vi.mock('../../src/features/home/local-shelf', () => ({ updateShelfCover: image.shelf }))
vi.mock('../../src/features/studio/api', () => ({ generateCoverPrompt: api.prompt, generateCoverImages: api.images, uploadNovelCover: api.upload, updateNovelMeta: api.update }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function fixture(overrides: Partial<Parameters<typeof useCoverActions>[0]> = {}) {
  const state: Parameters<typeof useCoverActions>[0] = {
    activeNovelId: 'novel', currentNovel: null, pendingCoverUploadFile: null,
    coverForm: { novelTitle: ' Title ', summary: ' Summary ', genre: 'fantasy', protagonist: '', stylePreference: '', prompt: 'Cover', negativePrompt: '', size: '768x1024', count: 1 },
    setCoverForm: vi.fn(), setCoverKeywords: vi.fn(), setCoverMessage: vi.fn(), setActiveToolPanel: vi.fn(),
    setMobileView: vi.fn(), setCoverAssets: vi.fn(), setSelectedCoverId: vi.fn(), setWorkspaceDialog: vi.fn(),
    setCoverGenerationBusy: vi.fn(), setCurrentNovel: vi.fn(), setPendingCoverUploadFile: vi.fn(), syncStudioPayload: vi.fn(), ...overrides,
  }
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 } } })
  const toast = { toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}><ToastContext.Provider value={toast}>{children}</ToastContext.Provider></QueryClientProvider>
  }
  return { ...renderHook(() => useCoverActions(state), { wrapper: Wrapper }), state, toast, client }
}

const novel: Novel = {
  id: 'novel', title: 'Title', displayTitle: null, slug: 'title', summary: '', categoryId: null, categoryName: null,
  tags: [], status: 'draft', visibility: 'private', coverUrl: null, coverAssetId: null, coverPrompt: null,
  wordCount: 0, chapterCount: 0, commentCount: 0, favoriteCount: 0, likeCount: 0, viewCount: 0,
  lastChapterTitle: null, lastPublishedAt: null, publishedAt: null, pinnedAt: null,
  author: { id: 'author', nickname: 'Author', avatarUrl: null, followerCount: 0, novelCount: 1, isFollowed: false },
  createdAt: '', updatedAt: '',
}
const asset: CoverAsset = {
  id: 'cover', novelId: 'novel', ownerUserId: 'author', sourceType: 'upload', imageUrl: '/cover.jpg', prompt: 'Asset prompt',
  negativePrompt: null, modelName: null, width: 768, height: 1024, createdAt: '',
}
const payload: StudioPayload = { novel, chapters: [], volumes: [], draftChapter: null, coverAssets: [] }

it('normalizes prompt inputs and preserves the cover entry point after success', async () => {
  api.prompt.mockResolvedValue({ prompt: 'Generated', negativePrompt: 'Exclude', visualKeywords: ['blue'] })
  const { result, state } = fixture()
  await act(async () => { await result.current.coverPromptMutation.mutateAsync() })
  expect(api.prompt).toHaveBeenCalledWith({ novelId: 'novel', novelTitle: 'Title', summary: 'Summary', genre: 'fantasy', protagonist: undefined, stylePreference: undefined })
  expect(state.setCoverKeywords).toHaveBeenCalledWith(['blue'])
  expect(state.setActiveToolPanel).toHaveBeenCalledWith('cover')
  expect(state.setMobileView).toHaveBeenCalledWith('cover')
  const update = vi.mocked(state.setCoverForm).mock.calls[0][0]
  expect(typeof update === 'function' ? update(state.coverForm) : update).toEqual({ ...state.coverForm, prompt: 'Generated', negativePrompt: 'Exclude' })
})

it('keeps the fixed image size and clears generation state after a failed request', async () => {
  api.images.mockRejectedValue(new Error('provider unavailable'))
  const { result, state } = fixture()
  await act(async () => { await expect(result.current.coverImageMutation.mutateAsync()).rejects.toThrow('provider unavailable') })
  expect(api.images).toHaveBeenCalledWith({ prompt: 'Cover', size: '768x1024', count: 1, novelId: 'novel' })
  expect(state.setCoverGenerationBusy).toHaveBeenNthCalledWith(1, true)
  expect(state.setCoverGenerationBusy).toHaveBeenLastCalledWith(false)
  expect(state.setCoverAssets).not.toHaveBeenCalled()
})

it('does not call the provider before the prompt form exists', async () => {
  const { result } = fixture({ coverForm: null })
  await act(async () => { await expect(result.current.coverPromptMutation.mutateAsync()).rejects.toThrow('封面参数尚未准备完成') })
  await act(async () => { await expect(result.current.coverImageMutation.mutateAsync()).rejects.toThrow('请先生成或补充封面提示词') })
  expect(api.prompt).not.toHaveBeenCalled()
  expect(api.images).not.toHaveBeenCalled()
})

it('prepends generated candidates and opens their existing confirmation destination', async () => {
  api.images.mockResolvedValue({ images: [asset] })
  const { result, state } = fixture()
  await act(async () => { await result.current.coverImageMutation.mutateAsync() })
  const assets = vi.mocked(state.setCoverAssets).mock.calls[0][0]
  expect(typeof assets === 'function' ? assets([]) : assets).toEqual([asset])
  const sync = vi.mocked(state.syncStudioPayload).mock.calls[0][0]
  expect(sync(payload)?.coverAssets).toEqual([asset])
  expect(sync(undefined)).toBeUndefined()
  vi.mocked(state.setWorkspaceDialog).mock.calls[0][0].onConfirm()
  expect(state.setMobileView).toHaveBeenLastCalledWith('cover')
  expect(state.setCoverGenerationBusy).toHaveBeenLastCalledWith(false)
})

it('does not open a completion dialog for zero generated candidates', async () => {
  api.images.mockResolvedValue({ images: [] })
  const { result, state } = fixture()
  await act(async () => { await result.current.coverImageMutation.mutateAsync() })
  expect(state.setSelectedCoverId).toHaveBeenCalledWith(null)
  expect(state.setWorkspaceDialog).not.toHaveBeenCalled()
})

it('uploads the cropped image and synchronizes shelf, novel and cached candidates', async () => {
  image.crop.mockResolvedValue('data:image/png;base64,test')
  api.upload.mockResolvedValue({ novel, asset })
  const file = new File(['image'], 'cover.png', { type: 'image/png' })
  const { result, state, client } = fixture({ currentNovel: novel, pendingCoverUploadFile: file })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const crop = { zoom: 1, offsetX: 0, offsetY: 0 }
  await act(async () => { await result.current.coverUploadMutation.mutateAsync(crop) })
  expect(image.crop).toHaveBeenCalledWith(file, crop)
  expect(api.upload).toHaveBeenCalledWith('novel', { coverDataUrl: 'data:image/png;base64,test' })
  expect(image.shelf).toHaveBeenCalledWith('novel', asset.imageUrl)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['novel-detail', 'novel'] })
  const assets = vi.mocked(state.setCoverAssets).mock.calls[0][0]
  expect(typeof assets === 'function' ? assets([asset]) : assets).toEqual([asset])
  const update = vi.mocked(state.setCurrentNovel).mock.calls[0][0]
  expect(typeof update === 'function' ? update(novel) : update).toEqual({ ...novel, coverUrl: asset.imageUrl, coverAssetId: asset.id })
  expect(typeof update === 'function' ? update(null) : update).toBeNull()
  const sync = vi.mocked(state.syncStudioPayload).mock.calls[0][0]
  expect(sync({ ...payload, coverAssets: [asset] })?.coverAssets).toEqual([asset])
  expect(sync(undefined)).toBeUndefined()
  expect(state.setPendingCoverUploadFile).toHaveBeenLastCalledWith(null)
})

it.each([false, true])('rejects uploads before required novel/file state exists (%s)', async (hasNovel) => {
  const { result, state } = fixture({ currentNovel: hasNovel ? novel : null })
  await act(async () => { await expect(result.current.coverUploadMutation.mutateAsync({ zoom: 1, offsetX: 0, offsetY: 0 })).rejects.toThrow() })
  expect(api.upload).not.toHaveBeenCalled()
  expect(state.setCoverMessage).toHaveBeenCalled()
  expect(state.setPendingCoverUploadFile).toHaveBeenCalledWith(null)
})

it('selects a saved cover using its prompt when the form is absent', async () => {
  api.update.mockResolvedValue(novel)
  const { result, state, client } = fixture({ currentNovel: novel, coverForm: null })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  await act(async () => { await result.current.coverSelectMutation.mutateAsync(asset) })
  expect(api.update).toHaveBeenCalledWith('novel', { coverAssetId: asset.id, coverPrompt: asset.prompt })
  expect(image.shelf).toHaveBeenCalledWith(novel.id, asset.imageUrl)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['home'] })
  const update = vi.mocked(state.setCurrentNovel).mock.calls[0][0]
  expect(typeof update === 'function' ? update(novel) : update).toEqual({ ...novel, coverUrl: asset.imageUrl, coverAssetId: asset.id })
  expect(typeof update === 'function' ? update(null) : update).toBeNull()
  const sync = vi.mocked(state.syncStudioPayload).mock.calls[0][0]
  expect(sync(payload)?.novel.coverAssetId).toBe(asset.id)
  expect(sync(undefined)).toBeUndefined()
})

it('leaves the selected cover unchanged when no novel is loaded', async () => {
  const { result, state } = fixture()
  await act(async () => { await expect(result.current.coverSelectMutation.mutateAsync(asset)).rejects.toThrow('作品信息尚未加载完成') })
  expect(api.update).not.toHaveBeenCalled()
  expect(state.setSelectedCoverId).not.toHaveBeenCalled()
})
