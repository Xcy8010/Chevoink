// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import AppState from '@/components/ui/AppState'
import EmptyState from '@/components/ui/EmptyState'
import { getNovelDetailPayload } from '@/features/discover/api'
import SearchPage from '@/pages/SearchPage'
import TopicPage from '@/pages/TopicPage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderRoute(path: string, element: ReactNode, client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/search" element={element} /><Route path="/community/topic/:topicKey" element={element} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

it('keeps loading on its original mark and maps an explicitly named empty scene', () => {
  const { container, rerender } = render(<AppState tone="loading" scene="writing" title="加载中" />)
  expect(container.querySelector('[data-app-state="loading"] .motion-safe\\:animate-spin')).toBeTruthy()
  expect(container.querySelector('img')).toBeNull()

  rerender(<EmptyState compact scene="works" />)
  expect(screen.getByRole('heading', { name: '还没有作品' }).closest('[data-compact="true"]')).toBeTruthy()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/chevoink-agent-writing.webp')
  expect(screen.queryByRole('img')).toBeNull()
})

it('locks an asynchronous retry until it settles and permits a new retry after failure', async () => {
  let rejectRetry: (reason: Error) => void = () => {}
  const retry = vi.fn(() => new Promise<void>((_, reject) => { rejectRetry = reject }))
  render(<AppState tone="error" title="加载失败" primaryAction={{ label: '重新加载', onClick: retry }} />)

  const button = screen.getByRole('button', { name: '重新加载' }) as HTMLButtonElement
  fireEvent.click(button)
  expect(button.disabled).toBe(true)
  expect(button.textContent).toBe('正在重试…')
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledOnce()

  await act(async () => rejectRetry(new Error('offline')))
  expect(screen.getByRole('alert').textContent).toBe('重试失败，请稍后再试。')
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledTimes(2)
})

it('shows search empty only after a successful response and retains result filters', async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(Response.json({ success: true, data: { novels: [], authors: [], posts: [] } }))
  vi.stubGlobal('fetch', fetch)
  const { container } = renderRoute('/search?q=墨水', <SearchPage />)

  expect(await screen.findByRole('heading', { name: '搜索失败' })).toBeTruthy()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/chevoink-agent-connection.webp')
  fireEvent.click(screen.getByRole('button', { name: '重新搜索' }))
  expect(await screen.findByRole('heading', { name: '未找到「墨水」的结果' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '作品' })).toBeTruthy()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/chevoink-agent-search.webp')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('keeps cached search rows visible when an update fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['search', '墨水'], {
    authors: [{ id: 'writer', nickname: '墨水作者', avatarUrl: null, bio: null }],
    novels: [],
    posts: [],
  })
  const { container } = renderRoute('/search?q=墨水', <SearchPage />, client)

  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('更新失败'))
  expect(screen.getByRole('link', { name: /墨水作者/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  expect(container.querySelector('[data-app-state="error"]')).toBeNull()
})

it('distinguishes an actual missing topic from a network failure', async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  const { container } = renderRoute('/community/topic/ink', <TopicPage />)

  expect(await screen.findByRole('heading', { name: '话题暂时没有打开' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByRole('heading', { name: '找不到这个话题' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/chevoink-agent-search.webp')
})

it('preserves the HTTP status returned by the novel endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
  await expect(getNovelDetailPayload('missing')).rejects.toMatchObject({ status: 404 })
})
