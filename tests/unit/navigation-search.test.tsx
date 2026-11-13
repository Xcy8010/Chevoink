// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import GlobalSearchBox from '@/features/search/GlobalSearchBox'
import { useRevealHeader } from '@/hooks/useRevealHeader'

vi.mock('@/features/search/api', () => ({
  getHotSearchKeywords: async () => ({ keywords: ['玄幻'] }),
  searchSuggest: async () => ({ items: [{ type: 'author', id: 'writer', text: '林间灯' }] }),
}))

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

function RouteProbe() {
  const location = useLocation()
  return <output>{location.pathname + location.search}</output>
}

it.each([false, true])('search input and compact entry share hot searches and suggestion navigation (compact=%s)', async compact => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/community']}><GlobalSearchBox compact={compact} /><RouteProbe /></MemoryRouter></QueryClientProvider>)
  if (compact) fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  const input = screen.getByRole('textbox', { name: '搜索作品、作者、讨论' })
  fireEvent.focus(input)
  expect(await screen.findByText('玄幻')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('/community')
  fireEvent.change(input, { target: { value: '林间' } })
  fireEvent.click(await screen.findByRole('button', { name: '林间灯' }))
  expect(screen.getByRole('status').textContent).toBe('/author/writer')
})

it('compact search Escape closes the panel and restores focus', async () => {
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><GlobalSearchBox compact /></MemoryRouter></QueryClientProvider>)
  const trigger = screen.getByRole('button', { name: '搜索' })
  fireEvent.click(trigger)
  const input = screen.getByRole('textbox')
  await waitFor(() => expect(document.activeElement).toBe(input))
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

function RevealProbe({ pinned = false }: { pinned?: boolean }) {
  const { ref, hidden } = useRevealHeader(pinned)
  return <main data-app-main-scroll><header ref={ref} data-hidden={hidden}>Header</header></main>
}

it('reveals on reverse scrolling, ignores jitter, keeps search open and restores at the top', () => {
  let nextFrame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { nextFrame = cb; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const { rerender } = render(<RevealProbe />)
  const main = screen.getByRole('main')
  const header = screen.getByText('Header')
  Object.defineProperties(main, { scrollHeight: { value: 3000 }, clientHeight: { value: 800 } })
  const scroll = (top: number) => act(() => { main.scrollTop = top; fireEvent.scroll(main); nextFrame?.(0) })
  scroll(200)
  expect(header.dataset.hidden).toBe('true')
  scroll(196)
  expect(header.dataset.hidden).toBe('true')
  scroll(170)
  expect(header.dataset.hidden).toBe('false')
  scroll(230)
  rerender(<RevealProbe pinned />)
  expect(header.dataset.hidden).toBe('false')
  rerender(<RevealProbe />)
  scroll(0)
  expect(header.dataset.hidden).toBe('false')
})
