// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import AdminFeedbackPage from '../../src/features/admin/pages/AdminFeedbackPage'
import AdminAgentEvalsPage from '../../src/features/admin/pages/AdminAgentEvalsPage'
const mocks=vi.hoisted(()=>({list:vi.fn(),detail:vi.fn(),status:vi.fn(),suites:vi.fn(),create:vi.fn(),sample:vi.fn()}))
vi.mock('../../src/features/admin/api',()=>({
 listAdminFeedbacks:mocks.list,getAdminFeedbackDetail:mocks.detail,setAdminFeedbackStatus:mocks.status,
 listAdminAgentEvalSuites:mocks.suites,createAdminAgentEvalSuite:mocks.create,addAdminAgentEvalSample:mocks.sample,
 getAdminAgentEvalResults:vi.fn(),getAdminAgent3OperationsMetrics:vi.fn(),getNextAdminBlindReview:vi.fn(),
 submitAdminBlindReview:vi.fn(),updateAdminAgentEvalSuiteStatus:vi.fn(),adminLogout:vi.fn(),
}))
vi.mock('../../src/features/admin/admin-shared',()=>({formatDateTime:(value:string|null)=>value??'—',useAdminSession:()=>({admin:{id:'synthetic-admin',isSuperAdmin:true}})}))
vi.mock('../../src/components/ui/toast-context',()=>({useToast:()=>({success:vi.fn(),error:vi.fn()})}))
const feedback={id:'synthetic-feedback',kind:'bug',status:'pending',excerpt:'合成反馈摘要',imageCount:0,contact:'合成联系方式',source:'studio-mobile',createdAt:'2026-11-04T00:00:00Z',handledAt:null,user:{id:'synthetic-user',nickname:'合成用户',avatarUrl:null},content:'合成反馈正文',imageUrls:[],pageUrl:'/studio',clientInfo:{platform:'Synthetic OS',viewport:{width:390,height:844},online:true,languages:['zh-CN','en'],extra:null},handledByNickname:null,updatedAt:'2026-11-04T00:00:00Z'}
function mount(element:React.ReactNode){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}})}><MemoryRouter initialEntries={['/admin']}>{element}</MemoryRouter></QueryClientProvider>)}
beforeEach(()=>{
 vi.clearAllMocks();mocks.list.mockResolvedValue({items:[feedback],pagination:{page:1,pageSize:10,total:1,hasMore:false},counts:{pending:1,accepted:0,ignored:0}})
 mocks.detail.mockResolvedValue({feedback});mocks.status.mockResolvedValue({ok:true})
 mocks.suites.mockResolvedValue({suites:[{id:'synthetic-suite',name:'合成套件',status:'draft',datasetVersion:'synthetic-v1',rubricVersion:'synthetic-rubric',sampleCount:0,reviewCount:0}]})
})
afterEach(cleanup)
it('keeps human feedback primary and preserves structured client details behind a collapsed disclosure',async()=>{
 mount(<AdminFeedbackPage/>);fireEvent.click(await screen.findByRole('button',{name:'详情'}))
 const dialog=await screen.findByRole('dialog',{name:'反馈详情'});await within(dialog).findByText('合成反馈正文')
 const summary=within(dialog).getByText('工程详情（客户端与提交页面）')
 const details=summary.closest('details')!
 expect(details.open).toBe(false)
 expect(within(dialog).getByText('合成联系方式')).toBeTruthy()
 fireEvent.click(summary);expect(details.open).toBe(true)
 expect(within(details).getByText('平台')).toBeTruthy();expect(within(details).getByText('Synthetic OS')).toBeTruthy()
 expect(within(details).getByText('宽度')).toBeTruthy();expect(within(details).getByText('390')).toBeTruthy()
 expect(within(details).getByText('是')).toBeTruthy();expect(within(details).getByText('zh-CN')).toBeTruthy()
 expect(details.textContent).not.toContain('{"platform"')
 expect(within(dialog).getByRole('button',{name:'已采纳'}).closest('footer')).toBeTruthy()
 fireEvent.click(within(dialog).getByRole('button',{name:'已采纳'}))
 await waitFor(()=>expect(mocks.status).toHaveBeenCalledWith('synthetic-feedback','accepted'))
})
it('shows only the suite list on the suites tab and preserves both creation drafts across tab changes',async()=>{
 mount(<AdminAgentEvalsPage/>);await screen.findByText('合成套件')
 expect(screen.queryByRole('combobox',{name:'评测套件'})).toBeNull()
 expect(screen.queryByRole('button',{name:'开始盲评'})).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'创建与样本'}))
 expect(screen.getByRole('combobox',{name:'评测套件'})).toBeTruthy()
 expect(screen.queryByRole('heading',{name:'套件列表'})).toBeNull()
 fireEvent.change(screen.getByPlaceholderText('套件名称'),{target:{value:'未保存套件草稿'}})
 fireEvent.change(screen.getByPlaceholderText('样本编号'),{target:{value:'unsaved-sample'}})
 fireEvent.click(screen.getByRole('button',{name:'评测套件'}))
 expect(screen.queryByRole('combobox',{name:'评测套件'})).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'创建与样本'}))
 expect((screen.getByPlaceholderText('套件名称') as HTMLInputElement).value).toBe('未保存套件草稿')
 expect((screen.getByPlaceholderText('样本编号') as HTMLInputElement).value).toBe('unsaved-sample')
 expect(mocks.create).not.toHaveBeenCalled();expect(mocks.sample).not.toHaveBeenCalled()
})
