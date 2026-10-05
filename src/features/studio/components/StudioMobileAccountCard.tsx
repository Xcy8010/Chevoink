import { useQuery } from '@tanstack/react-query'
import { Gift } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatCreditAmount, formatCreditResetLabel } from '@/features/account/credit-format'
import { fetchCreditSummary, fetchReferral } from '@/features/account/credits-api'
import InviteCreditsDialog from '@/features/account/InviteCreditsDialog'
import Avatar from '@/features/community/components/Avatar'
import { useShellStore } from '@/store/useShellStore'

/**
 * 手机端「更多」面板顶部的账户额度卡。
 * 手机没有 Work 侧栏账户菜单，也没有 IDE 顶栏「…」菜单，
 * 剩余用量与邀请入口只能落在这里：放面板最顶部，展开即一眼可见。
 */
export default function StudioMobileAccountCard() {
  const sessionUser = useShellStore((state) => state.sessionUser)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const autoCopyRef = useRef(false)

  const creditQuery = useQuery({ queryKey: ['credits', 'summary'], queryFn: fetchCreditSummary, staleTime: 20_000 })
  const referralQuery = useQuery({ queryKey: ['credits', 'referral'], queryFn: fetchReferral, staleTime: 60_000, enabled: inviteOpen })
  const summary = creditQuery.data
  const betaEnabled = summary?.publicBetaEnabled === true
  const remainingPercent = summary?.dailyAllowance ? Math.max(0, Math.min(100, Math.round(summary.totalRemaining / summary.dailyAllowance * 100))) : 100
  const exhausted = summary ? summary.totalRemaining <= 0 : false

  const copyInvite = useCallback(async () => {
    const url = referralQuery.data?.inviteUrl
    if (!url || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(url)
      setInviteCopied(true)
      window.setTimeout(() => setInviteCopied(false), 1800)
    } catch { /* 显式复制按钮仍可用 */ }
  }, [referralQuery.data?.inviteUrl])
  useEffect(() => {
    if (!inviteOpen || !autoCopyRef.current || !referralQuery.data?.inviteUrl) return
    autoCopyRef.current = false
    void copyInvite()
  }, [copyInvite, inviteOpen, referralQuery.data?.inviteUrl])

  return <>
    <div className="mx-3 mb-1 rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3">
      <div className="flex items-center gap-3">
        <Avatar name={sessionUser?.nickname ?? '创作者'} src={sessionUser?.avatarUrl} size="sm" className="h-9 w-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-[var(--text-primary)]">{sessionUser?.nickname ?? '创作者'}</p>
          <p className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary)]">
            {exhausted
              ? '额度已耗尽，邀请好友领取 300 Credits！'
              : `剩余 ${summary ? formatCreditAmount(summary.totalRemaining) : '—'} Credits${betaEnabled ? ` · ${remainingPercent}%` : ''}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setInviteOpen(true); autoCopyRef.current = true; if (referralQuery.data?.inviteUrl) { autoCopyRef.current = false; void copyInvite() } }}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-emerald-600 px-4 text-[13px] font-medium text-white transition-opacity active:opacity-85"
        ><Gift className="h-4 w-4" />邀请</button>
      </div>
      {betaEnabled ? <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]">
        <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${remainingPercent}%` }} />
      </div> : null}
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-tertiary)]">
        <span className="truncate">{betaEnabled ? '每日' : '基础额度'} {summary ? formatCreditAmount(summary.dailyAllowance) : '—'} Credits{betaEnabled ? ` · ${formatCreditResetLabel(summary?.resetsAt)}` : ''}</span>
        {/* 新窗口打开账户页，保留创作区当前状态方便回来继续写 */}
        <button type="button" onClick={() => window.open('/account/usage', '_blank', 'noopener,noreferrer')} className="-mr-1 inline-flex min-h-[32px] shrink-0 items-center px-1 font-medium text-[var(--text-secondary)]">用量明细 →</button>
      </div>
    </div>
    {/* 邀请弹窗 z-[140] 盖在底部面板（z-[70]）之上，不必先收起面板，关掉弹窗还能继续操作 */}
    <InviteCreditsDialog open={inviteOpen} referral={referralQuery.data ?? null} copied={inviteCopied} onCopy={() => void copyInvite()} onClose={() => { autoCopyRef.current = false; setInviteOpen(false) }} />
  </>
}
