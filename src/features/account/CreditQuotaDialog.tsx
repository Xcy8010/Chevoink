import { ArrowUpRight, Clock3, Gift, Gauge, X } from 'lucide-react'

import Button from '@/components/ui/Button'

type CreditQuotaDialogProps = {
  open: boolean
  resetsAt?: string
  globallyPaused?: boolean
  onInvite: () => void
  onClose: () => void
}

function resetLabel(value?: string): string {
  if (!value) return 'UTC+8 15:00'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

/** 输入框上方的额度状态条；保持在任务/变更停靠区之后，不使用遮罩或 portal。 */
export default function CreditQuotaDialog({ open, resetsAt, globallyPaused = false, onInvite, onClose }: CreditQuotaDialogProps) {
  if (!open) return null
  return <section role="status" aria-live="polite" className="mx-4 mb-2 rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3.5 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
    <div className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-default)]"><Gauge className="h-4 w-4 text-[var(--text-primary)]" /></span>
      <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold text-[var(--text-primary)]">{globallyPaused ? '模型服务暂时暂停' : '本期额度已用完'}</h2><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{globallyPaused ? '内置模型更新维护中，任务已安全停止，用户可自行配置自定义模型继续任务或等待服务维护后继续' : '每日额度会自动恢复，也可以邀请新朋友获得不会随每日重置清零的额外额度。'}</p>{!globallyPaused ? <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]"><Clock3 className="h-3.5 w-3.5" />下次重置 {resetLabel(resetsAt)}</p> : null}</div>
      <button type="button" onClick={onClose} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]" aria-label="关闭额度提示"><X className="h-3.5 w-3.5" /></button>
    </div>
    <div className="mt-3 flex flex-wrap justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => window.open('/account/usage', '_blank', 'noopener,noreferrer')}><ArrowUpRight className="h-3.5 w-3.5" />查看用量</Button>{!globallyPaused ? <Button size="sm" variant="primary" onClick={onInvite}><Gift className="h-3.5 w-3.5" />邀请好友</Button> : null}</div>
  </section>
}
