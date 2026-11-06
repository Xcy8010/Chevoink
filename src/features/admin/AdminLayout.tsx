import { useEffect, useLayoutEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, LayoutDashboard, Menu, Search, Users, Workflow, Pin, X, FileText, MessageSquare, CreditCard, Activity, Settings, Shield, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import Button from '@/components/ui/Button'
import TextInput from './components/AdminTextInput'
import { useToast } from '@/components/ui/toast-context'
import { useAutoHideScrollbars } from '@/hooks/useAutoHideScrollbars'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import type { Pagination } from '../../../shared/contracts/index.js'
import { adminLogout } from './api'
import { useAdminSession } from './admin-shared'
import { adminNavigation, adminCurrentPage, searchAdminPages } from './admin-navigation'
import './admin-workspace.css'
import { useAdminDialog } from './admin-dialog'
import { clearAdminModelHistoryDrafts } from './components/AdminModelDraftRecovery'

let draftSessionOwner: string | null = null
const scrollPositions = new Map<string, number>()
const pageIcons: Record<string, typeof Users> = { '/admin/content': FileText, '/admin/site-settings': Settings, '/admin/testers': Users, '/admin/app-releases': Workflow, '/admin/users': Users, '/admin/credits': CreditCard, '/admin/novels': BookOpen, '/admin/posts': MessageSquare, '/admin/comments': MessageSquare, '/admin/feedback': MessageSquare, '/admin/messages': MessageSquare, '/admin/creation-records': Activity, '/admin/evals': Activity, '/admin/craft': FileText, '/admin/models': Workflow, '/admin/tokens': Activity, '/admin/settings': Settings, '/admin/logs': Shield }
const mobileItems = [
  { to: '/admin', label: '总览', icon: LayoutDashboard },
  { to: '/admin/users', label: '用户', icon: Users },
  { to: '/admin/novels', label: '内容', icon: BookOpen },
  { to: '/admin/models', label: '模型', icon: Workflow },
]
export default function AdminLayout({ children }: { children?: ReactNode }) {
  const toast = useToast()
  const { admin, isLoading, denied } = useAdminSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('chevoink-admin-sidebar-collapsed') === 'true')
  const [search, setSearch] = useState('')
  const [pinned, setPinned] = useState(() => localStorage.getItem('chevoink-admin-model-pin') !== 'false')
  const mobileDialogRef = useAdminDialog(moreOpen, () => setMoreOpen(false))
  const mainRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const theme = useShellStore(state => state.theme)
  const toggleTheme = useShellStore(state => state.toggleTheme)
  useEffect(() => {
    if (denied || (!isLoading && !admin)) {
      clearAdminModelHistoryDrafts(); draftSessionOwner = null
    } else if (admin) {
      if (draftSessionOwner && draftSessionOwner !== admin.id) clearAdminModelHistoryDrafts()
      draftSessionOwner = admin.id
    }
  }, [admin, denied, isLoading])
  const currentPage = adminCurrentPage(location.pathname)
  const currentGroup = adminNavigation.find(group => group.items.some(item => item.to === currentPage.to))?.label
  const [expanded, setExpanded] = useState<string[]>(currentGroup ? [currentGroup] : [])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const desktop = window.matchMedia('(min-width: 768px)')
    const closeMobileNavigation = () => { if (desktop.matches) setMoreOpen(false) }
    closeMobileNavigation()
    desktop.addEventListener('change', closeMobileNavigation)
    return () => desktop.removeEventListener('change', closeMobileNavigation)
  }, [])
  useAutoHideScrollbars()
  useEffect(() => {
    // Admin accessibility must not alter author-side viewport behavior.
    const viewport = document.querySelector('meta[name="viewport"]')
    const original = viewport?.getAttribute('content')
    viewport?.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content')
    return () => { if (original) viewport?.setAttribute('content', original) }
  }, [])
  useLayoutEffect(() => {
    const main = mainRef.current
    const content = contentRef.current
    if (!main || !content) return
    const key = location.pathname + location.search
    const target = scrollPositions.get(key) ?? 0
    let restoring = true
    const restore = () => { if (!restoring) return; main.scrollTop = target; if (main.scrollTop >= target - 1) restoring = false }
    const cancel = () => { restoring = false }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore)
    observer?.observe(content)
    restore()
    main.addEventListener('wheel', cancel, { passive: true })
    main.addEventListener('touchstart', cancel, { passive: true })
    main.addEventListener('keydown', cancel)
    return () => {
      scrollPositions.set(key, main.scrollTop)
      if (scrollPositions.size > 100) scrollPositions.delete(scrollPositions.keys().next().value!)
      observer?.disconnect()
      main.removeEventListener('wheel', cancel)
      main.removeEventListener('touchstart', cancel)
      main.removeEventListener('keydown', cancel)
    }
  }, [location.pathname, location.search, isLoading])
  useEffect(() => { if (currentGroup) setExpanded(value => value.includes(currentGroup) ? value : [currentGroup]) }, [currentGroup])
  if (denied) return <Navigate to="/admin/login" replace />
  if (isLoading) return <div role="status" className="flex h-[100dvh] items-center justify-center text-sm">正在校验管理员身份…</div>
  if (!admin) return <div role="alert" className="p-8">暂时无法校验管理员身份，请刷新重试。</div>
  const logout = async () => {
    if (isLoggingOut) return
    setIsLoggingOut(true)
    try { await adminLogout(); clearAdminModelHistoryDrafts(); draftSessionOwner = null; navigate('/admin/login', { replace: true }) }
    catch { toast.error('暂时无法确认退出登录，请稍后重试。') }
    finally { setIsLoggingOut(false) }
  }
  const navigation = (mobile = false) => <>
    <NavLink to="/admin" end className="admin-nav-link" onClick={() => setMoreOpen(false)}><LayoutDashboard size={17} /><span>总览</span></NavLink>
    {pinned ? <NavLink to="/admin/models" className="admin-nav-link" onClick={() => setMoreOpen(false)}><Workflow size={17} />模型中心 <span className="ml-auto text-xs text-[var(--text-secondary)]">常用</span></NavLink> : null}
    <button type="button" className="flex min-h-11 w-full items-center gap-2 px-3 text-xs text-[var(--text-tertiary)]" onClick={() => { setPinned(!pinned); localStorage.setItem('chevoink-admin-model-pin', String(!pinned)) }}><Pin size={13} />{pinned ? '取消固定模型中心' : '固定模型中心'}</button>
    {adminNavigation.map(group => <section key={group.label} className="mt-3">
      <button type="button" className="admin-nav-group" aria-expanded={mobile || expanded.includes(group.label)} onClick={() => setExpanded(value => value.includes(group.label) ? value.filter(label => label !== group.label) : [...value, group.label])}>
        {group.label}<ChevronDown size={14} className={expanded.includes(group.label) || mobile ? '' : '-rotate-90'} />
      </button>
      {mobile || expanded.includes(group.label) ? <div className="space-y-1">{group.items.map(item => { const Icon = pageIcons[item.to]; return <NavLink key={item.to} to={item.to} className="admin-nav-link" onClick={() => setMoreOpen(false)}><Icon size={17} />{item.label}</NavLink> })}</div> : null}
    </section>)}
  </>
  return <div className="admin-workspace flex h-[100dvh] overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
    <a href="#admin-main" className="admin-skip-link">跳到主要内容</a>
    <aside style={{ visibility: sidebarCollapsed ? 'hidden' : undefined }} className={cn(sidebarCollapsed ? 'w-0 overflow-hidden border-r-0' : 'w-[248px]', "admin-sidebar hidden h-full shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--surface-default)] md:flex")}>
      <Link to="/admin" className="flex min-h-[72px] items-center gap-3 px-6"><img src="/favicon.png" alt="启创墨域 Logo" width={44} height={44} className="h-11 w-11 shrink-0 rounded-md object-contain" /><span><strong className="block text-base">启创墨域</strong><span className="text-xs text-[var(--text-tertiary)]">管理工作台</span></span></Link>
      <nav aria-label="后台业务导航" className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">{navigation()}</nav>
      <div className="border-t border-[var(--border-default)] px-6 py-4 text-xs text-[var(--text-tertiary)]">{admin.isSuperAdmin ? '超级管理员' : '管理员'} · 管理控制台</div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="relative z-40 flex min-h-[64px] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-default)] bg-[var(--surface-default)] px-4 py-2 md:px-8">
        <div className="flex items-center gap-2 text-sm"><button type="button" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(value => { localStorage.setItem('chevoink-admin-sidebar-collapsed', String(!value)); return !value })} className="hidden h-11 w-11 items-center justify-center rounded-lg hover:bg-[var(--surface-muted)] md:inline-flex">{sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button><span className="hidden text-[var(--text-tertiary)] lg:inline">{currentGroup ?? '工作台'} /</span><span className="font-medium">{currentPage.label}</span></div>
        <div className="flex items-center gap-2">
          <div className="relative"><TextInput aria-label="搜索后台页面及操作" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setSearch('') }} placeholder="搜索页面与操作" leading={<Search size={16} />} className="w-40 bg-[var(--surface-muted)] sm:w-60" />
            {search ? <div role="region" aria-label="页面搜索结果" className="absolute right-0 top-full z-50 mt-2 max-h-[65dvh] w-[min(320px,90vw)] overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-2 shadow-lg">{searchAdminPages(search).length ? searchAdminPages(search).map(item => <Link key={item.to} to={item.to} onClick={() => setSearch('')} className="flex min-h-11 items-center rounded-lg px-3 text-sm hover:bg-[var(--surface-muted)]">{item.label}</Link>) : <p role="status" className="p-3 text-sm">没有匹配页面</p>}</div> : null}
          </div>
          <Link to="/admin#attention" className="hidden min-h-11 shrink-0 items-center whitespace-nowrap px-3 text-sm sm:flex">待办</Link>
          <details className="relative shrink-0"><summary aria-label="管理员账号菜单" className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-sm"><span className="max-w-24 truncate">{admin.nickname || '管理员'}</span><ChevronDown size={14} /></summary><div className="absolute right-0 z-50 mt-2 w-44 rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-2 shadow-lg"><button type="button" className="admin-menu-item" onClick={toggleTheme}>{theme === 'light' ? '切换深色主题' : '切换浅色主题'}</button><Link to="/" className="admin-menu-item">返回主站</Link><button type="button" className="admin-menu-item" disabled={isLoggingOut} onClick={() => void logout()}>{isLoggingOut ? '正在退出…' : '退出登录'}</button></div></details>
        </div>
      </header>
      <main id="admin-main" ref={mainRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain"><div ref={contentRef} className="mx-auto w-full max-w-[1680px] px-4 pb-[calc(96px+var(--safe-bottom))] pt-6 md:px-8 md:pb-10 md:pt-8">{children ?? <Outlet />}</div></main>
      <nav aria-label="手机后台导航" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[var(--border-default)] bg-[var(--surface-default)] pb-[var(--safe-bottom)] md:hidden">{mobileItems.map(item => <NavLink key={item.to} to={item.to} end={item.to === '/admin'} className={({ isActive }) => cn('flex min-h-16 flex-col items-center justify-center gap-1 text-xs', isActive ? 'font-semibold text-[var(--color-brand)]' : 'text-[var(--text-secondary)]')}><item.icon size={20} />{item.label}</NavLink>)}<button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)} className="flex min-h-16 flex-col items-center justify-center gap-1 text-xs"><Menu size={20} />全部</button></nav>
      {moreOpen ? <div ref={mobileDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="全部管理页面" className="fixed inset-0 z-[100] flex flex-col bg-[var(--surface-default)] md:hidden"><div className="flex min-h-16 items-center justify-between border-b border-[var(--border-default)] px-5"><h2 className="text-lg font-semibold">全部管理页面</h2><button type="button" aria-label="关闭全部管理页面" onClick={() => setMoreOpen(false)} className="flex h-11 w-11 items-center justify-center"><X size={20} /></button></div><nav aria-label="全部业务导航" className="overflow-y-auto p-5 pb-[calc(24px+var(--safe-bottom))]">{navigation(true)}</nav></div> : null}
    </div>
  </div>
}

export function AdminToolbar({ children }: { children: ReactNode }) {
  return <div className="admin-toolbar mb-5 flex flex-wrap items-center gap-3 border-b border-[var(--border-default)] pb-4" aria-label="列表搜索与筛选">{children}</div>
}
export function AdminSectionTabs<T extends string>({ tabs, value, onChange, label = '页面分区' }: { tabs: readonly { id: T; label: string }[]; value: T; onChange: (value: T) => void; label?: string }) {
  return <nav aria-label={label} className="admin-section-tabs mb-5 flex max-w-full gap-1 overflow-x-auto border-b border-[var(--border-default)]">{tabs.map(tab => <button key={tab.id} type="button" aria-current={value === tab.id ? 'page' : undefined} onClick={() => onChange(tab.id)} className={cn('min-h-11 shrink-0 border-b-2 px-4 text-sm', value === tab.id ? 'border-[var(--color-brand)] font-semibold text-[var(--color-brand)]' : 'border-transparent text-[var(--text-secondary)]')}>{tab.label}</button>)}</nav>
}

/* ---------------- 页头 ---------------- */

export function AdminPageHeader({ title, description, extra }: { title: string; description?: string; extra?: ReactNode }) {
  return (
    <div className="admin-page-header mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
        {description ? <p className="mt-1 text-sm text-[var(--text-secondary)]">{description}</p> : null}
      </div>
      {extra}
    </div>
  )
}

/* ---------------- 卡片容器 ---------------- */

export function AdminCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('admin-section min-w-0 py-4', className)}>
      {children}
    </section>
  )
}

