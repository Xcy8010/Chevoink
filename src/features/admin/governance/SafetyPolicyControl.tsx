import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { requestJson } from '@/app/api-client'
import { AdminConfirmDialog } from '../AdminLayout'
import { fieldClass } from './GovernanceRestrictionsView'

export type SafetyPolicy = {mode:string;windowDays:number;banDays:number;updatedAt:string}
export function SafetyPolicyControl({policy}:{policy:SafetyPolicy}) {
  const [mode,setMode]=useState(policy.mode),[days,setDays]=useState(policy.windowDays),[ban,setBan]=useState(policy.banDays)
  const [reason,setReason]=useState(''),[confirm,setConfirm]=useState(false)
  const client=useQueryClient(),toast=useToast()
  const mutation=useMutation({mutationFn:()=>requestJson('/api/admin/governance/safety-events/policy',{method:'POST',
    body:JSON.stringify({mode,windowDays:days,banDays:ban,reason,expectedUpdatedAt:policy.updatedAt,confirmEnforcement:confirm})}),
    onSuccess:()=>{setConfirm(false);toast.success('策略变更已记录');void client.invalidateQueries({queryKey:['admin','governance','safety']})},
    onError:(e:Error)=>{setConfirm(false);toast.error(e.message)}})
  return <details className="my-3 text-sm"><summary className="cursor-pointer">管理处置策略</summary>
    <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();if(mode==='enforce')setConfirm(true);else mutation.mutate()}}>
      <label>模式<select className={fieldClass} value={mode} onChange={e=>setMode(e.target.value)}><option value="observe">仅观察</option><option value="enforce">自动处置</option></select></label>
      <label>统计窗口（天）<input className={fieldClass} required min={1} max={365} type="number" value={days} onChange={e=>setDays(e.target.valueAsNumber)}/></label>
      <label>一级封禁期限（天）<input className={fieldClass} required min={1} max={365} type="number" value={ban} onChange={e=>setBan(e.target.valueAsNumber)}/></label>
      <label>变更理由<input className={fieldClass} required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <Button className="justify-self-start" type="submit" disabled={mutation.isPending}>保存策略</Button>
    </form><AdminConfirmDialog open={confirm} title="启用自动处置" description={'后续经独立复核的事件可触发账号提醒或 '+ban+' 天全平台封禁。'} confirmText="自动处置" onCancel={()=>setConfirm(false)} onConfirm={()=>mutation.mutate()} loading={mutation.isPending}/>
  </details>
}
