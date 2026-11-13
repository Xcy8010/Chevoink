// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NovelCard } from '../../shared/contracts/index.js'
import DiscoverPage from '@/pages/DiscoverPage'
import { listNovels } from '@/features/discover/api'

const actions = vi.hoisted(() => ({ read: vi.fn(), click: vi.fn(), dismiss: vi.fn() }))
vi.mock('@/features/discover/api', async original => ({ ...await original<typeof import('@/features/discover/api')>(), listNovels: vi.fn() }))
vi.mock('@/features/discover/useStartReading', () => ({ useStartReading: () => ({ startReading: actions.read, isStarting: false, pendingNovelId: null }) }))
vi.mock('@/features/discover/useForYouRecommendations', () => ({ useForYouRecommendations: () => ({ items: [], personalized: false, reportClick: actions.click, reportDismiss: actions.dismiss }) }))

function novel(id: string, tags = ['玄幻'], wordCount = 1000): NovelCard {
  return { id, title: id, displayTitle: null, slug: id, summary: '一段公开简介', tags, status: 'published', coverUrl: null, wordCount, chapterCount: 3, lastPublishedAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', author: { id: 'author', nickname: '作者', avatarUrl: null } }
}
const books = [novel('短篇'), novel('长篇', ['都市'], 9000)]
const payload = (items = books) => ({ items, pagination: { page: 1, pageSize: 24, total: items.length, hasMore: false } })
function CurrentLocation() { const location = useLocation(); return <output data-testid="location">{location.search}</output> }
function mount(path = '/discover', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><DiscoverPage /><CurrentLocation /></MemoryRouter></QueryClientProvider>)
}
beforeEach(() => { vi.mocked(listNovels).mockResolvedValue(payload()) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('keeps sorting and the existing reading action while excluding drafts', async () => {
  vi.mocked(listNovels).mockResolvedValue(payload([...books, { ...novel('未公开草稿'), status: 'draft' }]))
  mount()
  const gallery = await screen.findByRole('region', { name: '发现好书' })
  expect(screen.queryByText('未公开草稿')).toBeNull()
  fireEvent.change(screen.getByRole('combobox', { name: '作品排序' }), { target: { value: 'wordCount' } })
  expect(within(gallery).getAllByRole('heading')[0].textContent).toBe('长篇')
  fireEvent.click(within(gallery).getAllByRole('button', { name: '开始阅读' })[0])
  expect(actions.read).toHaveBeenCalledWith('长篇')
})

it('preserves category controls and other query parameters when no category matches', async () => {
  mount('/discover?tag=不存在&keep=1')
  await screen.findByText('这个分类还没有作品')
  expect(screen.getByRole('button', { name: '不存在' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看全部' }))
  await screen.findByRole('region', { name: '发现好书' })
  expect(screen.getByTestId('location').textContent).toBe('?keep=1')
})

it('shows a connection error without calling it an empty library and lets retry recover', async () => {
  vi.mocked(listNovels).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(payload())
  mount()
  await screen.findByText('暂时连不上书库')
  expect(screen.queryByText('书库还在等待新的故事')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
  await screen.findByRole('region', { name: '发现好书' })
})

it('retains cached books and offers a local retry when a refresh fails', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['discover-novels'], payload())
  vi.mocked(listNovels).mockRejectedValue(new Error('offline'))
  mount('/discover', client)
  await screen.findByText('更新失败，正在显示上次加载的内容。')
  expect(screen.getByRole('region', { name: '发现好书' })).toBeTruthy()
  expect(screen.queryByText('暂时连不上书库')).toBeNull()
  vi.mocked(listNovels).mockResolvedValue(payload())
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(screen.queryByText('更新失败，正在显示上次加载的内容。')).toBeNull())
})
