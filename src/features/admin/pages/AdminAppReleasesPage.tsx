import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { AdminRowActions } from './AdminPageControls'
import { AdminCard, AdminPageHeader } from '../AdminLayout'
import { useAdminSession } from '../admin-shared'
import { useAdminDialog } from '../admin-dialog'
import { appReleaseActions, appReleaseExecuteSchema, type AdminAppReleaseIndex, type AppReleaseAction, type AppReleaseExecute, type AppReleasePreview, type AppReleaseReceipt } from '../../../../shared/contracts/app-release'
const labels={assign_test:'分配测试版',full_release:'发布为稳定版',rollback:'回退应用版本',withdraw_test:'撤回测试分流'}
const fieldClass='w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm'
export default function AdminAppReleasesPage(){
 const {admin}=useAdminSession(),client=useQueryClient()
 const query=useQuery({queryKey:['admin','app-releases'],queryFn:()=>requestJson<AdminAppReleaseIndex>('/api/admin/app-releases'),enabled:Boolean(admin?.isSuperAdmin)})
 const [importId,setImportId]=useState(''),[importOpen,setImportOpen]=useState(false),[view,setView]=useState<AppReleasePreview|null>(null),[confirmation,setConfirmation]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[pending,setPending]=useState<AppReleaseExecute|null>(null),[receipt,setReceipt]=useState<AppReleaseReceipt|null>(null)
 const storageKey=`app-release-pending:${admin?.id ?? 'unknown'}`
 const importDialog=useAdminDialog<HTMLDivElement>(importOpen,()=>{if(!busy)setImportOpen(false)})
 const dialog=useAdminDialog<HTMLDivElement>(Boolean(view),()=>{if(!busy)setView(null)})
 useEffect(()=>{if(!admin)return;try{const saved=localStorage.getItem(storageKey);if(saved){const value=appReleaseExecuteSchema.safeParse(JSON.parse(saved));if(value.success){setPending(value.data);setMessage('上次操作的结果需要先核对。')}else setMessage('保留的操作记录格式不完整，请通过审计核对。')}}catch{setMessage('操作记录暂时无法读取，请通过审计核对。')}},[admin,storageKey])
 async function refresh(){await client.invalidateQueries({queryKey:['admin','app-releases']})}
 async function importRelease(){setBusy(true);setMessage('');try{await requestJson('/api/admin/app-releases/import',{method:'POST',body:JSON.stringify({releaseId:importId.trim()})});setImportId('');setImportOpen(false);await refresh();setMessage('版本登记完成。')}catch(error){setMessage(error instanceof Error?error.message:'登记失败。')}finally{setBusy(false)}}
 async function preview(releaseId:string,action:AppReleaseAction){setBusy(true);setMessage('');try{const result=await requestJson<AppReleasePreview>('/api/admin/app-releases/preview',{method:'POST',body:JSON.stringify({action,releaseId})});setConfirmation('');setView(result)}catch(error){setMessage(error instanceof Error?error.message:'预览失败。')}finally{setBusy(false)}}
 async function execute(){
  if(!view||confirmation!==view.release.id||pending)return
  const operation:AppReleaseExecute={action:view.action,releaseId:view.release.id,expectedRevision:view.expectedRevision,previewHash:view.previewHash,operationId:crypto.randomUUID()}
  try{localStorage.setItem(storageKey,JSON.stringify(operation))}catch{setMessage('无法保留操作编号，请先恢复浏览器存储后再操作。');return}
  setPending(operation);setBusy(true);setMessage('')
  const abort=new AbortController(),timeout=window.setTimeout(()=>abort.abort(),35000)
  try{const result=await requestJson<AppReleaseReceipt>('/api/admin/app-releases/execute',{method:'POST',body:JSON.stringify(operation),signal:abort.signal});setReceipt(result);setPending(null);localStorage.removeItem(storageKey);setView(null);await refresh();setMessage('通道已切换，操作回执已保存。')}catch(error){setView(null);setMessage(`操作结果待核对。${error instanceof Error?error.message:''}`)}finally{window.clearTimeout(timeout);setBusy(false)}
 }
 async function reconcile(){
  if(!pending)return
  setBusy(true)
  try{const result=await requestJson<{status:string;receipt:AppReleaseReceipt|null}>(`/api/admin/app-releases/operations/${encodeURIComponent(pending.operationId)}`);if(result.status==='applied'&&result.receipt){setReceipt(result.receipt);setPending(null);localStorage.removeItem(storageKey);setMessage('已确认操作完成。');await refresh()}else if(result.status==='not_applied'){setPending(null);localStorage.removeItem(storageKey);setMessage('已确认操作未提交，可重新预览后操作。')}else setMessage('结果仍需核对，请保留当前操作编号。')}catch{setMessage('暂时无法核对结果，操作编号已保留。')}finally{setBusy(false)}
 }
 if(admin&&!admin.isSuperAdmin)return <><AdminPageHeader title="应用版本"/><p>应用版本管理仅限超级管理员。</p></>
 const releaseName=(id:string)=>query.data?.releases.find(item=>item.id===id)?.label ?? id
 return <>
  <AdminPageHeader title="应用版本" description="管理稳定版、测试版及每次切换的更新内容。"/>
  <div className="admin-content-toolbar"><p className="text-sm text-[var(--text-secondary)]">当前渠道与版本</p><Button className="ml-auto" disabled={busy||Boolean(pending)} onClick={()=>setImportOpen(true)}>登记已准备的版本</Button></div>
  {message?<p role="status" className="mb-4 rounded-lg bg-[var(--surface-muted)] p-3 text-sm">{message}</p>:null}
  {pending?<AdminCard className="mb-4"><h2 className="font-semibold">有一项操作需要核对</h2><p className="my-2">{labels[pending.action]} · {releaseName(pending.releaseId)}</p><Button disabled={busy} onClick={()=>void reconcile()}>核对操作结果</Button><details className="mt-3 text-xs"><summary>工程详情</summary><p>待核对操作：{pending.operationId}</p><p>版本编号：{pending.releaseId}</p></details></AdminCard>:null}
  {query.isLoading?<p role="status" className="py-12 text-center">加载中…</p>:query.isError?<p role="alert">版本读取失败。<button onClick={()=>void query.refetch()}>重试</button></p>:<>
    <div className="admin-channel-grid mb-4 grid gap-4 md:grid-cols-2">
      <AdminCard><p className="text-xs text-[var(--text-secondary)]">稳定版 · 全体用户</p><h2 className="mt-1 text-lg font-semibold">{query.data?.stable?releaseName(query.data.stable.releaseId):'未配置'}</h2><p className="mt-2 text-sm">{query.data?.stable?.enabled?'当前使用中的稳定版本':'尚未启用稳定渠道；API 更新不代表已全量发布'}</p><details className="mt-3 text-xs text-[var(--text-secondary)]"><summary>工程详情</summary><p>版本编号：{query.data?.stable?.releaseId??'未配置'}</p><p>修订：{query.data?.stable?.revision??0}</p></details></AdminCard>
      <AdminCard><p className="text-xs text-[var(--text-secondary)]">测试版 · 测试用户</p><h2 className="mt-1 text-lg font-semibold">{query.data?.test?.enabled?releaseName(query.data.test.releaseId):'未启用测试分流'}</h2><p className="mt-2 text-sm">{query.data?.test?.enabled?'测试用户使用此版本':'测试用户跟随稳定版'}</p><details className="mt-3 text-xs text-[var(--text-secondary)]"><summary>工程详情</summary><p>版本编号：{query.data?.test?.releaseId??'未配置'}</p><p>修订：{query.data?.test?.revision??0}</p></details></AdminCard>
    </div>
    <AdminCard><div className="mb-2 flex items-center justify-between gap-3"><h2 className="font-semibold">已登记版本</h2><span className="text-xs text-[var(--text-secondary)]">{query.data?.releases.length??0} 个版本</span></div>
      {query.data?.releases.length?query.data.releases.map(release=><article key={release.id} aria-label={release.label} className="admin-list-row">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{release.label}</h3><span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs">{release.validationState==='verified'?'已验证':'未验证草稿'}</span>{query.data?.stable?.releaseId===release.id?<span className="text-xs text-[var(--color-success)]">当前稳定版</span>:null}{query.data?.test?.enabled&&query.data.test.releaseId===release.id?<span className="text-xs text-[var(--color-info)]">当前测试版</span>:null}</div>
          <p className="admin-note-preview">{[...release.publicNotes.features,...release.publicNotes.fixes,...release.publicNotes.changes][0]??'暂无更新说明'}</p>
          <details className="mt-2 text-sm"><summary>更新说明与工程详情</summary>{(['features','fixes','changes'] as const).map(kind=><section className="mt-3" key={kind}><h4 className="text-xs font-medium text-[var(--text-secondary)]">{{features:'新增功能',fixes:'修复',changes:'改进'}[kind]}</h4>{release.publicNotes[kind].length?<ul className="list-inside list-disc text-sm">{release.publicNotes[kind].map((note,index)=><li key={index}>{note}</li>)}</ul>:<p className="text-xs text-[var(--text-secondary)]">无</p>}</section>)}
            <details className="mt-4 text-xs"><summary>工程验证信息（仅管理员）</summary><p>版本编号：{release.id}</p><p className="break-all">源码 SHA：{release.sourceSha}</p><p className="break-all">产物 SHA256：{release.artifactSha256}</p><p>原始 CI：{release.ciRunId??'尚未提供'}</p><p>API / 数据 / 任务协议：{release.compatibility.api} / {release.compatibility.schema} / {release.compatibility.task}</p><p>注册政策界面：{release.compatibility.legalConsentUi?'支持':'不兼容'}</p><p>验证时间：{release.verifiedAt?new Date(release.verifiedAt).toLocaleString():'尚未验证'}</p></details>
          </details>
        </div>
        <div className="admin-release-actions"><AdminRowActions label={release.label+'的版本操作'}>{appReleaseActions.map(item=><Button key={item} size="sm" disabled={busy||Boolean(pending)} onClick={()=>void preview(release.id,item)}>{labels[item]}</Button>)}</AdminRowActions></div>
      </article>):<p className="py-12 text-center text-[var(--text-secondary)]">暂无已登记版本。</p>}
    </AdminCard>
    <AdminCard className="mt-4"><h2 className="font-semibold">操作记录</h2>{receipt?<p className="my-3 text-sm">{labels[receipt.action]} · {releaseName(receipt.releaseId)} · 已完成</p>:null}{query.data?.operations.length?query.data.operations.map(item=><div key={item.operationId} className="mt-3 border-t border-[var(--border-subtle)] pt-3 text-sm"><p>{new Date(item.appliedAt).toLocaleString()} · {labels[item.action]} · {releaseName(item.releaseId)}</p><details className="mt-1 text-xs text-[var(--text-secondary)]"><summary>工程回执</summary><p className="break-all">操作编号：{item.operationId}</p><p>版本编号：{item.releaseId} · 修订 {item.revision}</p></details></div>):<p className="mt-3 text-sm text-[var(--text-secondary)]">暂无历史操作。</p>}</AdminCard>
  </>}
  {importOpen?<div className="admin-portal fixed inset-0 z-[150] flex items-center justify-center bg-black/35 p-3"><div ref={importDialog} role="dialog" aria-modal="true" aria-labelledby="release-import" tabIndex={-1} className="admin-editor-dialog"><header className="admin-editor-header"><h2 id="release-import" className="text-lg font-semibold">登记已准备的版本</h2></header><div className="admin-editor-body"><label className="block space-y-2 text-sm"><span>已准备的版本编号</span><input className={fieldClass} value={importId} onChange={event=>setImportId(event.target.value)} placeholder="版本编号"/></label>{message?<p role="status" className="mt-3">{message}</p>:null}</div><footer className="admin-editor-footer"><Button disabled={busy} onClick={()=>setImportOpen(false)}>取消</Button><Button variant="primary" disabled={busy||!importId.trim()||Boolean(pending)} onClick={()=>void importRelease()}>读取并登记</Button></footer></div></div>:null}
  {view?<div className="admin-portal fixed inset-0 z-[160] flex items-center justify-center bg-black/35 p-3"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="release-preview" tabIndex={-1} className="admin-editor-dialog">
    <header className="admin-editor-header"><h2 id="release-preview" className="text-lg font-semibold">{labels[view.action]} · {view.release.label}</h2></header><div className="admin-editor-body space-y-4"><p className="rounded-lg bg-[var(--surface-muted)] p-3 text-sm">{view.impact}</p>
    {(['features','fixes','changes'] as const).map(kind=><section key={kind}><h3 className="text-sm font-medium">{{features:'新增功能',fixes:'修复',changes:'改进'}[kind]}</h3><ul className="list-inside list-disc text-sm">{view.release.publicNotes[kind].map((note,index)=><li key={index}>{note}</li>)}</ul></section>)}
    {view.blockers.length?<ul role="alert" className="list-inside list-disc text-sm text-rose-600">{view.blockers.map(reason=><li key={reason}>{reason}</li>)}</ul>:null}
    <p className="text-sm">本次版本编号：<strong>{view.release.id}</strong></p><label className="block space-y-1 text-sm"><span>输入版本编号确认</span><input className={fieldClass} value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></label>
    <details className="text-xs"><summary>本次操作工程详情</summary><p className="break-all">SHA：{view.release.sourceSha}</p><p className="break-all">产物：{view.release.artifactSha256}</p><p>通道修订：{view.expectedRevision}</p></details></div>
    <footer className="admin-editor-footer"><Button disabled={busy} onClick={()=>setView(null)}>取消</Button><Button variant="primary" disabled={busy||view.blockers.length>0||confirmation!==view.release.id||Boolean(pending)} onClick={()=>void execute()}>确认本次操作</Button></footer>
  </div></div>:null}
 </>
}
