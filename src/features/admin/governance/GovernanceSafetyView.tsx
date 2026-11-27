import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { AdminCard, AdminPanelState } from '../AdminLayout'
import { formatDateTime } from '../admin-shared'
import { SafetyPolicyControl, type SafetyPolicy } from './SafetyPolicyControl'
import { GovernanceRestrictionsView, fieldClass, type GovernanceSubject } from './GovernanceRestrictionsView'

type Event = { id:string; userId:string; actionKey:string; category:string; source:string; policyVersion:string; status:string; createdAt:string; reviewReason:string|null; evidenceRef:string|null }
const path='/api/admin/governance/safety-events'
const labels:Record<string,string>={pending:'待复核',confirmed:'已确认',dismissed:'已排除'}
export function GovernanceSafetyView({userId=''}:GovernanceSubject) {
  const [target,setTarget]=useState(userId),[status,setStatus]=useState('pending'),[cursor,setCursor]=useState('')
  const [event,setEvent]=useState<Event|null>(null),[disposition,setDisposition]=useState<Event|null>(null)
  const [decision,setDecision]=useState('dismissed'),[evasion,setEvasion]=useState('none'),[reason,setReason]=useState(''),[evidence,setEvidence]=useState(''),[category,setCategory]=useState('')
  const client=useQueryClient(),toast=useToast()
  const query=useQuery({queryKey:['admin','governance','safety',target,status,cursor],queryFn:()=>{
    const params=new URLSearchParams()
    if(target.trim())params.set('userId',target.trim())
    if(status)params.set('status',status)
    if(cursor)params.set('cursor',cursor)
    return requestJson<{items:Event[];nextCursor:string|null;policy:SafetyPolicy;canConfigure:boolean}>(path+'?'+params)
  }})
  const mutation=useMutation({mutationFn:()=>requestJson<{level:string;mode:string}>(path+'/'+event!.id+'/review',{method:'POST',body:JSON.stringify({decision,evasion,reason,category,evidenceRef:evidence})}),
    onSuccess:r=>{setEvent(null);toast.success(r.mode==='observe'?'复核已保存，策略处于观察模式':'复核已保存');void client.invalidateQueries({queryKey:['admin','governance']})},onError:(e:Error)=>toast.error(e.message)})
  return <div className="space-y-4"><AdminCard>
    <div className="grid gap-3 text-sm sm:grid-cols-2"><label>用户 ID<input className={fieldClass} value={target} onChange={e=>{setTarget(e.target.value);setCursor('')}}/></label><label>复核状态<select value={status} className={fieldClass} onChange={e=>{setStatus(e.target.value);setCursor('')}}><option value="">全部</option>{Object.entries(labels).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label></div>
    {query.data && <p className="my-3 text-sm">{query.data.policy.mode==='observe'?'观察模式':'自动处置已启用'} · 滚动 {query.data.policy.windowDays} 天 · 一级限制 {query.data.policy.banDays} 天</p>}
    {query.data?.canConfigure && <SafetyPolicyControl key={query.data.policy.updatedAt} policy={query.data.policy}/>}
    <AdminPanelState state={query.isPending?'loading':query.isError?'error':!query.data?.items.length?'empty':'ready'}>{query.data?.items.map(item=><article key={item.id} className="space-y-2 border-b border-[var(--border-subtle)] py-3 text-sm">
      <strong>{item.category}</strong> · {labels[item.status]}<p className="break-all">{item.userId} · {item.id} · {formatDateTime(item.createdAt)}</p><p className="break-all">原始动作 {item.actionKey} · {item.source} · {item.policyVersion}</p>
      {item.reviewReason && <p>{item.reviewReason} · {item.evidenceRef}</p>}
      <div className="flex gap-2"><Button size="sm" onClick={()=>{setEvent(item);setDisposition(null);setEvidence(item.evidenceRef??'');setReason('');setCategory(item.category);setDecision('dismissed');setEvasion('none')}}>复核记录</Button><Button size="sm" onClick={()=>{setDisposition(item);setEvent(null)}}>账号处置</Button></div></article>)}</AdminPanelState>
    {cursor && <Button onClick={()=>setCursor('')}>首页</Button>}{query.data?.nextCursor && <Button onClick={()=>setCursor(query.data!.nextCursor!)}>下一页</Button>}
  </AdminCard>
    {event && <AdminCard><form className="grid gap-3 text-sm sm:grid-cols-2" onSubmit={e=>{e.preventDefault();mutation.mutate()}}>
      <h3 className="font-semibold sm:col-span-2">复核安全记录</h3><label>结论<select className={fieldClass} value={decision} onChange={e=>setDecision(e.target.value)}><option value="dismissed">排除或纠正误判</option><option value="confirmed">独立证据确认违规</option></select></label>
      <label>规避证据<select className={fieldClass} value={evasion} onChange={e=>setEvasion(e.target.value)}><option value="none">无持续规避证据</option><option value="credible">有可信持续规避证据</option><option value="high">有高可信恶意规避证据</option></select></label>
      <label>分类<input required maxLength={80} className={fieldClass} value={category} onChange={e=>setCategory(e.target.value)}/></label>
      <label>证据编号或来源<input required maxLength={300} className={fieldClass} value={evidence} onChange={e=>setEvidence(e.target.value)}/></label>
      <label className="sm:col-span-2">复核理由<textarea required maxLength={1000} className={fieldClass} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <div className="flex gap-2"><Button type="submit" variant="primary" disabled={mutation.isPending}>保存复核</Button><Button onClick={()=>setEvent(null)}>取消</Button></div>
    </form></AdminCard>}
    {disposition && <GovernanceRestrictionsView key={disposition.id} userId={disposition.userId} sourceId={disposition.id} initialReason={disposition.reviewReason??''}/>}
  </div>
}
