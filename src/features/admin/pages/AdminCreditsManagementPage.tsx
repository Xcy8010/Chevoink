import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, RefreshCcw } from 'lucide-react'
import { Link } from 'react-router-dom'

import Button from '@/components/ui/Button'
import AdminAnalytics from '../components/AdminAnalytics'
import { useToast } from '@/components/ui/toast-context'
import { formatCreditAmount } from '@/features/account/credit-format'
import { AdminCard, AdminPageHeader, AdminPanelState } from '../AdminLayout'
import AdminDangerActionDialog, { type AdminDangerPayload } from '../components/AdminDangerActionDialog'
import {
  getAdminCreditsManagement,
  resetAdminUserCredits,
  resetAllAdminCredits,
  resetSelectedAdminCredits,
  setAdminCreditsPaused,
  setAdminUserCreditsPaused,
  setSelectedAdminCreditsPaused,
} from '../api'

type PendingAction =
  | { kind: 'reset-user'; userId: string; name: string }
  | { kind: 'pause-user'; userId: string; name: string; paused: boolean }
  | { kind: 'reset-selected'; userIds: string[] }
  | { kind: 'pause-selected'; userIds: string[]; paused: boolean }
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
  const query = useQuery({ queryKey: ['admin', 'credits'], queryFn: getAdminCreditsManagement })
  const [pending, setPending] = useState<PendingAction>(null)
  const resetRequest = useRef<{ action: PendingAction; key: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const mutation = useMutation({
    mutationFn: async (payload: AdminDangerPayload) => {
      if (!pending) return
      if (resetRequest.current?.action !== pending) resetRequest.current = { action: pending, key: crypto.randomUUID() }
      const resetPayload = { ...payload, requestKey: resetRequest.current.key }
      if (pending.kind === 'reset-user') return resetAdminUserCredits(pending.userId, resetPayload)
      if (pending.kind === 'pause-user') return setAdminUserCreditsPaused(pending.userId, { ...payload, paused: pending.paused })
      if (pending.kind === 'reset-selected') return resetSelectedAdminCredits({ ...resetPayload, userIds: pending.userIds })
      if (pending.kind === 'pause-selected') return setSelectedAdminCreditsPaused({ ...payload, userIds: pending.userIds, paused: pending.paused })
      if (pending.kind === 'reset-all') return resetAllAdminCredits(resetPayload)
      return setAdminCreditsPaused({ ...payload, paused: pending.paused })
    },
    onSuccess: async () => {
      setPending(null)
      setSelected(new Set())
      toast.success('操作已完成')
      await queryClient.invalidateQueries({ queryKey: ['admin', 'credits'] })
    },
  })
  const copy = useMemo(() => {
    if (!pending) return null
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
  const selectedIds = [...selected]
  const allSelected = Boolean(data?.users.length) && data!.users.every((item) => selected.has(item.user.id))

  return <div>
    <AdminPageHeader title="Credits 管理" description="查看公测额度、奖励余额和耗尽情况；个人、批量及全局高危操作均需要人机验证与二次确认。" />
    <AdminAnalytics scope="credits" />
    <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
      {data ? <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[['公测用户', data.summary.users], ['每日总额度', data.summary.dailyAllowance], ['今日已用', data.summary.dailyUsed], ['奖励余额', data.summary.bonusBalance], ['已耗尽用户', data.summary.exhaustedUsers]].map(([label, value]) => <AdminCard key={label}><p className="text-xs text-[var(--text-secondary)]">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatCreditAmount(Number(value))}</p></AdminCard>)}
        </div>
        <AdminCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-sm font-semibold">全局状态</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">{data.summary.globallyPaused ? '全局暂停已生效，新用户会自动继承；仍可在下方单独恢复指定用户。' : '当前正常开放，额度规则实时生效。'}</p></div><div className="flex gap-2"><Button onClick={() => setPending({ kind: 'reset-all' })}><RefreshCcw className="h-4 w-4" />重置全体</Button><Button variant={data.summary.globallyPaused ? 'primary' : 'secondary'} onClick={() => setPending({ kind: 'pause-all', paused: !data.summary.globallyPaused })}>{data.summary.globallyPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{data.summary.globallyPaused ? '恢复全部' : '暂停全部'}</Button></div></div>
        </AdminCard>
        <AdminCard>
          <div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="mr-auto text-sm font-semibold">用户额度</h2>{selectedIds.length > 0 ? <><span className="text-xs text-[var(--text-secondary)]">已选 {selectedIds.length} 位</span><Button size="sm" onClick={() => setPending({ kind: 'reset-selected', userIds: selectedIds })}><RefreshCcw className="h-3.5 w-3.5" />批量重置</Button><Button size="sm" onClick={() => setPending({ kind: 'pause-selected', userIds: selectedIds, paused: true })}><Pause className="h-3.5 w-3.5" />批量暂停</Button><Button size="sm" onClick={() => setPending({ kind: 'pause-selected', userIds: selectedIds, paused: false })}><Play className="h-3.5 w-3.5" />批量恢复</Button></> : null}</div>
          <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm"><thead className="text-xs text-[var(--text-secondary)]"><tr><th className="pb-2"><input type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(data.users.map((item) => item.user.id)) : new Set())} aria-label="选择全部用户" /></th><th>用户</th><th>套餐</th><th>状态</th><th>使用率</th><th>今日已用</th><th>奖励余额</th><th>当前可用</th><th /></tr></thead><tbody className="divide-y divide-[var(--border-default)]">{data.users.map((item) => <tr key={item.user.id}><td className="py-2.5"><input type="checkbox" checked={selected.has(item.user.id)} onChange={(event) => setSelected((value) => { const next = new Set(value); if (event.target.checked) next.add(item.user.id); else next.delete(item.user.id); return next })} aria-label={`选择 ${item.user.nickname}`} /></td><td><Link className="font-medium hover:underline" to={`/admin/users/${item.user.id}`}>{item.user.nickname}</Link></td><td><span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-xs">{item.planLabel}</span></td><td><span className={item.suspended ? 'text-rose-600' : 'text-emerald-600'}>{item.suspended ? '已暂停' : '正常'}</span></td><td><Ring value={item.usedPercent} /></td><td className="tabular-nums">{formatCreditAmount(item.dailyUsed)} / {formatCreditAmount(item.dailyAllowance)}</td><td className="tabular-nums">{formatCreditAmount(item.bonusBalance)}</td><td className="tabular-nums">{formatCreditAmount(item.totalRemaining)}</td><td className="text-right"><div className="flex justify-end gap-1"><Button size="sm" onClick={() => setPending({ kind: 'reset-user', userId: item.user.id, name: item.user.nickname })}>重置</Button><Button size="sm" onClick={() => setPending({ kind: 'pause-user', userId: item.user.id, name: item.user.nickname, paused: !item.suspended })}>{item.suspended ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{item.suspended ? '恢复' : '暂停'}</Button></div></td></tr>)}</tbody></table></div>
        </AdminCard>
      </div> : null}
    </AdminPanelState>
    {copy ? <AdminDangerActionDialog open title={copy.title} description={copy.description} confirmation={copy.confirmation} onConfirm={(payload) => mutation.mutateAsync(payload)} onClose={() => setPending(null)} /> : null}
  </div>
}
