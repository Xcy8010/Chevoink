// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AdminContentPage from '../../src/features/admin/pages/AdminContentPage'
import type { ContentDraft } from '../../shared/contracts/site-content'
const mocks=vi.hoisted(()=>({request:vi.fn(),admin:{id:'fixture-admin',isSuperAdmin:true}}))
vi.mock('../../src/app/api-client',()=>({requestJson:mocks.request}))
vi.mock('../../src/features/admin/admin-shared',()=>({useAdminSession:()=>({admin:mocks.admin})}))
vi.mock('../../src/features/admin/AdminLayout',()=>({AdminCard:({children}:{children:React.ReactNode})=><section>{children}</section>,AdminPageHeader:({title}:{title:string})=><h1>{title}</h1>,StatusPill:({children}:{children:React.ReactNode})=><span>{children}</span>}))
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});render(<QueryClientProvider client={client}><AdminContentPage/></QueryClientProvider>)}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mocks.request.mockImplementation(async(_url:string,options?:RequestInit)=>{if(!options)return[];const draft=JSON.parse(String(options.body)) as ContentDraft;return{...draft,id:'notice',revision:1,status:'draft',deletedAt:null,withdrawn:false,published:null,history:[]}})})
afterEach(cleanup)
it('submits explicit immediate/unlimited draft choices without inventing browser timestamps',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:'新建公告'}))
 expect((screen.getByRole('combobox',{name:'开始方式'}) as HTMLSelectElement).value).toBe('immediate')
 expect((screen.getByRole('combobox',{name:'结束方式'}) as HTMLSelectElement).value).toBe('unlimited')
 fireEvent.change(screen.getByRole('textbox',{name:'公告编号'}),{target:{value:'immediate-notice'}});fireEvent.change(screen.getByRole('textbox',{name:'标题'}),{target:{value:'立即开始'}});fireEvent.change(screen.getByRole('textbox',{name:'公告正文'}),{target:{value:'不限结束公告'}})
 fireEvent.change(screen.getByRole('combobox',{name:'关闭后再次提醒'}),{target:{value:'version'}})
 fireEvent.click(screen.getByRole('button',{name:'保存草稿'}))
 await waitFor(()=>expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(true))
 const [,options]=mocks.request.mock.calls.find(([,options])=>options?.method==='POST')!
 expect(JSON.parse(options.body).payload).toMatchObject({startsAt:null,endsAt:null})
})
it('shows fixed UTC+8 labels for scheduled announcements and legal effective time',async()=>{
 mount();fireEvent.click(screen.getByRole('button',{name:'新建公告'}));fireEvent.change(screen.getByRole('combobox',{name:'开始方式'}),{target:{value:'scheduled'}});fireEvent.change(screen.getByRole('combobox',{name:'结束方式'}),{target:{value:'scheduled'}})
 const start=screen.getByLabelText('开始时间（包含此时刻）（北京时间 UTC+8）') as HTMLInputElement
 fireEvent.change(start,{target:{value:'2026-11-06T19:30'}})
 expect(start.value).toBe('2026-11-06T19:30')
 expect(screen.getByLabelText('结束时间（不含此时刻）（北京时间 UTC+8）')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'关闭内容编辑'}));fireEvent.click(screen.getByRole('button',{name:'新建服务条款'}))
 expect(screen.getByLabelText('生效时间（北京时间 UTC+8）')).toBeTruthy()
})