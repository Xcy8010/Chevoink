// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockNativeDialog } from '../helpers/test-native-dialog'
import type { AnnouncementInbox } from '../../shared/contracts/site-content'
import type { CreditAccountSummary } from '../../shared/contracts'
import StudioDesktopRail from '../../src/features/studio/components/StudioDesktopRail'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'

const credits = vi.hoisted(() => ({ data: undefined as CreditAccountSummary | undefined, isError: false, refetch: vi.fn() }))
vi.mock('../../src/features/studio/hooks/useStudioCredits', () => ({ useStudioCredits: () => credits }))
const inboxState = vi.hoisted(() => ({
  query: { data: undefined as AnnouncementInbox | undefined, refetch: vi.fn() },
  read: { reset: vi.fn(), mutate: vi.fn() }, viewerId: 'writer',
}))
vi.mock('../../src/features/site-content/announcement-inbox-api', () => ({ useAnnouncementInbox: () => inboxState }))
beforeEach(() => {
  inboxState.query.data = undefined
  inboxState.read.mutate.mockClear()
  credits.data = { publicBetaEnabled: true, planLabel: '公测版', totalRemaining: 780, dailyRemaining: 378,
    dailyAllowance: 450, bonusRemaining: 402, resetsAt: '2026-11-25T16:00:00Z' } as CreditAccountSummary
  credits.isError = false
})
afterEach(cleanup)
function CurrentPath() {
  return <span aria-label="当前页面">{useLocation().pathname}</span>
}

