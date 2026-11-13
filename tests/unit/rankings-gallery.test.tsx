// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ApiClientError } from '@/app/api-client'
import { listNovels } from '@/features/discover/api'
import { CATEGORY_RANKING_TAGS, RANKING_BOARDS } from '@/features/discover/ranking'
import RankingsPage from '@/pages/RankingsPage'
import type { NovelCard } from '../../shared/contracts/index.js'

const reading = vi.hoisted(() => ({ startReading: vi.fn() }))
vi.mock('@/features/discover/api', async original => ({
  ...await original<typeof import('@/features/discover/api')>(),
  listNovels: vi.fn(),
}))
vi.mock('@/features/discover/useStartReading', () => ({
  useStartReading: () => ({ startReading: reading.startReading, isStarting: false, pendingNovelId: null }),
}))

function novel(id: string, title: string, data: Partial<NovelCard> = {}): NovelCard {
  return {
    id, title, displayTitle: null, slug: id, tags: ['玄幻'], summary: '书里的第一段简介。',
    coverUrl: null, status: 'published', wordCount: 1000, chapterCount: 3,
    updatedAt: '2026-11-10T00:00:00Z', lastPublishedAt: '2026-11-10T00:00:00Z',
    author: { id: 'author', nickname: '榜单作者', avatarUrl: null }, ...data,
  }
}

const books = [
  novel('short', '山风来信', { tags: ['科幻'], updatedAt: '2026-11-12T00:00:00Z' }),
  novel('long', '海港长夜', { wordCount: 90000, status: 'completed' }),
]
const payload = (items = books) => ({ items, pagination: { page: 1, pageSize: 60, total: items.length, hasMore: false } })

function LocationOutput() {
  const location = useLocation()
  return <output data-testid="rankings-location">{location.pathname + location.search}</output>
}

function mount(path = '/rankings', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <RankingsPage />
        <LocationOutput />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.mocked(listNovels).mockReset().mockResolvedValue(payload()))
afterEach(() => { cleanup(); reading.startReading.mockReset() })

it('opens all six boards through the URL and uses the selected board’s order for ranks', async () => {
  const draft = novel('draft', '未发布草稿', { wordCount: 999999, status: 'draft' })
  vi.mocked(listNovels).mockResolvedValue(payload([...books, draft]))
  mount('/rankings?board=long')
  const rows = within(await screen.findByRole('list', { name: '长篇榜' })).getAllByRole('listitem')
  expect(rows.map(row => within(row).getByRole('heading').textContent)).toEqual(['海港长夜', '山风来信'])
  expect(rows.map(row => row.querySelector('.rankings-number')?.textContent)).toEqual(['01', '02'])
  expect(screen.queryByText('未发布草稿')).toBeNull()
  expect(listNovels).toHaveBeenCalledExactlyOnceWith({ page: 1, pageSize: 60, publishedOnly: true })

  const tabs = within(screen.getByRole('navigation', { name: '榜单类型' }))
  expect(tabs.getAllByRole('button').map(button => button.textContent)).toEqual(RANKING_BOARDS.map(board => board.label))
  for (const board of RANKING_BOARDS) {
    const tab = tabs.getByRole('button', { name: board.label })
    fireEvent.click(tab)
    expect(tab.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('rankings-location').textContent).toBe(board.id === 'hot' ? '/rankings' : `/rankings?board=${board.id}`)
  }
  expect(within(screen.getByRole('list', { name: '完结榜' })).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['海港长夜'])
})

it('opens the category from a deep link and keeps switching available when a category has no books', async () => {
  mount('/rankings?board=' + encodeURIComponent('科幻'))
  const results = await screen.findByRole('list', { name: '科幻榜' })
  expect(within(results).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['山风来信'])
  const categories = screen.getByRole<HTMLSelectElement>('combobox', { name: '分类榜' })
  expect(categories.value).toBe('科幻')
  expect([...categories.options].slice(1).map(option => option.value)).toEqual(CATEGORY_RANKING_TAGS)
  fireEvent.change(categories, { target: { value: '悬疑' } })
  expect(screen.getByText('当前榜单暂无作品')).toBeTruthy()
  expect(screen.getByTestId('rankings-location').textContent).toBe('/rankings?board=' + encodeURIComponent('悬疑'))
  fireEvent.click(screen.getByRole('button', { name: '查看热门榜' }))
  expect(screen.getByRole('list', { name: '热读榜' })).toBeTruthy()
  expect(categories.value).toBe('')
})

it('uses the real detail link and reading action for each work', async () => {
  mount('/rankings?board=finished')
  const row = within(await screen.findByRole('list', { name: '完结榜' })).getByRole('listitem')
  expect(within(row).getByText('榜单作者')).toBeTruthy()
  expect(within(row).getByText('书里的第一段简介。')).toBeTruthy()
  fireEvent.click(within(row).getByRole('button', { name: '阅读《海港长夜》' }))
  expect(reading.startReading).toHaveBeenCalledExactlyOnceWith('long')
  fireEvent.click(within(row).getByRole('link', { name: '海港长夜' }))
  expect(screen.getByTestId('rankings-location').textContent).toBe('/novel/long')
})

it('keeps the board controls and discovery link when the entire collection is empty', async () => {
  vi.mocked(listNovels).mockResolvedValue(payload([]))
  mount('/rankings?board=new')
  expect(await screen.findByText('暂无上榜作品')).toBeTruthy()
  expect(screen.getByRole('link', { name: '去发现' }).getAttribute('href')).toBe('/discover')
  expect(screen.getByRole('button', { name: '新书榜' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.change(screen.getByRole('combobox', { name: '分类榜' }), { target: { value: '科幻' } })
  expect(screen.getByText('暂无上榜作品')).toBeTruthy()
  expect(screen.getByTestId('rankings-location').textContent).toBe('/rankings?board=' + encodeURIComponent('科幻'))
})

it.each([
  { error: new Error('offline'), title: '榜单暂时没有打开' },
  { error: new ApiClientError('not found', 404), title: '榜单暂不可用' },
])('offers recovery for $title without declaring an empty collection', async ({ error, title }) => {
  vi.mocked(listNovels).mockRejectedValueOnce(error).mockResolvedValueOnce(payload())
  mount()
  expect(await screen.findByText(title)).toBeTruthy()
  expect(screen.queryByText('暂无上榜作品')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByRole('list', { name: '热读榜' })).toBeTruthy()
})

it('keeps cached results visible while retrying a failed refresh', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['rankings-novels'], payload())
  vi.mocked(listNovels).mockRejectedValueOnce(new Error('offline'))
  mount('/rankings?board=long', client)
  await screen.findByText('更新失败，正在显示上次加载的内容。')
  let finish!: (result: ReturnType<typeof payload>) => void
  vi.mocked(listNovels).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect((screen.getByRole('button', { name: '正在重试…' }) as HTMLButtonElement).disabled).toBe(true)
  expect(within(screen.getByRole('list', { name: '长篇榜' })).getAllByRole('listitem')).toHaveLength(2)
  finish(payload([books[0]]))
  await waitFor(() => expect(screen.queryByText('更新失败，正在显示上次加载的内容。')).toBeNull())
  expect(within(screen.getByRole('list', { name: '长篇榜' })).getAllByRole('listitem')).toHaveLength(1)
})
