import { defaultSiteSettings, effectiveSiteSettings } from '@/features/site-content/defaults'
import { formatShanghaiDateInput, parseShanghaiDateInput } from '../site-content-time'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { AdminCard, AdminPageHeader, StatusPill } from '../AdminLayout'
import { useAdminSession } from '../admin-shared'
import { useAdminDialog } from '../admin-dialog'
import { DOCS } from '@/features/account/docs-content'
import { contentDraftSchema, helpKeys, policyProtectedHelpSections, type ContentDraft, type ContentRow, type SiteSettings, type PublicSiteContent } from '../../../../shared/contracts/site-content'

const labels = {announcement:'公告',help:'帮助文档',terms:'服务条款',privacy:'隐私政策',settings:'站点设置'}
const statuses = {draft:'草稿',scheduled:'待生效',active:'生效中',ended:'已结束',withdrawn:'已撤下'}
const inputClass = 'w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm'
function Field({label,children,wide=false}:{label:string;children:ReactNode;wide?:boolean}) { return <label className={wide ? "admin-form-wide block space-y-1 text-sm" : "block space-y-1 text-sm"}><span>{label}</span>{children}</label> }
function Text({label,value,onChange,multiline=false,disabled=false}:{label:string;value:string;onChange:(value:string)=>void;multiline?:boolean;disabled?:boolean}) {
  return <Field label={label} wide={multiline}>{multiline ? <textarea className={inputClass} rows={4} value={value} onChange={event=>onChange(event.target.value)} disabled={disabled}/> : <input className={inputClass} value={value} onChange={event=>onChange(event.target.value)} disabled={disabled}/>}</Field>
}
function DateField({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}) { return <Field label={`${label}（北京时间 UTC+8）`}><input className={inputClass} type="datetime-local" value={formatShanghaiDateInput(value)} onChange={event=>onChange(parseShanghaiDateInput(event.target.value))}/></Field> }
function initial(kind: ContentDraft['kind']): ContentDraft {
  if (kind==='announcement') return {kind,key:'',payload:{title:'',body:'',scope:'both',startsAt:null,endsAt:null,dismissal:{mode:'session'}}}
  if (kind==='settings') return {kind,key:'main',payload:defaultSiteSettings}
  if (kind==='help') { const doc=DOCS[0]; return {kind,key:'what-is',payload:{title:doc.title,summary:doc.summary,sections:doc.sections}} }
  if (kind==='terms') return {kind,key:'terms',payload:{title:'',body:'',effectiveAt:''}}
  return {kind:'privacy',key:'privacy',payload:{title:'',body:'',effectiveAt:''}}
}
function Group({title,children}:{title:string;children:ReactNode}) {
  return <fieldset className="admin-form-group"><legend>{title}</legend><div className="admin-form-grid">{children}</div></fieldset>
}
function DraftFields({draft,onChange,existing,dismissalConfirmed,onDismissalConfirmed}:{draft:ContentDraft;onChange:(draft:ContentDraft)=>void;existing:boolean;dismissalConfirmed:boolean;onDismissalConfirmed:()=>void}) {
  function patch(payload:ContentDraft['payload']) { onChange({...draft,payload} as ContentDraft) }
  if (draft.kind==='announcement') { const payload=draft.payload; return <>
    <Group title="公告内容">
      <Text label="公告编号" value={draft.key} disabled={existing} onChange={key=>onChange({...draft,key})}/>
      <Text label="标题" value={payload.title} onChange={title=>patch({...payload,title})}/>
      <Text label="公告正文" multiline value={payload.body} onChange={body=>patch({...payload,body})}/>
    </Group>
    <Group title="展示与有效时间">
      <Field label="展示位置"><select className={inputClass} value={payload.scope} onChange={event=>patch({...payload,scope:event.target.value as 'home'|'studio'|'both'})}><option value="both">首页和创作中心</option><option value="home">首页</option><option value="studio">创作中心</option></select></Field><div/>
      <div className="space-y-3"><Field label="开始方式"><select className={inputClass} value={payload.startsAt === null ? 'immediate' : 'scheduled'} onChange={event=>patch({...payload,startsAt:event.target.value === 'immediate' ? null : ''})}><option value="immediate">发布时立即开始</option><option value="scheduled">指定开始时间</option></select></Field>{payload.startsAt !== null ? <DateField label="开始时间（包含此时刻）" value={payload.startsAt} onChange={startsAt=>patch({...payload,startsAt})}/> : null}</div>
      <div className="space-y-3"><Field label="结束方式"><select className={inputClass} value={payload.endsAt === null ? 'unlimited' : 'scheduled'} onChange={event=>patch({...payload,endsAt:event.target.value === 'unlimited' ? null : ''})}><option value="unlimited">不限结束时间</option><option value="scheduled">指定结束时间</option></select></Field>{payload.endsAt !== null ? <DateField label="结束时间（不含此时刻）" value={payload.endsAt} onChange={endsAt=>patch({...payload,endsAt})}/> : null}</div>
    </Group>
    <Group title="关闭与再次提醒">
      <Field label="关闭后再次提醒"><select className={inputClass} value={dismissalConfirmed ? payload.dismissal.mode : ''} onChange={event=>{onDismissalConfirmed();patch({...payload,dismissal:event.target.value==='ttl' ? {mode:'ttl',seconds:3600} : {mode:event.target.value as 'session'|'version'}})}}><option value="" disabled>请选择本次公告策略</option><option value="session">下次浏览器会话</option><option value="ttl">指定间隔后</option><option value="version">下一内容版本</option></select></Field>
      {payload.dismissal.mode==='ttl' ? <Field label="间隔秒数"><input className={inputClass} type="number" min={60} max={31536000} value={payload.dismissal.seconds} onChange={event=>patch({...payload,dismissal:{mode:'ttl',seconds:Number(event.target.value)}})}/></Field>:null}
    </Group>
  </> }
  if (draft.kind==='terms' || draft.kind==='privacy') { const payload=draft.payload; return <Group title="正式政策">
    <Text label="标题" value={payload.title} onChange={title=>patch({...payload,title})}/>
    <DateField label="生效时间" value={payload.effectiveAt} onChange={effectiveAt=>patch({...payload,effectiveAt})}/>
    <Text label="正式政策全文" multiline value={payload.body} onChange={body=>patch({...payload,body})}/>
    <p className="admin-form-wide text-sm text-[var(--text-secondary)]">请录入经确认的正式文本。发布后保留历史版本；新版本只影响之后的注册同意记录。两份正式政策均生效后才能注册。</p>
  </Group> }
  if (draft.kind==='help') { const payload=draft.payload; return <>
    <Group title="文档信息">
      <Field label="文档"><select className={inputClass} disabled={existing} value={draft.key} onChange={event=>{const doc=DOCS.find(item=>item.key===event.target.value)!;onChange({...draft,key:event.target.value as typeof helpKeys[number],payload:{title:doc.title,summary:doc.summary,sections:doc.sections}})}}>{DOCS.map(doc=><option key={doc.key} value={doc.key}>{doc.group} · {doc.title}</option>)}</select></Field>
      <Text label="标题" value={payload.title} onChange={title=>patch({...payload,title})}/><Text label="简介" multiline value={payload.summary} onChange={summary=>patch({...payload,summary})}/>
    </Group>
    {payload.sections.map((section,index)=><fieldset disabled={policyProtectedHelpSections[draft.key]?.includes(section.id)} key={section.id} className="admin-form-group"><legend>{section.heading}</legend><div className="admin-form-grid">
      <div className="admin-form-wide"><Text label="章节标题" value={section.heading} onChange={heading=>patch({...payload,sections:payload.sections.map((item,i)=>i===index?{...item,heading}:item)})}/></div>
      <Text label="正文（每行一段）" multiline value={section.paragraphs?.join('\n') ?? ''} onChange={value=>patch({...payload,sections:payload.sections.map((item,i)=>i===index?{...item,paragraphs:value.split('\n')}:item)})}/>
      <Text label="要点（每行一项）" multiline value={section.bullets?.join('\n') ?? ''} onChange={value=>patch({...payload,sections:payload.sections.map((item,i)=>i===index?{...item,bullets:value.split('\n').filter(Boolean)}:item)})}/>
    </div></fieldset>)}
    <p className="text-sm text-[var(--text-secondary)]">额度、邀请奖励、套餐以及注册政策的事实由当前产品政策显示。</p>
  </> }
  const payload=draft.payload as SiteSettings
  return <>
    <Group title="站点身份"><Text label="站点名称" value={payload.name} onChange={name=>patch({...payload,name})}/><Text label="Logo 链接" value={payload.logoUrl ?? ''} onChange={value=>patch({...payload,logoUrl:value || null})}/><Text label="关于" multiline value={payload.about} onChange={about=>patch({...payload,about})}/><Text label="页脚" multiline value={payload.footer} onChange={footer=>patch({...payload,footer})}/></Group>
    <Group title="帮助与联系"><Text label="文档入口名称" value={payload.docsLabel} onChange={docsLabel=>patch({...payload,docsLabel})}/><Text label="联系入口名称" value={payload.contact.label} onChange={label=>patch({...payload,contact:{...payload.contact,label}})}/><Text label="联系链接" value={payload.contact.url ?? ''} onChange={value=>patch({...payload,contact:{...payload.contact,url:value || null}})}/><Text label="联系方式与说明" multiline value={payload.contact.details} onChange={details=>patch({...payload,contact:{...payload.contact,details}})}/></Group>
    <fieldset className="admin-form-group space-y-3"><legend>站点导航</legend>{payload.navigation.map((link,index)=><div key={index} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]"><Text label="导航名称" value={link.label} onChange={label=>patch({...payload,navigation:payload.navigation.map((item,i)=>i===index?{...item,label}:item)})}/><Text label="导航链接" value={link.url} onChange={url=>patch({...payload,navigation:payload.navigation.map((item,i)=>i===index?{...item,url}:item)})}/><Button onClick={()=>patch({...payload,navigation:payload.navigation.filter((_,i)=>i!==index)})}>移除导航</Button></div>)}<Button disabled={payload.navigation.length>=12} onClick={()=>patch({...payload,navigation:[...payload.navigation,{label:'',url:'/'}]})}>添加导航</Button><p className="text-sm text-[var(--text-secondary)]">导航按列表顺序显示；移除并发布后隐藏该入口。</p></fieldset>
  </>
}
function ContentPreview({draft}:{draft:ContentDraft}) {
  if (draft.kind==='settings') {const payload=draft.payload;return <div className="space-y-3">{payload.logoUrl ? <img alt="站点 Logo" src={payload.logoUrl} className="h-12 w-12 object-contain"/>:null}<h2 className="text-xl">{payload.name}</h2><p className="whitespace-pre-wrap">{payload.about}</p><p>{payload.contact.details}</p>{payload.contact.url ? <a href={payload.contact.url}>{payload.contact.label}</a>:null}<nav>{payload.navigation.map(item=><span key={item.url} className="mr-4">{item.label}</span>)}</nav><p>{payload.footer}</p></div>}
  if (draft.kind==='help') return <article><h2 className="text-xl">{draft.payload.title}</h2><p>{draft.payload.summary}</p>{draft.payload.sections.map(section=><section key={section.id} className="mt-5"><h3 className="font-semibold">{section.heading}</h3>{section.paragraphs?.map((paragraph,index)=><p className="mt-2 whitespace-pre-wrap" key={index}>{paragraph}</p>)}<ul className="list-inside list-disc">{section.bullets?.map((bullet,index)=><li key={index}>{bullet}</li>)}</ul></section>)}</article>
  return <article><h2 className="text-xl">{draft.payload.title}</h2>{draft.kind === 'announcement' ? <p className="mt-2 text-sm">开始：{draft.payload.startsAt === null ? '发布时立即开始（服务端确定）' : formatShanghaiDateInput(draft.payload.startsAt).replace('T',' ') + ' UTC+8'} · 结束：{draft.payload.endsAt === null ? '不限结束时间' : formatShanghaiDateInput(draft.payload.endsAt).replace('T',' ') + ' UTC+8'}</p> : null}<p className="mt-3 whitespace-pre-wrap leading-7">{draft.payload.body}</p></article>
}
type Action='publish'|'withdraw'|'delete'|'restore'
export default function AdminContentPage({settingsOnly=false}:{settingsOnly?:boolean}) {
  const {admin}=useAdminSession()
  const client=useQueryClient()
  const query=useQuery({queryKey:['admin','site-content'],queryFn:()=>requestJson<ContentRow[]>('/api/admin/site-content'),refetchInterval:60000})
  const publicQuery=useQuery({queryKey:['site-content','public'],queryFn:()=>requestJson<PublicSiteContent>('/api/site-content'),enabled:settingsOnly})
  const [editorOpen,setEditorOpen]=useState(false)
  const [filter,setFilter]=useState('all')
  const [search,setSearch]=useState('')
  const [selected,setSelected]=useState<ContentRow|null>(null)
  const [draft,setDraft]=useState<ContentDraft>(initial(settingsOnly?'settings':'announcement'))
  const [dirty,setDirty]=useState(false)
  const [dismissalConfirmed,setDismissalConfirmed]=useState(settingsOnly)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const [preview,setPreview]=useState(false)
  const [confirm,setConfirm]=useState<Action|null>(null)
  const [replacement,setReplacement]=useState('')
  const editorDialog=useAdminDialog<HTMLDivElement>(editorOpen && !confirm,()=>{if(!busy)setEditorOpen(false)})
  const dialog=useAdminDialog<HTMLDivElement>(Boolean(confirm),()=>{if(!busy)setConfirm(null)})
  const rows=(query.data ?? []).filter(row=>settingsOnly ? row.kind==='settings' : row.kind!=='settings')
  const storageKey=(id:string)=>`site-content-draft:${admin?.id ?? 'unknown'}:${id}`
  function change(value:ContentDraft) {setDraft(value);setDirty(true);setPreview(false);try {localStorage.setItem(storageKey(selected?.id ?? `new-${value.kind}`),JSON.stringify({revision:selected?.revision ?? 0,draft:value}))} catch { /* Editing remains available without persistent browser storage. */ }}
  function choose(row:ContentRow|null,kind:ContentDraft['kind']=settingsOnly?'settings':'announcement') {
    setEditorOpen(true)
    setDismissalConfirmed(Boolean(row) || kind!=='announcement')
    setSelected(row);setMessage('');setPreview(false);setDirty(false);setReplacement('')
    const value=row ? {kind:row.kind,key:row.key,payload:row.payload} as ContentDraft : kind==='settings'?{kind,key:'main',payload:effectiveSiteSettings(publicQuery.data?.settings)} as ContentDraft:initial(kind)
    setDraft(value)
    try { const raw=localStorage.getItem(storageKey(row?.id ?? `new-${kind}`)); if(raw){const saved=JSON.parse(raw) as {revision:number;draft:unknown}; const parsed=contentDraftSchema.safeParse(saved.draft);if(parsed.success && saved.revision===(row?.revision ?? 0)){setDraft(parsed.data);setDirty(true);setDismissalConfirmed(true)}else setMessage('浏览器中有旧版本草稿，当前显示服务器版本。')} } catch { /* Ignore corrupt or unavailable browser storage. */ }
  }
  async function save() {
    if (draft.kind==='announcement' && !dismissalConfirmed) {setMessage('请选择本次公告的关闭后提醒策略。');return}
    const parsed=contentDraftSchema.safeParse(draft)
    if (!parsed.success) {setMessage(parsed.error.issues.map(issue=>issue.message).join('；'));return}
    setBusy(true);setMessage('')
    try {const row=await requestJson<ContentRow>(`/api/admin/site-content${selected ? `/${selected.id}` : ''}`,{method:'POST',body:JSON.stringify(selected ? {expectedRevision:selected.revision,action:'save',draft:parsed.data}:parsed.data)});try{localStorage.removeItem(storageKey(selected?.id ?? `new-${draft.kind}`))}catch{/* Browser storage is optional. */}setSelected(row);setDraft({kind:row.kind,key:row.key,payload:row.payload} as ContentDraft);setDirty(false);await client.invalidateQueries({queryKey:['admin','site-content']});setMessage('草稿已保存。')} catch(error){setMessage(error instanceof Error?error.message:'保存失败。')}finally{setBusy(false)}
  }
  async function operate() {
    if(!selected || !confirm)return
    setBusy(true);setMessage('')
    try {const replaced=rows.find(row=>row.id===replacement);const row=await requestJson<ContentRow>(`/api/admin/site-content/${selected.id}`,{method:'POST',body:JSON.stringify({expectedRevision:selected.revision,action:confirm,...(confirm==='publish' && replaced ? {replace:{id:replaced.id,expectedRevision:replaced.revision}}:{})})});setSelected(row);setConfirm(null);await Promise.all([client.invalidateQueries({queryKey:['admin','site-content']}),client.invalidateQueries({queryKey:['site-content','public']})]);setMessage('操作已完成。')}catch(error){setMessage(error instanceof Error?error.message:'操作失败。')}finally{setBusy(false)}
  }
  const title=(row:ContentRow)=>'title' in row.payload?row.payload.title:row.payload.name
  const visible=rows.filter(row=>(filter==='all'||row.kind===filter)&&(row.key+' '+title(row)).toLowerCase().includes(search.toLowerCase()))
  return <>
    <AdminPageHeader title={settingsOnly?'站点设置':'公告与帮助政策'} description={settingsOnly?'维护站点公开资料与联系入口。':'维护公告、帮助文档、服务条款和隐私政策。'}/>
    <div className="admin-toolbar admin-content-toolbar">
      {!settingsOnly?<><input aria-label="搜索内容" placeholder="搜索标题或编号" className={inputClass} value={search} onChange={event=>setSearch(event.target.value)}/><select aria-label="内容类型" className={inputClass} value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">全部类型</option>{(['announcement','help','terms','privacy'] as const).map(kind=><option key={kind} value={kind}>{labels[kind]}</option>)}</select></>:null}
      <div className="flex flex-wrap gap-2 md:ml-auto">{settingsOnly?<Button disabled={busy||query.isLoading||query.isError||publicQuery.isLoading} onClick={()=>choose(rows.find(row=>row.key==='main')??null,'settings')}>编辑站点资料</Button>:(['announcement','help','terms','privacy'] as const).map(kind=><Button key={kind} disabled={busy} onClick={()=>choose(null,kind)}>新建{labels[kind]}</Button>)}</div>
    </div>
    {query.isLoading?<p role="status" className="py-12 text-center">加载中…</p>:query.isError?<p role="alert" className="py-8">内容读取失败。<button onClick={()=>void query.refetch()}>重试</button></p>:<AdminCard>
      <h2 className="mb-2 font-semibold">{settingsOnly?'站点配置':'内容列表'} <span className="ml-2 text-xs font-normal text-[var(--text-secondary)]">{visible.length} 项</span></h2>
      {settingsOnly&&!visible.length?<div className="py-3"><p className="mb-4 text-xs text-[var(--text-secondary)]">{publicQuery.data?.settings?'当前公开资料 · 尚无管理草稿':'当前默认资料 · 尚未建立管理记录'}</p><ContentPreview draft={{kind:'settings',key:'main',payload:effectiveSiteSettings(publicQuery.data?.settings)}}/></div>:visible.length?visible.map(row=><article key={row.id} className="admin-list-row">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{title(row)||'未命名'}</h3><StatusPill tone={row.deletedAt?'danger':row.status==='active'?'success':'neutral'}>{row.deletedAt?'已删除（可恢复）':statuses[row.status]}</StatusPill></div><div className="admin-list-meta"><span>{labels[row.kind]}</span><span>编号：{row.key}</span><span>内容版本：{row.published?.contentVersion ?? '尚未发布'}</span>{row.kind==='announcement'?<span>{{home:'首页',studio:'创作中心',both:'首页和创作中心'}[row.payload.scope]}</span>:null}</div></div>
        <Button size="sm" onClick={()=>choose(row)} disabled={busy} aria-label={'编辑'+labels[row.kind]+'：'+title(row)}>编辑{labels[row.kind]}</Button>
      </article>):<p className="py-12 text-center text-[var(--text-secondary)]">{rows.length?'没有匹配内容':'暂无内容，请先新建。'}</p>}
    </AdminCard>}
    {editorOpen?<div className="admin-portal fixed inset-0 z-[150] flex items-center justify-center bg-black/35 p-3" hidden={Boolean(confirm)} style={confirm?{display:"none"}:undefined}><div ref={editorDialog} role="dialog" aria-modal="true" aria-labelledby="content-editor-title" tabIndex={-1} className="admin-editor-dialog">
      <header className="admin-editor-header"><div><h2 id="content-editor-title" className="text-lg font-semibold">{selected?'编辑':'新建'}{labels[draft.kind]}</h2><p className="text-xs text-[var(--text-secondary)]">{selected?'编号：'+selected.key+' · 修订 '+selected.revision:'新内容'}</p></div><div className="flex gap-2"><Button disabled={busy} onClick={()=>{if(preview){setPreview(false);return}const parsed=contentDraftSchema.safeParse(draft);if(parsed.success)setPreview(true);else setMessage(parsed.error.issues.map(issue=>issue.message).join('；'))}}>{preview?'继续编辑':'预览草稿'}</Button><Button disabled={busy} aria-label="关闭内容编辑" onClick={()=>setEditorOpen(false)}>关闭</Button></div></header>
      <div className="admin-editor-body">
        {message?<p role="status" className="mb-4 rounded-lg bg-[var(--surface-muted)] p-3 text-sm">{message}</p>:null}
        <fieldset disabled={busy || Boolean(selected?.deletedAt)}>{preview?<ContentPreview draft={draft}/>:<DraftFields draft={draft} onChange={change} existing={Boolean(selected)} dismissalConfirmed={dismissalConfirmed} onDismissalConfirmed={()=>setDismissalConfirmed(true)}/>}</fieldset>
        {selected?.kind==='announcement' && !selected.deletedAt?<Field label="发布时替换已有公告（可选）"><select className={inputClass} value={replacement} onChange={event=>setReplacement(event.target.value)}><option value="">独立发布</option>{rows.filter(row=>row.kind==='announcement' && row.id!==selected.id && !row.deletedAt && !row.withdrawn && row.published).map(row=><option key={row.id} value={row.id}>{title(row)} · 修订 {row.revision}</option>)}</select></Field>:null}
        {selected?.history.length?<details className="mt-5"><summary>发布历史（{selected.history.length}）</summary>{selected.history.map(item=><details key={item.id} className="mt-3 border-t border-[var(--border-subtle)] pt-3"><summary>内容版本 {item.contentVersion} · {new Date(item.publishedAt).toLocaleString()}</summary><p className="my-2 break-all text-xs">校验值 {item.hash}</p><ContentPreview draft={{kind:selected.kind,key:selected.key,payload:item.payload} as ContentDraft}/></details>)}</details>:null}
      </div>
      <footer className="admin-editor-footer"><span className="text-xs text-[var(--text-secondary)]">{dirty?'有未保存草稿':selected?'服务器草稿已保存':'尚未保存'}</span><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={()=>setEditorOpen(false)}>取消</Button>{selected?<>{selected.deletedAt?<Button disabled={busy} onClick={()=>setConfirm('restore')}>恢复</Button>:<><Button disabled={busy} onClick={()=>setConfirm('withdraw')}>撤下</Button><Button disabled={busy} onClick={()=>setConfirm('delete')}>删除</Button><Button disabled={busy || dirty} onClick={()=>setConfirm('publish')}>发布已保存草稿</Button></>}</>:null}<Button variant="primary" disabled={busy || Boolean(selected?.deletedAt)} onClick={()=>void save()}>{busy?'处理中…':'保存草稿'}</Button></div></footer>
    </div></div>:null}
    {confirm?<div className="admin-portal fixed inset-0 z-[160] flex items-center justify-center bg-black/35 p-4"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="content-confirm" tabIndex={-1} className="max-h-[85dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl bg-[var(--surface-default)] p-6"><h2 id="content-confirm" className="font-semibold">确认{{publish:'发布',withdraw:'撤下',delete:'删除',restore:'恢复'}[confirm]}{labels[draft.kind]}？</h2><p className="text-sm">{confirm==='publish'?'将发布当前已保存草稿，并保留发布历史。':confirm==='delete'?'内容将停止公开展示，之后可以恢复。':confirm==='restore'?'恢复内容记录；原来的发布与撤下状态将保留。':'内容将停止公开展示。'}{(draft.kind==='terms'||draft.kind==='privacy') && confirm!=='publish'?'此操作可能使新用户注册暂时不可用。':''}</p>{confirm==='publish'?<ContentPreview draft={draft}/>:null}{message?<p role="status">{message}</p>:null}<div className="flex gap-3"><Button disabled={busy} onClick={()=>void operate()}>{busy?'处理中…':'确认'}</Button><Button disabled={busy} onClick={()=>setConfirm(null)}>取消</Button></div></div></div>:null}
  </>
}
export function AdminSiteSettingsPage(){return <AdminContentPage settingsOnly/>}
