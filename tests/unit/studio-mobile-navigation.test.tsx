// @vitest-environment jsdom
import { useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StudioMobileHeader from '@/features/studio/components/StudioMobileHeader'
import StudioMobileNavigation from '@/features/studio/components/StudioMobileNavigation'
import WorkspaceNovelSwitcher from '@/features/studio/components/WorkspaceNovelSwitcher'
import InviteCreditsDialog from '@/features/account/InviteCreditsDialog'
import type { MobileView } from '@/features/studio/types'
import { mockNativeDialog } from '../helpers/test-native-dialog'

vi.mock('@/features/site-content/announcement-inbox-api', () => ({
  useAnnouncementInbox: () => ({
    query: { data: { items: [] }, refetch: vi.fn() },
    read: { reset: vi.fn() },
    viewerId: null,
  }),
}))

beforeEach(() => { vi.stubGlobal('innerWidth', 390) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.style.overflow = '' })

describe('mobile workspace header', () => {
  it('keeps two views and exits through the header without invoking chapter selection', () => {
    const select = vi.fn()
    const open = vi.fn()
    const exit = vi.fn()
    const view = render(<StudioMobileHeader view="assistant" navigationOpen={false} onOpenNavigation={open} onSelectView={select} onBack={vi.fn()} onExit={exit} />)
    const menu = screen.getByRole('button', { name: '打开创作区导航' })
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: '工作台' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('navigation', { name: '创作视图' }).querySelectorAll('button')).toHaveLength(2)
    fireEvent.click(menu)
    fireEvent.click(screen.getByRole('button', { name: '写作' }))
    fireEvent.click(screen.getByRole('button', { name: '退出创作区' }))
    expect(open).toHaveBeenCalledOnce()
    expect(select.mock.calls).toEqual([['editor']])
    expect(exit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '卷章' })).toBeNull()
    view.rerender(<StudioMobileHeader view="editor" navigationOpen onOpenNavigation={open} onSelectView={select} onBack={vi.fn()} onExit={exit} />)
    expect(screen.getByRole('button', { name: '写作' }).getAttribute('aria-pressed')).toBe('true')
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    expect(menu.className).toContain('h-11 w-11')
  })

  it.each<[MobileView, string]>([['chapters', '卷章'], ['cover', '封面工坊'], ['meta', '作品设置'], ['memory', '小说关系网'], ['context', '记忆'], ['skills', '作品技能']])('retains the %s auxiliary view and its return action', (view, title) => {
    const back = vi.fn()
    render(<StudioMobileHeader view={view} navigationOpen={false} onOpenNavigation={vi.fn()} onSelectView={vi.fn()} onBack={back} onExit={vi.fn()} />)
    expect(screen.getByRole('heading', { name: title })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: '创作视图' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回工作台' }))
    expect(back).toHaveBeenCalledOnce()
  })

  it('announces the writing return destination when chapters were opened from writing', () => {
    const back = vi.fn()
    render(<StudioMobileHeader view="chapters" navigationOpen={false} onOpenNavigation={vi.fn()} onSelectView={vi.fn()} onBack={back} backLabel="返回写作" onExit={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '返回工作台' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回写作' }))
    expect(back).toHaveBeenCalledOnce()
  })
})

function Harness({ onAction = () => {}, onCreate = () => {}, onSettings = () => {}, switcher, children }: {
  onAction?: () => void
  onCreate?: () => void
  onSettings?: () => void
  switcher?: ReactNode
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return <>
    <button onClick={() => setOpen(true)}>导航入口</button>
    <textarea aria-label="创作草稿" defaultValue="保留中的草稿" />
    <StudioMobileNavigation open={open} onClose={() => setOpen(false)} onCreateNovel={onCreate} onOpenSettings={onSettings}
      accountCard={<span>作者信息</span>} novelSwitcher={switcher ?? <button>选择作品</button>}>
      {search => <>
        <button onClick={() => { setOpen(false); onAction() }}>卷章操作</button>
        <button disabled>不可用操作</button>
        {search && <p>搜索词：{search}</p>}
        {children}
      </>}
    </StudioMobileNavigation>
  </>
}

function openNavigation() {
  const trigger = screen.getByRole('button', { name: '导航入口' })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('controlled mobile workspace navigation', () => {
  it('keeps account, borderless announcement bell and settings in the fixed footer and closes the inbox first', ({ onTestFinished }) => {
    const restore = mockNativeDialog()
    onTestFinished(() => { cleanup(); restore() })
    render(<Harness />)
    openNavigation()
    const bell = screen.getByRole('button', { name: '通知中心' })
    const navigation = screen.getByRole('dialog', { name: '创作区导航' })
    const settings = screen.getByRole('button', { name: '创作区设置' })
    const scroll = navigation.querySelector('[data-studio-mobile-navigation-scroll]')
    expect(bell.nextElementSibling).toBe(settings)
    expect(bell.classList.contains('site-announcement-bell--plain')).toBe(true)
    expect(bell.closest('footer')?.contains(screen.getByText('作者信息'))).toBe(true)
    expect(scroll?.contains(bell)).toBe(false)
    expect(screen.getByRole('searchbox').closest('header')).toBeTruthy()

    fireEvent.click(bell)
    const inbox = screen.getByRole('dialog', { name: '通知中心' })
    expect(navigation.contains(inbox)).toBe(true)
    fireEvent.keyDown(inbox, { key: 'Escape' })
    fireEvent(inbox, new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog', { name: '通知中心' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '创作区导航' })).toBe(navigation)
    expect(document.activeElement).toBe(bell)
  })

  it('keeps the visual close transition mounted while removing it from interaction, then cleans up', () => {
    vi.useFakeTimers()
    try {
      render(<Harness />)
      openNavigation()
      const backdrop = screen.getByRole('button', { name: '关闭导航遮罩' })
      expect(backdrop.querySelector('svg')).toBeNull()
      fireEvent.click(backdrop)
      expect(screen.queryByRole('dialog', { name: '创作区导航' })).toBeNull()
      const closing = document.querySelector('.studio-mobile-navigation')
      expect(closing?.getAttribute('data-state')).toBe('closed')
      expect(closing?.hasAttribute('inert')).toBe(true)
      act(() => vi.advanceTimersByTime(211))
      expect(document.querySelector('.studio-mobile-navigation')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('forwards search only after IME composition and delegates the two drawer actions once', () => {
    const create = vi.fn(), settings = vi.fn()
    render(<Harness onCreate={create} onSettings={settings} />)
    openNavigation()
    const search = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '创作区导航' }))
    fireEvent.compositionStart(search)
    fireEvent.change(search, { target: { value: 'duihua' } })
    expect(screen.queryByText('搜索词：duihua')).toBeNull()
    fireEvent.change(search, { target: { value: '对话' } })
    fireEvent.compositionEnd(search)
    expect(screen.getByText('搜索词：对话')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByText('搜索词：对话')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '新建作品' }))
    expect(create).toHaveBeenCalledOnce()
    openNavigation()
    fireEvent.click(screen.getByRole('button', { name: '创作区设置' }))
    expect(settings).toHaveBeenCalledOnce()
  })
  it('locks scroll, traps forward/backward focus, and restores focus/scroll on Escape', () => {
    document.body.style.overflow = 'clip'
    render(<Harness />)
    const draft = screen.getByRole('textbox', { name: '创作草稿' })
    const trigger = openNavigation()
    const first = screen.getByRole('searchbox')
    const last = screen.getByRole('button', { name: '创作区设置' })
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '创作区导航' }))
    expect(document.body.style.overflow).toBe('hidden')
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    draft.focus()
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.style.overflow).toBe('clip')
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('textbox', { name: '创作草稿' })).toBe(draft)
    expect((draft as HTMLTextAreaElement).value).toBe('保留中的草稿')
  })

  it('dismisses on backdrop, invokes a selected action once, and cleans up after unmount', () => {
    const action = vi.fn()
    const view = render(<Harness onAction={action} />)
    openNavigation()
    fireEvent.click(screen.getByRole('button', { name: '关闭导航遮罩' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    openNavigation()
    fireEvent.click(screen.getByRole('button', { name: '卷章操作' }))
    expect(action).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    openNavigation()
    view.unmount()
    expect(document.body.style.overflow).toBe('')
    const background = document.createElement('button')
    document.body.append(background); background.focus()
    expect(document.activeElement).toBe(background)
    background.remove()
  })

  it('keeps the existing novel picker portal usable and closes its menu before the drawer', () => {
    const create = vi.fn()
    render(<Harness switcher={<WorkspaceNovelSwitcher currentNovelId="one" currentNovelTitle="作品一" novels={[]} onSelectNovel={vi.fn()} onCreateNovel={create} fullWidth />} />)
    openNavigation()
    fireEvent.click(screen.getByRole('button', { name: '选择作品：作品一' }))
    const menu = screen.getByRole('region', { name: '我的作品' })
    const createButton = within(menu).getByRole('button', { name: /新建作品/ })
    createButton.focus()
    expect(document.activeElement).toBe(createButton)
    fireEvent.keyDown(createButton, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '我的作品' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '创作区导航' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '选择作品：作品一' }))
    fireEvent.click(within(screen.getByRole('region', { name: '我的作品' })).getByRole('button', { name: /新建作品/ }))
    expect(create).toHaveBeenCalledOnce()
  })

  it('allows the real account invitation dialog while keeping unrelated portals outside the focus boundary', () => {
    function Invitation() {
      const [open, setOpen] = useState(false)
      return <><button onClick={() => setOpen(true)}>邀请</button><InviteCreditsDialog open={open} referral={null} onCopy={vi.fn()} onClose={() => setOpen(false)} /></>
    }
    render(<Harness><Invitation /></Harness>)
    openNavigation()
    fireEvent.click(screen.getByRole('button', { name: '邀请' }))
    const close = screen.getByRole('button', { name: '关闭邀请弹窗' })
    close.focus()
    expect(document.activeElement).toBe(close)
    const unrelated = document.createElement('button')
    document.body.append(unrelated); unrelated.focus()
    expect(document.activeElement).toBe(close)
    fireEvent.click(close)
    expect(screen.getByRole('dialog', { name: '创作区导航' })).toBeTruthy()
    unrelated.remove()
  })

  it('closes when resizing to desktop and restores focus if the original trigger disappears', () => {
    const onClose = vi.fn()
    const trigger = document.createElement('button')
    document.body.append(trigger); trigger.focus()
    const fallback = document.createElement('button')
    fallback.setAttribute('data-studio-mobile-primary-control', '')
    document.body.append(fallback)
    const view = render(<StudioMobileNavigation open onClose={onClose} onCreateNovel={vi.fn()} onOpenSettings={vi.fn()} accountCard={null} novelSwitcher={<button>作品</button>}>{() => <button>操作</button>}</StudioMobileNavigation>)
    trigger.remove()
    vi.stubGlobal('innerWidth', 1024)
    fireEvent(window, new Event('resize'))
    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    expect(document.activeElement).toBe(fallback)
    fallback.remove()
  })
})
