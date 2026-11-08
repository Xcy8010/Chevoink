// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookOpen } from 'lucide-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import StudioMobileMenu from '@/features/studio/components/StudioMobileMenu'
import type { AgentSession, Novel } from '../../shared/contracts/index.js'
import { mockNativeDialog } from '../helpers/test-native-dialog'

const { searchSessions, renameSession, updateSession, deleteSession, readStatuses } = vi.hoisted(() => ({
  searchSessions: vi.fn(), renameSession: vi.fn(), updateSession: vi.fn(), deleteSession: vi.fn(), readStatuses: vi.fn(),
}))
vi.mock('@/features/studio/agent/agentApi', () => ({
  searchAgentSessions: searchSessions, renameAgentSession: renameSession,
  updateAgentSessionSettings: updateSession, deleteAgentSession: deleteSession, fetchSessionsRunStatus: readStatuses,
}))

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })
const defaults = { viewerId: 'owner', search: '', recentSessions: [], onSelectSession: () => {}, onSessionChange: () => {} }
const book = (id: string, title: string) => ({ id, title, displayTitle: null, chapterCount: 7, wordCount: 18000 }) as Novel
const one = book('one', '第一本作品'), two = book('two', '第二本作品')

describe('mobile book folders and categorized existing actions', () => {
  it('expands a different book without switching data until explicit selection', () => {
    const select = vi.fn(), close = vi.fn()
    render(<StudioMobileMenu {...defaults} currentNovel={one} novels={[one, two]} loading={false} busy={false} view="assistant" actions={[]} onClose={close} onSelectNovel={select} onCreateNovel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '展开作品：第二本作品' }))
    expect(select).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '进入作品' }))
    expect(select.mock.calls).toEqual([['two']])
    expect(close).toHaveBeenCalledOnce()
  })
  it('keeps current-book toggles local while the create action lives in the header', () => {
    const select = vi.fn()
    render(<StudioMobileMenu {...defaults} currentNovel={one} novels={[]} loading busy={false} view="assistant" actions={[]} onClose={vi.fn()} onSelectNovel={select} onCreateNovel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '收起作品：第一本作品' }))
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '展开作品：第一本作品' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: '新建作品' })).toBeNull()
  })
  it('expands categories and delegates an existing action exactly once, keeping disabled and future actions', () => {
    const action = vi.fn(), unavailable = vi.fn()
    render(<StudioMobileMenu {...defaults} currentNovel={one} novels={[one]} loading={false} busy={false} view="assistant" actions={[
      { key: 'meta', label: '作品设置', icon: BookOpen, action },
      { key: 'delete-novel', label: '删除作品', icon: BookOpen, action: unavailable, disabled: true, danger: true },
      { key: 'future-action', label: '扩展入口', icon: BookOpen, action: vi.fn() },
    ]} onClose={vi.fn()} onSelectNovel={vi.fn()} onCreateNovel={vi.fn()} />)
    fireEvent.click(screen.getByText('创作资料'))
    fireEvent.click(screen.getByRole('button', { name: '作品设置' }))
    expect(action).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('作品操作'))
    expect(screen.getByRole('button', { name: '删除作品' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '删除作品' }))
    expect(unavailable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('其他操作'))
    expect(screen.getByRole('button', { name: '扩展入口' })).toBeTruthy()
  })

  it('sorts the latest six conversations and opens a long-press menu without also navigating', ({ onTestFinished }) => {
    const restore = mockNativeDialog()
    onTestFinished(() => { cleanup(); restore() })
    vi.useFakeTimers()
    vi.stubGlobal('PointerEvent', MouseEvent)
    const items = Array.from({ length: 8 }, (_, index) => ({
      id: 's-' + index, userId: 'owner', novelId: one.id, title: '对话 ' + index,
      lastRunAt: new Date(Date.UTC(2026, 10, 1 + index)).toISOString(),
    })) as AgentSession[]
    const open = vi.fn(), change = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><StudioMobileMenu
      {...defaults} currentNovel={one} novels={[one]} loading={false} busy={false} view="assistant"
      actions={[]} recentSessions={items} onClose={vi.fn()} onSelectNovel={vi.fn()} onCreateNovel={vi.fn()}
      onSelectSession={open} onSessionChange={change}
    /></QueryClientProvider>)
    const recent = within(screen.getByRole('region', { name: '最近对话' })).getAllByRole('button')
    expect(recent.map(button => button.textContent)).toEqual(['对话 7', '对话 6', '对话 5', '对话 4', '对话 3', '对话 2'])
    fireEvent.pointerDown(recent[0], { button: 0, clientX: 50, clientY: 20 })
    fireEvent.pointerMove(recent[0], { clientX: 50, clientY: 50 })
    act(() => vi.advanceTimersByTime(520))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.pointerDown(recent[0], { button: 0, clientX: 50, clientY: 20 })
    act(() => vi.advanceTimersByTime(520))
    fireEvent.click(recent[0], { detail: 1 })
    expect(open).not.toHaveBeenCalled()
    const actions = within(screen.getByRole('dialog', { name: '对话操作' }))
    expect(actions.getByText('对话 7')).toBeTruthy()
    fireEvent.click(actions.getByRole('button', { name: '删除' }))
    expect(deleteSession).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(actions.getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(recent[0])
  })

  it('groups matches from titles, available functions, and persisted conversations and opens the correct object', async () => {
    const session = { id: 'session-1', userId: 'owner', novelId: 'one', title: '正文里匹配的会话', novelTitle: one.title } as AgentSession
    searchSessions.mockResolvedValue({ items: [session, { ...session, id: 'foreign', userId: 'other', title: '另一个账号的结果' }] })
    const open = vi.fn()
    const select = vi.fn()
    const action = vi.fn()
    const close = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><StudioMobileMenu
      {...defaults} currentNovel={one} novels={[one, two]} loading={false} busy={false} view="assistant"
      search="作品" actions={[{ key: 'meta', label: '作品设置', icon: BookOpen, action }]}
      onClose={close} onSelectNovel={select} onSelectSession={open} onCreateNovel={vi.fn()}
    /></QueryClientProvider>)
    const books = screen.getByRole('region', { name: '匹配作品' })
    const functions = screen.getByRole('region', { name: '匹配功能' })
    fireEvent.click(within(books).getByRole('button', { name: two.title }))
    fireEvent.click(within(functions).getByRole('button', { name: '作品设置' }))
    expect(select).toHaveBeenCalledWith(two.id)
    expect(action).toHaveBeenCalledOnce()
    await waitFor(() => expect(searchSessions).toHaveBeenCalledWith('作品', expect.any(AbortSignal)))
    fireEvent.click(await screen.findByRole('button', { name: /正文里匹配的会话/ }))
    expect(open).toHaveBeenCalledWith(session)
    expect(close).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('另一个账号的结果')).toBeNull()
  })
})
