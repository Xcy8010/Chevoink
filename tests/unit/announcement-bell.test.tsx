// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AnnouncementBell from '@/features/site-content/AnnouncementBell'
import { useShellStore } from '@/store/useShellStore'
import type { AnnouncementInbox, ReadAnnouncementsRequest } from '../../shared/contracts/site-content'

import { mockNativeDialog } from '../helpers/test-native-dialog'

const request = vi.hoisted(() => vi.fn())
let restoreDialog: () => void
vi.mock('@/app/api-client', () => ({ requestJson: request }))

function inbox(viewerId: string | null): AnnouncementInbox {
  return {
    viewerId,
    serverNow: '2026-11-08T12:00:00.000Z',
    nextBoundaryAt: null,
    items: [
      { id: 'latest', versionId: 'latest-v1', contentVersion: 1, title: '最新通知', body: '最新正文', publishedAt: '2026-11-08T09:00:00.000Z', unread: Boolean(viewerId) },
      { id: 'second', versionId: 'second-v1', contentVersion: 1, title: '较早通知', body: '较早正文', publishedAt: '2026-11-07T09:00:00.000Z', unread: Boolean(viewerId) },
    ],
  }
}
function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
}
beforeEach(() => {
  restoreDialog = mockNativeDialog()
  request.mockReset()
  useShellStore.setState({ authStatus: 'guest', sessionUser: null })
})
afterEach(() => { cleanup(); restoreDialog() })

it('reads one on detail open, syncs multiple bells, and retains the history after reading all', async () => {
  const payload = inbox('author')
  useShellStore.setState({
    authStatus: 'authenticated', sessionUser: {
      id: 'author', nickname: '作者', avatarUrl: null, email: null, phone: null, passwordConfigured: false,
      followerCount: 0, followingCount: 0, novelCount: 0, postCount: 0, unreadMessageCount: 0, unreadNotificationCount: 0,
      createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z',
    },
  })
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (!init) return structuredClone(payload)
    const input = JSON.parse(String(init.body)) as ReadAnnouncementsRequest
    const updates = payload.items.filter(item => item.unread && (input.action === 'all' || item.versionId === input.versionId))
    for (const item of updates) item.unread = false
    return { readVersionIds: updates.map(item => item.versionId) }
  })

  mount(<><AnnouncementBell placement="studio" /><AnnouncementBell placement="site" /></>)
  const [bell, secondBell] = await screen.findAllByRole('button', { name: '未读通知' })
  expect(bell.title).toBe('未读通知')
  fireEvent.click(bell)
  const dialog = screen.getByRole('dialog', { name: '公告通知' })
  const latest = within(dialog).getByRole('button', { name: /最新通知.*NEW.*未读/ })
  expect(latest.querySelector('time')?.dateTime).toBe(payload.items[0].publishedAt)
  fireEvent.click(latest)
  expect(within(dialog).getByText('最新正文')).toBeTruthy()
  expect(within(dialog).getByRole('heading', { name: '最新通知' })).toBe(document.activeElement)
  fireEvent.click(within(dialog).getByRole('button', { name: '返回公告列表' }))
  await waitFor(() => expect(latest.hasAttribute('data-unread')).toBe(false))
  expect(secondBell.getAttribute('aria-label')).toBe('未读通知')
  fireEvent.click(within(dialog).getByRole('button', { name: '全部已读' }))
  await waitFor(() => expect(secondBell.getAttribute('aria-label')).toBe('公告通知'))
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(2)
  expect(dialog.querySelectorAll('[data-unread]')).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭公告通知' }))
  expect(document.activeElement).toBe(bell)
})

it('lets a guest browse the same archive without showing unread state or writing receipts', async () => {
  request.mockResolvedValue(inbox(null))
  mount(<AnnouncementBell placement="site" />)
  const bell = screen.getByRole('button', { name: '公告通知' })
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(bell)
  fireEvent.click(await screen.findByRole('button', { name: /最新通知.*NEW/ }))
  expect(await screen.findByText('最新正文')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '全部已读' })).toBeNull()
  expect(request.mock.calls.every(([, init]) => !init)).toBe(true)
})
