import { useLocation } from 'react-router-dom'
import { Skeleton } from '@/components/ui/Skeleton'
import './admin-loading.css'

type Layout = 'rows' | 'list' | 'profile' | 'mail' | 'governance' | 'dashboard'

function Rows({ count = 4 }: { count?: number }) {
  return <div className="divide-y divide-[var(--border-subtle)]">{Array.from({ length: count }, (_, i) =>
    <div key={i} className="flex min-h-16 items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-3 w-2/5 max-w-56"/><Skeleton className="h-2 w-3/5 max-w-80"/></div>
      <Skeleton className="h-5 w-12 shrink-0 rounded-full"/>
    </div>)}</div>
}

function Metrics() {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{Array.from({ length: 4 }, (_, i) =>
    <div key={i} className="admin-loading-card space-y-3 px-4 py-3"><Skeleton className="h-3 w-16"/><Skeleton className="h-5 w-8"/></div>)}</div>
}

function Tabs() {
  return <div className="flex min-h-11 items-center gap-4 border-b border-[var(--border-default)] px-2">
    {[0,1,2,3].map(i => <Skeleton key={i} className="h-3 w-14"/>)}
  </div>
}

function MailColumns() {
  return <div className="admin-loading-mail-columns">
    <div className="admin-loading-card p-4 sm:p-6"><Skeleton className="mb-4 h-5 w-24"/><Rows count={5}/></div>
    <div className="space-y-3"><div className="admin-loading-card p-4"><Skeleton className="h-4 w-32"/></div>
      <div className="admin-loading-card space-y-6 p-5"><Skeleton className="h-4 w-24"/><Skeleton className="h-6 w-2/3"/>
        <div className="min-h-48 space-y-4 rounded-lg border border-[var(--border-subtle)] p-5"><Skeleton className="h-6 w-2/3"/><Skeleton className="h-3 w-full"/><Skeleton className="h-3 w-4/5"/></div>
      </div></div>
  </div>
}

function Profile() {
  return <><div className="admin-loading-card flex items-center gap-4 p-5"><Skeleton className="h-14 w-14 shrink-0 rounded-full"/>
    <div className="flex-1 space-y-3"><Skeleton className="h-5 w-24"/><Skeleton className="h-3 w-2/5"/></div></div><Metrics/></>
}

export function AdminLoading({ layout = 'rows', title = false, label = '加载中…' }: { layout?: Layout; title?: boolean; label?: string }) {
  return <div role="status" aria-busy="true" className={layout === 'mail' ? 'admin-loading-mail' : undefined} data-admin-loading={layout}>
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className="space-y-4">
      {title && <Skeleton className="h-7 w-32"/>}
      {layout === 'mail' ? <><Tabs/><MailColumns/></> : layout === 'profile' ? <Profile/> : <>
        {(layout === 'dashboard' || layout === 'governance') && <Metrics/>}
        {layout === 'governance' && <><Tabs/><Skeleton className="h-8 w-40"/></>}
        <div className={layout === 'rows' ? undefined : 'admin-loading-card'}><Rows/></div>
      </>}
    </div>
  </div>
}

export function AdminRouteLoading({ shell = false, collapsed = false }: { shell?: boolean; collapsed?: boolean }) {
  const { pathname } = useLocation()
  let layout: Layout = 'list'
  if (pathname === '/admin/email') layout = 'mail'
  else if (pathname.startsWith('/admin/governance')) layout = 'governance'
  else if (/^\/admin\/users\/[^/]+\/?$/.test(pathname)) layout = 'profile'
  else if (/^\/admin\/?$/.test(pathname)) layout = 'dashboard'
  if (!shell) return <AdminLoading layout={layout} title/>
  return <div className="admin-workspace flex h-[100dvh] overflow-hidden bg-[var(--app-bg)]" data-admin-loading-shell="">
    {!collapsed && <div aria-hidden="true" className="admin-sidebar hidden w-[248px] shrink-0 space-y-7 border-r border-[var(--border-default)] p-5 md:block">
      <Skeleton className="mb-8 h-9 w-28"/>{[0,1,2,3,4,5].map(i => <Skeleton key={i} className="h-4 w-2/3"/>)}</div>}
    <div className="min-w-0 flex-1 overflow-hidden">
      <div aria-hidden="true" className="flex min-h-16 items-center justify-between border-b border-[var(--border-default)] bg-[var(--surface-default)] px-4 md:px-8"><Skeleton className="h-4 w-24"/><Skeleton className="h-8 w-28"/></div>
      <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 md:px-8 md:pt-8"><AdminLoading layout={layout} title label="正在校验管理员身份…"/></div>
      <div aria-hidden="true" className="fixed inset-x-0 bottom-0 grid h-16 grid-cols-5 place-items-center border-t border-[var(--border-default)] bg-[var(--surface-default)] md:hidden">
        {[0,1,2,3,4].map(i => <Skeleton key={i} className="h-6 w-6"/>)}</div>
    </div>
  </div>
}
