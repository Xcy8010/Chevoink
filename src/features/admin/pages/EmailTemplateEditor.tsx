import { useId, useRef, useState, type ChangeEvent } from 'react'
import { Eye, FilePlus2, FileUp, Mail, ChevronRight } from 'lucide-react'
import { emailLibraryEntrySchema, emailVariables, type EmailLibraryEntry } from '../../../../shared/contracts/email-library'
import { governanceLibrary, returnMail } from './email-composer'
import approvedHtml from './creator-return.html?raw'
const htmlEsc = (s: string) => s.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]!))
function documentHtml(body: string, vars: Record<string,string>) {
  const markup = /<(?:html|table|div|p|body|h[1-6])\b/i.test(body)
  const template = document.createElement('template')
  const source = markup ? body : '<p style="white-space:pre-wrap;font:16px/1.65 system-ui">' + htmlEsc(body) + '</p>'
  template.innerHTML = source.replace(/{{\s*([\w]+)\s*}}/g, (literal, key: string) => htmlEsc(Object.prototype.hasOwnProperty.call(vars,key) && vars[key] ? vars[key] : literal))
  template.content.querySelectorAll('script,iframe,object,embed,form,base,link,meta,svg,math,audio,video,source').forEach(node => node.remove())
  template.content.querySelectorAll('*').forEach(node => {
    for (const attr of Array.from(node.attributes)) {
      if (/^on|^(href|src|srcset|background|target|action|ping|srcdoc)$/i.test(attr.name)) node.removeAttribute(attr.name)
    }
  })
  if (body === approvedHtml || governanceLibrary.some(entry => entry.body === body)) template.content.querySelector('img')?.setAttribute('src', location.origin + '/favicon.png')
  return '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src '+location.origin+'; base-uri \'none\'; form-action \'none\'"><style>body{margin:0;background:white;color:#222}*{box-sizing:border-box}table{max-width:100%}</style>' + template.innerHTML
}
export function MailProof({ template, values }: {template: EmailLibraryEntry; values: Record<string,string>}) {
  return <div className="mail-proof"><div className="mail-proof-title"><Eye size={16}/>邮件预览</div><div className="mail-proof-subject">{template.subject.replace(/{{\s*([\w]+)\s*}}/g,(literal,k:string)=>Object.prototype.hasOwnProperty.call(values,k) && values[k] ? values[k]:literal) || '邮件主题'}</div>
    <iframe title="邮件正文预览" sandbox="" referrerPolicy="no-referrer" srcDoc={documentHtml(template.body,values)}/></div>
}

function TemplateBodyField({ body, onChange }: { body: string; onChange: (body: string) => void }) {
  const fieldId = useId()
  const chooser = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const revision = useRef(0)

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const current = ++revision.current
    setError('')
    if (!/\.(?:html?|txt)$/i.test(file.name) || file.size > 262144) {
      setError('请选择 256 KB 以内的 HTML 或 TXT 文件。')
      return
    }
    try {
      const text = await file.text()
      if (revision.current !== current || !chooser.current) return
      if (!text.trim() || text.length > 65536) {
        setError('文件正文须为 1 至 65536 个字符。')
        return
      }
      onChange(text)
      setFileName(file.name)
    } catch {
      if (revision.current === current) setError('读取文件失败，请重新选择。')
    }
  }

  return <div className="mail-body-field">
    <div className="mail-body-toolbar">
      <label htmlFor={fieldId}>模板正文</label>
      <button type="button" className="mail-import-button" onClick={() => chooser.current?.click()}>
        <FileUp size={15} aria-hidden="true"/>{body.trim() ? '从文件替换' : '导入文件'}
      </button>
      <input ref={chooser} type="file" hidden accept=".html,.htm,.txt" aria-label="选择正文文件" onChange={importFile}/>
    </div>
    <textarea id={fieldId} rows={6} maxLength={65536} placeholder="输入 HTML 或纯文本，变量写作 {{name}}" value={body}
      onChange={event => {
        revision.current++
        setFileName('')
        setError('')
        onChange(event.target.value)
      }}/>
    {error && <small role="alert">{error}</small>}
    {fileName && <small role="status">已导入 {fileName}</small>}
  </div>
}

