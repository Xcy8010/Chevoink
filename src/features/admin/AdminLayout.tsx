import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Home,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  MoonStar,
  MoreHorizontal,
  ShieldCheck,
  SunMedium,
  Users,
} from 'lucide-react'

import BottomSheet from '@/components/layout/BottomSheet'
import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { useToast } from '@/components/ui/toast-context'
import { useAutoHideScrollbars } from '@/hooks/useAutoHideScrollbars'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import type { Pagination } from '../../../shared/contracts/index.js'
import { adminLogout } from './api'
import { useAdminSession } from './admin-shared'

/* ---------------- 布局 ---------------- */

const navItems = [
  { to: '/admin', label: '仪表盘', end: true },
  { to: '/admin/users', label: '用户管理' },
  { to: '/admin/novels', label: '作品管理' },
  { to: '/admin/posts', label: '帖子管理' },
  { to: '/admin/comments', label: '评论管理' },
  { to: '/admin/messages', label: '消息管理' },
  { to: '/admin/evals', label: '创作盲评' },
  { to: '/admin/creation-records', label: '创作记录' },
  { to: '/admin/tokens', label: 'Token 管理' },
  { to: '/admin/credits', label: 'Credits 管理' },
  { to: '/admin/models', label: '模型管理' },
  { to: '/admin/craft', label: '合法文笔库' },
  { to: '/admin/feedback', label: '用户反馈 / 建议' },
  { to: '/admin/logs', label: '操作日志' },
  { to: '/admin/settings', label: '安全设置' },
]

/** 手机端底部导航：四个主入口 + 「更多」抽屉（与主站移动端同模式） */
const mobilePrimaryNav = [
  { to: '/admin', label: '仪表盘', end: true, icon: LayoutDashboard },
  { to: '/admin/users', label: '用户', icon: Users },
  { to: '/admin/novels', label: '作品', icon: BookOpen },
  { to: '/admin/posts', label: '帖子', icon: MessagesSquare },
]

const mobileMoreNav = [
  { to: '/admin/comments', label: '评论管理' },
  { to: '/admin/messages', label: '消息管理' },
  { to: '/admin/evals', label: '创作盲评' },
  { to: '/admin/creation-records', label: '创作记录' },
  { to: '/admin/tokens', label: 'Token 管理' },
  { to: '/admin/credits', label: 'Credits 管理' },
  { to: '/admin/models', label: '模型管理' },
  { to: '/admin/craft', label: '合法文笔库' },
  { to: '/admin/feedback', label: '用户反馈 / 建议' },
  { to: '/admin/logs', label: '操作日志' },
  { to: '/admin/settings', label: '安全设置' },
]

