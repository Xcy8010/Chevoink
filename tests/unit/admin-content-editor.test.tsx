// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultSiteSettings } from '../../src/features/site-content/defaults'
import AdminContentPage from '../../src/features/admin/pages/AdminContentPage'
import type { ContentRow } from '../../shared/contracts/site-content'
const mocks=vi.hoisted(()=>({request:vi.fn(),admin:{id:'fixture-admin',isSuperAdmin:true}}))
vi.mock('../../src/app/api-client',()=>({requestJson:mocks.request}))
vi.mock('../../src/features/admin/admin-shared',()=>({useAdminSession:()=>({admin:mocks.admin})}))
vi.mock('../../src/features/admin/AdminLayout',()=>({
 AdminCard:({children}:{children:React.ReactNode})=><section>{children}</section>,
 AdminPageHeader:({title}:{title:string})=><h1>{title}</h1>,
 StatusPill:({children}:{children:React.ReactNode})=><span>{children}</span>,
}))
function notice(id='notice-a',revision=7):ContentRow{
 return {kind:'announcement',key:id,id,revision,status:'active',withdrawn:false,deletedAt:null,
 payload:{title:'公告 '+id,body:'现有正文',scope:'both',startsAt:'2026-11-06T01:30:00.000Z',endsAt:null,dismissal:{mode:'version'}},
 published:{id:'version-'+id,contentVersion:2,hash:'a'.repeat(64),payload:{title:'旧版',body:'旧正文',scope:'both',startsAt:null,endsAt:null,dismissal:{mode:'version'}},publishedAt:'2026-11-06T01:00:00.000Z'},history:[]}
}
function mount(settingsOnly=false){
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}})
 render(<QueryClientProvider client={client}><AdminContentPage settingsOnly={settingsOnly}/></QueryClientProvider>)
}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mocks.request.mockResolvedValue([notice()])})
afterEach(cleanup)
it('starts with a searchable content list, and opens the chosen row in a named editor',async()=>{
 mount();await screen.findByRole('button',{name:'编辑公告：公告 notice-a'})
 expect(screen.queryByRole('dialog')).toBeNull()
 fireEvent.change(screen.getByRole('textbox',{name:'搜索内容'}),{target:{value:'missing'}})
 expect(screen.queryByRole('button',{name:'编辑公告：公告 notice-a'})).toBeNull()
 fireEvent.change(screen.getByRole('textbox',{name:'搜索内容'}),{target:{value:'notice-a'}})
 fireEvent.click(screen.getByRole('button',{name:'编辑公告：公告 notice-a'}))
 const editor=screen.getByRole('dialog',{name:'编辑公告'})
 expect((within(editor).getByRole('textbox',{name:'标题'}) as HTMLInputElement).value).toBe('公告 notice-a')
 expect((within(editor).getByLabelText('开始时间（包含此时刻）（北京时间 UTC+8）') as HTMLInputElement).value).toBe('2026-11-06T09:30')
 const footer=within(editor).getByRole('button',{name:'保存草稿'}).closest('footer')
 expect(footer).toBeTruthy()
 fireEvent.click(within(editor).getByRole('button',{name:'取消'}))
 expect(screen.queryByRole('dialog')).toBeNull()
})
it('restores a same-revision local draft after closing and rejects an older revision',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:'编辑公告：公告 notice-a'}))
 fireEvent.change(screen.getByRole('textbox',{name:'标题'}),{target:{value:'保留的草稿'}})
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 fireEvent.click(screen.getByRole('button',{name:'编辑公告：公告 notice-a'}))
 expect((screen.getByRole('textbox',{name:'标题'}) as HTMLInputElement).value).toBe('保留的草稿')
 expect(screen.getByRole('button',{name:'发布已保存草稿'}).hasAttribute('disabled')).toBe(true)
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 const saved=JSON.parse(localStorage.getItem('site-content-draft:fixture-admin:notice-a')!)
 localStorage.setItem('site-content-draft:fixture-admin:notice-a',JSON.stringify({...saved,revision:6}))
 fireEvent.click(screen.getByRole('button',{name:'编辑公告：公告 notice-a'}))
 expect((screen.getByRole('textbox',{name:'标题'}) as HTMLInputElement).value).toBe('公告 notice-a')
 expect(screen.getByRole('status').textContent).toContain('旧版本草稿')
})
it('keeps edited content on a revision conflict and sends the selected server revision',async()=>{
 mocks.request.mockImplementation(async(_url:string,options?:RequestInit)=>{if(options?.method==='POST')throw Error('内容已更新，请重新载入。');return [notice()]})
 mount();fireEvent.click(await screen.findByRole('button',{name:'编辑公告：公告 notice-a'}))
 fireEvent.change(screen.getByRole('textbox',{name:'标题'}),{target:{value:'未保存标题'}})
 fireEvent.click(screen.getByRole('button',{name:'保存草稿'}))
 await screen.findByText('内容已更新，请重新载入。')
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==='POST')!
 expect(call[0]).toBe('/api/admin/site-content/notice-a')
 expect(JSON.parse(call[1].body)).toMatchObject({expectedRevision:7,action:'save',draft:{payload:{title:'未保存标题'}}})
 expect((screen.getByRole('textbox',{name:'标题'}) as HTMLInputElement).value).toBe('未保存标题')
 expect(screen.getByRole('button',{name:'发布已保存草稿'}).hasAttribute('disabled')).toBe(true)
})
it('confirms announcement replacement and preserves both expected revisions',async()=>{
 const current=notice(),replaced=notice('notice-b',12)
 mocks.request.mockImplementation(async(_url:string,options?:RequestInit)=>options?.method==='POST'?{...current,revision:8}:[current,replaced])
 mount();fireEvent.click(await screen.findByRole('button',{name:'编辑公告：公告 notice-a'}))
 fireEvent.change(screen.getByRole('combobox',{name:'发布时替换已有公告（可选）'}),{target:{value:'notice-b'}})
 fireEvent.click(screen.getByRole('button',{name:'发布已保存草稿'}))
 expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(0)
 expect(screen.getAllByRole('dialog')).toHaveLength(1)
 fireEvent.click(within(screen.getByRole('dialog',{name:'确认发布公告？'})).getByRole('button',{name:'确认'}))
 await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/admin/site-content/notice-a',expect.objectContaining({body:JSON.stringify({expectedRevision:7,action:'publish',replace:{id:'notice-b',expectedRevision:12}})})))
})
it('keeps deleted records read-only and requires confirmation before restoring',async()=>{
 const deleted={...notice(),deletedAt:'2026-11-06T02:00:00.000Z'}
 mocks.request.mockImplementation(async(_url:string,options?:RequestInit)=>options?.method==='POST'?{...deleted,deletedAt:null,revision:8}:[deleted])
 mount();fireEvent.click(await screen.findByRole('button',{name:'编辑公告：公告 notice-a'}))
 expect(screen.getByRole('button',{name:'保存草稿'}).hasAttribute('disabled')).toBe(true)
 expect(screen.getByRole('textbox',{name:'标题'}).closest('fieldset[disabled]')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'恢复'}))
 fireEvent.click(within(screen.getByRole('dialog',{name:'确认恢复公告？'})).getByRole('button',{name:'确认'}))
 await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/admin/site-content/notice-a',expect.objectContaining({body:JSON.stringify({expectedRevision:7,action:'restore'})})))
})

