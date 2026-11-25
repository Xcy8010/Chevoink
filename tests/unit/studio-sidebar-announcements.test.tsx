// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'
import StudioDesktopRail from '../../src/features/studio/components/StudioDesktopRail'
import StudioDesktopContent from '../../src/features/studio/components/StudioDesktopContent'
import StudioMobileAccountCard from '../../src/features/studio/components/StudioMobileAccountCard'
import { useShellStore } from '../../src/store/useShellStore'
import type { User } from '../../shared/contracts'
import type { AnnouncementInbox, PublicSiteContent } from '../../shared/contracts/site-content'
const state=vi.hoisted(()=>({content:undefined as PublicSiteContent|undefined,inbox:undefined as AnnouncementInbox|undefined,markRead:vi.fn()}))
vi.mock('../../src/features/site-content/announcement-inbox-api',()=>({useAnnouncementInbox:()=>({query:{data:state.inbox},viewerId:'author',read:{mutate:state.markRead}})}))
vi.mock('@tanstack/react-query',()=>({useQuery:({queryKey}:{queryKey:string[]})=>({data:queryKey[0]==='site-content'?state.content:undefined,dataUpdatedAt:Date.now()}),useQueryClient:()=>({invalidateQueries:vi.fn()})}))
import { MemoryRouter } from 'react-router-dom'
vi.mock('../../src/components/ui/toast-context',()=>({useToast:()=>({success:vi.fn(),error:vi.fn()})}))
const noop=()=>undefined
const originalShow=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal'),originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close')
function Fixture({ perspective = 'work' }: { perspective?: 'work' | 'ide' }) {
  return <MemoryRouter>
    <div className="studio-workspace" data-testid="workspace">
      <StudioDesktopRail onOpenSettings={noop} onInvite={noop} />
      <StudioDesktopContent>
        {perspective === 'work' && <StudioWorkspaceSidebar open onOpenChange={noop} perspective="work" perspectiveSwitchEnabled onPerspectiveChange={noop} currentNovelId="synthetic" currentNovelTitle="合成作品" novels={[]} currentTasks={[]} currentTasksNovelId="synthetic" activeTaskId={null} taskSwitchLocked={false} onSelectNovel={noop} onCreateNovel={noop} onCreateTask={noop} onSelectTask={noop} onRenameTask={noop} onCreateTaskInNovel={noop} onTaskDeleted={noop} onTaskForked={noop} onNovelDeleted={noop} onImportNovel={noop}/>}
        <main data-testid="main">主工作区</main>
      </StudioDesktopContent>
    </div>
  </MemoryRouter>
}
beforeEach(()=>{
 sessionStorage.clear();localStorage.clear()
 useShellStore.setState({sessionUser:null})
 state.inbox=undefined;state.markRead.mockClear()
 const now=Date.now();state.content={serverNow:new Date(now).toISOString(),nextBoundaryAt:null,settings:null,help:{},legal:{terms:null,privacy:null,registrationAvailable:false},announcements:[{id:'sidebar-notice',contentVersion:1,title:'侧栏合成公告',body:'合成公告正文',scope:'studio',startsAt:new Date(now-1000).toISOString(),endsAt:null,dismissal:{mode:'version'}}]}
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','')}})
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open')}})
})
afterEach(()=>{cleanup();vi.restoreAllMocks();if(originalShow)Object.defineProperty(HTMLDialogElement.prototype,'showModal',originalShow);else Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,'close',originalClose);else Reflect.deleteProperty(HTMLDialogElement.prototype,'close')})
it('keeps one announcement above Work and IDE content, outside the rail and the collapsible list', () => {
  const view = render(<Fixture />)
  const banner = screen.getByLabelText('站点公告')
  const content = screen.getByRole('region', { name: '创作内容' })
  expect(banner.dataset.studioRegion).toBe('announcement-banner')
  expect(banner.nextElementSibling).toBe(content)
  expect(content.contains(screen.getByTestId('main'))).toBe(true)
  const work = content.querySelector('[data-workspace-sidebar]')!
  expect(work.contains(banner)).toBe(false)
  expect(work.querySelector('button[aria-label="Agent 与定时"]')).toBeNull()
  expect(Array.from(work.querySelectorAll('button'), button => button.textContent)).not.toContain('更多')
  expect(screen.getByRole('button', { name: '个人菜单，创作者' }).closest('.studio-desktop-rail')).toBeTruthy()
  view.rerender(<Fixture perspective="ide" />)
  expect(screen.getByLabelText('站点公告')).toBe(banner)
  expect(content.querySelector('[data-workspace-sidebar]')).toBeNull()
})
it('places the email immediately below the nickname in both studio account controls', () => {
  useShellStore.setState({ sessionUser: {
    id: 'owner',
    nickname: '合成作者',
    email: 'writer@example.com',
    emailAuthEnabled: true,
    emailVerified: true,
  } as User })
  const view = render(<><Fixture /><StudioMobileAccountCard /></>)
  fireEvent.click(screen.getByRole('button', {name:'个人菜单，合成作者'}))
  const desktop = screen.getByRole('region', {name:'个人菜单'})
  const mobile = view.container.querySelector('details > summary')!
  for (const control of [desktop, mobile]) {
    const email = control.querySelector('[title="writer@example.com"]')!
    expect(email.textContent).toBe('writer@example.com')
    expect(email.previousElementSibling?.textContent).toBe('合成作者')
  }
})
it('keeps the full accessible title and gives the banner a separate close control', () => {
  const title = '这是一条用于验证桌面横幅保留完整标题的合成公告'.repeat(4)
  state.content!.announcements[0].title = title
  render(<Fixture />)
  const open = screen.getByRole('button', { name: '打开公告：' + title })
  const close = screen.getByRole('button', { name: '关闭公告：' + title })
  expect(open.nextElementSibling).toBe(close)
  expect(open.title).toBe(title)
  expect(open.querySelector('.lucide-chevron-right')).toBeTruthy()
  expect(close.querySelector('.lucide-x')).toBeTruthy()
  expect(screen.getByText(title).classList.contains('truncate')).toBe(true)
})
it('removes the whole banner on dismissal and keeps keyboard navigation in the same workspace', () => {
  render(<Fixture />)
  const content = screen.getByRole('region', { name: '创作内容' })
  const main = screen.getByTestId('main')
  const close = screen.getByRole('button', {name:'关闭公告：侧栏合成公告'})
  close.focus()
  fireEvent.click(close)
  expect(screen.queryByLabelText('站点公告')).toBeNull()
  expect(content.previousElementSibling).toBeNull()
  expect(document.activeElement).toBe(content)
  expect(screen.getByTestId('main')).toBe(main)
  expect(localStorage.getItem('site-announcement-dismissals')).toContain('sidebar-notice:1')
})
it('renders no banner or spacer for an empty batch', () => {
  state.content!.announcements = []
  render(<Fixture perspective="ide" />)
  expect(screen.queryByLabelText('站点公告')).toBeNull()
  expect(screen.getByRole('region', { name: '创作内容' }).previousElementSibling).toBeNull()
})
it('prioritizes the latest unread notice and dismisses the batch without reading it or exposing the next card',()=>{
 const first=state.content!.announcements[0]
 const second={...first,id:'latest',title:'较新的未读公告'}
 state.content!.announcements.push(second)
 state.inbox={viewerId:'author',serverNow:first.startsAt,nextBoundaryAt:null,items:[second,first].map(item=>({...item,versionId:item.id+'-v1',publishedAt:item.startsAt,unread:true}))}
 const view=render(<Fixture/>)
 expect(screen.queryByText(first.title)).toBeNull()
 expect(screen.getByText('NEW').className).toBe('site-announcement-strip-new')
 fireEvent.click(screen.getByRole('button',{name:'关闭公告：'+second.title}))
 expect(screen.queryByLabelText('站点公告')).toBeNull()
 expect(state.markRead).not.toHaveBeenCalled()

 view.unmount()
 const fresh={...first,id:'fresh',title:'随后发布的公告'}
 state.content!.announcements.push(fresh)
 render(<Fixture/>)
 expect(screen.getByRole('button',{name:'打开公告：'+fresh.title})).toBeTruthy()
 expect(screen.queryByText(first.title)).toBeNull()
})
it('opens public history from the announcement detail and restores focus to the sidebar', () => {
 const first = state.content!.announcements[0]
 state.inbox = { viewerId: 'author', serverNow: first.startsAt, nextBoundaryAt: null, items: [
   { ...first, versionId: 'current', publishedAt: first.startsAt, unread: false },
   { ...first, id: 'history', versionId: 'history', title: '历史公告', body: '历史公告正文', publishedAt: first.startsAt, unread: false },
 ], personalItems: [{ id: 'private', title: '个人额度通知', body: '私人正文', publishedAt: first.startsAt, unread: true }] }
 render(<Fixture />)
 const trigger = screen.getByRole('button', { name: '打开公告：侧栏合成公告' })
 fireEvent.click(trigger)
 fireEvent.click(screen.getByRole('button', { name: '查看全部公告' }))
 expect(screen.getByRole('dialog', { name: '全部公告' })).toBeTruthy()
 expect(screen.queryByText('个人额度通知')).toBeNull()
 fireEvent.click(screen.getByRole('button', { name: /历史公告/ }))
 expect(screen.getByText('历史公告正文')).toBeTruthy()
 fireEvent.click(screen.getByRole('button', { name: '关闭全部公告' }))
 expect(document.activeElement).toBe(trigger)
})

it('opens the actual sidebar notice in a Studio-themed body portal and restores focus without persisting modal close',()=>{
 render(<Fixture/>);const trigger=screen.getByRole('button',{name:'打开公告：侧栏合成公告'})
 fireEvent.click(trigger);const dialog=screen.getByRole('dialog',{name:'侧栏合成公告'})
 expect(dialog.parentElement).toBe(document.body);expect(dialog.classList.contains('studio-workspace')).toBe(true)
 expect(screen.getByText('合成公告正文')).toBeTruthy()
 expect(screen.getByRole('button',{name:'查看全部公告'})).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'关闭公告弹窗'}))
 expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(trigger)
 expect(localStorage.getItem('site-announcement-dismissals')).toBeNull()
})