export default function AdminLayout({ children }: { children?: ReactNode }) {
  const toast = useToast()
  const { admin, isLoading, denied } = useAdminSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const theme = useShellStore((state) => state.theme)
  const toggleTheme = useShellStore((state) => state.toggleTheme)

  // 与主站一致：细滚动条 + 不滚动时自动隐藏
  useAutoHideScrollbars()

  if (denied) {
    return <Navigate to="/admin/login" replace />
  }

  if (isLoading) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-[var(--surface-muted)] text-sm text-[var(--text-secondary)]">
        正在校验管理员身份…
      </div>
    )
  }

  const handleLogout = async () => {
    if (isLoggingOut) return
    setIsLoggingOut(true)
    try {
      await adminLogout()
    } catch {
      toast.error('暂时无法确认退出登录，请稍后重试。')
      return
    } finally { setIsLoggingOut(false) }
    navigate('/admin/login', { replace: true })
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-[var(--surface-muted)] text-[var(--text-primary)]">
      <aside className="hidden h-full w-56 shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--surface-default)] md:flex">
        <Link to="/admin" className="flex items-center gap-2 px-5 py-5">
          <ShieldCheck size={20} className="text-[var(--text-primary)]" />
          <div>
            <p className="text-sm font-semibold tracking-[-0.01em]">启创墨域</p>
            <p className="text-xs text-[var(--text-secondary)]">管理后台</p>
          </div>
        </Link>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'block rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-[var(--surface-contrast)] text-[var(--text-contrast)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[var(--border-default)] px-5 py-4">
          <p className="truncate text-sm">
            {admin?.nickname}
            {admin?.isSuperAdmin ? <span className="ml-1.5 text-xs text-[var(--color-warning)]">超级管理</span> : null}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleLogout()}
              aria-label="退出登录"
              title="退出登录"
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <LogOut size={14} />
            </button>
            <Link
              to="/"
              aria-label="返回主站"
              title="返回主站"
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <Home size={14} />
            </Link>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="切换主题"
              title="切换深色/浅色模式"
              className="ml-auto flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {theme === 'light' ? <MoonStar size={14} /> : <SunMedium size={14} />}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* 手机端顶栏：品牌 + 图标操作区（导航移至底部） */}
        <header className="shrink-0 border-b border-[var(--border-default)] bg-[var(--surface-default)] md:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <p className="text-sm font-semibold">启创墨域 · 管理后台</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleTheme}
                aria-label="切换主题"
                title="切换深色/浅色模式"
                className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)]"
              >
                {theme === 'light' ? <MoonStar size={14} /> : <SunMedium size={14} />}
              </button>
              <Link
                to="/"
                aria-label="返回主站"
                title="返回主站"
                className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)]"
              >
                <Home size={14} />
              </Link>
              <button
                type="button"
                onClick={() => void handleLogout()}
                aria-label="退出登录"
                title="退出登录"
                className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)]"
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </header>
        
        {/* 整体滚动容器：body 全局 overflow hidden，管理端自管滚动；
            滚动条走全局 6px 细条 + autohide 机制（静止隐藏、滚动时显示） */}
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-[calc(88px+var(--safe-bottom))] md:px-8 md:pb-8">
            {children ?? <Outlet />}
          </div>
        </main>
        
        {/* 手机端底部导航：与主站移动端同模式 */}
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-default)] bg-[var(--surface-default)]/95 pb-[var(--safe-bottom)] backdrop-blur md:hidden">
          <div className="grid grid-cols-5">
            {mobilePrimaryNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex flex-col items-center gap-1 py-2 text-[11px]',
                    isActive ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                  )
                }
              >
                <item.icon size={18} />
                {item.label}
              </NavLink>
            ))}
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className={cn(
                'flex flex-col items-center gap-1 py-2 text-[11px]',
                mobileMoreNav.some((item) => location.pathname.startsWith(item.to))
                  ? 'font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-tertiary)]',
              )}
            >
              <MoreHorizontal size={18} />
              更多
            </button>
          </div>
        </nav>
        
        <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="更多管理">
          <div className="space-y-1 p-2 pb-[calc(8px+var(--safe-bottom))]">
            {mobileMoreNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMoreOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'block rounded-lg px-4 py-3 text-sm',
                    isActive
                      ? 'bg-[var(--surface-muted)] font-medium text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </BottomSheet>
      </div>
    </div>
  )
}

/* ---------------- 页头 ---------------- */

export function AdminPageHeader({ title, description, extra }: { title: string; description?: string; extra?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
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
    <section className={cn('rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-4 md:p-5', className)}>
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
      <TextInput value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} />
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
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-5">
        <h3 className="text-base font-semibold">{title}</h3>
        <div className="mt-2 text-sm text-[var(--text-secondary)]">{description}</div>

        {confirmText !== undefined ? (
          <div className="mt-4">
            <p className="mb-2 text-xs text-[var(--text-secondary)]">
              请输入 <span className="font-semibold text-[var(--text-primary)]">{confirmText}</span> 以确认操作
            </p>
            <TextInput value={typed} placeholder={confirmText} onChange={(event) => setTyped(event.target.value)} />
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel}>取消</Button>
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
    return <div className="py-16 text-center text-sm text-[var(--text-secondary)]">加载中…</div>
  }
  if (state === 'error') {
    return <div className="py-16 text-center text-sm text-[var(--color-error)]">加载失败，请刷新重试。</div>
  }
  if (state === 'empty') {
    return <div className="py-16 text-center text-sm text-[var(--text-secondary)]">暂无数据</div>
  }
  return <>{children}</>
}