/* ---------------- 状态标签 ---------------- */

export function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'danger' | 'warning' }) {
  const toneClass = {
    neutral: 'bg-[var(--surface-muted)] text-[var(--text-secondary)]',
    success: 'bg-[var(--color-success)]/15 text-[var(--color-success)]',
    danger: 'bg-[var(--color-error)]/15 text-[var(--color-error)]',
    warning: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
  }[tone]

  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs', toneClass)}>{children}</span>
}

/* ---------------- 分页 ---------------- */

function PagerIconButton({
  disabled,
  label,
  onClick,
  children,
}: {
  disabled: boolean
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:text-[var(--text-secondary)]"
    >
      {children}
    </button>
  )
}

/** 列表分页器：左侧总条数，右侧条/页选择 + 首页/上一页/页码输入/下一页/末页 */
export function AdminPager({
  pagination,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  pagination: Pagination
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}) {
  const totalPages = Math.max(Math.ceil(pagination.total / pageSize), 1)
  const [draft, setDraft] = useState(String(page))

  useEffect(() => {
    setDraft(String(page))
  }, [page, totalPages])

  const commitDraft = () => {
    const parsed = Number.parseInt(draft, 10)
    if (Number.isNaN(parsed)) {
      setDraft(String(page))
      return
    }
    const next = Math.min(Math.max(parsed, 1), totalPages)
    setDraft(String(next))
    if (next !== page) {
      onPageChange(next)
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] pt-3">
      <p className="text-xs text-[var(--text-secondary)]">共 {pagination.total} 条</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-1.5 text-xs text-[var(--text-primary)] outline-none"
          >
            {[10, 20, 50].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          条 / 页
        </label>
        <div className="flex items-center gap-1">
          <PagerIconButton label="首页" disabled={page <= 1} onClick={() => onPageChange(1)}>
            <ChevronsLeft size={14} />
          </PagerIconButton>
          <PagerIconButton label="上一页" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            <ChevronLeft size={14} />
          </PagerIconButton>
          <input
            value={draft}
            inputMode="numeric"
            aria-label="页码"
            onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitDraft()
              }
            }}
            className="h-11 w-12 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] text-center text-xs text-[var(--text-primary)] outline-none"
          />
          <span className="px-0.5 text-xs text-[var(--text-secondary)]">/ {totalPages} 页</span>
          <PagerIconButton label="下一页" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
            <ChevronRight size={14} />
          </PagerIconButton>
          <PagerIconButton label="末页" disabled={page >= totalPages} onClick={() => onPageChange(totalPages)}>
            <ChevronsRight size={14} />
          </PagerIconButton>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 搜索栏 ---------------- */