it('prepares the first settings draft from the same real defaults as the public shell',async()=>{
 mocks.request.mockImplementation(async(url:string)=>url==='/api/site-content'?{settings:null}:[])
 mount(true)
 const edit=await screen.findByRole('button',{name:'编辑站点资料'})
 await waitFor(()=>expect(edit.hasAttribute('disabled')).toBe(false));fireEvent.click(edit)
 expect((screen.getByRole('textbox',{name:'站点名称'}) as HTMLInputElement).value).toBe(defaultSiteSettings.name)
 expect((screen.getByRole('textbox',{name:'Logo 链接'}) as HTMLInputElement).value).toBe(defaultSiteSettings.logoUrl)
 expect(screen.getAllByRole('textbox',{name:'导航名称'}).map(input=>(input as HTMLInputElement).value)).toEqual(defaultSiteSettings.navigation.map(item=>item.label))
 expect((screen.getByRole('textbox',{name:'关于'}) as HTMLTextAreaElement).value).toBe('')
 expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false)
})
it('uses currently public settings when no management record exists and saves only a draft',async()=>{
 const settings={...defaultSiteSettings,name:'现有公开名称',about:'现有公开介绍'}
 mocks.request.mockImplementation(async(url:string,options?:RequestInit)=>options?.method==='POST'?{kind:'settings',key:'main',payload:settings,id:'settings',revision:1,status:'draft',deletedAt:null,history:[]}:url==='/api/site-content'?{settings}:[])
 mount(true);const edit=await screen.findByRole('button',{name:'编辑站点资料'})
 await waitFor(()=>expect(edit.hasAttribute('disabled')).toBe(false));fireEvent.click(edit)
 expect((screen.getByRole('textbox',{name:'站点名称'}) as HTMLInputElement).value).toBe(settings.name)
 expect((screen.getByRole('textbox',{name:'关于'}) as HTMLTextAreaElement).value).toBe(settings.about)
 fireEvent.click(screen.getByRole('button',{name:'保存草稿'}))
 await waitFor(()=>expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(true))
 const post=mocks.request.mock.calls.find(([,options])=>options?.method==='POST')!
 expect(post[0]).toBe('/api/admin/site-content')
 expect(JSON.parse(post[1].body)).toEqual({kind:'settings',key:'main',payload:settings})
 expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1)
})
it('opens the existing settings draft rather than replacing it with public or blank values',async()=>{
 const draft={...defaultSiteSettings,name:'管理草稿名称',footer:'待发布页脚'}
 const row={kind:'settings',key:'main',id:'settings',payload:draft,revision:4,status:'draft',published:null,history:[],deletedAt:null,withdrawn:false}
 mocks.request.mockImplementation(async(url:string)=>url==='/api/site-content'?{settings:{...defaultSiteSettings,name:'公开名称'}}:[row])
 mount(true);const edit=await screen.findByRole('button',{name:'编辑站点资料'})
 await waitFor(()=>expect(edit.hasAttribute('disabled')).toBe(false));fireEvent.click(edit)
 expect((screen.getByRole('textbox',{name:'站点名称'}) as HTMLInputElement).value).toBe(draft.name)
 expect((screen.getByRole('textbox',{name:'页脚'}) as HTMLTextAreaElement).value).toBe(draft.footer)
 expect(screen.getByRole('dialog').textContent).toContain('修订 4')
})
