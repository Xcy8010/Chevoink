import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Gift } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatCreditAmount, formatCreditResetLabel } from '@/features/account/credit-format'
import { fetchCreditSummary, fetchReferral } from '@/features/account/credits-api'
import InviteCreditsDialog from '@/features/account/InviteCreditsDialog'
import Avatar from '@/features/community/components/Avatar'
import { useShellStore } from '@/store/useShellStore'

/** 固定侧栏底栏的个人信息与可展开的用量、邀请入口。 */
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

  const nickname = sessionUser?.nickname ?? '创作者'
  return <>
    <details className="min-w-0 flex-1">
      <summary aria-label={nickname + '，账户与用量'} className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-lg pr-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
        <Avatar name={nickname} src={sessionUser?.avatarUrl} size="sm" className="h-9 w-9 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold" title={nickname}>{nickname}</span>
          {sessionUser?.emailAuthEnabled && sessionUser.email ? <span className="block truncate text-[11px] text-[var(--text-tertiary)]" title={sessionUser.email}>{sessionUser.email}</span> : null}
        </span>
        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
      </summary>
      <div className="absolute inset-x-3 bottom-full z-10 mb-2 rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 shadow-xl">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">账户与用量</p>
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
    </details>
    <InviteCreditsDialog open={inviteOpen} referral={referralQuery.data ?? null} copied={inviteCopied} onCopy={() => void copyInvite()} onClose={() => { autoCopyRef.current = false; setInviteOpen(false) }} />
  </>
}
