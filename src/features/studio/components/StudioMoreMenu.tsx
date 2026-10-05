import { useQuery } from '@tanstack/react-query'
import { Bug, ChevronDown, Gauge, Gift, Lightbulb, MoreHorizontal, Settings2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatCreditAmount, formatCreditResetLabel } from '@/features/account/credit-format'
import { fetchCreditSummary, fetchReferral } from '@/features/account/credits-api'
import InviteCreditsDialog from '@/features/account/InviteCreditsDialog'
import FeedbackDialog from '@/features/feedback/components/FeedbackDialog'
import { cn } from '@/lib/utils'
import type { FeedbackKind } from '../../../../shared/contracts/index.js'

export type StudioSettingsSection = 'general' | 'models' | 'operations' | 'archives'

type Props = {
  onOpenStudioSettings?: (section?: StudioSettingsSection) => void
}

/**
 * IDE 顶栏「…」菜单：Work 视图的账户菜单在 IDE 下没有落点，
 * 这里把用量、邀请、创作区设置与反馈入口收纳到返回首页左侧。
 */
export default function StudioMoreMenu(props: Props) {
  const [open, setOpen] = useState(false)
  const [usageExpanded, setUsageExpanded] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const autoCopyRef = useRef(false)

  const creditQuery = useQuery({ queryKey: ['credits', 'summary'], queryFn: fetchCreditSummary, staleTime: 20_000, refetchInterval: 60_000 })
  const referralQuery = useQuery({ queryKey: ['credits', 'referral'], queryFn: fetchReferral, staleTime: 60_000, enabled: inviteOpen })
  const summary = creditQuery.data
  const betaEnabled = summary?.publicBetaEnabled === true
  const remainingPercent = summary?.dailyAllowance ? Math.max(0, Math.min(100, Math.round(summary.totalRemaining / summary.dailyAllowance * 100))) : 100

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

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

  function openInvite() {
    setOpen(false)
    setInviteOpen(true)
    autoCopyRef.current = true
    if (referralQuery.data?.inviteUrl) { autoCopyRef.current = false; void copyInvite() }
  }

  const item = 'flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'

  return <>
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="更多"
        title="更多"
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-[var(--border-subtle)] transition-colors',
          open ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
        )}
      ><MoreHorizontal className="h-4 w-4" /></button>
      {open ? <div className="absolute right-0 top-[calc(100%+7px)] z-[70] w-[268px] overflow-hidden rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1.5 shadow-[0_20px_55px_rgba(15,23,42,.22)] motion-safe:origin-top-right motion-safe:animate-[agent-menu-in_150ms_cubic-bezier(.2,.8,.2,1)]">
        {betaEnabled ? <div className="mb-1 flex items-center gap-2 rounded-[10px] bg-emerald-600 px-3 py-2.5 text-[11px] text-white shadow-[0_5px_16px_rgba(5,150,105,.18)]">
          <Gift className="h-3.5 w-3.5" />
          <span className="font-medium">公测期间，每日送 450 Credits！</span>
        </div> : null}
        <button type="button" onClick={() => setUsageExpanded((value) => !value)} className={cn(item, 'font-medium')}>
          <Gauge className="h-3.5 w-3.5" />
          <span className="flex-1">剩余用量</span>
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', usageExpanded && 'rotate-180')} />
        </button>
        {usageExpanded ? <div className="mx-1 mb-1 rounded-[10px] bg-[var(--surface-muted)] px-3 py-2.5 text-[11px]">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[var(--text-tertiary)]">当前可用</p>
              {(summary?.reserved ?? 0) > 0 && <p className="text-[10px] text-[var(--text-tertiary)]">另有 {formatCreditAmount(summary?.reserved ?? 0)} Credits 待结算预留</p>}
              <p className="mt-0.5 text-base font-semibold tabular-nums">{summary ? formatCreditAmount(summary.totalRemaining) : '—'} <span className="text-[10px] font-normal">Credits</span></p>
            </div>
            {betaEnabled ? <span className="text-[10px] text-[var(--text-tertiary)]">{remainingPercent}%</span> : null}
          </div>
          {betaEnabled ? <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${remainingPercent}%` }} /></div> : null}
          <div className="mt-2 flex justify-between text-[10px] text-[var(--text-tertiary)]">
            <span>{betaEnabled ? '每日' : '基础额度'} {summary ? formatCreditAmount(summary.dailyAllowance) : '—'} Credits</span>
            {betaEnabled ? <span>{formatCreditResetLabel(summary?.resetsAt)}</span> : null}
          </div>
          {/* 新窗口打开账户页，创作区界面原样保留，看完直接切回来 */}
          <button type="button" onClick={() => window.open('/account/usage', '_blank', 'noopener,noreferrer')} className="mt-2 text-[10px] font-medium hover:underline">查看详细记录 →</button>
        </div> : null}
        <button type="button" onClick={openInvite} className={item}><Gift className="h-3.5 w-3.5" />邀请好友</button>
        {props.onOpenStudioSettings ? <button type="button" onClick={() => { setOpen(false); props.onOpenStudioSettings?.('general') }} className={item}><Settings2 className="h-3.5 w-3.5" />创作区设置</button> : null}
        <button type="button" onClick={() => { setOpen(false); setFeedbackKind('suggestion') }} className={item}><Lightbulb className="h-3.5 w-3.5" />提交建议</button>
        <button type="button" onClick={() => { setOpen(false); setFeedbackKind('bug') }} className={item}><Bug className="h-3.5 w-3.5" />问题反馈</button>
      </div> : null}
    </div>
    <InviteCreditsDialog open={inviteOpen} referral={referralQuery.data ?? null} copied={inviteCopied} onCopy={() => void copyInvite()} onClose={() => { autoCopyRef.current = false; setInviteOpen(false) }} />
    <FeedbackDialog open={feedbackKind !== null} kind={feedbackKind ?? 'bug'} source="studio-ide" onClose={() => setFeedbackKind(null)} />
  </>
}
