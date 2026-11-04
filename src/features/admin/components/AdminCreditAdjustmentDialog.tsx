import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Gift, Minus, Replace, X } from 'lucide-react'
import Button from '@/components/ui/Button'
import { formatAdminCredits as formatCreditAmount } from '../admin-credit-format'
import { MAX_CREDIT_MILLI, type AdminCreditAdjustmentInput, type AdminCreditAdjustmentResult } from '../../../../shared/contracts/admin-credit-adjustment'
import { adjustAdminUserBonusCredits } from '../api'
import { useAdminDialog } from '../admin-dialog'
import TextInput from './AdminTextInput'
import AdminDangerActionDialog, { type AdminDangerPayload } from './AdminDangerActionDialog'

const modes = [
  { value: 'add', label: '赠送 Credits', icon: Gift },
  { value: 'subtract', label: '减少 Credits', icon: Minus },
  { value: 'set', label: '覆盖余额', icon: Replace },
] as const

/** Parse the entered decimal once into the wallet's exact integer milli unit. */
function parseAmount(value: string): number | null {
  if (!/^\d{1,7}(?:\.\d{1,3})?$/.test(value.trim())) return null
  const [whole, fraction = ''] = value.trim().split('.')
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  return milli <= MAX_CREDIT_MILLI ? milli : null
}

export default function AdminCreditAdjustmentDialog({ user, bonusBalance, onClose, onApplied }: {
  user: { id: string; nickname: string }
  bonusBalance: number
  onClose: () => void
  onApplied: (result: AdminCreditAdjustmentResult) => void
}) {
  const [mode, setMode] = useState<AdminCreditAdjustmentInput['mode']>('add')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [prepared, setPrepared] = useState<AdminCreditAdjustmentInput | null>(null)
  const dialogRef = useAdminDialog<HTMLElement>(!prepared, onClose)
  const before = Math.round(bonusBalance * 1000)
  const amountMilli = parseAmount(amount)
  const after = amountMilli === null ? null : mode === 'set' ? amountMilli : before + (mode === 'add' ? amountMilli : -amountMilli)
  const invalidAmount = amount.trim() && (amountMilli === null || (mode !== 'set' && amountMilli === 0))
  const invalidBalance = after !== null && (after < 0 || after > MAX_CREDIT_MILLI)
  const ready = amountMilli !== null && !invalidAmount && !invalidBalance && reason.trim().length > 0
  const submit = async (payload: AdminDangerPayload) => {
    if (!prepared) return
    const result = await adjustAdminUserBonusCredits(user.id, { ...prepared, ...payload })
    onApplied(result)
  }

  if (prepared) return <AdminDangerActionDialog open title={`确认调整 ${user.nickname} 的奖励 Credits`} description={`奖励余额从 ${formatCreditAmount(before / 1000)} 变为 ${formatCreditAmount(after! / 1000)} Credits。原因：${prepared.reason}`} confirmation="ADJUST_CREDITS" onConfirm={submit} onClose={onClose} />
  return createPortal(<div className="admin-portal fixed inset-0 z-[160] flex items-center justify-center overflow-y-auto bg-black/35 p-4 backdrop-blur-[2px]">
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="credit-adjustment-title" className="my-auto w-full max-w-lg rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] p-6 shadow-xl">
      <div className="flex items-start justify-between gap-4"><div><h2 id="credit-adjustment-title" className="text-lg font-semibold">调整奖励 Credits</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">{user.nickname}</p><p className="mt-1 break-all text-xs text-[var(--text-tertiary)]">{user.id}</p></div><button type="button" onClick={onClose} aria-label="关闭 Credits 调整" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--surface-muted)]"><X size={18} /></button></div>
      <form className="mt-5 space-y-5" onSubmit={event => {
        event.preventDefault()
        if (ready && amountMilli !== null) setPrepared({ mode, amountMilli, expectedBonusBalanceMilli: before, reason: reason.trim(), requestKey: crypto.randomUUID() })
      }}>
        <fieldset><legend className="mb-2 text-sm font-medium">调整方式</legend><div className="grid grid-cols-3 gap-2">{modes.map(item => <label key={item.value} className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border p-3 text-center text-xs sm:text-sm ${mode === item.value ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]' : 'border-[var(--border-default)]'}`}><input type="radio" name="credit-adjustment-mode" value={item.value} checked={mode === item.value} onChange={() => setMode(item.value)} className="sr-only peer" /><item.icon size={18} aria-hidden="true" /><span className="peer-focus-visible:underline">{item.label}</span></label>)}</div></fieldset>
        <label className="block text-sm font-medium">{mode === 'set' ? '目标奖励余额' : '调整数量'}<TextInput aria-label={mode === 'set' ? '目标奖励余额' : '调整数量'} className="mt-2" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.000" autoComplete="off" aria-invalid={Boolean(invalidAmount || invalidBalance)} /></label>
        {invalidAmount ? <p role="alert" className="text-sm text-[var(--color-error)]">请输入有效金额，最多三位小数；赠送和减少须大于 0。</p> : invalidBalance ? <p role="alert" className="text-sm text-[var(--color-error)]">{after! < 0 ? '减少数量不能超过当前奖励余额。' : '调整后的奖励余额超出上限。'}</p> : null}
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-muted)] p-4"><dl className="flex items-center justify-between gap-3 text-sm"><div><dt className="text-[var(--text-secondary)]">当前奖励余额</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{formatCreditAmount(bonusBalance)}</dd></div><span aria-hidden="true">→</span><div className="text-right"><dt className="text-[var(--text-secondary)]">调整后</dt><dd className="mt-1 text-xl font-semibold tabular-nums" aria-live="polite">{after === null || invalidBalance ? '—' : formatCreditAmount(after / 1000)}</dd></div></dl></div>
        <label className="block text-sm font-medium">调整原因<textarea aria-label="调整原因" required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} rows={3} className="mt-2 block w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] p-3 text-sm" placeholder="填写本次调整原因" /></label>
        <p className="text-xs leading-6 text-[var(--text-secondary)]">与好友邀请奖励使用同一奖励余额；每日额度和已用量保持不变。</p>
        <div className="flex justify-end gap-2 border-t border-[var(--border-default)] pt-4"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={!ready}>验证并确认</Button></div>
      </form>
    </section>
  </div>, document.body)
}