function fixture(ide?: ComponentProps<typeof StudioDesktopRail>['ide']) {
  const open = vi.fn()
  render(<MemoryRouter initialEntries={['/studio/example']}><StudioDesktopRail ide={ide} onOpenSettings={open} onInvite={vi.fn()} /><CurrentPath /></MemoryRouter>)
  return { open, usage: screen.getByRole('button', { name: '查看剩余额度' }), profile: screen.getByRole('button', { name: /^个人菜单/ }) }
}
it('shows the actual available balance on hover and focus, with a daily ring independent of bonuses', () => {
  const { open, usage, profile } = fixture()
  expect(usage.nextElementSibling).toBe(profile)
  expect(usage.querySelector('.studio-ring-value')?.getAttribute('stroke-dasharray')).toBe('84 100')
  fireEvent.mouseOver(usage)
  expect(screen.getByRole('tooltip').textContent).toBe('每日剩余 84%可用 780 Credits')
  fireEvent.mouseOut(usage)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.focus(usage)
  expect(usage.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
  fireEvent.click(usage)
  const card = within(screen.getByRole('region', { name: '额度概览' }))
  expect(card.getByRole('heading', { name: '额度来源 · 公测版' })).toBeTruthy()
  expect(card.getByText('剩余 84%')).toBeTruthy()
  expect(card.getAllByRole('term').map(item => item.textContent)).toEqual(['每日额度', '奖励额度'])
  expect(card.getAllByRole('definition').map(item => item.textContent)).toEqual(['剩余 84%', '402 credits'])
  expect(card.queryByText(/当前可用|780|重置/)).toBeNull()
  fireEvent.click(card.getByRole('button', { name: '管理用量' }))
  expect(open).toHaveBeenCalledWith('usage', usage)
  expect(screen.queryByRole('region', { name: '额度概览' })).toBeNull()
})
it('draws a continuous closed stroke at full allowance', () => {
  Object.assign(credits.data!, { dailyRemaining: 450 })
  const { usage } = fixture()
  const circle = usage.querySelector('.studio-ring-value')
  expect(circle).toBeTruthy()
  expect(circle!.hasAttribute('stroke-dasharray')).toBe(false)
  fireEvent.focus(usage)
  expect(screen.getByRole('tooltip').textContent).toContain('100%')
})
it('reserves the 100% label for a genuinely full ring', () => {
  Object.assign(credits.data!, { dailyRemaining: 999, dailyAllowance: 1000 })
  const { usage } = fixture()
  fireEvent.focus(usage)
  expect(screen.getByRole('tooltip').textContent).toContain('99%')
  expect(usage.querySelector('.studio-ring-value')?.hasAttribute('stroke-dasharray')).toBe(true)
})
it('keeps free accounts with bonus-only credits meaningful without a fabricated usage percentage', () => {
  Object.assign(credits.data!, { publicBetaEnabled: false, planLabel: '免费版', totalRemaining: 125, dailyRemaining: 0, dailyAllowance: 0, bonusRemaining: 125 })
  const { usage } = fixture()
  fireEvent.focus(usage)
  expect(screen.getByRole('tooltip').textContent).toBe('可用 125 Credits')
  expect(usage.querySelector('.studio-ring-value')).toBeNull()
  fireEvent.click(usage)
  expect(screen.getByRole('heading', { name: '额度来源 · 免费版' })).toBeTruthy()
  expect(screen.queryByText(/剩余.*%/)).toBeNull()
  expect(screen.getByText('未开通')).toBeTruthy()
  expect(screen.getByText('125 credits')).toBeTruthy()
  expect(screen.queryByText(/重置/)).toBeNull()
})
it('restores focus on Escape, switches cards and sends account actions to their corresponding settings', () => {
  const { open, profile, usage } = fixture()
  fireEvent.click(usage)
  fireEvent.click(profile)
  expect(screen.queryByRole('region', { name: '额度概览' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('button', { name: '个人资料' }), { key: 'Escape' })
  expect(document.activeElement).toBe(profile)
  expect(screen.queryByRole('region', { name: '个人菜单' })).toBeNull()
  for (const [name, section] of [['个人资料', 'profile'], ['创作区设置', 'general'], ['个性化', 'personalization']]) {
    fireEvent.click(profile)
    expect(screen.getByText('公测版')).toBeTruthy()
    expect(screen.getByRole('link', { name: '帮助文档' }).getAttribute('href')).toBe('/account/docs')
    fireEvent.click(screen.getByRole('button', { name }))
    expect(open).toHaveBeenLastCalledWith(section, profile)
  }
  fireEvent.click(profile)
  fireEvent.pointerDown(document.body)
  expect(profile.getAttribute('aria-expanded')).toBe('false')
})
it('offers a retry on unavailable credits without displaying a zero balance', () => {
  credits.data = undefined
  credits.isError = true
  const { usage } = fixture()
  fireEvent.click(usage)
  expect(screen.getByRole('status').textContent).toContain('额度暂时无法读取')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(credits.refetch).toHaveBeenCalledOnce()
  expect(screen.queryByText('0')).toBeNull()
})


it.each(['work', 'ide'])('opens an ordered two-item settings card in %s without prematurely leaving the current page', mode => {
  const { open } = fixture(mode === 'ide' ? { tab: 'work', open: true, onSelect: vi.fn(), onToggle: vi.fn() } : undefined)
  const gear = screen.getByRole('button', { name: '设置' })
  fireEvent.click(gear)
  const card = screen.getByRole('region', { name: '设置入口' })
  expect(Array.from(card.querySelectorAll('button, a'), item => item.textContent)).toEqual(['创作区设置', '账号设置'])
  expect(within(card).getByRole('link', { name: '账号设置' }).getAttribute('href')).toBe('/settings')
  fireEvent.keyDown(card, { key: 'Escape' })
  expect(document.activeElement).toBe(gear)
  fireEvent.click(gear)
  fireEvent.click(screen.getByRole('button', { name: '创作区设置' }))
  expect(open).toHaveBeenCalledWith('general', gear)
  expect(screen.getByLabelText('当前页面').textContent).toBe('/studio/example')
  fireEvent.click(gear)
  fireEvent.click(screen.getByRole('link', { name: '账号设置' }))
  expect(screen.getByLabelText('当前页面').textContent).toBe('/settings')
})
it('keeps discovery beside the four site links and moves the archived work entry into More', () => {
  const { open } = fixture()
  const nav = within(screen.getByRole('navigation', { name: '桌面工作区导航' }))
  expect(nav.getAllByRole('link').map(item => item.getAttribute('aria-label'))).toEqual(['首页', '发现', '创作区', '社区'])
  const more = nav.getByRole('button', { name: '更多入口' })
  fireEvent.click(more)
  expect(within(nav.getByRole('region', { name: '更多入口' })).queryByRole('link', { name: '发现' })).toBeNull()
  expect(nav.getByRole('link', { name: '个人书架' }).getAttribute('href')).toBe('/me')
  const divider = more.nextElementSibling?.nextElementSibling
  expect(divider?.className).toBe('studio-rail-divider')
  const operations = nav.getByRole('button', { name: 'Agent 与定时' })
  expect(divider?.nextElementSibling).toBe(operations)
  expect(operations.nextElementSibling).toBe(nav.getByRole('button', { name: '设置' }))
  fireEvent.click(nav.getByRole('button', { name: '归档内容' }))
  expect(open).toHaveBeenCalledWith('archives', more)
  fireEvent.click(operations)
  expect(open).toHaveBeenCalledWith('operations', operations)
  fireEvent.click(more)
  fireEvent.pointerDown(document.body)
  expect(more.getAttribute('aria-expanded')).toBe('false')
})
it.each(['studio', 'editor'])('places the shared tracking switch immediately after notifications in %s', mode => {
  fixture(mode === 'editor' ? { open: true, tab: 'work', onSelect: vi.fn(), onToggle: vi.fn() } : undefined)
  fireEvent.click(screen.getByRole('button', { name: '更多入口' }))
  const menu = within(screen.getByRole('region', { name: '更多入口' }))
  const toggle = menu.getByRole('switch', { name: '正文追踪' })
  expect(toggle.previousElementSibling).toBe(menu.getByRole('button', { name: '站内通知' }))
  const initial = useAgentStore.getState().autoFollow
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-checked')).toBe(String(!initial))
  expect(useAgentStore.getState().autoFollow).toBe(!initial)
  fireEvent.click(toggle)
  expect(useAgentStore.getState().autoFollow).toBe(initial)
})
it('keeps hidden IDE tools selectable while the tree is folded', () => {
  const select = vi.fn()
  fixture({ open: false, tab: 'work', onSelect: select, onToggle: vi.fn() })
  const nav = within(screen.getByRole('navigation', { name: 'Editor 工作区导航' }))
  expect(nav.getByRole('button', { name: '展开左侧面板' })).toBeTruthy()
  expect(nav.getByRole('link', { name: '发现' }).getAttribute('href')).toBe('/discover')
  expect(nav.getByRole('button', { name: 'Agent 与定时' })).toBeTruthy()
  expect(nav.getByRole('button', { name: '作品' })).toBeTruthy()
  expect(nav.queryByRole('button', { name: '技能' })).toBeNull()
  fireEvent.click(nav.getByRole('button', { name: '更多入口' }))
  expect(nav.getByRole('button', { name: '关系网' })).toBeTruthy()
  expect(nav.getByRole('button', { name: '记忆' })).toBeTruthy()
  fireEvent.click(nav.getByRole('button', { name: '技能' }))
  expect(select).toHaveBeenCalledWith('skills')
  expect(nav.queryByRole('region', { name: '更多入口' })).toBeNull()
})

it('exposes every rail icon label on hover and Tab, and restores keyboard focus after dismissal', async () => {
  const user = userEvent.setup()
  const { usage } = fixture()
  const rail = screen.getByRole('complementary', { name: '创作区活动栏' })
  const icons = Array.from(rail.querySelectorAll<HTMLElement>('.studio-rail-button'))
  for (const icon of icons) {
    await user.hover(icon)
    const hint = screen.getByRole('tooltip')
    expect(icon.getAttribute('aria-describedby')).toBe(hint.id)
    expect(hint.textContent).toContain(icon === usage ? '780 Credits' : icon.getAttribute('aria-label'))
    await user.unhover(icon)
    expect(screen.queryByRole('tooltip')).toBeNull()
  }
  for (const icon of icons) {
    await user.tab()
    expect(document.activeElement).toBe(icon)
    expect(icon.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    if (icon.getAttribute('aria-label') === '更多入口') {
      await user.keyboard('{Enter}')
      expect(screen.queryByRole('tooltip')).toBeNull()
      await user.tab()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '站内通知' }))
      await user.keyboard('{Escape}')
      expect(document.activeElement).toBe(icon)
      expect(screen.queryByRole('region', { name: '更多入口' })).toBeNull()
    } else {
      await user.keyboard('{Escape}')
      expect(document.activeElement).toBe(icon)
      expect(screen.queryByRole('tooltip')).toBeNull()
    }
  }
})

it.each(['work', 'ide'])('keeps the unread indication from public and personal inbox items on the %s More trigger', async mode => {
  const restoreDialog = mockNativeDialog()
  try {
    const publishedAt = '2026-11-25T00:00:00Z'
    const announcement = { id: 'announcement', versionId: 'v1', contentVersion: 1, title: '公告', body: '公告正文', unread: false, publishedAt }
    const personal = { id: 'personal', title: '个人奖励', body: '个人通知正文', unread: true, publishedAt }
    inboxState.query.data = { viewerId: 'writer', serverNow: publishedAt, nextBoundaryAt: null, items: [announcement], personalItems: [personal] }
    fixture(mode === 'ide' ? { open: true, tab: 'work', onSelect: vi.fn(), onToggle: vi.fn() } : undefined)
    const more = screen.getByRole('button', { name: '更多入口' })
    expect(more.querySelector('.studio-more-unread')).toBeTruthy()
    expect(more.getAttribute('aria-description')).toContain('未读')
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('button', { name: '站内通知' }))
    expect(screen.queryByRole('region', { name: '更多入口' })).toBeNull()
    const dialog = screen.getByRole('dialog', { name: '通知中心' })
    fireEvent.click(within(dialog).getByRole('button', { name: /个人奖励/ }))
    const detail = await screen.findByRole('dialog', { name: '个人奖励' })
    expect(within(detail).getByText('个人通知正文')).toBeTruthy()
    fireEvent.click(within(detail).getByRole('button', { name: '关闭', exact: true }))
    await waitFor(() => expect(inboxState.read.mutate).toHaveBeenCalledWith({ viewerId: 'writer', action: 'personal', notificationId: 'personal' }))
    personal.unread = false
    announcement.unread = true
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭通知中心' }))
    expect(document.activeElement).toBe(more)
    expect(more.querySelector('.studio-more-unread')).toBeTruthy()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('button', { name: '站内通知' }))
    fireEvent.click(screen.getByRole('button', { name: '全部已读' }))
    expect(inboxState.read.mutate).toHaveBeenCalledWith({ viewerId: 'writer', action: 'allNotifications' })
    announcement.unread = false
    fireEvent.click(screen.getByRole('button', { name: '关闭通知中心' }))
    expect(more.querySelector('.studio-more-unread')).toBeNull()
    expect(more.hasAttribute('aria-description')).toBe(false)
  } finally { cleanup(); restoreDialog() }
})
