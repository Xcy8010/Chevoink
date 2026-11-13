// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DeviceProvider } from '@/components/layout/DeviceProvider'
import { ToastContext } from '@/components/ui/toast-context'
import { createPost, listPosts } from '@/features/community/api'
import CommunityPage from '@/pages/CommunityPage'
import { useShellStore } from '@/store/useShellStore'
import type { Post } from '../../shared/contracts/index.js'

vi.mock('@/features/community/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/community/api')>(),
  listPosts: vi.fn(),
  createPost: vi.fn(),
  listTopics: vi.fn(async () => ({ items: [{ id: 'fantasy', name: '玄幻', slug: 'fantasy', postCount: 2 }] })),
  listRecommendedTopics: vi.fn(async () => ({ items: [] })),
}))

const initialShell = useShellStore.getState()
const toast = { toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }
const snapshotAt = '2026-11-13T00:00:00.000Z'
const list = vi.mocked(listPosts)
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
})

afterEach(() => {
  cleanup()
  useShellStore.setState(initialShell)
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

function post(id: string, content: string): Post {
  return {
    id,
    content,
    excerpt: content,
    topic: null,
    imageUrls: [],
    relatedNovel: null,
    likeCount: 0,
    commentCount: 0,
    favoriteCount: 0,
    auditStatus: 'approved',
    author: { id: 'writer', nickname: '测试作者', avatarUrl: null },
    createdAt: snapshotAt,
    updatedAt: snapshotAt,
  }
}

function page(items: Post[], pageNumber = 1, hasMore = false) {
  return {
    items,
    pagination: { total: 2, page: pageNumber, pageSize: 10, hasMore },
    snapshotAt,
  }
}

function Destination() {
  const { state, search } = useLocation()
  return <output>{state?.communitySearch ?? search}</output>
}

function renderFeed(initial = '/community') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toast}>
        <DeviceProvider>
          <MemoryRouter initialEntries={[initial]}>
            <main data-app-main-scroll>
              <Routes>
                <Route path="/community" element={<><Destination /><CommunityPage /></>} />
                <Route path="/post/:id" element={<Destination />} />
              </Routes>
            </main>
          </MemoryRouter>
        </DeviceProvider>
      </ToastContext.Provider>
    </QueryClientProvider>,
  )
  const scroll = vi.fn()
  const main = view.getByRole('main')
  Object.defineProperty(main, 'scrollTo', { value: scroll })
  return { ...view, main, scroll }
}

it('keeps the toolbar and draft during feed loading, filter errors and rejected publishing', async () => {
  let finishFirstLoad!: (value: ReturnType<typeof page>) => void
  list.mockImplementationOnce(() => new Promise((resolve) => { finishFirstLoad = resolve }))
  list.mockRejectedValueOnce(new Error('列表暂不可用'))
  vi.mocked(createPost).mockRejectedValueOnce(new Error('发帖失败'))
  useShellStore.setState({ authStatus: 'authenticated' })
  const { scroll } = renderFeed()

  const composer = screen.getByRole('button', { name: '发帖' })
  expect(screen.getByLabelText('讨论加载中')).toBeTruthy()
  fireEvent.click(composer)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '我正在写一条讨论' } })
  await act(async () => finishFirstLoad(page([post('first', '最初的讨论')])))
  expect(await screen.findByText('最初的讨论')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '最新' }))
  expect(await screen.findByRole('heading', { name: '社区内容暂时没有打开' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '发帖' })).toBe(composer)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('我正在写一条讨论')
  expect(scroll).toHaveBeenCalledWith({ top: 0 })

  fireEvent.click(screen.getByRole('button', { name: '发布讨论' }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('发帖失败'))
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('我正在写一条讨论')
})

it('pages from the AppShell scroller and carries the feed selection into a post link', async () => {
  const observe = vi.fn()
  const unobserve = vi.fn()
  const disconnect = vi.fn()
  let entriesCallback!: IntersectionObserverCallback
  let observerRoot: Element | Document | null | undefined
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      entriesCallback = callback
      observerRoot = options.root
    }
    observe = observe
    unobserve = unobserve
    disconnect = disconnect
  })
  list.mockResolvedValueOnce(page([post('first', '第一条')], 1, true))
  list.mockRejectedValueOnce(new Error('下一页失败'))
  list.mockResolvedValueOnce(page([post('second', '第二条')], 2))
  const { main } = renderFeed('/community?topic=fantasy&sort=latest')

  const first = await screen.findByText('第一条')
  expect(observerRoot).toBe(main)
  expect(observe).toHaveBeenCalledTimes(1)
  act(() => entriesCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  const retry = await screen.findByRole('button', { name: '重试加载更多' })
  expect(screen.getByText('第一条')).toBe(first)
  fireEvent.click(retry)
  expect(await screen.findByText('第二条')).toBeTruthy()
  expect(list).toHaveBeenLastCalledWith(10, { page: 2, topicId: 'fantasy', sort: 'latest', snapshotAt })
  fireEvent.click(first)
  expect(screen.getByRole('status').textContent).toBe('?topic=fantasy&sort=latest')
})

it('keeps the post draft across animated close/reopen and restores the feed scroller', async () => {
  list.mockResolvedValue(page([]))
  useShellStore.setState({ authStatus: 'authenticated' })
  const { main } = renderFeed()
  fireEvent.click(screen.getByRole('button', { name: '发帖' }))
  const dialog = screen.getByRole<HTMLDialogElement>('dialog', { name: '发帖' })
  fireEvent.change(screen.getByRole('textbox', { name: '帖子内容' }), { target: { value: '保留这条草稿' } })
  expect(main.style.overflowY).toBe('hidden')
  fireEvent.click(screen.getByRole('button', { name: '添加话题' }))
  expect(screen.getByText('使用 # 引用或创建话题，话题名最多 9 个字')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '关闭发帖' }))
  await waitFor(() => expect(dialog.open).toBe(false))
  expect(main.style.overflowY).toBe('')
  fireEvent.click(screen.getByRole('button', { name: '发帖' }))
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '帖子内容' }).value).toBe('保留这条草稿')
})
