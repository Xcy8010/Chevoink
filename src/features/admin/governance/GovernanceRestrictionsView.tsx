import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { requestJson } from '@/app/api-client'
import { AdminCard, AdminConfirmDialog, AdminPanelState } from '../AdminLayout'
import { formatDateTime } from '../admin-shared'
import { restrictionScopes, restrictionLabels, type RestrictionScope } from '../../../../shared/contracts/governance-restrictions'

export type GovernanceSubject = { userId?: string; sourceId?: string; initialReason?: string; onSaved?: () => void }
type Row = { legacyBan:boolean; id:string; userId:string; scope:RestrictionScope; reason:string; clause:string; createdAt:string; expiresAt:string|null; revokedAt:string|null }
const path = '/api/admin/governance/restrictions'
export const fieldClass = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3 py-2'
const days = [1,3,7,30,90]
const commonReasons = ['发布违法有害内容', '持续规避内容安全规则', '骚扰辱骂或威胁他人', '欺诈广告或垃圾信息', '侵犯知识产权或泄露隐私']

export function UserRestrictionPanel({user, onClose, onSaved}: {user:{id:string;nickname:string}; onClose:()=>void; onSaved:()=>void}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  return <section className="mb-5 space-y-3" aria-labelledby="user-restriction-heading">
    <div className="flex items-center justify-between gap-3">
      <h2 id="user-restriction-heading" ref={heading} tabIndex={-1} className="text-lg font-semibold">{user.nickname} 的使用限制</h2>
      <Button size="sm" onClick={onClose}>收起</Button>
    </div>
    <GovernanceRestrictionsView userId={user.id} onSaved={onSaved}/>
  </section>
}
export function GovernanceRestrictionsView({ userId = '', sourceId, initialReason = '', onSaved }: GovernanceSubject) {
  const clauseOptions = useId()
  const [target,setTarget] = useState(userId)
  const [scopes,setScopes] = useState<RestrictionScope[]>([])
  const [reason,setReason] = useState(initialReason), [clause,setClause] = useState('')
  const [reasonChoice,setReasonChoice] = useState('custom')
  const [duration,setDuration] = useState('7'), [custom,setCustom] = useState('')
  const [edit,setEdit] = useState<{ row:Row; action:'extend'|'revoke' }|null>(null)
  const [confirm,setConfirm] = useState(false), [cursor,setCursor] = useState('')
  const [filter,setFilter] = useState<RestrictionScope|''>('')
  const previous = useRef<{draft:string; operationId:string; expiresAt:string|null}|null>(null)
  const client = useQueryClient(), toast = useToast()
  const query = useQuery({ queryKey:['admin','governance','restrictions',target,filter,cursor], queryFn:() => {
    const params = new URLSearchParams()
    if (target.trim()) params.set('userId',target.trim())
    if (filter) params.set('scope',filter)
    if (cursor) params.set('cursor',cursor)
    return requestJson<{items:Row[]; nextCursor:string|null; legacyOnly:boolean}>(path+'?'+params)
  } })
  const legacyOnly = query.data?.legacyOnly === true
  const legacyIssue = legacyOnly && !edit
  const mutation = useMutation({ mutationFn: async () => {
    if (legacyIssue || (legacyOnly && edit?.row.legacyBan && edit.action === 'revoke')) {
      const action = edit ? 'unban' : 'ban'
      const draft = JSON.stringify([action, edit?.row.id, target.trim(), reason, clause])
      if (previous.current?.draft !== draft) previous.current = { draft, expiresAt:null, operationId:crypto.randomUUID() }
      return requestJson('/api/admin/users/'+encodeURIComponent(edit?.row.userId ?? target.trim())+'/'+action,
        {method:'POST',body:JSON.stringify({operationId:previous.current.operationId,reason,...(edit ? {} : {clause})})})
    }
    const expiresAt = duration === 'permanent' || edit?.action === 'revoke' ? null
      : duration === 'custom' ? new Date(custom).toISOString() : new Date(Date.now() + Number(duration) * 86_400_000).toISOString()
    if (edit) return requestJson(path+'/'+encodeURIComponent(edit.row.id),{method:'PATCH',body:JSON.stringify({action:edit.action,reason,expiresAt})})
    const draft = JSON.stringify([target.trim(), scopes, reason, clause, duration, custom, sourceId])
    if (previous.current?.draft !== draft) previous.current = {draft, operationId:crypto.randomUUID(), expiresAt}
    return requestJson(path,{method:'POST',body:JSON.stringify({userId:target.trim(), scopes, reason, clause, expiresAt:previous.current.expiresAt, operationId:previous.current.operationId, sourceId, confirmPlatform:confirm})})
  }, onSuccess:() => { previous.current=null;setConfirm(false);setEdit(null);setReason('');setReasonChoice('custom');setScopes([]);onSaved?.();toast.success('处置已记录');void client.invalidateQueries({queryKey:['admin','governance']}) },
    onError:(error:Error) => {setConfirm(false);toast.error(error.message)} })
  return <div className="space-y-4">
    <AdminCard><form className="grid gap-4 text-sm sm:grid-cols-2" onSubmit={e => {
      e.preventDefault()
      if (legacyIssue || (!edit && scopes.includes('platform')) || (edit?.row.scope === 'platform' && edit.action === 'extend')) setConfirm(true)
      else mutation.mutate()
    }}>
      <label>用户 ID<input required value={edit?.row.userId ?? target} readOnly={!!userId || !!edit} onChange={e=>{setTarget(e.target.value);setCursor('')}} className={fieldClass}/></label>
      {!edit && <label>协议条款<input required list={clauseOptions} maxLength={300} value={clause} onChange={e=>setClause(e.target.value)} className={fieldClass}/>
        <datalist id={clauseOptions}>
          <option value="用户服务协议第五节 · 禁止生成和传播的内容"/>
          <option value="用户服务协议第六节 · 内容审核与处置"/>
          <option value="用户服务协议第七节 · 举报、投诉、申诉及争议处理"/>
        </datalist></label>}
      {legacyIssue && <p className="sm:col-span-2">此账号当前使用稳定版，可按原有流程永久封禁全平台访问。</p>}
      {!edit && !legacyIssue && <fieldset className="sm:col-span-2"><legend>限制范围</legend><div className="mt-2 flex flex-wrap gap-3">{restrictionScopes.map(scope=><label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e=>setScopes(e.target.checked?[...scopes,scope]:scopes.filter(s=>s!==scope))}/> {restrictionLabels[scope]}</label>)}</div></fieldset>}
      {!legacyIssue && edit?.action !== 'revoke' && <label>限制期限<select className={fieldClass} value={duration} onChange={e=>setDuration(e.target.value)}>{days.map(d=><option value={d} key={d}>{d===1?'24 小时':d+' 天'}</option>)}<option value="permanent">永久</option><option value="custom">自定义截止时间</option></select></label>}
      {!legacyIssue && edit?.action !== 'revoke' && duration==='custom' && <label>截止时间<input required type="datetime-local" className={fieldClass} value={custom} onChange={e=>setCustom(e.target.value)}/></label>}
      {!edit && <label>常见理由<select className={fieldClass} value={reasonChoice} onChange={e => {
        const value = e.target.value
        setReasonChoice(value); setReason(value === 'custom' ? '' : value)
      }}>
        <option value="custom">自定义理由</option>
        {commonReasons.map(item => <option key={item}>{item}</option>)}
      </select></label>}
      <label className="sm:col-span-2">处置理由<textarea required maxLength={1000} className={fieldClass} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">{initialReason && <Button size="sm" onClick={()=>setReason(initialReason)}>引用案件理由</Button>}
        <Button variant="primary" type="submit" disabled={mutation.isPending || query.isFetching || query.isError || (!edit && !legacyIssue && !scopes.length)}>{edit?.action==='revoke'?'撤销此项限制':edit?'延长期限':'执行限制'}</Button>
        {edit && <Button onClick={()=>{setEdit(null);setReason(initialReason)}}>取消编辑</Button>}</div>
    </form></AdminCard>
    <AdminCard><label className="text-sm">筛选范围<select className={fieldClass} value={filter} onChange={e=>{setFilter(e.target.value as typeof filter);setCursor('')}}><option value="">全部范围</option>{restrictionScopes.map(s=><option key={s} value={s}>{restrictionLabels[s]}</option>)}</select></label>
      <AdminPanelState state={query.isPending?'loading':query.isError?'error':!query.data?.items.length?'empty':'ready'}>
        {query.data?.items.map(row=>{ const active=!row.revokedAt && (!row.expiresAt || Date.parse(row.expiresAt)>Date.now())
          return <article className="space-y-2 border-b border-[var(--border-subtle)] py-4 text-sm" key={row.id}>
            <strong>{restrictionLabels[row.scope]}</strong><span className="ml-3">{row.revokedAt?'已撤销':active?'生效中':'已到期'}</span>
            <p className="break-all">{row.userId} · {row.id}</p><p>{row.reason} · {row.clause}</p><p>{formatDateTime(row.createdAt)} 至 {row.expiresAt?formatDateTime(row.expiresAt):'永久'}</p>
            {active && <div className="flex gap-2">{!legacyOnly && row.expiresAt && <Button size="sm" onClick={()=>{setEdit({row,action:'extend'});setReason('')}}>延长</Button>}<Button size="sm" onClick={()=>{setEdit({row,action:'revoke'});setReason('')}}>撤销</Button></div>}
          </article>})}
      </AdminPanelState>{cursor && <Button size="sm" onClick={()=>setCursor('')}>首页</Button>}{query.data?.nextCursor && <Button size="sm" onClick={()=>setCursor(query.data!.nextCursor!)}>下一页</Button>}
    </AdminCard>
    <AdminConfirmDialog open={confirm} title="确认全平台限制" description={'账号 '+(edit?.row.userId??target)+' 将受全平台限制。'} confirmLabel="确认执行" loading={mutation.isPending} onCancel={()=>setConfirm(false)} onConfirm={()=>mutation.mutate()}/>
  </div>
}
