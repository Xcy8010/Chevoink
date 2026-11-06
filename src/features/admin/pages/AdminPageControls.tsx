import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

export function AdminCommunityTabs() {
  return <nav aria-label="社区管理" className="mb-4 flex gap-2 border-b border-[var(--border-default)]">
    {[['/admin/posts', '帖子'], ['/admin/comments', '评论']].map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => `inline-flex min-h-11 items-center border-b-2 px-4 text-sm ${isActive ? 'border-[var(--text-primary)] font-semibold' : 'border-transparent text-[var(--text-secondary)]'}`}>{label}</NavLink>)}
  </nav>
}

export function AdminRowActions({ children, label = '行操作' }: { children: ReactNode; label?: string }) {
  return <div role="group" aria-label={label} className="admin-row-actions">{children}</div>
}
