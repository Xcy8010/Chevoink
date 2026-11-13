// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AnnouncementBell from '@/features/site-content/AnnouncementBell'
import { refreshPublishedAnnouncements } from '@/features/site-content/announcement-inbox-api'
import { useLiveConfiguration } from '@/app/live-configuration'
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
  return client
}

function signIn() {
  useShellStore.setState({
    authStatus: 'authenticated', sessionUser: {
      id: 'author', nickname: '作者', avatarUrl: null, email: null, phone: null, passwordConfigured: false,
      followerCount: 0, followingCount: 0, novelCount: 0, postCount: 0, unreadMessageCount: 0, unreadNotificationCount: 0,
      createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z',
    },
  })
}
beforeEach(() => {
  restoreDialog = mockNativeDialog()
  request.mockReset()
  useShellStore.setState({ authStatus: 'guest', sessionUser: null })
})
afterEach(() => { cleanup(); restoreDialog() })

it('reads one on detail open, syncs multiple bells, and retains the history after reading all', async () => {
  const payload = inbox('author')
  payload.personalItems = [{ id: 'gift', title: '你收到了奖励额度', body: '管理员已发放 500 奖励额度。', publishedAt: '2026-11-08T08:00:00.000Z', unread: true }]
  signIn()
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return structuredClone(payload)
    const input = JSON.parse(String(init.body)) as ReadAnnouncementsRequest
    const updates = payload.items.filter(item => item.unread && (input.action === 'allNotifications' || (input.action === 'one' && item.versionId === input.versionId)))
    const privateUpdates = payload.personalItems!.filter(item => item.unread && (input.action === 'allNotifications' || (input.action === 'personal' && item.id === input.notificationId)))
    for (const item of [...updates, ...privateUpdates]) item.unread = false
    return { readVersionIds: updates.map(item => item.versionId), readNotificationIds: privateUpdates.map(item => item.id) }
  })

  mount(<><AnnouncementBell placement="studio" /><AnnouncementBell placement="site" /></>)
  const [bell, secondBell] = await screen.findAllByRole('button', { name: '未读通知' })
  expect(bell.title).toBe('未读通知')
  fireEvent.click(bell)
  const dialog = screen.getByRole('dialog', { name: '通知中心' })
  const latest = within(dialog).getByRole('button', { name: /最新通知.*NEW.*未读/ })
  expect(latest.querySelector('time')?.dateTime).toBe(payload.items[0].publishedAt)
  fireEvent.click(latest)
  expect(within(dialog).getByText('最新正文')).toBeTruthy()
  expect(within(dialog).getByRole('heading', { name: '最新通知' })).toBe(document.activeElement)
  fireEvent.click(within(dialog).getByRole('button', { name: '返回通知列表' }))
  await waitFor(() => expect(latest.hasAttribute('data-unread')).toBe(false))
  expect(secondBell.getAttribute('aria-label')).toBe('未读通知')
  const personal = within(dialog).getByRole('button', { name: /你收到了奖励额度.*个人通知/ })
  fireEvent.click(personal)
  expect(within(dialog).getByText('管理员已发放 500 奖励额度。')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '返回通知列表' }))
  await waitFor(() => expect(personal.hasAttribute('data-unread')).toBe(false))
  fireEvent.click(within(dialog).getByRole('button', { name: '全部已读' }))
  await waitFor(() => expect(secondBell.getAttribute('aria-label')).toBe('通知中心'))
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(3)
  expect(dialog.querySelectorAll('[data-unread]')).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭通知中心' }))
  expect(document.activeElement).toBe(bell)
})

it('lets a guest browse the same archive without showing unread state or writing receipts', async () => {
  request.mockResolvedValue(inbox(null))
  mount(<AnnouncementBell placement="site" />)
  const bell = screen.getByRole('button', { name: '通知中心' })
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(bell)
  fireEvent.click(await screen.findByRole('button', { name: /最新通知.*NEW/ }))
  expect(await screen.findByText('最新正文')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '全部已读' })).toBeNull()
  expect(request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
})

it('refreshes an already open tab after an administrator publishes without needing to open the bell', async () => {
  signIn()
  const payload = inbox('author')
  payload.items = []
  request.mockImplementation(async () => structuredClone(payload))
  mount(<AnnouncementBell placement="studio" />)
  await waitFor(() => expect(request).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: '通知中心' }).querySelector('.site-announcement-bell-dot')).toBeNull()
  payload.items = inbox('author').items
  await refreshPublishedAnnouncements(new QueryClient())
  const bell = await screen.findByRole('button', { name: '未读通知' })
  expect(bell.querySelector('.site-announcement-bell-dot')).toBeTruthy()
})

it('updates both closed bells from a server notification without a local publish event', async () => {
  const streams: EventTarget[] = []
  const close = vi.fn()
  vi.stubGlobal('EventSource', class extends EventTarget {
    close = close
    constructor() { super(); streams.push(this) }
  })
  const payload = inbox('author')
  payload.items = []
  signIn()
  request.mockImplementation(async () => structuredClone(payload))
  function Layout() {
    useLiveConfiguration(useQueryClient(), 'authenticated', 'author')
    return <><AnnouncementBell placement="studio" /><AnnouncementBell placement="admin" /></>
  }
  try {
    mount(<Layout />)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(streams).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '通知中心' })).toHaveLength(2)
    payload.items = inbox('author').items
    streams[0].dispatchEvent(new Event('announcements'))
    await waitFor(() => expect(screen.getAllByRole('button', { name: '未读通知' })).toHaveLength(2))
    expect(request).toHaveBeenCalledTimes(2)
    cleanup()
    expect(close).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})