export function AdminSearchBar({
  value,
  placeholder,
  onSearch,
}: {
  value: string
  placeholder: string
  onSearch: (keyword: string) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    onSearch(draft.trim())
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-md gap-2">
      <TextInput aria-label={placeholder} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" variant="primary">
        搜索
      </Button>
    </form>
  )
}

/* ---------------- 确认弹窗（危险操作二次确认，支持输入确认文本） ---------------- */

export function AdminConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  confirmText,
  tone = 'danger',
  loading,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel?: string
  /** 需要用户逐字输入该文本才能确认（如删除作品需输入书名） */
  confirmText?: string
  /** danger 红色确认钮；primary 常规确认钮（信息展示类弹窗） */
  tone?: 'danger' | 'primary'
  loading?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const titleId = useId()
  const dialogRef = useAdminDialog(open, () => { if (!loading) onCancel() })

  useEffect(() => {
    if (open) {
      setTyped('')
    }
  }, [open])

  if (!open) {
    return null
  }

  const blocked = confirmText !== undefined && typed.trim() !== confirmText

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1}>
      <div className="w-full max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-5">
        <h3 id={titleId} className="text-base font-semibold">{title}</h3>
        <div className="mt-2 text-sm text-[var(--text-secondary)]">{description}</div>

        {confirmText !== undefined ? (
          <div className="mt-4">
            <p className="mb-2 text-xs text-[var(--text-secondary)]">
              请输入 <span className="font-semibold text-[var(--text-primary)]">{confirmText}</span> 以确认操作
            </p>
            <TextInput aria-label="输入确认文本" value={typed} placeholder={confirmText} onChange={(event) => setTyped(event.target.value)} />
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={loading} onClick={onCancel}>取消</Button>
          <Button
            variant="primary"
            disabled={blocked || loading}
            className={tone === 'danger' ? 'bg-[var(--color-error)] text-white hover:bg-[var(--color-error)]' : undefined}
            onClick={onConfirm}
          >
            {loading ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 加载与空态 ---------------- */

export function AdminPanelState({ state, children }: { state: 'loading' | 'error' | 'empty' | 'ready'; children?: ReactNode }) {
  if (state === 'loading') {
    return <div role="status" aria-live="polite" className="admin-panel-state py-16 text-center text-sm text-[var(--text-secondary)]">加载中…</div>
  }
  if (state === 'error') {
    return <div role="alert" className="py-16 text-center text-sm text-[var(--color-error)]">加载失败，请刷新重试。</div>
  }
  if (state === 'empty') {
    return <div className="py-16 text-center text-sm text-[var(--text-secondary)]">暂无数据</div>
  }
  return <>{children}</>
}
