import { useAdminNumberQuery } from './admin-page-query'
import { useAdminQueryState } from '../admin-query-state'
import { AdminRowActions } from './AdminPageControls'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, RefreshCcw, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import AdminAnalytics from '../components/AdminAnalytics'
import AdminCreditAdjustmentDialog from '../components/AdminCreditAdjustmentDialog'
import { useToast } from '@/components/ui/toast-context'
import { formatAdminCredits as formatCreditAmount } from '../admin-credit-format'
import { AdminCard, AdminPageHeader, AdminPanelState, AdminSectionTabs } from '../AdminLayout'
import AdminDangerActionDialog, { type AdminDangerPayload } from '../components/AdminDangerActionDialog'
import {
  getAdminCreditsManagement,
  resetAdminUserCredits,
  resetAllAdminCredits,
  resetSelectedAdminCredits,
  setAdminCreditsPaused,
  setAdminPublicBeta,
  setAdminUserCreditsPaused,
  setSelectedAdminCreditsPaused,
} from '../api'

type PendingAction =
  | { kind: 'reset-user'; userId: string; name: string }
  | { kind: 'pause-user'; userId: string; name: string; paused: boolean }
  | { kind: 'reset-selected'; userIds: string[] }
  | { kind: 'pause-selected'; userIds: string[]; paused: boolean }
  | { kind: 'beta'; enabled: boolean; expectedRevision: number }
  | { kind: 'reset-all' }
  | { kind: 'pause-all'; paused: boolean }
  | null

function Ring({ value }: { value: number }) {
  const percent = Math.min(100, Math.max(0, value))
  return <div className="relative h-10 w-10 rounded-full" style={{ background: `conic-gradient(var(--text-primary) ${percent}%, var(--border-subtle) 0)` }}><span className="absolute inset-[4px] flex items-center justify-center rounded-full bg-[var(--surface-default)] text-[9px] font-medium tabular-nums">{Math.round(percent)}%</span></div>
}

