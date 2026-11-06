// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AdminAppReleasesPage from '../../src/features/admin/pages/AdminAppReleasesPage'
import AppVersionPage from '../../src/features/app-releases/AppVersionPage'
import type { AdminAppRelease, AdminAppReleaseIndex, AppReleaseExecute, AppReleasePreview, AppReleaseReceipt } from '../../shared/contracts/app-release'
const mocks=vi.hoisted(()=>({request:vi.fn(),success:vi.fn(),error:vi.fn(),info:vi.fn(),admin:{id:'super-admin',isSuperAdmin:true}}))
vi.mock('../../src/components/ui/toast-context',()=>({useToast:()=>({success:mocks.success,error:mocks.error,info:mocks.info})}))
vi.mock('../../src/app/api-client',()=>({requestJson:mocks.request}))
vi.mock('../../src/features/admin/admin-shared',()=>({useAdminSession:()=>({admin:mocks.admin})}))
vi.mock('../../src/features/admin/AdminLayout',()=>({AdminCard:({children}:{children:React.ReactNode})=><section>{children}</section>,AdminPageHeader:({title}:{title:string})=><h1>{title}</h1>}))
const id='candidate-version',operationId='00000000-0000-4000-8000-000000000001'
const release:AdminAppRelease={id,label:'候选版本',sourceSha:'a'.repeat(40),artifactSha256:'b'.repeat(64),publicNotes:{features:['新增可见功能'],fixes:['修复可见问题'],changes:[]},validationState:'verified',verifiedAt:'2026-11-06T00:00:00Z',compatibility:{api:1,schema:1,task:1,legalConsentUi:true},capabilities:['siteContent'],ciRunId:'123',createdAt:'2026-11-06T00:00:00Z'}
const index:AdminAppReleaseIndex={releases:[release],stable:{releaseId:'stable-version',revision:3,enabled:true},test:{releaseId:id,revision:4,enabled:true},operations:[]}
const preview:AppReleasePreview={action:'full_release',release,stable:index.stable,test:index.test,expectedRevision:3,previewHash:'c'.repeat(64),blockers:[],impact:'所有账号切换到指定稳定版本，并停用测试分流。'}
const receipt:AppReleaseReceipt={operationId,status:'applied',action:'full_release',releaseId:id,previousReleaseId:'stable-version',revision:4,testRevision:5,appliedAt:'2026-11-06T10:00:00Z'}
function mount(element=<AdminAppReleasesPage/>){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mocks.admin.isSuperAdmin=true;vi.spyOn(crypto,'randomUUID').mockReturnValue(operationId);mocks.request.mockImplementation(async(path:string)=>path.endsWith('/preview')?preview:path.includes('/operations/')?{status:'applied',receipt}:path.endsWith('/execute')?receipt:index)})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
async function openPreview(){fireEvent.click(await screen.findByRole('button',{name:'发布为稳定版'}));await screen.findByRole('dialog')}

