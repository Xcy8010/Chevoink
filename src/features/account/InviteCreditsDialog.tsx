import { Check, Copy, Gift, X } from 'lucide-react'
import { createPortal } from 'react-dom'

import { StudioPresence } from '@/features/studio/components/StudioPresence'
import Button from '@/components/ui/Button'
import type { ReferralPayload } from '../../../shared/contracts'
import { formatCreditAmount } from './credit-format'

type InviteCreditsDialogProps = {
  open: boolean
  referral: ReferralPayload | null
  copied?: boolean
  onCopy: () => void
  onClose: () => void
}

export default function InviteCreditsDialog({
  open,
  referral,
  copied = false,
  onCopy,
  onClose,
}: InviteCreditsDialogProps) {
  return createPortal(
    <StudioPresence kind="dialog">{open && <div className="fixed inset-0 z-[260] flex items-end justify-center bg-black/30 px-0 backdrop-blur-[2px] sm:items-center sm:px-5">
      <section data-studio-motion-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-credits-title"
        className="w-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-5 pb-[calc(24px+var(--safe-bottom))] pt-5 shadow-[0_24px_70px_rgba(15,23,42,0.18)] sm:max-w-[500px] sm:rounded-[22px] sm:p-6"
      >
        <div className="flex items-start justify-between gap-6">
          <div>
            <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border-subtle)] text-[var(--text-primary)]">
              <Gift className="h-[18px] w-[18px]" />
            </span>
            <h2 id="invite-credits-title" className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
              邀请好友，继续创作
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              好友通过专属链接首次注册，完成手机验证并使用平台模型获得一次有效的 Agent 回复后，你获得 {formatCreditAmount(referral?.inviterReward ?? 300)} Credits，好友获得 {formatCreditAmount(referral?.inviteeReward ?? 120)} Credits。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
            aria-label="关闭邀请弹窗"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-6 border-y border-[var(--border-subtle)] py-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">专属邀请链接</p>
          <p className="mt-2 break-all text-sm leading-6 text-[var(--text-primary)]">
            {referral?.inviteUrl ?? '正在生成邀请链接…'}
          </p>
        </div>

        <div className="mt-5 flex items-center justify-between gap-4">
          <p className="text-xs leading-5 text-[var(--text-tertiary)]">
            已成功邀请 {referral?.successfulInvites ?? 0} 人 · 累计获得 {formatCreditAmount(referral?.totalEarned ?? 0)} Credits
          </p>
          <Button variant="primary" onClick={onCopy} disabled={!referral} className="shrink-0">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? '已复制' : '复制链接'}
          </Button>
        </div>
      </section>
    </div>}</StudioPresence>,
    document.body,
  )
}
