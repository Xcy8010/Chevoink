// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ToastContext } from '@/components/ui/toast-context'
import { getMe, listFavoriteNovels, listPosts, listUserBookmarkedPosts } from '@/features/community/api'
import { listNovelCardsByIds } from '@/features/discover/api'
import { getLocalShelf, subscribeShelfChange, upsertShelfRaw } from '@/features/home/local-shelf'
import ProfilePage from '@/pages/ProfilePage'
import { useShellStore } from '@/store/useShellStore'
import type { NovelCard, Post, User, UserMePayload } from '../../shared/contracts'

vi.mock('@/features/community/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/community/api')>(),
  getMe: vi.fn(),
  listPosts: vi.fn(),
  listFavoriteNovels: vi.fn(),
  listUserBookmarkedPosts: vi.fn(),
}))
vi.mock('@/features/discover/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/discover/api')>(),
  listNovelCardsByIds: vi.fn(),
}))

const date = '2026-11-13T01:00:00Z'
const user: User = {
  id: 'me', nickname: '测试读者', email: null, phone: null, avatarUrl: null,
  passwordConfigured: true, followerCount: 0, followingCount: 0, novelCount: 0, postCount: 2,
  unreadMessageCount: 0, unreadNotificationCount: 0, createdAt: date, updatedAt: date,
}
const profile: UserMePayload = { user, shelf: [], drafts: [], activities: [], notifications: [] }
const pagination = { page: 1, pageSize: 40, total: 3, hasMore: false }
const initialShell = useShellStore.getState()
const toast = { toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }

function post(id: string, authorId: string, likeCount: number, favoriteCount: number): Post {
  return {
    id, content: '', excerpt: '', topic: null, imageUrls: [], relatedNovel: null,
    likeCount, favoriteCount, commentCount: 0, auditStatus: 'approved',
    author: { id: authorId, nickname: '测试作者', avatarUrl: null },
    createdAt: date, updatedAt: date,
  }
}

function card(id: string, coverUrl: string): NovelCard {
  return {
    id, title: id, slug: id, coverUrl, displayTitle: null, summary: '', tags: [], status: 'published',
    wordCount: 0, chapterCount: 0, lastPublishedAt: null, updatedAt: date, author: user,
  }
}

function renderProfile(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toast}>
        <MemoryRouter>
          <ProfilePage />
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useShellStore.setState({ authStatus: 'authenticated', sessionUser: user })
  vi.mocked(getMe).mockResolvedValue(profile)
  vi.mocked(listPosts).mockResolvedValue({ items: [], pagination })
})

afterEach(() => {
  cleanup()
  useShellStore.setState(initialShell)
  window.localStorage.clear()
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

it('shows the profile, shelf and editable controls while the post counts are pending', async () => {
  let resolvePosts!: (result: Awaited<ReturnType<typeof listPosts>>) => void
  vi.mocked(listPosts).mockImplementation(() => new Promise((resolve) => { resolvePosts = resolve }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['community', 'posts'], { items: [post('different-page', user.id, 50, 0)], pagination })

  renderProfile(client)
  expect(screen.getByRole('status', { name: '个人中心加载中' })).toBeTruthy()
  expect(await screen.findByRole('heading', { name: user.nickname })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '书架还空着' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '— 获赞' })).toBeTruthy()
  expect(listPosts).toHaveBeenCalledWith(40)
  expect(listFavoriteNovels).not.toHaveBeenCalled()
  expect(listUserBookmarkedPosts).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '编辑资料' }))
  const nickname = screen.getByRole<HTMLInputElement>('textbox', { name: '昵称' })
  fireEvent.change(nickname, { target: { value: '未保存的昵称' } })
  await act(async () => resolvePosts({
    items: [post('mine-1', user.id, 2, 3), post('mine-2', user.id, 1, 0), post('other', 'other', 50, 20)],
    pagination,
  }))
  expect(await screen.findByRole('button', { name: '6 获赞' })).toBeTruthy()
  expect(nickname.value).toBe('未保存的昵称')
})

it('keeps the profile usable when the post request fails and loads the bookmarked panel on demand', async () => {
  vi.mocked(listPosts).mockRejectedValue(new Error('帖子暂不可用'))
  vi.mocked(listFavoriteNovels).mockResolvedValue({ items: [] })
  vi.mocked(listUserBookmarkedPosts).mockResolvedValue({ items: [] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  renderProfile(client)

  await waitFor(() => expect(client.getQueryState(['community', 'posts', 'profile', user.id])?.status).toBe('error'))
  expect(screen.getByRole('heading', { name: user.nickname })).toBeTruthy()
  expect(screen.getByRole('button', { name: '— 获赞' })).toBeTruthy()
  expect(listUserBookmarkedPosts).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '收藏' }))
  fireEvent.click(screen.getByRole('button', { name: '帖子' }))
  await waitFor(() => expect(listUserBookmarkedPosts).toHaveBeenCalledWith(user.id))
})

it('only shows an empty collection after a successful retry', async () => {
  vi.mocked(listFavoriteNovels)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [] })
  renderProfile()

  fireEvent.click(await screen.findByRole('button', { name: '收藏' }))
  expect(await screen.findByRole('heading', { name: '收藏作品加载失败' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '还没有收藏作品' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByRole('heading', { name: '还没有收藏作品' })).toBeTruthy()
  expect(listFavoriteNovels).toHaveBeenCalledTimes(2)
})

it('renders shelf snapshots before cover recovery and persists changed covers together', async () => {
  upsertShelfRaw({ novelId: 'a', title: '旧封面', coverUrl: '/old-a.jpg', addedAt: 2 })
  upsertShelfRaw({ novelId: 'b', title: '缺封面', coverUrl: null, addedAt: 1 })
  let resolveCovers!: (cards: NovelCard[]) => void
  vi.mocked(listNovelCardsByIds).mockImplementation(() => new Promise((resolve) => { resolveCovers = resolve }))
  const setItem = vi.spyOn(Storage.prototype, 'setItem')
  const onShelfChange = vi.fn()
  const unsubscribe = subscribeShelfChange(onShelfChange)
  try {
    renderProfile()
    const snapshot = await screen.findByRole('img', { name: '旧封面' })
    expect(snapshot.getAttribute('src')).toBe('/old-a.jpg')
    expect(snapshot.getAttribute('loading')).toBe('lazy')
    expect(screen.getByRole('button', { name: /缺封面/ })).toBeTruthy()
    expect(listNovelCardsByIds).toHaveBeenCalledTimes(1)

    await act(async () => resolveCovers([card('a', '/new-a.jpg'), card('b', '/new-b.jpg'), card('untracked', '/extra.jpg')]))
    expect((await screen.findByRole('img', { name: '缺封面' })).getAttribute('src')).toBe('/new-b.jpg')
    expect(snapshot.getAttribute('src')).toBe('/new-a.jpg')
    expect(getLocalShelf().map(({ coverUrl }) => coverUrl)).toEqual(['/new-a.jpg', '/new-b.jpg'])
    expect(setItem.mock.calls.filter(([key]) => key === 'chevoink-shelf')).toHaveLength(1)
    expect(onShelfChange).toHaveBeenCalledTimes(1)
  } finally {
    unsubscribe()
  }
})
