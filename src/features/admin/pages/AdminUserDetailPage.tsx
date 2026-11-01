import { AdminRowActions } from './AdminPageControls'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'

import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import { banAdminUser, getAdminUserDetail, resetAdminUserPassword, setAdminUserRole, unbanAdminUser } from '../api'
import { AdminCard, AdminConfirmDialog, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatDateTime, formatTokens, useAdminSession } from '../admin-shared'
import { useState } from 'react'

const ROLE_LABELS: Record<string, string> = {
  user: '用户',
  author: '用户',
  admin: '管理',
}

export default function AdminUserDetailPage() {
  const location = useLocation()
  const returnTo = (location.state as { adminReturnTo?: string } | null)?.adminReturnTo
  const { userId = '' } = useParams()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { admin } = useAdminSession()
  const isSuperAdmin = Boolean(admin?.isSuperAdmin)
  const [showBanDialog, setShowBanDialog] = useState(false)
  const [showResetDialog, setShowResetDialog] = useState(false)
  const [tempPassword, setTempPassword] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['admin', 'users', userId],
    queryFn: () => getAdminUserDetail(userId),
    enabled: Boolean(userId),
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId] })
  }

  const banMutation = useMutation({
    mutationFn: () => banAdminUser(userId),
    onSuccess: () => {
      toast.success('已封禁该用户')
      invalidate()
      setShowBanDialog(false)
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '封禁失败'),
  })

  const unbanMutation = useMutation({
    mutationFn: () => unbanAdminUser(userId),
    onSuccess: () => {
      toast.success('已解封该用户')
      invalidate()
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '解封失败'),
  })

  const resetMutation = useMutation({
    mutationFn: () => resetAdminUserPassword(userId),
    onSuccess: (result) => {
      setTempPassword(result.tempPassword)
      setShowResetDialog(false)
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '重置失败'),
  })

  const roleMutation = useMutation({
    mutationFn: (nextRole: 'user' | 'admin') => setAdminUserRole(userId, nextRole),
    onSuccess: () => {
      toast.success('角色已更新')
      invalidate()
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '角色更新失败'),
  })

  const detail = query.data
  const user = detail?.user

  return (
    <div>
      <Link to={returnTo?.startsWith('/admin/users') ? returnTo : '/admin/users'} className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <ArrowLeft size={15} />
        返回用户列表
      </Link>

      <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
        {user && detail ? (
          <div className="space-y-4">
            <AdminCard>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt={user.nickname} className="h-14 w-14 rounded-full object-cover" />
                  ) : (
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--surface-muted)] text-lg font-semibold">
                      {user.nickname.slice(0, 1)}
                    </span>
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <h1 className="text-lg font-semibold">{user.nickname}</h1>
                      {user.bannedAt ? (
                        <StatusPill tone="danger">已封禁</StatusPill>
                      ) : (
                        <StatusPill tone="success">正常</StatusPill>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
                      {ROLE_LABELS[user.role] ?? user.role}
                      {user.bio ? <span className="mx-1.5">·</span> : null}
                      {user.bio ?? ''}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/admin/users/${userId}/creation-records`}
                    className="inline-flex h-9 items-center rounded-lg border border-[var(--border-strong)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                  >
                    创作记录
                  </Link>
                  <AdminRowActions label="账户管理">{isSuperAdmin && user.id !== admin?.id ? (
                    <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                      身份
                      <select
                        value={user.role === 'admin' ? 'admin' : 'user'}
                        disabled={roleMutation.isPending}
                        onChange={(event) => roleMutation.mutate(event.target.value as 'user' | 'admin')}
                        className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
                      >
                        <option value="user">用户</option>
                        <option value="admin">管理</option>
                      </select>
                    </label>
                  ) : null}
                  {user.role !== 'admin' ? (
                    <>
                      {user.bannedAt ? (
                        <Button onClick={() => unbanMutation.mutate()} disabled={unbanMutation.isPending}>
                          解封
                        </Button>
                      ) : (
                        <Button onClick={() => setShowBanDialog(true)}>封禁账号</Button>
                      )}
                      <Button variant="ghost" onClick={() => setShowResetDialog(true)}>
                        重置密码
                      </Button>
                    </>
                  ) : (
                    <StatusPill tone="warning">管理员账号</StatusPill>
                  )}</AdminRowActions>
                </div>
              </div>

              <details className="mt-4"><summary className="min-h-11 cursor-pointer py-3 text-sm">基本资料与联系方式</summary><dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ['手机号', user.phone ?? '未绑定'],
                  ['邮箱', user.email ?? '未绑定'],
                  ['注册时间', formatDateTime(user.createdAt)],
                  ['最近活跃', formatDateTime(user.lastActiveAt)],
                  ['封禁时间', user.bannedAt ? formatDateTime(user.bannedAt) : '—'],
                  ['粉丝数', String(user.followerCount)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-[var(--text-secondary)]">{label}</dt>
                    {label === '粉丝数' ? (
                      <dd className="mt-0.5">
                        <Link to={`/admin/users/${userId}/followers`} className="hover:underline">
                          {value}
                        </Link>
                      </dd>
                    ) : (
                      <dd className="mt-0.5">{value}</dd>
                    )}
                  </div>
                ))}
              </dl></details>
              <nav aria-label="用户关联管理" className="mt-3 flex flex-wrap gap-3 text-sm"><Link className="inline-flex min-h-11 items-center underline" to={`/admin/credits?search=${encodeURIComponent(userId)}`}>Credits 账户</Link><Link className="inline-flex min-h-11 items-center underline" to={`/admin/logs?targetType=user&object=${encodeURIComponent(userId)}`}>相关操作审计</Link></nav>
            </AdminCard>

            <AdminCard>
              <h2 className="mb-3 text-sm font-semibold">内容统计</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                {[
                  { label: '作品', value: detail.stats.novels, to: `/admin/novels?search=${encodeURIComponent(user.nickname)}` },
                  { label: '帖子', value: detail.stats.posts, to: `/admin/posts?search=${encodeURIComponent(user.nickname)}` },
                  { label: '评论', value: detail.stats.comments, to: `/admin/comments?search=${encodeURIComponent(user.nickname)}` },
                  { label: '收藏作品', value: detail.stats.favorites, to: `/admin/users/${userId}/favorites` },
                  { label: '总 Token', value: formatTokens(detail.stats.totalTokens), to: '/admin/tokens' },
                  { label: '联网搜索', value: detail.stats.webSearchCalls },
                  { label: '生图调用', value: detail.stats.imageCalls },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg bg-[var(--surface-muted)] p-3">
                    <p className="text-xs text-[var(--text-secondary)]">{item.label}</p>
                    {item.to ? (
                      <Link to={item.to} className="mt-1 block text-xl font-semibold hover:underline">
                        {item.value}
                      </Link>
                    ) : (
                      <p className="mt-1 text-xl font-semibold">{item.value}</p>
                    )}
                  </div>
                ))}
              </div>
            </AdminCard>
          </div>
        ) : null}
      </AdminPanelState>

      <AdminConfirmDialog
        open={showBanDialog}
        title="封禁用户"
        description={user ? <>封禁后 {user.nickname} 的登录态立即失效且无法再访问平台。确定要封禁吗？</> : null}
        confirmLabel="确认封禁"
        loading={banMutation.isPending}
        onCancel={() => setShowBanDialog(false)}
        onConfirm={() => banMutation.mutate()}
      />

      <AdminConfirmDialog
        open={showResetDialog}
        title="重置用户密码"
        description="将生成新的临时密码并覆盖旧密码，请通过安全渠道交付给用户。"
        confirmLabel="生成临时密码"
        loading={resetMutation.isPending}
        onCancel={() => setShowResetDialog(false)}
        onConfirm={() => resetMutation.mutate()}
      />

      <AdminConfirmDialog
        open={tempPassword !== null}
        tone="primary"
        title="临时密码已生成"
        description={
          <div>
            <p>请通过安全渠道交付给用户：</p>
            <p className="mt-3 select-all rounded-lg bg-[var(--surface-muted)] px-3 py-2 font-mono text-sm text-[var(--text-primary)]">
              {tempPassword}
            </p>
          </div>
        }
        confirmLabel="我已记录"
        onCancel={() => setTempPassword(null)}
        onConfirm={() => setTempPassword(null)}
      />
    </div>
  )
}
