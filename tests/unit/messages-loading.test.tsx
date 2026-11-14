// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DeviceContext } from '@/components/layout/device-context'
import { ToastContext } from '@/components/ui/toast-context'
import { createDirectConversation, listConversations, listMessages } from '@/features/community/api'
import MessagesPage from '@/pages/MessagesPage'
import type { Conversation } from '../../shared/contracts'

const date = '2026-11-13T01:00:00Z'
const me = { id: 'me', nickname: '我', avatarUrl: null }
const friend = { id: 'friend', nickname: '山舟', avatarUrl: null }
const conversation: Conversation = {
  id: 'conversation', type: 'direct', title: null, avatarUrl: null,
  members: [me, friend], counterpart: friend, isMutualFollow: true,
  lastMessageAt: date, lastMessagePreview: '第一条消息', unreadCount: 0,
}
const pagination = { page: 1, pageSize: 30, total: 0, hasMore: false }

vi.mock('@/features/community/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/community/api')>(),
  getMe: vi.fn(),
  listConversations: vi.fn(),
  listMessages: vi.fn(),
  listUserFollowers: vi.fn(),
  listInteractions: vi.fn(),
  getInteractionBadges: vi.fn(),
  markConversationRead: vi.fn(),
  createDirectConversation: vi.fn(),
}))
vi.mock('@/features/messages/load-detail-pages', () => ({ preloadMessageDetailPages: vi.fn() }))

const api = await import('@/features/community/api')
const toast = { toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.mocked(api.getMe).mockResolvedValue({ user: { ...me, email: null, phone: null, passwordConfigured: true,
    followerCount: 0, followingCount: 0, novelCount: 0, postCount: 0, unreadMessageCount: 0,
    unreadNotificationCount: 0, createdAt: date, updatedAt: date },
  shelf: [], drafts: [], activities: [], notifications: [] })
  vi.mocked(api.listUserFollowers).mockResolvedValue({
    items: [{ ...friend, followedByViewer: true, followsViewer: true, followedAt: date, bio: null }],
  })
  vi.mocked(api.listInteractions).mockResolvedValue({ items: [] })
  vi.mocked(api.getInteractionBadges).mockResolvedValue({
    followersUnseen: 0, interactionsUnseen: 0, followersSeenAt: null, interactionsSeenAt: null,
  })
  vi.mocked(api.listMessages).mockResolvedValue({ conversation, items: [], pagination })
  vi.mocked(api.markConversationRead).mockResolvedValue({ ok: true })
  vi.mocked(api.listConversations).mockResolvedValue({ items: [], pagination })
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function CurrentLocation() {
  return <output aria-label="当前地址">{useLocation().search}</output>
}

function renderMessages(path = '/messages') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DeviceContext.Provider value={{
        device: 'mobile', isMobile: true, isTablet: false, isDesktop: false,
        isTouch: true, mobileSize: 'medium', orientation: 'portrait',
      }}>
        <ToastContext.Provider value={toast}>
          <MemoryRouter initialEntries={[path]}>
            <MessagesPage />
            <CurrentLocation />
          </MemoryRouter>
        </ToastContext.Provider>
      </DeviceContext.Provider>
    </QueryClientProvider>,
  )
}

it('opens the pending chat immediately and starts message loading without waiting for the list refresh', async () => {
  let finish!: (value: Conversation) => void
  vi.mocked(createDirectConversation).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.mocked(listConversations)
    .mockResolvedValueOnce({ items: [], pagination })
    .mockImplementation(() => new Promise(() => {}))
  renderMessages()

  fireEvent.click(await screen.findByRole('button', { name: '给 山舟 发消息' }))
  expect(screen.getByRole('heading', { name: '山舟' })).toBeTruthy()
  expect(screen.getByLabelText('会话加载中')).toBeTruthy()
  expect(screen.getByLabelText('当前地址').textContent).toBe('')
  await act(async () => finish(conversation))
  expect(await screen.findByRole('link', { name: '山舟' })).toBeTruthy()
  expect(screen.getByLabelText('当前地址').textContent).toBe('?conversationId=conversation')
  expect(listMessages).toHaveBeenCalledWith(conversation.id, 20, 1)
})

it('keeps the list selected when the user goes back before chat creation resolves', async () => {
  let finish!: (value: Conversation) => void
  vi.mocked(createDirectConversation).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  renderMessages()
  fireEvent.click(await screen.findByRole('button', { name: '给 山舟 发消息' }))
  fireEvent.click(screen.getByRole('button', { name: '返回会话列表' }))
  await act(async () => finish(conversation))
  expect(screen.getByRole('button', { name: '给 山舟 发消息' })).toBeTruthy()
  expect(screen.getByLabelText('当前地址').textContent).toBe('')
  expect(listMessages).not.toHaveBeenCalled()
})

it('loads a direct chat link independently of the still-pending conversation list', async () => {
  vi.mocked(listConversations).mockImplementation(() => new Promise(() => {}))
  renderMessages('/messages?conversationId=conversation')
  expect(screen.getByRole('button', { name: '返回会话列表' })).toBeTruthy()
  expect(await screen.findByRole('link', { name: '山舟' })).toBeTruthy()
})

it('reuses the same pending direct conversation request after backing out and reopening', async () => {
  let finish!: (value: Conversation) => void
  vi.mocked(createDirectConversation).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  renderMessages()
  fireEvent.click(await screen.findByRole('button', { name: '给 山舟 发消息' }))
  fireEvent.click(screen.getByRole('button', { name: '返回会话列表' }))
  fireEvent.click(screen.getByRole('button', { name: '给 山舟 发消息' }))
  expect(createDirectConversation).toHaveBeenCalledTimes(1)
  await act(async () => finish(conversation))
  expect(await screen.findByRole('link', { name: '山舟' })).toBeTruthy()
})

it('hides the mobile thumb in both message views and still requests the next page on scroll', async () => {
  vi.mocked(listConversations)
    .mockResolvedValueOnce({ items: [{ ...conversation, isMutualFollow: false }], pagination: { ...pagination, hasMore: true } })
    .mockResolvedValue({ items: [], pagination: { ...pagination, page: 2 } })
  renderMessages()
  const strangerEntry = await screen.findByRole('button', { name: /^陌生消息/ })
  const mainList = strangerEntry.closest<HTMLElement>('.overflow-y-auto')!
  const stylesheet = readFileSync('src/index.css', 'utf8')
  expect(mainList.classList.contains('messages-list-scroll')).toBe(true)
  expect(stylesheet).toMatch(/@media \(max-width: 767px\), \(pointer: coarse\)\s*\{\s*\.messages-list-scroll\s*\{[^}]*scrollbar-width: none/u)
  expect(stylesheet).toMatch(/\.messages-list-scroll::-webkit-scrollbar\s*\{[^}]*display: none;[^}]*width: 0;/u)
  Object.defineProperties(mainList, {
    scrollHeight: { value: 280 },
    clientHeight: { value: 200 },
  })
  fireEvent.scroll(mainList)
  await waitFor(() => expect(listConversations).toHaveBeenCalledTimes(2))

  fireEvent.click(strangerEntry)
  const strangerList = screen.getByText('互相关注前，最多给对方发送 3 条消息。').closest<HTMLElement>('.overflow-y-auto')!
  expect(strangerList.classList.contains('messages-list-scroll')).toBe(true)
})
