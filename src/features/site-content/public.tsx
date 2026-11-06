import { useState } from 'react'
import { dismissalIsActive, dismissalKey, usePublicSiteContent } from './public-api'

function readDismissals(storage: Storage): Record<string, number> {
  try { const value: unknown=JSON.parse(storage.getItem('site-announcement-dismissals') ?? '{}'); return value && typeof value==='object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string,number]=>typeof entry[1]==='number')) : {} } catch { return {} }
}
export function SiteAnnouncements({scope}:{scope:'home'|'studio'}) {
  const query=usePublicSiteContent()
  const [dismissed,setDismissed]=useState<Record<string,number>>({})
  const data=query.data
  if (!data) return null
  const now=Date.parse(data.serverNow)+Date.now()-query.dataUpdatedAt
  const items=data.announcements.filter(item=>{
    const key=dismissalKey(item.id,item.contentVersion)
    const stored=readDismissals(item.dismissal.mode==='session' ? sessionStorage : localStorage)
    return (item.scope===scope || item.scope==='both') && now >= Date.parse(item.startsAt) && (item.endsAt === null || now < Date.parse(item.endsAt)) && !dismissalIsActive(dismissed[key] ?? stored[key],item.dismissal,now)
  })
  return <div aria-label="站点公告" className={scope === 'studio' ? 'max-h-32 shrink-0 space-y-2 overflow-y-auto' : 'space-y-2'}>{items.map(item=><aside key={dismissalKey(item.id,item.contentVersion)} className="flex items-start gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-3 text-sm"><div className="min-w-0 flex-1"><p className="font-medium">{item.title}</p><p className="mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{item.body}</p></div><button type="button" aria-label={`关闭公告：${item.title}`} onClick={()=>{
    const key=dismissalKey(item.id,item.contentVersion)
    const storage=item.dismissal.mode==='session' ? sessionStorage : localStorage
    const entries={...readDismissals(storage),[key]:now}
    try { storage.setItem('site-announcement-dismissals',JSON.stringify(Object.fromEntries(Object.entries(entries).sort((a,b)=>b[1]-a[1]).slice(0,100)))) } catch { /* The current view still dismisses when browser storage is unavailable. */ }
    setDismissed(current=>({...current,[key]:now}))
  }}>关闭</button></aside>)}</div>
}
export function SiteInformation() {
  const {data}=usePublicSiteContent()
  const settings=data?.settings
  if (!settings) return null
  return <footer className="space-y-3 border-t border-[var(--border-subtle)] py-6 text-sm text-[var(--text-secondary)]"><div className="flex items-center gap-3">{settings.logoUrl ? <img src={settings.logoUrl} alt="" className="h-8 w-8 object-contain"/> : null}<strong>{settings.name}</strong></div>{settings.about ? <p className="whitespace-pre-wrap">{settings.about}</p> : null}<nav className="flex flex-wrap gap-4">{settings.navigation.map(link=><a key={link.url} href={link.url}>{link.label}</a>)}<a href="/account/docs">{settings.docsLabel}</a></nav>{settings.contact.details ? <p className="whitespace-pre-wrap">{settings.contact.details}</p>:null}{settings.contact.url ? <a className="block underline" href={settings.contact.url}>{settings.contact.label || '联系我们'}</a>:null}<p className="whitespace-pre-wrap">{settings.footer}</p></footer>
}