export default function AdminCreditsManagementPage() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [search, setSearch] = useAdminQueryState('search', '')
  const [keyword, setKeyword] = useState(search)
  const [tab, setTab] = useAdminQueryState('tab', 'accounts')
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const pageSize = 20
  const query = useQuery({ queryKey: ['admin', 'credits', search, page, pageSize], queryFn: () => getAdminCreditsManagement(search || undefined, { page, pageSize }) })
  const [pending, setPending] = useState<PendingAction>(null)
  const [adjusting, setAdjusting] = useState<{ user: { id: string; nickname: string }; bonusBalance: number } | null>(null)
  const resetRequest = useRef<{ action: PendingAction; key: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const mutation = useMutation({
    mutationFn: async (payload: AdminDangerPayload) => {
      if (!pending) return
      if (resetRequest.current?.action !== pending) resetRequest.current = { action: pending, key: crypto.randomUUID() }
      const resetPayload = { ...payload, requestKey: resetRequest.current.key }
      if (pending.kind === 'beta') return setAdminPublicBeta({ ...payload, enabled: pending.enabled, expectedRevision: pending.expectedRevision })
      if (pending.kind === 'reset-user') return resetAdminUserCredits(pending.userId, resetPayload)
      if (pending.kind === 'pause-user') return setAdminUserCreditsPaused(pending.userId, { ...payload, paused: pending.paused })
      if (pending.kind === 'reset-selected') return resetSelectedAdminCredits({ ...resetPayload, userIds: pending.userIds })
      if (pending.kind === 'pause-selected') return setSelectedAdminCreditsPaused({ ...payload, userIds: pending.userIds, paused: pending.paused })
      if (pending.kind === 'reset-all') return resetAllAdminCredits(resetPayload)
      return setAdminCreditsPaused({ ...payload, paused: pending.paused })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'credits'] })
      await queryClient.invalidateQueries({ queryKey: ['credits'] })
      setPending(null)
      setSelected(new Set())
      toast.success('操作已完成')
    },
  })
  const copy = useMemo(() => {
    if (!pending) return null
    if (pending.kind === 'beta') return pending.enabled
      ? { title: '恢复公测', description: '恢复每日额度自动重置。', confirmation: 'RESUME_BETA' }
      : { title: '停止公测', description: '停止每日额度自动重置。', confirmation: 'STOP_BETA' }
    if (pending.kind === 'reset-user') return { title: `重置 ${pending.name} 的每日额度`, description: '每日已用量将清零，邀请奖励余额保持不变；该用户当前运行中的任务会停止。', confirmation: 'RESET_USER' }
    if (pending.kind === 'pause-user') return pending.paused
      ? { title: `暂停 ${pending.name} 的额度`, description: '该用户将无法调用文本、生图与联网能力，当前 Agent 任务会立即停止。', confirmation: 'PAUSE_USER' }
      : { title: `恢复 ${pending.name} 的额度`, description: '该用户将重新获得模型调用权限，余额不会被修改。', confirmation: 'RESUME_USER' }
    if (pending.kind === 'reset-selected') return { title: `重置已选 ${pending.userIds.length} 位用户`, description: '已选用户每日已用量将清零，奖励余额保持不变，当前任务会停止。', confirmation: 'RESET_SELECTED' }
    if (pending.kind === 'pause-selected') return pending.paused
      ? { title: `暂停已选 ${pending.userIds.length} 位用户`, description: '已选用户的模型、图片与联网调用将立即停止。', confirmation: 'PAUSE_SELECTED' }
      : { title: `恢复已选 ${pending.userIds.length} 位用户`, description: '已选用户将重新获得调用权限，余额不会被修改。', confirmation: 'RESUME_SELECTED' }
    if (pending.kind === 'reset-all') return { title: '重置全体用户每日额度', description: '所有公测用户的每日已用量将清零，奖励余额保持不变，并停止当前运行任务。', confirmation: 'RESET_ALL' }
    return pending.paused
      ? { title: '暂停全部模型调用', description: '所有用户将无法调用文本、生图与联网能力，当前 Agent 任务会立即停止。', confirmation: 'PAUSE_ALL' }
      : { title: '恢复全部模型调用', description: '公测用户将重新获得模型调用权限。', confirmation: 'RESUME_ALL' }
  }, [pending])
  const data = query.data
  const pageCount = Math.max(1, Math.ceil((data?.pagination.total ?? 0) / pageSize))
  const currentPage = data?.pagination.page ?? page
  const visibleUsers = data?.users ?? []
  useEffect(() => { setSelected(new Set()); setKeyword(search) }, [search, page])
  const allSelected = visibleUsers.length > 0 && visibleUsers.every((item) => selected.has(item.user.id))
  const selectedIds = visibleUsers.filter(item => selected.has(item.user.id)).map(item => item.user.id)

  return <div>
    <AdminPageHeader title="Credits 权益" description="查看公测额度、奖励余额和耗尽情况；个人、批量及全局高危操作均需要人机验证与二次确认。" />
    <AdminSectionTabs tabs={[{ id: 'accounts', label: '用户账户' }, { id: 'policy', label: '全局政策' }]} value={tab} onChange={setTab} label="Credits 分区" />
    {tab === 'policy' ? <AdminAnalytics scope="credits" /> : null}
    {tab !== 'policy' ? <AdminCard className="mb-4 min-w-0"><form className="flex w-full min-w-0 max-w-lg flex-wrap gap-2" onSubmit={event => {
      event.preventDefault(); setPage(1); setSearch(keyword.trim()); setSelected(new Set())
    }}><TextInput className="min-w-0 flex-[1_1_12rem]" type="search" aria-label="搜索用户" placeholder="用户 ID / 昵称 / 手机号 / 邮箱" value={keyword} onChange={event => setKeyword(event.target.value)} />
      <Button type="submit">搜索</Button><Button type="button" onClick={() => { setPage(1); setKeyword(''); setSearch(''); setSelected(new Set()) }}>清空</Button>
    </form></AdminCard> : null}
    <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
      {data ? <div className="space-y-4">{tab === 'policy' ? <AdminCard><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">{data.summary.publicBetaEnabled ? '公测已开启' : '公测已停止'}</h2><Button className={data.summary.publicBetaEnabled ? 'min-h-11 bg-rose-700 text-white hover:bg-rose-800' : 'min-h-11'} disabled={mutation.isPending} onClick={() => setPending({ kind: 'beta', enabled: !data.summary.publicBetaEnabled, expectedRevision: data.summary.publicBetaRevision })}>{data.summary.publicBetaEnabled ? <ShieldAlert className="h-4 w-4" /> : <Play className="h-4 w-4" />}{data.summary.publicBetaEnabled ? '停止公测' : '恢复公测'}</Button></div></AdminCard> : null}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[[data.summary.publicBetaEnabled ? '公测用户' : '免费用户', data.summary.users], [data.summary.publicBetaEnabled ? '每日总额度' : '基础总额度', data.summary.dailyAllowance], [data.summary.publicBetaEnabled ? '今日已用' : '已用额度', data.summary.dailyUsed], ['奖励余额', data.summary.bonusBalance], ['已耗尽用户', data.summary.exhaustedUsers]].map(([label, value]) => <AdminCard key={label}><p className="text-xs text-[var(--text-secondary)]">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatCreditAmount(Number(value))}</p></AdminCard>)}
        </div>
        {tab === 'policy' ? <AdminCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-sm font-semibold">全局状态</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">{data.summary.globallyPaused ? '全局暂停已生效，新用户会自动继承；可在用户账户分区单独恢复指定用户。' : '当前正常开放，额度规则实时生效。'}</p></div><div className="flex gap-2"><Button onClick={() => setPending({ kind: 'reset-all' })}><RefreshCcw className="h-4 w-4" />重置全体</Button><Button variant={data.summary.globallyPaused ? 'primary' : 'secondary'} onClick={() => setPending({ kind: 'pause-all', paused: !data.summary.globallyPaused })}>{data.summary.globallyPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{data.summary.globallyPaused ? '恢复全部' : '暂停全部'}</Button></div></div>
        </AdminCard> : null}
        {tab !== 'policy' ? <AdminCard>
          <div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="mr-auto text-sm font-semibold">用户额度</h2><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(visibleUsers.map((item) => item.user.id)) : new Set())} aria-label="选择当前页用户" />当前页</label>{selectedIds.length > 0 ? <><span className="text-xs text-[var(--text-secondary)]">已选 {selectedIds.length} 位（当前页）</span><Button size="sm" onClick={() => setPending({ kind: 'reset-selected', userIds: selectedIds })}><RefreshCcw className="h-3.5 w-3.5" />批量重置</Button><Button size="sm" onClick={() => setPending({ kind: 'pause-selected', userIds: selectedIds, paused: true })}><Pause className="h-3.5 w-3.5" />批量暂停</Button><Button size="sm" onClick={() => setPending({ kind: 'pause-selected', userIds: selectedIds, paused: false })}><Play className="h-3.5 w-3.5" />批量恢复</Button></> : null}</div>
          {data.users.length === 0 ? <p className="py-6 text-center text-sm text-[var(--text-secondary)]">{search ? '未找到匹配的用户' : '暂无用户'}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="hidden text-xs text-[var(--text-secondary)] md:table-header-group"><tr><th className="pb-2">选择</th><th>用户</th><th>套餐</th><th>状态</th><th>使用率</th><th>{data.summary.publicBetaEnabled ? '今日已用' : '已用额度'}</th><th>奖励余额</th><th>当前可用</th><th /></tr></thead><tbody className="divide-y divide-[var(--border-default)]">{visibleUsers.map((item) => <tr key={item.user.id} className="mb-3 grid grid-cols-2 gap-3 rounded-xl border border-[var(--border-default)] p-3 md:mb-0 md:table-row md:rounded-none md:border-0 md:p-0"><td className="py-2.5"><input type="checkbox" checked={selected.has(item.user.id)} onChange={(event) => setSelected((value) => { const next = new Set(value); if (event.target.checked) next.add(item.user.id); else next.delete(item.user.id); return next })} aria-label={`选择 ${item.user.nickname}`} /></td><td><Link className="font-medium hover:underline" to={`/admin/users/${item.user.id}`}>{item.user.nickname}</Link></td><td><span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-xs">{item.planLabel}</span></td><td><span className={item.suspended ? 'text-rose-600' : 'text-emerald-600'}>{item.suspended ? '已暂停' : '正常'}</span></td><td>{data.summary.publicBetaEnabled ? <Ring value={item.usedPercent} /> : '—'}</td><td className="tabular-nums"><span className="block text-xs text-[var(--text-secondary)] md:hidden">已用 / 额度</span>{formatCreditAmount(item.dailyUsed)} / {formatCreditAmount(item.dailyAllowance)}</td><td className="tabular-nums"><span className="block text-xs text-[var(--text-secondary)] md:hidden">奖励余额</span>{formatCreditAmount(item.bonusBalance)}</td><td className="tabular-nums"><span className="block text-xs text-[var(--text-secondary)] md:hidden">当前可用</span>{formatCreditAmount(item.totalRemaining)}</td><td className="col-span-2 text-right"><AdminRowActions><Button size="sm" onClick={() => setAdjusting({ user: item.user, bonusBalance: item.bonusBalance })}>调整 Credits</Button><Button size="sm" onClick={() => setPending({ kind: 'reset-user', userId: item.user.id, name: item.user.nickname })}>重置</Button><Button size="sm" onClick={() => setPending({ kind: 'pause-user', userId: item.user.id, name: item.user.nickname, paused: !item.suspended })}>{item.suspended ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{item.suspended ? '恢复' : '暂停'}</Button></AdminRowActions></td></tr>)}</tbody></table></div>}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><p>筛选结果 {data.pagination.total} 位 · 每页 {pageSize} 位 · 第 {currentPage} / {pageCount} 页</p><div className="flex gap-2"><Button disabled={currentPage <= 1} onClick={() => { setPage(currentPage - 1); setSelected(new Set()) }}>上一页</Button><Button disabled={currentPage >= pageCount} onClick={() => { setPage(currentPage + 1); setSelected(new Set()) }}>下一页</Button></div></div>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">服务端分页 · 全选只选择当前页，不包含全部筛选结果。全局摘要不随搜索改变。</p>
        </AdminCard> : null}
      </div> : null}
    </AdminPanelState>
    {adjusting ? <AdminCreditAdjustmentDialog key={adjusting.user.id} {...adjusting} onClose={() => setAdjusting(null)} onApplied={() => { setAdjusting(null); toast.success('奖励 Credits 已调整'); void queryClient.invalidateQueries({ queryKey: ['admin', 'credits'] }); void queryClient.invalidateQueries({ queryKey: ['credits'] }) }} /> : null}
    {copy ? <AdminDangerActionDialog key={copy.confirmation} open title={copy.title} description={copy.description} confirmation={copy.confirmation} onConfirm={(payload) => mutation.mutateAsync(payload)} onClose={() => setPending(null)} /> : null}
  </div>
}