it('imports only a release ID, never client paths or verification claims',async()=>{mount();fireEvent.click(screen.getByRole('button',{name:'登记已准备的版本'}));fireEvent.change(screen.getByRole('textbox',{name:'已准备的版本编号'}),{target:{value:id}});fireEvent.click(screen.getByRole('button',{name:'读取并登记'}));await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/admin/app-releases/import',expect.objectContaining({body:JSON.stringify({releaseId:id})})))})
it('previews exact source/artifact and public changes, and requires typed version confirmation',async()=>{mount();await openPreview();const dialog=screen.getByRole('dialog');expect(dialog.textContent).toContain(release.sourceSha);expect(dialog.textContent).toContain(release.artifactSha256);expect(dialog.textContent).toContain('新增可见功能');expect(dialog.textContent).toContain(preview.impact);const button=screen.getByRole('button',{name:'确认本次操作'});expect(button.hasAttribute('disabled')).toBe(true);fireEvent.change(screen.getByRole('textbox',{name:'输入版本编号确认'}),{target:{value:id}});expect(button.hasAttribute('disabled')).toBe(false);fireEvent.click(button);await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/admin/app-releases/execute',expect.objectContaining({body:JSON.stringify({action:'full_release',releaseId:id,expectedRevision:3,previewHash:'c'.repeat(64),operationId})})))})
it('preserves unknown outcome ID and reconciles receipt without retrying the mutation',async()=>{mocks.request.mockImplementation(async(path:string)=>{if(path.endsWith('/execute'))throw Error('response lost');if(path.endsWith('/preview'))return preview;if(path.includes('/operations/'))return{status:'applied',receipt};return index});mount();await openPreview();fireEvent.change(screen.getByRole('textbox',{name:'输入版本编号确认'}),{target:{value:id}});fireEvent.click(screen.getByRole('button',{name:'确认本次操作'}));await screen.findByRole('button',{name:'核对操作结果'});expect(localStorage.getItem('app-release-pending:super-admin')).toContain(operationId);expect(mocks.success).not.toHaveBeenCalled();expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('操作结果待核对'));fireEvent.click(screen.getByRole('button',{name:'核对操作结果'}));await screen.findByText('已确认操作完成。');expect(mocks.request.mock.calls.filter(call=>call[0]==='/api/admin/app-releases/execute')).toHaveLength(1);expect(localStorage.getItem('app-release-pending:super-admin')).toBeNull()})
it('restores an unknown operation on reload instead of starting another release',async()=>{const pending:AppReleaseExecute={action:'full_release',releaseId:id,expectedRevision:3,previewHash:'c'.repeat(64),operationId};localStorage.setItem('app-release-pending:super-admin',JSON.stringify(pending));mount();await screen.findByText('上次操作的结果需要先核对。');expect(screen.getByText(`待核对操作：${operationId}`)).toBeTruthy();expect(mocks.request.mock.calls.some(call=>call[0]==='/api/admin/app-releases/execute')).toBe(false)})
it('blocks unvalidated/incompatible previews and keeps non-super administrators out',async()=>{mocks.request.mockImplementation(async(path:string)=>path.endsWith('/preview')?{...preview,blockers:['版本缺少原始同 SHA 完整 CI 验证证据。']}:index);mount();await openPreview();fireEvent.change(screen.getByRole('textbox',{name:'输入版本编号确认'}),{target:{value:id}});expect(screen.getByRole('button',{name:'确认本次操作'}).hasAttribute('disabled')).toBe(true);cleanup();mocks.admin.isSuperAdmin=false;mount();expect(screen.getByText('应用版本管理仅限超级管理员。')).toBeTruthy();expect(screen.queryByRole('button',{name:'读取并登记'})).toBeNull()})
it('renders public release notes without source, artifact hashes or engineering diagnostics',async()=>{mocks.request.mockResolvedValue({mode:'artifact',channel:'test',release:{id,label:'公开版本',notes:release.publicNotes,capabilities:[],entryUrl:'/entry',sourceSha:release.sourceSha,artifactSha256:release.artifactSha256,ciRunId:'internal'}});mount(<AppVersionPage/>);await screen.findByText('公开版本 · 测试版');expect(document.body.textContent).toContain('新增可见功能');expect(document.body.textContent).not.toContain(release.sourceSha);expect(document.body.textContent).not.toContain(release.artifactSha256);expect(document.body.textContent).not.toContain('internal')})
it('sends the clicked row and action directly to preview without mutation',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path.endsWith('/preview')?preview:{...index,test:null})
 mount();fireEvent.click(await screen.findByRole('button',{name:'分配测试版'}));await screen.findByRole('dialog')
 expect(mocks.request).toHaveBeenCalledWith('/api/admin/app-releases/preview',expect.objectContaining({body:JSON.stringify({action:'assign_test',releaseId:id})}))
 expect(mocks.request.mock.calls.some(call=>call[0]==='/api/admin/app-releases/execute')).toBe(false)
})
it('keeps unresolved reconciliation fenced and releases only a confirmed not-applied operation',async()=>{
 const pending:AppReleaseExecute={action:'full_release',releaseId:id,expectedRevision:3,previewHash:'c'.repeat(64),operationId}
 localStorage.setItem('app-release-pending:super-admin',JSON.stringify(pending))
 mocks.request.mockImplementation(async(path:string)=>path.includes('/operations/')?{status:'unknown',receipt:null}:index)
 mount();fireEvent.click(await screen.findByRole('button',{name:'核对操作结果'}));await screen.findByText('结果仍需核对，请保留当前操作编号。')
 expect(screen.getByRole('button',{name:'发布为稳定版'}).hasAttribute('disabled')).toBe(true)
 expect(localStorage.getItem('app-release-pending:super-admin')).toContain(operationId)
 mocks.request.mockImplementation(async(path:string)=>path.includes('/operations/')?{status:'not_applied',receipt:null}:index)
 fireEvent.click(screen.getByRole('button',{name:'核对操作结果'}));await screen.findByText('已确认操作未提交，可重新预览后操作。')
 expect(localStorage.getItem('app-release-pending:super-admin')).toBeNull()
 expect(screen.getByRole('button',{name:'发布为稳定版'}).hasAttribute('disabled')).toBe(false)
 expect(mocks.request.mock.calls.some(call=>call[0]==='/api/admin/app-releases/execute')).toBe(false)
})

it('shows contextual channel actions and keeps candidate-wide release in version details',async()=>{
 const stable={...release,id:'stable-version',label:'当前稳定'},candidate={...release,id:'next-version',label:'下一候选'},history={...release,id:'history-version',label:'历史稳定'}
 mocks.request.mockImplementation(async(path:string)=>path.endsWith('/preview')?{...preview,release:candidate}:{...index,releases:[stable,release,candidate,history],operations:[{...receipt,releaseId:stable.id,previousReleaseId:history.id}]})
 mount();await screen.findByRole('button',{name:'查看下一候选详情'})
 const stableRow=screen.getByText('当前稳定',{selector:'strong'}).closest('tr')!
 expect(within(stableRow).getAllByRole('button')).toHaveLength(1)
 const candidateRow=screen.getByText('下一候选',{selector:'strong'}).closest('tr')!
 expect(within(candidateRow).getByRole('button',{name:'分配测试版'})).toBeTruthy()
 expect(within(candidateRow).queryByRole('button',{name:'撤回测试分流'})).toBeNull()
 expect(within(candidateRow).queryByRole('button',{name:'回退至此版本'})).toBeNull()
 expect(screen.getAllByRole('button',{name:'撤回测试分流'})).toHaveLength(1)
 fireEvent.click(screen.getByRole('button',{name:'查看下一候选详情'}))
 const detail=screen.getByRole('dialog',{name:'下一候选'})
 expect(within(detail).getByText('新增可见功能')).toBeTruthy()
 fireEvent.click(within(detail).getByRole('button',{name:'发布给全部用户'}))
 await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/admin/app-releases/preview',expect.objectContaining({body:JSON.stringify({action:'full_release',releaseId:candidate.id})})))
 expect(mocks.request.mock.calls.some(call=>call[0]==='/api/admin/app-releases/execute')).toBe(false)
})
it.each([
 {action:'assign_test',button:'分配测试版',message:'已将「候选版本」推送到测试版。'},
 {action:'full_release',button:'发布为稳定版',message:'已将「候选版本」发布为全量稳定版，测试分流已关闭。'},
 {action:'withdraw_test',button:'撤回测试分流',message:'已撤回测试分流，测试用户将使用稳定版。'},
 {action:'rollback',button:'回退至此版本',message:'已回退稳定版至「候选版本」。'},
] as const)('notifies $action only after the receipt and fences repeated execution',async({action,button,message})=>{
 let resolve!: (receipt:AppReleaseReceipt)=>void
 const current={...index,...(action==='assign_test'||action==='rollback'?{test:null}:{}),operations:action==='rollback'?[{...receipt,releaseId:'stable-version',previousReleaseId:id}]:[]}
 mocks.request.mockImplementation(async(path:string)=>path.endsWith('/preview')?{...preview,action}:path.endsWith('/execute')?new Promise<AppReleaseReceipt>(done=>{resolve=done}):current)
 mount();fireEvent.click(await screen.findByRole('button',{name:button}));await screen.findByRole('dialog')
 fireEvent.change(screen.getByRole('textbox',{name:'输入版本编号确认'}),{target:{value:id}})
 const confirm=screen.getByRole('button',{name:'确认本次操作'})
 fireEvent.click(confirm);fireEvent.click(confirm)
 await waitFor(()=>expect(resolve).toBeTypeOf('function'))
 expect(mocks.success).not.toHaveBeenCalled()
 expect(mocks.request.mock.calls.filter(call=>call[0]==='/api/admin/app-releases/execute')).toHaveLength(1)
 expect(localStorage.getItem('app-release-pending:super-admin')).toContain(operationId)
 await act(async()=>resolve({...receipt,action}))
 await waitFor(()=>expect(mocks.success).toHaveBeenCalledExactlyOnceWith(message))
 expect(localStorage.getItem('app-release-pending:super-admin')).toBeNull()
 expect(screen.queryByRole('dialog')).toBeNull()
})
it('does not execute when the pending operation cannot be persisted',async()=>{
 mount();await openPreview()
 vi.spyOn(Storage.prototype,'setItem').mockImplementationOnce(()=>{throw Error('storage denied')})
 fireEvent.change(screen.getByRole('textbox',{name:'输入版本编号确认'}),{target:{value:id}})
 fireEvent.click(screen.getByRole('button',{name:'确认本次操作'}))
 expect(mocks.error).toHaveBeenCalledWith('无法保留操作编号，请先恢复浏览器存储后再操作。')
 expect(mocks.success).not.toHaveBeenCalled()
 expect(mocks.request.mock.calls.some(call=>call[0]==='/api/admin/app-releases/execute')).toBe(false)
})
it('acknowledges registration and distinguishes confirmed not-applied reconciliation from success',async()=>{
 mount();fireEvent.click(screen.getByRole('button',{name:'登记已准备的版本'}))
 fireEvent.change(screen.getByRole('textbox',{name:'已准备的版本编号'}),{target:{value:id}})
 fireEvent.click(screen.getByRole('button',{name:'读取并登记'}))
 await waitFor(()=>expect(mocks.success).toHaveBeenCalledWith('版本登记完成。'))
 cleanup();vi.clearAllMocks()
 const pending:AppReleaseExecute={action:'full_release',releaseId:id,expectedRevision:3,previewHash:'c'.repeat(64),operationId}
 localStorage.setItem('app-release-pending:super-admin',JSON.stringify(pending))
 mocks.request.mockImplementation(async(path:string)=>path.includes('/operations/')?{status:'not_applied',receipt:null}:index)
 mount();fireEvent.click(await screen.findByRole('button',{name:'核对操作结果'}))
 await waitFor(()=>expect(mocks.info).toHaveBeenCalledWith('已确认操作未提交，可重新预览后操作。'))
 expect(mocks.success).not.toHaveBeenCalled()
})
