import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import type { CreditModelOption, CreditModelTier, CustomModelView, ModelReasoningEffort } from '../../../../../shared/contracts/index.js'
import { cn } from '@/lib/utils'
import { ReasoningSlider } from './ReasoningSlider'

type Props = {
  modelOptions: CreditModelOption[]
  customModels: CustomModelView[]
  modelTier: CreditModelTier
  customModelId: string | null
  activeModelLabel: string
  activeReasoningEffort: ModelReasoningEffort
  activeReasoningEfforts: ModelReasoningEffort[]
  onTier: (tier: CreditModelTier) => void
  onCustom: (id: string) => void
  onReasoning: (effort: ModelReasoningEffort) => void
  onSettings: () => void
  onClose: () => void
}


/** A single viewport-bound surface, never positioned relative to a narrow toolbar. */
export function AgentMobileModelSheet(props: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    const resize = () => {
      const viewport = window.visualViewport
      dialog.style.maxHeight = `${Math.max(140, (viewport?.height ?? window.innerHeight) - 16)}px`
      dialog.style.bottom = `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`
      if (window.innerWidth >= 768) close.current()
    }
    resize()
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    return () => {
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('scroll', resize)
      dialog.close()
      document.body.style.overflow = overflow
      previous?.focus({ preventScroll: true })
    }
  }, [])

  const row = (key: string, label: string, selected: boolean, detail: string, onClick: () => void, badge?: ReactNode) => (
    <button key={key} type="button" aria-pressed={selected} onClick={onClick} className={cn('flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm', selected ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]')}>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 break-words">{label}{badge}</span>
      <span className="shrink-0 text-xs text-[var(--text-tertiary)]">{detail}</span>
      <span className="w-4 shrink-0">{selected && <Check className="h-4 w-4" />}</span>
    </button>
  )

  return createPortal(
    <dialog ref={ref} data-native-back-dismiss aria-label="模型与思考设置" onCancel={props.onClose} onClick={event => { if (event.target === event.currentTarget) props.onClose() }} className="studio-workspace fixed inset-x-0 bottom-0 top-auto m-0 w-full max-w-none overflow-hidden rounded-t-2xl border-0 bg-[var(--surface-solid)] p-0 text-[var(--text-primary)] backdrop:bg-black/35">
      <div className="flex max-h-[inherit] flex-col pb-[max(12px,env(safe-area-inset-bottom))]">
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
          <h2 className="text-base font-semibold">模型与思考</h2>
          <button type="button" onClick={props.onClose} aria-label="关闭模型设置" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-[var(--surface-muted)]"><X className="h-5 w-5" /></button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-3 py-3">
          <p className="px-3 pb-2 text-xs text-[var(--text-tertiary)]">内置模型 · Credits 倍率</p>
          {props.modelOptions.filter(option => option.available).map(option => row(option.tier, option.label, props.modelTier === option.tier, `${option.multiplier.toFixed(1)}x`, () => props.onTier(option.tier), option.multiplier === 0 ? <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--color-error)]">免费</span> : undefined))}
          {props.customModels.some(model => model.enabled) && <p className="px-3 pb-2 pt-4 text-xs text-[var(--text-tertiary)]">自定义模型</p>}
          {props.customModels.filter(model => model.enabled).map(model => row(model.id, model.displayName, props.modelTier === 'custom' && props.customModelId === model.id, '自有密钥', () => props.onCustom(model.id)))}
          <section className="mt-3 border-t border-[var(--border-subtle)] px-3 pt-4">
            <ReasoningSlider efforts={props.activeReasoningEfforts} value={props.activeReasoningEffort} modelLabel={props.activeModelLabel} onChange={props.onReasoning} />
          </section>
          <button type="button" onClick={props.onSettings} className="mt-3 min-h-11 w-full px-3 text-left text-sm text-[var(--text-secondary)]">配置自定义模型</button>
        </div>
        <footer className="shrink-0 border-t border-[var(--border-subtle)] px-4 pt-3"><button type="button" onClick={props.onClose} className="min-h-11 w-full rounded-xl bg-[var(--surface-contrast)] text-sm text-[var(--text-contrast)]">完成</button></footer>
      </div>
    </dialog>, document.body,
  )
}
