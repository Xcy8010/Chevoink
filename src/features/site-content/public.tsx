import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Megaphone, X } from 'lucide-react'
import type { PublicSiteContent } from '../../../shared/contracts/site-content'
import './announcements.css'
import { dismissalIsActive, dismissalKey, usePublicSiteContent } from './public-api'
import { useAnnouncementInbox } from './announcement-inbox-api'

function readDismissals(storage: Storage, key = 'site-announcement-dismissals'): Record<string, number> {
  try { const value: unknown=JSON.parse(storage.getItem(key) ?? '{}'); return value && typeof value==='object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string,number]=>typeof entry[1]==='number')) : {} } catch { return {} }
}
const studioDockSuppressionKey = 'studio-announcement-dock-suppressed'
type PublicAnnouncement=PublicSiteContent['announcements'][number]
function AnnouncementDialog({item,index,total,onClose,onDismiss,onPrevious,onNext,returnFocus,id,scope}:{scope:'home'|'studio';item:PublicAnnouncement;index:number;total:number;onClose:()=>void;onDismiss:()=>void;onPrevious:()=>void;onNext:()=>void;returnFocus:HTMLElement|null;id:string}) {
  const dialog=useRef<HTMLDialogElement>(null)
  const titleId=useId()
  useEffect(()=>{
    const node=dialog.current!
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null
    const overflow=document.body.style.overflow
    document.body.style.overflow='hidden'
    node.showModal()
    node.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true})
    return()=>{node.close();document.body.style.overflow=overflow;const target=returnFocus?.isConnected?returnFocus:previous;if(target?.isConnected)target.focus({preventScroll:true})}
  },[returnFocus])
  return createPortal(<dialog ref={dialog} id={id} data-native-back-dismiss aria-modal="true" aria-labelledby={titleId} onKeyDown={event=>{
    if(event.key!=='Tab')return
    const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const first=buttons[0],last=buttons[buttons.length-1]
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }} onCancel={event=>{event.preventDefault();onClose()}} onClick={event=>{
    if(event.target!==event.currentTarget)return
    const rect=event.currentTarget.getBoundingClientRect()
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose()
  }} className={'site-announcement-dialog'+(scope==='studio'?' studio-workspace':'')}>
    <div className="site-announcement-dialog-frame">
      <header className="site-announcement-dialog-header"><h2 id={titleId} className="min-w-0 text-base font-semibold">{item.title}</h2><button type="button" onClick={onClose} aria-label="关闭公告弹窗" className="site-announcement-dialog-close"><X aria-hidden="true" size={18}/></button></header>
      <div key={dismissalKey(item.id,item.contentVersion)} className="site-announcement-dialog-body"><p className="whitespace-pre-wrap break-words text-sm leading-7">{item.body}</p></div>
      <footer className="site-announcement-dialog-footer">{total>1?<nav aria-label="公告切换" className="flex items-center gap-2"><button type="button" aria-label="上一条公告" disabled={index===0} onClick={onPrevious} className="site-announcement-dialog-close"><ChevronLeft aria-hidden="true" size={18}/></button><span className="text-xs tabular-nums text-[var(--text-secondary)]">{index+1} / {total}</span><button type="button" aria-label="下一条公告" disabled={index===total-1} onClick={onNext} className="site-announcement-dialog-close"><ChevronRight aria-hidden="true" size={18}/></button></nav>:<span/>}<button type="button" onClick={onDismiss} className="rounded-lg border border-[var(--border-strong)] px-3 py-2 text-sm hover:bg-[var(--surface-muted)]">关闭本条公告</button></footer>
    </div>
  </dialog>,document.fullscreenElement??document.body)
}
export function SiteAnnouncements({scope}:{scope:'home'|'studio'}) {
  const query=usePublicSiteContent()
  const { query: inbox, read, viewerId } = useAnnouncementInbox(scope === 'studio')
  const [dismissed,setDismissed]=useState<Record<string,number>>({})
  const [dockSuppressed, setDockSuppressed] = useState(() => scope === 'studio' ? readDismissals(sessionStorage, studioDockSuppressionKey) : {})
  const [openedKey,setOpenedKey]=useState<string|null>(null)
  const origin=useRef<HTMLElement|null>(null)
  const dialogId=useId()
  const data=query.data
  if (!data) return null
  const now=Date.parse(data.serverNow)+Date.now()-query.dataUpdatedAt
  const items=data.announcements.filter(item=>{
    const key=dismissalKey(item.id,item.contentVersion)
    const stored=readDismissals(item.dismissal.mode==='session' ? sessionStorage : localStorage)
    return !(key in dockSuppressed) && (item.scope===scope || item.scope==='both') && now >= Date.parse(item.startsAt) && (item.endsAt === null || now < Date.parse(item.endsAt)) && !dismissalIsActive(dismissed[key] ?? stored[key],item.dismissal,now)
  })
  if (!items.length) return null
  const unread = new Map((inbox.data?.items ?? []).filter(item => item.unread).map(item => [dismissalKey(item.id, item.contentVersion), item.versionId]))
  const eligible = new Map(items.map(item => [dismissalKey(item.id, item.contentVersion), item]))
  const newestUnread = scope === 'studio' ? [...unread.keys()].find(key => eligible.has(key)) : undefined
  const first = (newestUnread && eligible.get(newestUnread)) || items[0]
  const index = items.findIndex(item => dismissalKey(item.id, item.contentVersion) === openedKey)
  const active = index < 0 ? null : items[index]

  function openItem(item: PublicAnnouncement) {
    const key = dismissalKey(item.id, item.contentVersion)
    setOpenedKey(key)
    const versionId = unread.get(key)
    if (viewerId && versionId) read.mutate({ viewerId, action: 'one', versionId })
  }
  function dismiss(item:PublicAnnouncement, collapseDock = false) {
    const key=dismissalKey(item.id,item.contentVersion)
    const storage=item.dismissal.mode==='session' ? sessionStorage : localStorage
    const entries={...readDismissals(storage),[key]:now}
    try { storage.setItem('site-announcement-dismissals',JSON.stringify(Object.fromEntries(Object.entries(entries).sort((a,b)=>b[1]-a[1]).slice(0,100)))) } catch { /* The current view still dismisses when browser storage is unavailable. */ }
    setDismissed(current=>({...current,[key]:now}))
    if (collapseDock) {
      // Dismiss the card once. Other items in this batch remain in the bell inbox.
      const suppressed = { ...dockSuppressed }
      for (const candidateKey of eligible.keys()) if (candidateKey !== key) suppressed[candidateKey] = now
      setDockSuppressed(suppressed)
      try { sessionStorage.setItem(studioDockSuppressionKey, JSON.stringify(suppressed)) } catch { /* In-memory suppression still applies. */ }
      setOpenedKey(null)
    } else if (openedKey === key) {
      const next = items.find(candidate => dismissalKey(candidate.id, candidate.contentVersion) !== key)
      setOpenedKey(next ? dismissalKey(next.id, next.contentVersion) : null)
    }
  }
  return <div aria-label="站点公告" className={scope==='studio'?'site-announcements-studio':'site-announcements-home'}>
    <aside className={'site-announcement-card '+(scope==='studio'?'site-announcement-dock':'site-announcement-banner')}>
      {scope === 'studio' && <button
        type="button"
        aria-label={'关闭公告：'+first.title}
        onClick={() => dismiss(first, true)}
        className="site-announcement-dismiss site-announcement-dock-action"
      >
        <ChevronRight aria-hidden="true" size={16} className="site-announcement-dock-chevron" />
        <X aria-hidden="true" size={16} className="site-announcement-dock-close" />
      </button>}
      <button type="button" aria-label={'打开公告：'+first.title} aria-haspopup="dialog" aria-expanded={Boolean(active)} aria-controls={dialogId} className="site-announcement-open" onClick={event=>{origin.current=event.currentTarget;openItem(first)}}>
        {scope === 'home' && <Megaphone aria-hidden="true" size={16} className="shrink-0 text-[var(--text-secondary)]" />}
        <span className="min-w-0 flex-1 text-left">
          <span className={'block text-sm font-medium ' + (scope === 'studio' ? 'site-announcement-dock-title' : 'truncate')}>{first.title}</span>
          {scope === 'home' && <span className="block truncate text-xs text-[var(--text-secondary)]">{first.body}</span>}
        </span>
        {items.length > 1 && <span className="shrink-0 text-xs text-[var(--text-secondary)]">{items.length}条</span>}
        {scope === 'home' && <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-[var(--text-secondary)]" />}
      </button>
      {scope === 'home' && <button type="button" aria-label={'关闭公告：'+first.title} onClick={() => dismiss(first)} className="site-announcement-dismiss"><X aria-hidden="true" size={16} /></button>}
    </aside>
    {active?<AnnouncementDialog scope={scope} item={active} index={index} total={items.length} id={dialogId} returnFocus={origin.current} onClose={()=>setOpenedKey(null)} onDismiss={()=>dismiss(active)} onPrevious={()=>openItem(items[index-1])} onNext={()=>openItem(items[index+1])}/>:null}
  </div>
}
export function SiteInformation() {
  const {data}=usePublicSiteContent()
  const settings=data?.settings
  if (!settings) return null
  return <footer className="space-y-3 border-t border-[var(--border-subtle)] py-6 text-sm text-[var(--text-secondary)]"><div className="flex items-center gap-3">{settings.logoUrl ? <img src={settings.logoUrl} alt="" className="h-8 w-8 object-contain"/> : null}<strong>{settings.name}</strong></div>{settings.about ? <p className="whitespace-pre-wrap">{settings.about}</p> : null}<nav className="flex flex-wrap gap-4">{settings.navigation.map(link=><a key={link.url} href={link.url}>{link.label}</a>)}<a href="/account/docs">{settings.docsLabel}</a></nav>{settings.contact.details ? <p className="whitespace-pre-wrap">{settings.contact.details}</p>:null}{settings.contact.url ? <a className="block underline" href={settings.contact.url}>{settings.contact.label || '联系我们'}</a>:null}<p className="whitespace-pre-wrap">{settings.footer}</p></footer>
}