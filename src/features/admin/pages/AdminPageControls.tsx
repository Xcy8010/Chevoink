import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

export function AdminCommunityTabs() {
  return <nav aria-label="社区管理" className="mb-4 flex gap-2 border-b border-[var(--border-default)]">
    {[['/admin/posts', '帖子'], ['/admin/comments', '评论']].map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => `inline-flex min-h-11 items-center border-b-2 px-4 text-sm ${isActive ? 'border-[var(--text-primary)] font-semibold' : 'border-transparent text-[var(--text-secondary)]'}`}>{label}</NavLink>)}
  </nav>
}

export function AdminRowActions({ children, label = '更多操作' }: { children: ReactNode; label?: string }) {
  return <details className="relative" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}><summary className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-[var(--border-default)] px-3 text-sm">{label}</summary><div className="mt-2 flex min-w-36 flex-col gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] p-2">{children}</div></details>
}
