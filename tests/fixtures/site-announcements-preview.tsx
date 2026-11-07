import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {ToastProvider} from '../../src/components/ui/Toast'
import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'
import {useShellStore} from '../../src/store/useShellStore'
import type {User} from '../../shared/contracts'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {SiteAnnouncements} from '../../src/features/site-content/public'
import type {PublicSiteContent} from '../../shared/contracts/site-content'
import '../../src/index.css'
const params=new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark',params.get('theme')==='dark')
const policy=params.get('policy')==='session'?{mode:'session' as const}:params.get('policy')==='ttl'?{mode:'ttl' as const,seconds:60}:{mode:'version' as const}
const title='创作中心更新公告',body=Array.from({length:55},(_,i)=>'公开合成公告正文 '+(i+1)+'：这是用于检查长公告滚动、居中弹窗和关闭策略的示例内容。').join('\n\n')
const user:User={id:'synthetic-announcement-user',nickname:'合成创作者',avatarUrl:null,email:null,phone:null,passwordConfigured:true,followerCount:0,followingCount:0,novelCount:0,postCount:0,unreadMessageCount:0,unreadNotificationCount:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
useShellStore.setState({sessionUser:user,authStatus:'authenticated',authTokens:null})
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof Request?input.url:input.href,location.origin)
 if(init?.method&&init.method!=='GET')throw Error('Preview blocks all mutations')
 if(url.pathname==='/api/agent/sessions')return Response.json({success:true,data:{items:[]}})
 if(url.pathname==='/api/credits/summary')return Response.json({success:true,data:{publicBetaEnabled:false,dailyAllowance:450,totalRemaining:450,resetsAt:null}})
 if(url.pathname!=='/api/site-content')throw Error('Preview blocks all other API requests')
 const now=Date.now(),data:PublicSiteContent={serverNow:new Date(now).toISOString(),nextBoundaryAt:null,settings:null,help:{},legal:{terms:null,privacy:null,registrationAvailable:false},announcements:[
  {id:'preview-notice',contentVersion:Number(params.get('version')??1),title,body,scope:'both',startsAt:new Date(now-60000).toISOString(),endsAt:null,dismissal:policy},
  {id:'preview-help',contentVersion:1,title:'使用帮助更新',body:'第二条公开合成公告。关闭当前公告不会连带关闭其它公告。',scope:'both',startsAt:new Date(now-60000).toISOString(),endsAt:null,dismissal:{mode:'session'}},
 ]}
 return Response.json({success:true,data})
}
const scope=params.get('scope')==='home'?'home':'studio',client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}})
export function Preview(){
 const [open,setOpen]=useState(true)
 if(scope==='home')return <main className="min-h-screen bg-[var(--app-bg)] px-4 py-5 text-[var(--text-primary)]"><div className="mx-auto max-w-5xl"><SiteAnnouncements scope="home"/><section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5"><h1 className="text-xl font-semibold">首页内容</h1><p className="mt-4 text-sm text-[var(--text-secondary)]">公开合成首页预览，不读取用户或生产数据。</p><div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({length:4},(_,i)=><article key={i} className="rounded-lg bg-[var(--surface-muted)] p-4"><div className="mb-3 h-36 rounded bg-[var(--border-subtle)]"/><p>示例作品 {i+1}</p></article>)}</div></section></div></main>
 const sidebar=<StudioWorkspaceSidebar open={open} onOpenChange={setOpen} perspective="work" perspectiveSwitchEnabled onPerspectiveChange={()=>{}} currentNovelId="synthetic-novel" currentNovelTitle="合成作品" novels={[]} currentTasks={[]} currentTasksNovelId="synthetic-novel" activeTaskId={null} taskSwitchLocked={false} onSelectNovel={()=>{}} onCreateNovel={()=>{}} onCreateTask={()=>{}} onSelectTask={()=>{}} onRenameTask={()=>{}} onCreateTaskInNovel={()=>{}} onTaskDeleted={()=>{}} onTaskForked={()=>{}} onNovelDeleted={()=>{}} onImportNovel={()=>{}} autoFollow={false} onAutoFollowChange={()=>{}} onOpenStudioSettings={()=>{}}/>
 if(params.get('layout')==='sidebar')return <div className="studio-workspace flex h-[100dvh] overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">{sidebar}<p className="min-w-0 flex-1 p-3 text-xs">实际侧栏组件 · 合成账户 · 独立窄屏组件检查</p></div>
 return <div data-preview-workspace className="studio-workspace flex h-[100dvh] min-h-0 overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]"><div className="hidden h-full lg:flex">{sidebar}</div><main data-preview-main className="flex min-h-0 min-w-0 flex-1 flex-col"><header className="flex min-h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4"><h1 className="font-semibold">创作工作台</h1><button className="min-h-10 px-3 text-sm" onClick={()=>setOpen(value=>!value)}>侧栏</button></header><section className="min-h-0 flex-1 overflow-y-auto p-4"><h2 className="text-lg font-semibold">当前任务</h2><p className="mt-3 text-sm text-[var(--text-secondary)]">实际 Studio 侧栏和用户信息组件，使用公开合成数据；主区仅作位置参照，不运行任务。窄屏沿用生产隐藏侧栏布局。</p></section><div data-preview-composer className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-3"><label className="block rounded-xl border border-[var(--border-strong)] bg-[var(--surface-default)] p-3 text-sm"><span className="sr-only">Agent 输入</span><textarea aria-label="Agent 输入" className="h-20 w-full resize-none bg-transparent outline-none" placeholder="输入创作要求"/><div className="flex justify-end"><button type="button" data-preview-send className="min-h-10 rounded-lg bg-[var(--surface-contrast)] px-4 text-[var(--text-contrast)]">发送</button></div></label></div></main></div>
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><ToastProvider><MemoryRouter><Preview/></MemoryRouter></ToastProvider></QueryClientProvider>)
