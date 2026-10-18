import { Check, Copy, Trash2, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatMessageTime } from '../lib/message-time'
import { useLocalCalendarDay } from '../useLocalCalendarDay'

export function MessageTime({ value, label, className }: { value?: string | null; label: string; className?: string }) {
  useLocalCalendarDay()
  const time = formatMessageTime(value)
  if (!time || !value) return null
  const date = new Date(value)
  return <time dateTime={value} title={`${label}：${date.toLocaleString('zh-CN', { hour12: false })}`} aria-label={`${label} ${time}`} className={cn('text-xs tabular-nums text-[var(--text-tertiary)]', className)}>{time}</time>
}

/** One hover/focus target owns all actions; touch keeps the existing long press. */
export function UserMessageActions({ createdAt, visible, copied, disabled, onCopy, onRollback, onDelete }: {
  createdAt: string; visible: boolean; copied: boolean; disabled: boolean
  onCopy: () => void; onRollback: () => void; onDelete: () => void
}) {
  const button = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40 mobile:h-10 mobile:w-10'
  return <div role="group" aria-label="用户消息操作" className={cn('flex items-center justify-end gap-0.5 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100', visible ? 'opacity-100' : 'opacity-0')}>
    <MessageTime value={createdAt} label="发送时间" className="mr-2" />
    <button type="button" onClick={onCopy} className={button} aria-label="复制消息" title={copied ? '已复制' : '复制'}>{copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}</button>
    <button type="button" onClick={onRollback} disabled={disabled} className={button} aria-label="回退到此对话之前" title="回退到此对话之前"><Undo2 className="h-3.5 w-3.5" /></button>
    <button type="button" onClick={onDelete} disabled={disabled} className={cn(button, 'hover:text-rose-500')} aria-label="删除这轮对话" title="删除这轮对话"><Trash2 className="h-3.5 w-3.5" /></button>
  </div>
}
