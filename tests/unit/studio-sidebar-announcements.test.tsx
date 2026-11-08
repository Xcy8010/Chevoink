// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'
import type { AnnouncementInbox, PublicSiteContent } from '../../shared/contracts/site-content'
const state=vi.hoisted(()=>({content:undefined as PublicSiteContent|undefined,inbox:undefined as AnnouncementInbox|undefined,markRead:vi.fn()}))
vi.mock('../../src/features/site-content/announcement-inbox-api',()=>({useAnnouncementInbox:()=>({query:{data:state.inbox},viewerId:'author',read:{mutate:state.markRead}})}))
vi.mock('@tanstack/react-query',()=>({useQuery:({queryKey}:{queryKey:string[]})=>({data:queryKey[0]==='site-content'?state.content:undefined,dataUpdatedAt:Date.now()}),useQueryClient:()=>({invalidateQueries:vi.fn()})}))
vi.mock('react-router-dom',()=>({useNavigate:()=>vi.fn()}))
vi.mock('../../src/components/ui/toast-context',()=>({useToast:()=>({success:vi.fn(),error:vi.fn()})}))
const noop=()=>undefined
const originalShow=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal'),originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close')
function Fixture(){return <div className="studio-workspace" data-testid="workspace"><StudioWorkspaceSidebar open onOpenChange={noop} perspective="work" perspectiveSwitchEnabled onPerspectiveChange={noop} currentNovelId="synthetic" currentNovelTitle="合成作品" novels={[]} currentTasks={[]} currentTasksNovelId="synthetic" activeTaskId={null} taskSwitchLocked={false} onSelectNovel={noop} onCreateNovel={noop} onCreateTask={noop} onSelectTask={noop} onRenameTask={noop} onCreateTaskInNovel={noop} onTaskDeleted={noop} onTaskForked={noop} onNovelDeleted={noop} onImportNovel={noop} autoFollow={false} onAutoFollowChange={noop} onOpenStudioSettings={noop}/><main data-testid="main">主工作区</main></div>}
beforeEach(()=>{
 sessionStorage.clear();localStorage.clear()
 state.inbox=undefined;state.markRead.mockClear()
 const now=Date.now();state.content={serverNow:new Date(now).toISOString(),nextBoundaryAt:null,settings:null,help:{},legal:{terms:null,privacy:null,registrationAvailable:false},announcements:[{id:'sidebar-notice',contentVersion:1,title:'侧栏合成公告',body:'合成公告正文',scope:'studio',startsAt:new Date(now-1000).toISOString(),endsAt:null,dismissal:{mode:'version'}}]}
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','')}})
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open')}})
})
afterEach(()=>{cleanup();vi.restoreAllMocks();if(originalShow)Object.defineProperty(HTMLDialogElement.prototype,'showModal',originalShow);else Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,'close',originalClose);else Reflect.deleteProperty(HTMLDialogElement.prototype,'close')})
it('places the single compact announcement directly above the actual sidebar account button',()=>{
 const view=render(<Fixture/>),notice=screen.getByLabelText('站点公告'),account=view.container.querySelector('[data-studio-region="sidebar-account"]')!
 const accountButton=screen.getByRole('button',{name:'创作者'})
 expect(notice.parentElement).toBe(account);expect(notice.nextElementSibling).toBe(accountButton)
 expect(account.closest('[data-workspace-sidebar]')).toBeTruthy()
 expect(screen.getByTestId('main').contains(notice)).toBe(false)
 expect(screen.getByTestId('workspace').lastElementChild).toBe(screen.getByTestId('main'))
})
it('removes the announcement and its wrapper entirely after closing without a ghost account row',()=>{
 const view=render(<Fixture/>),account=view.container.querySelector('[data-studio-region="sidebar-account"]')!,accountButton=screen.getByRole('button',{name:'创作者'}),main=screen.getByTestId('main')
 fireEvent.click(screen.getByRole('button',{name:'关闭公告：侧栏合成公告'}))
 expect(screen.queryByLabelText('站点公告')).toBeNull();expect(account.children).toHaveLength(1);expect(account.firstElementChild).toBe(accountButton)
 expect(screen.getByTestId('main')).toBe(main);expect(screen.getByTestId('workspace').lastElementChild).toBe(main)
 expect(localStorage.getItem('site-announcement-dismissals')).toContain('sidebar-notice:1')
})
it('prioritizes the latest unread notice and dismisses the batch without reading it or exposing the next card',()=>{
 const first=state.content!.announcements[0]
 const second={...first,id:'latest',title:'较新的未读公告'}
 state.content!.announcements.push(second)
 state.inbox={viewerId:'author',serverNow:first.startsAt,nextBoundaryAt:null,items:[second,first].map(item=>({...item,versionId:item.id+'-v1',publishedAt:item.startsAt,unread:true}))}
 const view=render(<Fixture/>)
 expect(screen.queryByText(first.title)).toBeNull()
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
it('opens the actual sidebar notice in a Studio-themed body portal and restores focus without persisting modal close',()=>{
 render(<Fixture/>);const trigger=screen.getByRole('button',{name:'打开公告：侧栏合成公告'})
 fireEvent.click(trigger);const dialog=screen.getByRole('dialog',{name:'侧栏合成公告'})
 expect(dialog.parentElement).toBe(document.body);expect(dialog.classList.contains('studio-workspace')).toBe(true)
 expect(screen.getByText('合成公告正文')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'关闭公告弹窗'}))
 expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(trigger)
 expect(localStorage.getItem('site-announcement-dismissals')).toBeNull()
})
