// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'
import StudioDesktopRail from '../../src/features/studio/components/StudioDesktopRail'
import { SiteAnnouncements } from '../../src/features/site-content/public'
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
      <SiteAnnouncements scope="studio" />
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
it('opens one centered announcement outside the rail and keeps the same dialog across perspectives', async () => {
  const view = render(<Fixture />)
  const content = screen.getByRole('region', { name: '创作内容' })
  const dialog = await screen.findByRole('dialog', { name: '侧栏合成公告' })
  expect(content.contains(dialog)).toBe(false)
  expect(content.previousElementSibling).toBeNull()
  const work = content.querySelector('[data-workspace-sidebar]')!
  expect(work.querySelector('button[aria-label="Agent 与定时"]')).toBeNull()
  expect(Array.from(work.querySelectorAll('button'), button => button.textContent)).not.toContain('更多')
  expect(screen.getByRole('button', { name: '个人菜单，创作者' }).closest('.studio-desktop-rail')).toBeTruthy()
  view.rerender(<Fixture perspective="ide" />)
  expect(screen.getByRole('dialog')).toBe(dialog)
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
it('keeps a long title readable and restores focus after the single close control', async () => {
  const title = '一份给创作者的公告'.repeat(10)
  state.content!.announcements[0].title = title
  render(<Fixture />)
  const dialog = await screen.findByRole('dialog', { name: title })
  expect(within(dialog).getByRole('heading', { name: title })).toBeTruthy()
  expect(within(dialog).queryByRole('button', { name: '关闭公告弹窗' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(screen.getByRole('region', { name: '创作内容' }))
})
it('renders no banner or spacer for an empty batch', () => {
  state.content!.announcements = []
  render(<Fixture perspective="ide" />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('region', { name: '创作内容' }).previousElementSibling).toBeNull()
})
it('opens public announcement history without including personal notifications', async () => {
  const first = state.content!.announcements[0]
  state.inbox = { viewerId: 'author', serverNow: first.startsAt, nextBoundaryAt: null, items: [
    { ...first, versionId: 'current', publishedAt: first.startsAt, unread: true },
    { ...first, id: 'history', versionId: 'history', title: '历史公告', body: '历史公告正文', publishedAt: first.startsAt, unread: false },
  ], personalItems: [{ id: 'private', title: '个人额度通知', body: '私人正文', publishedAt: first.startsAt, unread: true }] }
  render(<Fixture />)
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '查看全部公告' }))
  expect(await screen.findByText('历史公告')).toBeTruthy()
  expect(screen.queryByText('个人额度通知')).toBeNull()
})
