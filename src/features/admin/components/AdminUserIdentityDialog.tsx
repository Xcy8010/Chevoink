import { useRef, useState } from 'react'
import type { AdminUserIdentityInput, AdminUserRow } from '../../../../shared/contracts'
import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { getAdminUserDetail, updateAdminUserIdentity } from '../api'
import { useAdminDialog } from '../admin-dialog'
import { formatShanghaiDateInput, parseShanghaiDateInput } from '../site-content-time'

const fieldClass='w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2 text-sm'
type Props={user:AdminUserRow;adminId:string;isSuperAdmin:boolean;onClose:()=>void;onSaved:()=>void}
export default function AdminUserIdentityDialog({user,adminId,isSuperAdmin,onClose,onSaved}:Props) {
  const [snapshot,setSnapshot]=useState(user)
  const [role,setRole]=useState<'user'|'admin'>(user.role==='admin'?'admin':'user')
  const [enabled,setEnabled]=useState(Boolean(user.isSuperAdmin||user.tester?.enabled))
  const [expiryMode,setExpiryMode]=useState(user.tester?.expiresAt?'scheduled':'unlimited')
  const [expiry,setExpiry]=useState(formatShanghaiDateInput(user.tester?.expiresAt??''))
  const [reason,setReason]=useState(user.tester?.reason??'')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [stale,setStale]=useState(false)
  const [unknown,setUnknown]=useState(false)
  const submitting=useRef(false)
  const attempt=useRef<AdminUserIdentityInput|null>(null)
  const dialog=useAdminDialog<HTMLDivElement>(true,()=>{if(!submitting.current)onClose()})
  const canChangeRole=isSuperAdmin&&snapshot.id!==adminId&&!snapshot.isSuperAdmin
  const roleChanged=canChangeRole&&role!==(snapshot.role==='admin'?'admin':'user')
  const originalExpiry=snapshot.tester?.expiresAt??null
  const expiryChanged=(expiryMode==='unlimited')!==(originalExpiry===null)||(expiryMode==='scheduled'&&expiry!==formatShanghaiDateInput(originalExpiry??''))
  const testerChanged=!snapshot.isSuperAdmin&&(enabled!==Boolean(snapshot.tester?.enabled)||expiryChanged||reason.trim()!==(snapshot.tester?.reason??'').trim())
  const blocked=busy||stale||unknown
  async function save() {
    if(submitting.current||stale||(!attempt.current&&!roleChanged&&!testerChanged))return
    let payload=attempt.current
    if(!payload) {
      const expiresAt=expiryMode==='unlimited'?null:expiryChanged?parseShanghaiDateInput(expiry):originalExpiry
      if(testerChanged&&expiryMode==='scheduled'&&!expiresAt){setError('请选择测试资格的到期时间。');return}
      payload={operationId:crypto.randomUUID(),
        ...(roleChanged?{role,expectedRole:snapshot.role}:{}),
        ...(testerChanged?{tester:{enabled,expiresAt,reason:reason.trim()||(enabled?'在用户管理授予测试员权益':'在用户管理撤销测试员权益'),expectedRevision:snapshot.tester?.revision??0}}:{})}
      attempt.current=payload
    }
    submitting.current=true;setBusy(true);setError('')
    try {await updateAdminUserIdentity(snapshot.id,payload);onSaved()}
    catch(cause) {
      if(cause instanceof ApiClientError&&cause.status===409) {setStale(true);setUnknown(false);setError(cause.message+' 请重新载入用户资料后再编辑。')}
      else if(cause instanceof ApiClientError&&cause.status>=400&&cause.status<500) {attempt.current=null;setUnknown(false);setError(cause.message)}
      else {setUnknown(true);setError('保存结果尚未确认，请重试同一次保存。')}
    } finally {submitting.current=false;setBusy(false)}
  }
  async function reload() {
    if(submitting.current)return
    submitting.current=true;setBusy(true)
    try {
      const latest=(await getAdminUserDetail(snapshot.id)).user
      setSnapshot(latest);setRole(latest.role==='admin'?'admin':'user');setEnabled(Boolean(latest.isSuperAdmin||latest.tester?.enabled))
      setExpiryMode(latest.tester?.expiresAt?'scheduled':'unlimited');setExpiry(formatShanghaiDateInput(latest.tester?.expiresAt??''));setReason(latest.tester?.reason??'')
      attempt.current=null;setStale(false);setUnknown(false);setError('')
    } catch(cause) {setError(cause instanceof Error?cause.message:'用户资料载入失败，请重试。')}
    finally {submitting.current=false;setBusy(false)}
  }
  return <div className="admin-portal fixed inset-0 z-[150] flex items-center justify-center bg-black/35 p-3"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="user-identity-title" tabIndex={-1} className="admin-editor-dialog !max-w-[640px]">
    <header className="admin-editor-header"><div><h2 id="user-identity-title" className="text-lg font-semibold">编辑用户身份</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">{snapshot.nickname}</p></div><Button disabled={busy} onClick={onClose} aria-label="关闭身份编辑">关闭</Button></header>
    <div className="admin-editor-body">
      {error?<div role="alert" className="mb-4 rounded-lg bg-[var(--surface-muted)] p-3 text-sm">{error}{stale?<Button className="ml-2" disabled={busy} onClick={()=>void reload()}>重新载入用户资料</Button>:null}</div>:null}
      <fieldset className="admin-form-group" disabled={blocked}><legend>账号角色</legend><label className="block space-y-1 text-sm"><span>角色</span><select className={fieldClass} value={role} disabled={!canChangeRole} onChange={event=>setRole(event.target.value as 'user'|'admin')}><option value="user">用户</option><option value="admin">管理员</option></select></label>{snapshot.isSuperAdmin?<p className="mt-2 text-xs text-[var(--text-secondary)]">超级管理员身份受保护。</p>:!canChangeRole?<p className="mt-2 text-xs text-[var(--text-secondary)]">{snapshot.id===adminId?'不能修改自己的角色。':'仅超级管理员可修改账号角色。'}</p>:null}</fieldset>
      <fieldset className="admin-form-group" disabled={blocked||Boolean(snapshot.isSuperAdmin)}><legend>测试资格</legend>
        <label className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/><span>测试员</span></label>
        {snapshot.isSuperAdmin?<p className="mb-3 text-xs text-[var(--text-secondary)]">超级管理员默认具有测试资格。</p>:null}
        <div className="admin-form-grid mt-3">
          <label className="block space-y-1 text-sm"><span>资格期限</span><select className={fieldClass} disabled={!enabled} value={expiryMode} onChange={event=>setExpiryMode(event.target.value)}><option value="unlimited">长期有效</option><option value="scheduled">指定到期时间</option></select></label>
          {expiryMode==='scheduled'?<label className="block space-y-1 text-sm"><span>到期时间（北京时间 UTC+8）</span><input type="datetime-local" className={fieldClass} disabled={!enabled} value={expiry} onChange={event=>setExpiry(event.target.value)}/></label>:null}
          <label className="admin-form-wide block space-y-1 text-sm"><span>变更原因（可选）</span><textarea className={fieldClass} maxLength={500} rows={3} value={reason} onChange={event=>setReason(event.target.value)}/></label>
        </div>
      </fieldset>
    </div>
    <footer className="admin-editor-footer"><span className="text-xs text-[var(--text-secondary)]">{unknown?'等待保存结果确认':roleChanged||testerChanged?'有未保存修改':'未修改'}</span><div className="flex gap-2"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy||stale||(!roleChanged&&!testerChanged&&!unknown)} onClick={()=>void save()}>{busy?'正在保存…':unknown?'重试保存':'保存身份'}</Button></div></footer>
  </div></div>
}
