import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { AdminCard, AdminPageHeader } from '../AdminLayout'
import { useAdminSession } from '../admin-shared'
import { useAdminDialog } from '../admin-dialog'
import { appReleaseExecuteSchema, type AdminAppRelease, type AdminAppReleaseIndex, type AppReleaseAction, type AppReleaseExecute, type AppReleasePreview, type AppReleaseReceipt } from '../../../../shared/contracts/app-release'

const labels={assign_test:'分配测试版',full_release:'发布为稳定版',rollback:'回退应用版本',withdraw_test:'撤回测试分流'}
const noteLabels={features:'新增功能',fixes:'修复',changes:'改进'}
const fieldClass='w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2 text-sm'
type NoticeTone='success'|'error'|'info'|'warning'
function ReleaseNotes({release}:{release:AdminAppRelease}) {
 return <div className="space-y-5">{(['features','fixes','changes'] as const).map(kind=><section key={kind}><h3 className="mb-2 font-semibold">{noteLabels[kind]}</h3>{release.publicNotes[kind].length?<ul className="list-inside list-disc space-y-1 text-sm">{release.publicNotes[kind].map((note,index)=><li key={index}>{note}</li>)}</ul>:<p className="text-sm text-[var(--text-secondary)]">无</p>}</section>)}</div>
}
export default function AdminAppReleasesPage(){
 const {admin}=useAdminSession(),client=useQueryClient(),toast=useToast()
 const query=useQuery({queryKey:['admin','app-releases'],queryFn:()=>requestJson<AdminAppReleaseIndex>('/api/admin/app-releases'),enabled:Boolean(admin?.isSuperAdmin)})
 const [importId,setImportId]=useState(''),[importOpen,setImportOpen]=useState(false)
 const [detail,setDetail]=useState<AdminAppRelease|null>(null),[view,setView]=useState<AppReleasePreview|null>(null)
 const [confirmation,setConfirmation]=useState(''),[busy,setBusy]=useState<string|null>(null)
 const [message,setMessage]=useState(''),[tone,setTone]=useState<NoticeTone>('info')
 const [pending,setPending]=useState<AppReleaseExecute|null>(null),[receipt,setReceipt]=useState<AppReleaseReceipt|null>(null)
 const [filter,setFilter]=useState<'all'|'history'>('all'),[search,setSearch]=useState('')
 const lock=useRef(false),listHeading=useRef<HTMLHeadingElement>(null)
 const storageKey='app-release-pending:'+(admin?.id??'unknown')
 const importDialog=useAdminDialog<HTMLDivElement>(importOpen,()=>{if(!lock.current)setImportOpen(false)})
 const detailDialog=useAdminDialog<HTMLDivElement>(Boolean(detail),()=>{if(!lock.current)setDetail(null)})
 const dialog=useAdminDialog<HTMLDivElement>(Boolean(view),()=>{if(!lock.current)setView(null)})
 const releaseName=(id:string)=>query.data?.releases.find(item=>item.id===id)?.label??id
 const stable=query.data?.stable,test=query.data?.test
 const stableEnabled=Boolean(stable?.enabled),testEnabled=Boolean(test?.enabled)
 const historicalIds=new Set((query.data?.operations??[]).filter(item=>item.action==='full_release'||item.action==='rollback').flatMap(item=>[item.releaseId,...(item.previousReleaseId?[item.previousReleaseId]:[])]))
 const releases=(query.data?.releases??[]).filter(item=>(filter==='all'||historicalIds.has(item.id)&&item.id!==stable?.releaseId)&&(item.label+' '+item.id).toLowerCase().includes(search.toLowerCase()))
 const operations=receipt?[receipt,...(query.data?.operations??[]).filter(item=>item.operationId!==receipt.operationId)]:query.data?.operations??[]
 const blocked=Boolean(busy||pending)
 function report(text:string,nextTone:NoticeTone){setMessage(text);setTone(nextTone);toast[nextTone==='warning'?'info':nextTone](text)}
 function begin(text:string){if(lock.current)return false;lock.current=true;setBusy(text);setMessage('');return true}
 function finish(){lock.current=false;setBusy(null)}
 function successText(action:AppReleaseAction,id:string){
  if(action==='assign_test')return '已将「'+releaseName(id)+'」推送到测试版。'
  if(action==='full_release')return '已将「'+releaseName(id)+'」发布为全量稳定版，测试分流已关闭。'
  if(action==='withdraw_test')return '已撤回测试分流，测试用户将使用稳定版。'
  return '已回退稳定版至「'+releaseName(id)+'」。'
 }
 useEffect(()=>{
  if(!admin)return
  try{const saved=localStorage.getItem(storageKey);if(saved){const value=appReleaseExecuteSchema.safeParse(JSON.parse(saved));if(value.success){setPending(value.data);setMessage('上次操作的结果需要先核对。')}else setMessage('保留的操作记录格式不完整，请通过审计核对。');setTone('warning')}}
  catch{setMessage('操作记录暂时无法读取，请通过审计核对。');setTone('warning')}
 },[admin,storageKey])
 async function refresh(){await client.invalidateQueries({queryKey:['admin','app-releases']})}
 function accept(result:AppReleaseReceipt){
  setReceipt(result);setPending(null);setView(null)
  try{localStorage.removeItem(storageKey)}catch{/* The confirmed receipt remains visible; a retained browser record is reconciled on reload. */}
 }
 async function importRelease(){
  if(pending||!importId.trim()||!begin('正在登记版本…'))return
  try{await requestJson('/api/admin/app-releases/import',{method:'POST',body:JSON.stringify({releaseId:importId.trim()})});setImportId('');setImportOpen(false);report('版本登记完成。','success');await refresh()}
  catch(error){report(error instanceof Error?error.message:'登记失败。','error')}finally{finish()}
 }
 async function preview(releaseId:string,action:AppReleaseAction){
  if(pending||!begin('正在读取'+labels[action]+'的影响…'))return
  setDetail(null)
  try{const result=await requestJson<AppReleasePreview>('/api/admin/app-releases/preview',{method:'POST',body:JSON.stringify({action,releaseId})});setConfirmation('');setView(result)}
  catch(error){report(error instanceof Error?error.message:'预览失败。','error')}finally{finish()}
 }
 async function execute(){
  if(!view||confirmation!==view.release.id||view.blockers.length||pending||!begin('正在'+labels[view.action]+'…'))return
  const operation:AppReleaseExecute={action:view.action,releaseId:view.release.id,expectedRevision:view.expectedRevision,previewHash:view.previewHash,operationId:crypto.randomUUID()}
  try{localStorage.setItem(storageKey,JSON.stringify(operation))}catch{report('无法保留操作编号，请先恢复浏览器存储后再操作。','error');finish();return}
  setPending(operation)
  const abort=new AbortController(),timeout=window.setTimeout(()=>abort.abort(),35000)
  let result:AppReleaseReceipt
  try{result=await requestJson<AppReleaseReceipt>('/api/admin/app-releases/execute',{method:'POST',body:JSON.stringify(operation),signal:abort.signal})}
  catch(error){setView(null);report('操作结果待核对。'+(error instanceof Error?error.message:''),'warning');finish();return}
  finally{window.clearTimeout(timeout)}
  accept(result);report(successText(result.action,result.releaseId),'success')
  try{await refresh()}finally{finish()}
 }
 async function reconcile(){
  if(!pending||!begin('正在核对上次操作结果…'))return
  let result:{status:string;receipt:AppReleaseReceipt|null}
  try{result=await requestJson('/api/admin/app-releases/operations/'+encodeURIComponent(pending.operationId))}
  catch{report('暂时无法核对结果，操作编号已保留。','warning');finish();return}
  if(result.status==='applied'&&result.receipt){accept(result.receipt);setMessage('已确认操作完成。');setTone('success');toast.success('已核对：'+successText(result.receipt.action,result.receipt.releaseId));try{await refresh()}finally{finish()}}
  else if(result.status==='not_applied'){setPending(null);try{localStorage.removeItem(storageKey)}catch{/* A retained record can be checked again after reload. */}report('已确认操作未提交，可重新预览后操作。','info');finish()}
  else{report('结果仍需核对，请保留当前操作编号。','warning');finish()}
 }
 function showHistory(){setFilter('history');setSearch('');requestAnimationFrame(()=>listHeading.current?.focus())}
 if(admin&&!admin.isSuperAdmin)return <><AdminPageHeader title="应用版本"/><p>应用版本管理仅限超级管理员。</p></>
 if(!admin)return <><AdminPageHeader title="应用版本"/><p role="status">正在校验管理权限…</p></>
 return <div className="space-y-4">
  <AdminPageHeader title="应用版本" description="查看当前渠道，先预览影响，再确认版本切换。"/>
  <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-[var(--text-secondary)]">稳定版面向全体用户，测试版面向有效测试员。</p><Button disabled={blocked} onClick={()=>setImportOpen(true)}>登记已准备的版本</Button></div>
  {message?<p role={tone==='warning'||tone==='error'?'alert':'status'} className={'admin-release-notice '+tone}>{message}</p>:null}
  {busy?<p role="status" aria-live="polite" className="text-sm font-medium">{busy}</p>:null}
  {pending?<AdminCard><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{busy?'操作处理中':'有一项操作需要核对'}</h2><p className="mt-1 text-sm">{labels[pending.action]} · {releaseName(pending.releaseId)}</p></div><Button disabled={Boolean(busy)} onClick={()=>void reconcile()}>{busy?'核对中…':'核对操作结果'}</Button></div><details className="mt-3 text-xs"><summary>工程详情</summary><p>待核对操作：{pending.operationId}</p><p>版本编号：{pending.releaseId}</p></details></AdminCard>:null}
  {query.isLoading?<p role="status" className="py-12 text-center">加载中…</p>:query.isError?<p role="alert">版本读取失败。<Button onClick={()=>void query.refetch()}>重试</Button></p>:<>
   <div className="admin-channel-grid grid gap-4 md:grid-cols-2">
    <AdminCard><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium text-[var(--text-secondary)]">当前稳定版</h2><span className="admin-channel-badge">{stableEnabled?'全体用户':'尚未启用'}</span></div><p className="mt-3 text-xl font-semibold">{stableEnabled&&stable?releaseName(stable.releaseId):'未配置稳定版本'}</p><p className="mt-2 text-sm text-[var(--text-secondary)]">{stableEnabled?'普通用户正在使用此版本。':'API 更新不代表已全量发布。'}</p><div className="mt-5 flex flex-wrap gap-2">{stableEnabled&&stable?<><Button onClick={()=>setDetail(query.data?.releases.find(item=>item.id===stable.releaseId)??null)} disabled={!query.data?.releases.some(item=>item.id===stable.releaseId)}>查看更新说明</Button><Button disabled={blocked} onClick={showHistory}>回退历史稳定版</Button></>:<Button disabled={blocked} onClick={()=>{setFilter('all');listHeading.current?.focus()}}>选择初始稳定版</Button>}</div></AdminCard>
    <AdminCard><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium text-[var(--text-secondary)]">当前测试版</h2><span className="admin-channel-badge">{testEnabled?'有效测试员':'跟随稳定版'}</span></div><p className="mt-3 text-xl font-semibold">{testEnabled&&test?releaseName(test.releaseId):'未开启测试分流'}</p><p className="mt-2 text-sm text-[var(--text-secondary)]">{testEnabled?'先由测试用户使用，通过后可发布给全部用户。':'从下方版本列表选择要推送的测试版本。'}</p><div className="mt-5 flex flex-wrap gap-2">{testEnabled&&test?<>{test.releaseId!==stable?.releaseId?<Button variant="primary" disabled={blocked} onClick={()=>void preview(test.releaseId,'full_release')}>发布为稳定版</Button>:null}<Button disabled={blocked} onClick={()=>void preview(test.releaseId,'withdraw_test')}>撤回测试分流</Button></>:<Button disabled={blocked} onClick={()=>{setFilter('all');listHeading.current?.focus()}}>选择测试版本</Button>}</div></AdminCard>
   </div>
   <AdminCard><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 ref={listHeading} tabIndex={-1} className="font-semibold outline-none">{filter==='history'?'历史稳定版本':'版本列表'} <span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">{releases.length} 个</span></h2><div className="flex w-full flex-wrap gap-2 sm:w-auto"><input aria-label="搜索应用版本" placeholder="搜索版本名称" className={fieldClass+' !w-56 max-w-full'} value={search} onChange={event=>setSearch(event.target.value)}/>{filter==='history'?<Button onClick={()=>setFilter('all')}>全部版本</Button>:null}<Button disabled={Boolean(busy)} onClick={()=>void refresh()}>刷新列表</Button></div></div>
    {releases.length?<table className="admin-release-table w-full text-left text-sm"><thead><tr><th>版本</th><th>当前用途</th><th>验证状态</th><th>更新摘要</th><th>操作</th></tr></thead><tbody>{releases.map(item=>{
     const isStable=stableEnabled&&stable?.releaseId===item.id,isTest=testEnabled&&test?.releaseId===item.id,isHistory=historicalIds.has(item.id)&&!isStable
     return <tr key={item.id}><td data-label="版本"><strong className="font-semibold">{item.label}</strong><span className="mt-1 block text-xs text-[var(--text-secondary)]">{new Date(item.createdAt).toLocaleDateString()}</span></td><td data-label="当前用途">{isStable?'稳定版':isTest?'测试版':isHistory?'历史稳定版':'候选版本'}</td><td data-label="验证状态"><span className="text-xs">{item.validationState==='verified'?'已验证':'待验证草稿'}</span></td><td data-label="更新摘要" className="max-w-80 text-[var(--text-secondary)]">{[...item.publicNotes.features,...item.publicNotes.fixes,...item.publicNotes.changes][0]??'暂无更新说明'}</td><td data-label="操作"><div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={()=>setDetail(item)} aria-label={'查看'+item.label+'详情'}>详情</Button>{!isStable&&!isTest?<Button size="sm" disabled={blocked} onClick={()=>void preview(item.id,stableEnabled?'assign_test':'full_release')}>{stableEnabled?'分配测试版':'发布为稳定版'}</Button>:null}{isHistory?<Button size="sm" disabled={blocked} onClick={()=>void preview(item.id,'rollback')}>回退至此版本</Button>:null}</div></td></tr>
    })}</tbody></table>:<p className="py-12 text-center text-[var(--text-secondary)]">{filter==='history'?'暂无可选历史稳定版本。':'暂无匹配版本。'}</p>}
   </AdminCard>
   <AdminCard><h2 className="font-semibold">操作记录</h2>{operations.length?<ol className="mt-3 divide-y divide-[var(--border-default)]">{operations.map(item=><li key={item.operationId} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm"><div><p className="font-medium">{labels[item.action]} · {releaseName(item.releaseId)}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{new Date(item.appliedAt).toLocaleString()} · 已完成</p></div><details className="text-xs text-[var(--text-secondary)]"><summary>工程回执</summary><p className="break-all">操作编号：{item.operationId}</p><p>版本编号：{item.releaseId} · 修订 {item.revision}</p></details></li>)}</ol>:<p className="mt-3 text-sm text-[var(--text-secondary)]">暂无历史操作。</p>}</AdminCard>
  </>}
  {detail?<div className="admin-portal !mt-0 fixed inset-0 z-[150] flex justify-end bg-black/35"><div ref={detailDialog} role="dialog" aria-modal="true" aria-labelledby="release-detail-title" tabIndex={-1} className="admin-release-drawer"><header className="admin-editor-header"><div><h2 id="release-detail-title" className="text-lg font-semibold">{detail.label}</h2><p className="text-xs text-[var(--text-secondary)]">更新说明</p></div><Button onClick={()=>setDetail(null)}>关闭</Button></header><div className="admin-editor-body"><ReleaseNotes release={detail}/><details className="mt-6 border-t border-[var(--border-default)] pt-4 text-xs"><summary>工程验证信息（仅管理员）</summary><div className="mt-3 space-y-2"><p>版本编号：{detail.id}</p><p className="break-all">源码 SHA：{detail.sourceSha}</p><p className="break-all">产物 SHA256：{detail.artifactSha256}</p><p>原始 CI：{detail.ciRunId??'尚未提供'}</p><p>API / 数据 / 任务协议：{detail.compatibility.api} / {detail.compatibility.schema} / {detail.compatibility.task}</p><p>注册政策界面：{detail.compatibility.legalConsentUi?'支持':'不兼容'}</p><p>验证时间：{detail.verifiedAt?new Date(detail.verifiedAt).toLocaleString():'尚未验证'}</p></div></details></div><footer className="admin-editor-footer"><Button onClick={()=>setDetail(null)}>关闭详情</Button>{detail.id!==stable?.releaseId?<Button disabled={blocked} onClick={()=>void preview(detail.id,'full_release')}>发布给全部用户</Button>:null}</footer></div></div>:null}
  {importOpen?<div className="admin-portal !mt-0 fixed inset-0 z-[150] flex items-center justify-center bg-black/35 p-3"><div ref={importDialog} role="dialog" aria-modal="true" aria-labelledby="release-import" tabIndex={-1} className="admin-editor-dialog !max-w-lg"><header className="admin-editor-header"><h2 id="release-import" className="text-lg font-semibold">登记已准备的版本</h2></header><div className="admin-editor-body"><label className="block space-y-2 text-sm"><span>已准备的版本编号</span><input className={fieldClass} value={importId} onChange={event=>setImportId(event.target.value)} placeholder="版本编号" disabled={Boolean(busy)}/></label>{message?<p role="status" className="mt-3">{message}</p>:null}</div><footer className="admin-editor-footer"><Button disabled={Boolean(busy)} onClick={()=>setImportOpen(false)}>取消</Button><Button variant="primary" disabled={blocked||!importId.trim()} onClick={()=>void importRelease()}>{busy?'正在登记…':'读取并登记'}</Button></footer></div></div>:null}
  {view?<div className="admin-portal !mt-0 fixed inset-0 z-[160] flex items-center justify-center bg-black/35 p-3"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="release-preview" tabIndex={-1} className="admin-editor-dialog !max-w-2xl"><header className="admin-editor-header"><h2 id="release-preview" className="text-lg font-semibold">{labels[view.action]} · {view.release.label}</h2></header><div className="admin-editor-body space-y-4"><p className="rounded-lg bg-[var(--surface-muted)] p-3 text-sm">{view.impact}</p><ReleaseNotes release={view.release}/>{view.blockers.length?<ul role="alert" className="list-inside list-disc text-sm text-[var(--color-error)]">{view.blockers.map(reason=><li key={reason}>{reason}</li>)}</ul>:null}{message?<p role="alert">{message}</p>:null}<p className="text-sm">本次版本编号：<strong>{view.release.id}</strong></p><label className="block space-y-1 text-sm"><span>输入版本编号确认</span><input className={fieldClass} value={confirmation} disabled={Boolean(busy)} onChange={event=>setConfirmation(event.target.value)}/></label><details className="text-xs"><summary>本次操作工程详情</summary><p className="break-all">SHA：{view.release.sourceSha}</p><p className="break-all">产物：{view.release.artifactSha256}</p><p>通道修订：{view.expectedRevision}</p></details></div><footer className="admin-editor-footer"><Button disabled={Boolean(busy)} onClick={()=>setView(null)}>取消</Button><Button variant="primary" disabled={blocked||view.blockers.length>0||confirmation!==view.release.id} onClick={()=>void execute()}>{busy?'正在执行…':'确认本次操作'}</Button></footer></div></div>:null}
 </div>
}
