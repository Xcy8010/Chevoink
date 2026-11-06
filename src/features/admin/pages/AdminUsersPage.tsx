import AdminUserIdentityDialog from '../components/AdminUserIdentityDialog'
import { useAdminNumberQuery } from './admin-page-query'
import { useAdminQueryState } from '../admin-query-state'
import { AdminRowActions } from './AdminPageControls'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import type { AdminUserRow } from '../../../../shared/contracts/index.js'
import {
  banAdminUser,
  listAdminUsers,
  resetAdminUserPassword,
  unbanAdminUser,
} from '../api'
import { AdminCard, AdminConfirmDialog, AdminPageHeader, AdminPager, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatDateTime, useAdminSession } from '../admin-shared'

export default function AdminUsersPage() {
  const location = useLocation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { admin } = useAdminSession()
  const [search, setSearch] = useAdminQueryState('search', '')
  const [keyword, setKeyword] = useState(search)
  const [role, setRole] = useAdminQueryState('role', '')
  const [status, setStatus] = useAdminQueryState('status', '')
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const [pageSize, setPageSize] = useAdminNumberQuery('pageSize', 10)
  const [identityUser,setIdentityUser] = useState<AdminUserRow|null>(null)
  const [pendingBan, setPendingBan] = useState<AdminUserRow | null>(null)
  const [pendingReset, setPendingReset] = useState<AdminUserRow | null>(null)
  const [tempPassword, setTempPassword] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['admin', 'users', search, role, status, page, pageSize],
    queryFn: () =>
      listAdminUsers({
        search: search || undefined,
        role: role || undefined,
        banned: status === 'true' ? 'true' : status === 'false' ? 'false' : undefined,
        online: status === 'online' ? 'true' : undefined,
        page,
        pageSize,
      }),
  })

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setPage(1)
  }

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
  }

  const banMutation = useMutation({
    mutationFn: (userId: string) => banAdminUser(userId),
    onSuccess: () => {
      toast.success('已封禁该用户，其登录态立即失效')
      invalidate()
      setPendingBan(null)
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '封禁失败'),
  })

  const unbanMutation = useMutation({
    mutationFn: (userId: string) => unbanAdminUser(userId),
    onSuccess: () => {
      toast.success('已解封该用户')
      invalidate()
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '解封失败'),
  })

  const resetMutation = useMutation({
    mutationFn: (userId: string) => resetAdminUserPassword(userId),
    onSuccess: (result) => {
      setTempPassword(result.tempPassword)
      setPendingReset(null)
      invalidate()
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '重置失败'),
  })

  const data = query.data

  return (
    <div>
      <AdminPageHeader
        title="用户管理"
        description="查看用户、管理身份与测试资格、处理账号状态"
      />

      <AdminCard className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <form
            className="flex w-full max-w-sm gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setSearch(keyword.trim())
              setPage(1)
            }}
          >
            <TextInput
              value={keyword}
              placeholder="昵称 / 手机号 / 邮箱"
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button type="submit" variant="primary">
              搜索
            </Button>
          </form>

          <select
            value={role}
            onChange={(event) => {
              setRole(event.target.value)
              setPage(1)
            }}
            aria-label="角色筛选" className="h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-sm text-[var(--text-primary)] outline-none"
          >
            <option value="">全部角色</option>
            <option value="user">用户</option>
            <option value="admin">管理</option>
          </select>

          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value)
              setPage(1)
            }}
            aria-label="状态筛选" className="h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-sm text-[var(--text-primary)] outline-none"
          >
            <option value="">全部状态</option>
            <option value="false">正常</option>
            <option value="true">已封禁</option>
            <option value="online">在线</option>
          </select>
        </div>
      </AdminCard>

      <AdminCard>
        <AdminPanelState
          state={query.isLoading ? 'loading' : query.isError ? 'error' : data && data.items.length === 0 ? 'empty' : 'ready'}
        >
          {data ? (
            <>
              {/* 手机端：卡片式列表，避免宽表格横向裁切 */}
              <ul className="space-y-3 md:hidden">
                {data.items.map((user) => (
                  <li key={user.id} className="rounded-lg border border-[var(--border-default)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Link to={`/admin/users/${user.id}`} state={{ adminReturnTo: location.pathname + location.search }} className="min-w-0 truncate text-sm font-medium hover:underline">
                        {user.nickname}
                      </Link>
                      {user.bannedAt ? (
                        <StatusPill tone="danger">已封禁</StatusPill>
                      ) : user.isOnline ? (
                        <StatusPill tone="success">在线</StatusPill>
                      ) : (
                        <StatusPill>正常</StatusPill>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">
                      最近活跃 {formatDateTime(user.lastActiveAt)}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                      作品 / 帖子 {user.novelCount} / {user.postCount} · 注册 {formatDateTime(user.createdAt)}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <span className="text-sm text-[var(--text-secondary)]">{user.isSuperAdmin?'超级管理员':user.role === 'admin' ? '管理员' : '用户'}</span>{user.tester?.effective||user.isSuperAdmin?<StatusPill tone="success">测试员</StatusPill>:user.tester?.enabled?<StatusPill>测试已过期</StatusPill>:null}
                      <AdminRowActions label="用户操作">
<Link to={"/admin/users/"+user.id} state={{adminReturnTo:location.pathname+location.search}} className="inline-flex items-center rounded-md px-2 text-sm hover:underline">查看</Link><Button size="sm" onClick={()=>setIdentityUser(user)}>编辑身份</Button>
                        {user.bannedAt ? (
                          <Button size="sm" onClick={() => unbanMutation.mutate(user.id)} disabled={unbanMutation.isPending}>
                            解封
                          </Button>
                        ) : user.role !== 'admin' ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setPendingBan(user)}>
                              封禁
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setPendingReset(user)}>
                              重置密码
                            </Button>
                          </>
                        ) : null}
                      </AdminRowActions>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto md:block">
                <table className="admin-users-table w-full min-w-[960px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-[var(--text-secondary)]">
                      <th className="pb-2 font-normal">用户</th>

                      <th className="pb-2 font-normal">角色</th>
                      <th className="pb-2 font-normal">状态</th>
                      <th className="pb-2 font-normal">作品 / 帖子</th>
                      <th className="pb-2 font-normal">注册时间</th>
                      <th className="pb-2 font-normal">最近活跃</th>
                      <th className="pb-2 font-normal">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((user) => (
                      <tr key={user.id} className="border-t border-[var(--border-default)]">
                        <td className="py-2.5">
                          <Link to={`/admin/users/${user.id}`} state={{ adminReturnTo: location.pathname + location.search }} className="font-medium hover:underline">
                            {user.nickname}
                          </Link>

                        </td>

                        <td className="py-2.5">
                          <span className="text-sm text-[var(--text-secondary)]">{user.isSuperAdmin?'超级管理员':user.role === 'admin' ? '管理员' : '用户'}</span>{user.tester?.effective||user.isSuperAdmin?<StatusPill tone="success">测试员</StatusPill>:user.tester?.enabled?<StatusPill>测试已过期</StatusPill>:null}
                        </td>
                        <td className="py-2.5">
                          {user.bannedAt ? (
                            <StatusPill tone="danger">已封禁</StatusPill>
                          ) : user.isOnline ? (
                            <StatusPill tone="success">在线</StatusPill>
                          ) : (
                            <StatusPill>正常</StatusPill>
                          )}
                        </td>
                        <td className="py-2.5 text-[var(--text-secondary)]">
                          {user.novelCount} / {user.postCount}
                        </td>
                        <td className="py-2.5 text-[var(--text-secondary)]">{formatDateTime(user.createdAt)}</td>
                        <td className="py-2.5 text-[var(--text-secondary)]">{formatDateTime(user.lastActiveAt)}</td>
                        <td className="py-2.5">
                          <AdminRowActions label="用户操作">
<Link to={"/admin/users/"+user.id} state={{adminReturnTo:location.pathname+location.search}} className="inline-flex items-center rounded-md px-2 text-sm hover:underline">查看</Link><Button size="sm" onClick={()=>setIdentityUser(user)}>编辑身份</Button>
                            {user.bannedAt ? (
                              <Button size="sm" onClick={() => unbanMutation.mutate(user.id)} disabled={unbanMutation.isPending}>
                                解封
                              </Button>
                            ) : user.role !== 'admin' ? (
                              <>
                                <Button size="sm" variant="ghost" onClick={() => setPendingBan(user)}>
                                  封禁
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setPendingReset(user)}>
                                  重置密码
                                </Button>
                              </>
                            ) : null}
                          </AdminRowActions>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <AdminPager
                pagination={data.pagination}
                page={page}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={handlePageSizeChange}
              />
            </>
          ) : null}
        </AdminPanelState>
      </AdminCard>

      {identityUser?<AdminUserIdentityDialog key={identityUser.id} user={identityUser} adminId={admin?.id ?? ""} isSuperAdmin={Boolean(admin?.isSuperAdmin)} onClose={()=>setIdentityUser(null)} onSaved={()=>{invalidate();setIdentityUser(null);toast.success("身份已更新")}}/>:null}
      <AdminConfirmDialog
        open={pendingBan !== null}
        title="封禁用户"
        description={
          pendingBan ? (
            <>
              封禁后 <span className="font-medium text-[var(--text-primary)]">{pendingBan.nickname}</span>{' '}
              的登录态立即失效且无法再访问平台，其已发布内容暂时保留。确定要封禁吗？
            </>
          ) : null
        }
        confirmLabel="确认封禁"
        loading={banMutation.isPending}
        onCancel={() => setPendingBan(null)}
        onConfirm={() => pendingBan && banMutation.mutate(pendingBan.id)}
      />

      <AdminConfirmDialog
        open={pendingReset !== null}
        title="重置用户密码"
        description={
          pendingReset ? (
            <>
              将为 <span className="font-medium text-[var(--text-primary)]">{pendingReset.nickname}</span>{' '}
              生成一个新的临时密码并覆盖旧密码，请通过安全渠道交付给用户。
            </>
          ) : null
        }
        confirmLabel="生成临时密码"
        loading={resetMutation.isPending}
        onCancel={() => setPendingReset(null)}
        onConfirm={() => pendingReset && resetMutation.mutate(pendingReset.id)}
      />

      <AdminConfirmDialog
        open={tempPassword !== null}
        tone="primary"
        title="临时密码已生成"
        description={
          <div>
            <p>请通过安全渠道交付给用户，登录后建议用户尽快修改：</p>
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
