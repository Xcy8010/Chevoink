// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AnnouncementBell from '@/features/site-content/AnnouncementBell'
import { refreshPublishedAnnouncements } from '@/features/site-content/announcement-inbox-api'
import { useLiveConfiguration } from '@/app/live-configuration'
import { useShellStore } from '@/store/useShellStore'
import type { AnnouncementInbox, ReadAnnouncementsRequest } from '../../shared/contracts/site-content'

import { mockAnimationSupport, mockNativeDialog } from '../helpers/test-native-dialog'

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

it('keeps the notification list and detail inside the desktop client area and restores list focus', async () => {
  document.documentElement.dataset.desktopFrame = 'studio'
  try {
    request.mockResolvedValue(inbox(null))
    mount(<AnnouncementBell placement="site" />)
    const bell = screen.getByRole('button', { name: '通知中心' })
    fireEvent.click(bell)
    const list = await screen.findByRole('dialog', { name: '通知中心' })
    const row = await within(list).findByRole('button', { name: /最新通知/ })
    expect(list.closest('.desktop-notice-layer')).toBeTruthy()
    fireEvent.click(row)
    const detail = await screen.findByRole('dialog', { name: '最新通知' })
    expect(detail.closest('.desktop-notice-layer')).toBeTruthy()
    fireEvent.keyDown(detail, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(row))
    fireEvent.keyDown(row, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(bell))
  } finally {
    delete document.documentElement.dataset.desktopFrame
  }
})

it('reads just the closed announcement, syncs the bells and retains the history after reading all', async () => {
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
  const notice = await screen.findByRole('dialog', { name: '最新通知' })
  expect(within(notice).getByText('最新正文')).toBeTruthy()
  expect(within(notice).getByAltText('启创墨域 Chevoink 最新公告')).toBeTruthy()
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  fireEvent.click(within(notice).getByRole('button', { name: '关闭', exact: true }))
  await waitFor(() => expect(latest.hasAttribute('data-unread')).toBe(false))
  expect(document.activeElement).toBe(latest)
  expect(within(dialog).getByRole('button', { name: /较早通知.*未读/ })).toBeTruthy()
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init.body))).toEqual([
    { viewerId: 'author', action: 'one', versionId: 'latest-v1' },
  ])
  expect(secondBell.getAttribute('aria-label')).toBe('未读通知')
  const personal = within(dialog).getByRole('button', { name: /你收到了奖励额度.*个人通知/ })
  fireEvent.click(personal)
  const message = await screen.findByRole('dialog', { name: '你收到了奖励额度' })
  expect(within(message).getByAltText('启创墨域 Chevoink 个人通知')).toBeTruthy()
  expect(within(message).getByText('管理员已发放 500 奖励额度。')).toBeTruthy()
  fireEvent.click(within(message).getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(personal.hasAttribute('data-unread')).toBe(false))
  const markAll = within(dialog).getByRole<HTMLButtonElement>('button', { name: '全部已读' })
  await waitFor(() => expect(markAll.disabled).toBe(false))
  fireEvent.click(markAll)
  await waitFor(() => expect(secondBell.getAttribute('aria-label')).toBe('通知中心'))
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(3)
  expect(dialog.querySelectorAll('[data-unread]')).toHaveLength(0)
  const receipts = request.mock.calls.filter(([, init]) => init?.method === 'POST').length
  for (const [row, title, label] of [
    [personal, '你收到了奖励额度', '个人通知'],
    [latest, '最新通知', '最新公告'],
    [within(dialog).getByRole('button', { name: /较早通知/ }), '较早通知', '公告'],
  ] as const) {
    fireEvent.click(row)
    const reopened = await screen.findByRole('dialog', { name: title })
    expect(within(reopened).getByAltText('启创墨域 Chevoink ' + label)).toBeTruthy()
    fireEvent.click(within(reopened).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(document.activeElement).toBe(row))
  }
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(receipts)
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
  const notice = await screen.findByRole('dialog', { name: '最新通知' })
  expect(within(notice).getByText('最新正文')).toBeTruthy()
  fireEvent.click(within(notice).getByRole('button', { name: '查看全部公告' }))
  const archive = await screen.findByRole('dialog', { name: '全部公告' })
  fireEvent.click(within(archive).getByRole('button', { name: /较早通知/ }))
  const older = await screen.findByRole('dialog', { name: '较早通知' })
  expect(within(older).getByAltText('启创墨域 Chevoink 公告')).toBeTruthy()
  fireEvent(older, new Event('cancel', { cancelable: true }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '较早通知' })).toBeNull())
  expect(screen.getByRole('dialog', { name: '全部公告' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '全部已读' })).toBeNull()
  expect(request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
})

it('reveals the same inbox and restores its row when dismissing a notice mid-entry', async ({ onTestFinished }) => {
  onTestFinished(mockAnimationSupport())
  request.mockResolvedValue(inbox(null))
  mount(<AnnouncementBell placement="studio" />)
  const bell = screen.getByRole('button', { name: '通知中心' })
  fireEvent.click(bell)
  const list = screen.getByRole('dialog', { name: '通知中心' })
  const row = await within(list).findByRole('button', { name: /最新通知/ })
  fireEvent.click(row)
  expect(list.hasAttribute('inert')).toBe(true)
  const detail = screen.getByRole('dialog', { name: '最新通知' })
  fireEvent.click(within(detail).getByRole('button', { name: '关闭' }))
  expect(detail.dataset.phase).toBe('closing')
  expect(detail.hasAttribute('open')).toBe(true)
  expect(list.hasAttribute('data-covered')).toBe(false)
  await waitFor(() => expect(document.activeElement).toBe(row))
  fireEvent.click(within(list).getByRole('button', { name: '关闭通知中心' }))
  expect(list.dataset.phase).toBe('closing')
  await waitFor(() => expect(document.activeElement).toBe(bell))
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
