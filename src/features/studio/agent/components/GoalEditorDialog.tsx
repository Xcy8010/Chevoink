import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, History, LoaderCircle, RefreshCw, Save, Target, X } from 'lucide-react'

import type { AgentGoalSnapshot } from '../../../../../shared/contracts/agent-goal.js'
import { agentGoalObjectiveSchema, agentGoalPresentation } from '../../../../../shared/contracts/agent-goal.js'
import type { AgentGoalDetail } from '../../../../../shared/contracts/agent-goal.js'
import { formatCreditsMicros, formatGoalReason } from './goal-formatters'
import { useDialogFocusTrap } from '../../components/use-dialog-focus-trap'

export type GoalEditBase = Pick<AgentGoalSnapshot, 'id' | 'sessionId' | 'revision' | 'stateVersion'>

type GoalEditorDialogProps = {
  open: boolean
  goal?: AgentGoalSnapshot | null
  initialObjective?: string
  busy: boolean
  error?: string
  detail?: AgentGoalDetail | null
  detailBusy?: boolean
  onLoadDetail?: () => void
  onConfirmCompletion?: () => void
  onRestartEdit?: () => void
  onClose: () => void
  onSave: (objective: string, base?: GoalEditBase) => void
}

export function GoalEditorDialog({ open, goal, initialObjective, busy, error, detail, detailBusy = false, onLoadDetail, onConfirmCompletion, onRestartEdit, onClose, onSave }: GoalEditorDialogProps) {
  const [objective, setObjective] = useState('')
  const [validationError, setValidationError] = useState('')
  const [base, setBase] = useState<GoalEditBase>()
  const editIdentity = useRef<{ id?: string; sessionId?: string; initialObjective?: string } | null>(null)
  const panel = useRef<HTMLElement>(null)
  const readOnly = goal?.status === 'completed' || goal?.status === 'cancelled'
  const updating = goal?.pendingRevision != null

  useEffect(() => {
    if (!open) { editIdentity.current = null; return }
    const previous = editIdentity.current
    if (previous && previous.id === goal?.id && previous.sessionId === goal?.sessionId && previous.initialObjective === initialObjective) return
    editIdentity.current = { id: goal?.id, sessionId: goal?.sessionId, initialObjective }
    setObjective(initialObjective ?? goal?.objective ?? '')
    setBase(goal ?? undefined)
    setValidationError('')
  }, [goal, initialObjective, open])

  useDialogFocusTrap({ panel, open, onClose: () => { if (!busy) onClose() } })

  if (!open) return null

  const save = () => {
    if (updating) return
    const result = agentGoalObjectiveSchema.safeParse(objective)
    if (!result.success) { setValidationError(result.error.issues[0].message); return }
    onSave(result.data, base)
  }
  const hasNewVersion = goal && base && goal.id === base.id && goal.stateVersion > base.stateVersion

  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[160] flex min-h-0 items-center justify-center overflow-hidden bg-[rgba(15,23,42,0.32)] px-3 py-3 backdrop-blur-[2px] sm:px-4 sm:py-6" role="presentation" onClick={onClose}>
      <section ref={panel} role="dialog" aria-modal="true" aria-label="编辑目标" tabIndex={-1} className="flex max-h-[calc(100dvh-24px)] min-h-0 w-full max-w-xl flex-col overflow-hidden rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_28px_80px_rgba(15,23,42,0.28)] sm:max-h-[calc(100dvh-48px)]" onClick={event => event.stopPropagation()}>
        <header className="flex shrink-0 items-center gap-2.5 border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-[var(--surface-muted)] text-[var(--text-secondary)]"><Target aria-hidden="true" className="h-4 w-4" /></span>
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{readOnly ? '目标详情' : goal ? '修改目标' : '新建目标'}</h2>
          {goal && onLoadDetail ? <button type="button" disabled={busy || detailBusy} onClick={onLoadDetail} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-wait disabled:opacity-40" aria-label="刷新目标详情" title="刷新目标详情">{detailBusy ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}</button> : null}
          <button type="button" disabled={busy} onClick={onClose} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-40" aria-label="关闭目标编辑"><X aria-hidden="true" className="h-4 w-4" /></button>
        </header>

        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [-webkit-overflow-scrolling:touch] sm:px-5">
          <label className="block text-xs font-medium text-[var(--text-primary)]" htmlFor="agent-goal-objective">目标</label>
          <textarea id="agent-goal-objective" aria-label="目标" value={objective} disabled={busy || readOnly} onChange={event => { setObjective(event.target.value); setValidationError('') }} className="mt-2 min-h-36 w-full resize-y rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2.5 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--text-secondary)] focus:ring-2 focus:ring-[var(--text-secondary)]/15 disabled:opacity-60" placeholder="写下要持续完成的结果" />
          <p className="mt-1 text-right text-[10px] tabular-nums text-[var(--text-tertiary)]">{Array.from(objective).length}/12,000</p>
          {hasNewVersion && !readOnly ? <button type="button" disabled={busy || updating} onClick={() => {
            setObjective(goal.objective)
            setBase(goal)
            setValidationError('')
            onRestartEdit?.()
          }} className="min-h-11 rounded-[9px] px-2 text-xs text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 disabled:opacity-40">读取新版并重新编辑</button> : null}

          {goal ? (
            <details className="mt-3 rounded-[12px] border border-[var(--border-subtle)]" open>
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2"><History aria-hidden="true" className="h-4 w-4 text-[var(--text-secondary)]" />目标详情</summary>
              <div className="border-t border-[var(--border-subtle)] px-3 py-3 text-[11px] text-[var(--text-secondary)]">
                {detailBusy ? <div className="flex items-center gap-2 py-2"><LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />正在读取详情…</div> : detail ? (
                  <>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                      <div><dt className="text-[var(--text-tertiary)]">状态</dt><dd className="mt-0.5 font-medium text-[var(--text-primary)]">{agentGoalPresentation(detail.goal).label}</dd></div>
                      <div><dt className="text-[var(--text-tertiary)]">Token</dt><dd className="mt-0.5 tabular-nums text-[var(--text-primary)]">{detail.goal.tokensUsed}/{detail.goal.tokenLimit}</dd></div>
                      <div><dt className="text-[var(--text-tertiary)]">Credits</dt><dd className="mt-0.5 tabular-nums text-[var(--text-primary)]">{formatCreditsMicros(detail.goal.creditsUsedMicros)}</dd></div>
                      <div><dt className="text-[var(--text-tertiary)]">原因</dt><dd className="mt-0.5 text-[var(--text-primary)]">{formatGoalReason(detail.goal.reasonCode)}</dd></div>
                    </dl>
                    {detail.completion.canConfirm && detail.completion.needsAuthorVerification && !readOnly ? (
                      <button type="button" disabled={busy} onClick={onConfirmCompletion} className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-[9px] bg-[var(--surface-contrast)] px-3.5 text-xs font-medium text-[var(--text-contrast)] transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 disabled:cursor-wait disabled:opacity-40" aria-label="确认目标完成">
                        {busy ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />}确认目标完成
                      </button>
                    ) : null}
                    {detail.revisions.length > 0 ? <div className="mt-3"><h3 className="flex items-center gap-1 font-medium text-[var(--text-primary)]"><History aria-hidden="true" className="h-3.5 w-3.5" />版本历史</h3><ul className="mt-1.5 space-y-1.5">{detail.revisions.map(revision => <li key={revision.revision} className="flex gap-2"><span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">v{revision.revision}</span><span className="min-w-0 truncate" title={revision.objective}>{revision.objective}</span></li>)}</ul></div> : null}
                    {detail.evidence.length > 0 ? <div className="mt-3"><h3 className="font-medium text-[var(--text-primary)]">验收项</h3><ul className="mt-1.5 space-y-1.5">{detail.evidence.map(item => <li key={item.criterionId} className="flex items-start gap-1.5"><CheckCircle2 aria-hidden="true" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${item.status === 'verified' ? 'text-emerald-600' : 'text-[var(--text-tertiary)]'}`} /><span className="min-w-0 truncate" title={item.description}>{item.description}</span></li>)}</ul></div> : null}
                  </>
                ) : <button type="button" onClick={onLoadDetail} className="min-h-11 rounded-[9px] px-2 text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2">读取详情</button>}
              </div>
            </details>
          ) : null}

          {validationError || error ? <p role="alert" className="mt-3 rounded-[9px] bg-rose-500/8 px-3 py-2 text-xs leading-5 text-rose-600">{validationError || error}</p> : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-4 py-3 sm:px-5">
          <button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-[9px] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 disabled:opacity-40">取消</button>
          {!readOnly ? <button type="button" disabled={busy || updating || !objective.trim()} onClick={save} className="inline-flex min-h-11 items-center gap-1.5 rounded-[9px] bg-[var(--surface-contrast)] px-3.5 text-xs font-medium text-[var(--text-contrast)] transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40" aria-label="保存目标">{busy || updating ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden="true" className="h-3.5 w-3.5" />}{updating ? '更新中…' : busy ? '保存中…' : '保存目标'}</button> : null}
        </footer>
      </section>
    </div>,
    document.body,
  )
}

export type { GoalEditorDialogProps }
