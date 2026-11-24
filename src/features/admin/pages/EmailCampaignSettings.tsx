import { ChevronRight } from 'lucide-react'
import { emailVariables, type EmailLibraryEntry } from '../../../../shared/contracts/email-library'
import { MAX_CREDIT_MILLI } from '../../../../shared/contracts/admin-credit-adjustment'
import { returnMail, resolvedDate, type ReturnFields } from './email-composer'
import { MailProof } from './EmailTemplateEditor'

export function CampaignSettings({templates,selected,choose,fields,update,values,change,next}:{
  templates:EmailLibraryEntry[];selected:EmailLibraryEntry;choose:(id:number)=>void;fields:ReturnFields;update:(fields:ReturnFields)=>void;
  values:Record<string,string>;change:(values:Record<string,string>)=>void;next:()=>void
}) {
  const isReturn=selected.id===returnMail.id
  const at=resolvedDate(fields,new Date())
  const stamp=Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(at)+'（北京时间）':''
  const proof=isReturn ? {max_credits:fields.credits,expires_at:stamp,workspace_path:'return-reward'} : values
  return <div className="mail-columns"><form className="mail-sheet mail-fields" onSubmit={e=>{e.preventDefault();next()}}>
    <h2>邮件内容</h2><label>选择模板<select value={selected.id} onChange={e=>choose(Number(e.target.value))}>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    {isReturn && <><hr/><h3>回归奖励</h3>
      <label>赠送额度（Credits）<input type="number" required min={1} max={Math.floor(MAX_CREDIT_MILLI / 1000)} value={fields.credits} onChange={e=>update({...fields,credits:e.target.value})}/></label>
      <label>有效期<select value={fields.kind} onChange={e=>update({...fields,kind:e.target.value as ReturnFields['kind']})}><option value="relative">从每封邮件发出时计算</option><option value="fixed">指定截止日期</option></select></label>
      {fields.kind==='relative'?<label>发送后有效天数<input type="number" required min={1} max={365} value={fields.days} onChange={e=>update({...fields,days:e.target.value})}/></label>
      :<label>截止时间（北京时间）<input type="datetime-local" required value={fields.fixed} onChange={e=>update({...fields,fixed:e.target.value})}/></label>}
      <details><summary>领取后前往</summary><label>创作区路径<input required value={fields.path} onChange={e=>update({...fields,path:e.target.value})}/></label></details></>}
    {!isReturn && emailVariables(selected.subject+'\n'+selected.body).map(k=><label key={k}>{k}<input required maxLength={2000} value={Object.prototype.hasOwnProperty.call(values,k)?values[k]:''} onChange={e=>change({...values,[k]:e.target.value})}/></label>)}
    <div className="mail-actions"><button className="mail-primary" type="submit">选择收件人<ChevronRight size={15}/></button></div>
  </form><MailProof template={selected} values={proof}/></div>
}