export function TemplateLibrary({ items, choose, save, error, loading }: {
  items: EmailLibraryEntry[]; choose:(item:EmailLibraryEntry)=>void; save:(item:EmailLibraryEntry)=>Promise<void>; error?:string;loading:boolean
}) {
  const [edit,setEdit] = useState(false)
  const [selected,setSelected] = useState<EmailLibraryEntry>(returnMail)
  const [draft,setDraft] = useState({id:'',name:'',subject:'',body:''})
  const [problem,setProblem] = useState('')
  const [saving,setSaving] = useState(false)
  const selectedGovernance = governanceLibrary.find(entry => entry.id === selected.id)
  const sample = edit ? {...draft,id:Number(draft.id)} : selected
  const [values,setValues] = useState<Record<string,string>>({})
  async function persist() {
    setProblem('')
    const result = emailLibraryEntrySchema.safeParse(sample)
    if (!result.success) { setProblem(result.error.issues[0]?.code==='custom' ? result.error.issues[0].message : '请填写有效的 SES 模板 ID、名称、邮件主题和正文。'); return }
    setSaving(true)
    try { await save(result.data); setSelected(result.data); setDraft({id:'',name:'',subject:'',body:''}); setEdit(false) }
    catch (e) { setProblem(e instanceof Error ? e.message : '模板保存失败。') }
    finally { setSaving(false) }
  }
  return <div className="mail-columns"><section className="mail-sheet">
    <header className="mail-heading"><h2>{edit ? '添加模板' : '模板库'}</h2>{!edit && <button className="mail-secondary" onClick={()=>{setEdit(true);setValues({});setProblem('')}}><FilePlus2 size={16}/>添加模板</button>}</header>
    {error && <p role="alert">{error}</p>}{loading && <p role="status">正在读取模板…</p>}
    {edit ? <div className="mail-fields">
      <label>腾讯云 SES 模板 ID<input type="number" min="1" value={draft.id} onChange={e=>setDraft({...draft,id:e.target.value})}/></label>
      <label>模板名称<input maxLength={80} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <label>邮件主题<input maxLength={150} value={draft.subject} onChange={e=>setDraft({...draft,subject:e.target.value})}/></label>
      <TemplateBodyField body={draft.body} onChange={body => setDraft(old => ({ ...old, body }))}/>
      <div className="mail-actions"><button className="mail-primary" disabled={saving} onClick={()=>void persist()}>保存模板</button><button className="mail-secondary" onClick={()=>{setEdit(false);setProblem('')}}>取消</button></div>
    </div> : <><div className="mail-template-list">{items.map(t=><button key={t.id} aria-pressed={t.id===selected.id} onClick={()=>{setSelected(t);setValues({})}}><Mail size={18}/><span><b>{t.name}</b><small>{t.id ? 'SES · '+t.id : '内置模板'}</small></span><ChevronRight size={16}/></button>)}</div>
    {selectedGovernance ? <div className="space-y-3"><p className="text-sm text-[var(--text-secondary)]">对应决定记录后，系统向当事人发送此通知。</p><a className="mail-primary" href={selectedGovernance.to}>{selectedGovernance.action}</a></div> : <button className="mail-primary" onClick={()=>choose(selected)}>使用此模板</button>}</>}
    {problem && <p role="alert">{problem}</p>}</section>
    <section className="mail-library-proof">{emailVariables(sample.subject+'\n'+sample.body).length>0 && <details className="mail-sheet"><summary>填写变量预览</summary><div className="mail-fields">{emailVariables(sample.subject+'\n'+sample.body).map(k=><label key={k}>{k}<input value={Object.prototype.hasOwnProperty.call(values,k)?values[k]:''} onChange={e=>setValues({...values,[k]:e.target.value})}/></label>)}</div></details>}<MailProof template={sample} values={values}/></section></div>
}
