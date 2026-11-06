import { formatModelPrice } from '../../../../shared/model-price-format'
import { modelPublicCopy } from '../../../../shared/model-public-copy'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Clock3 } from 'lucide-react'
import type { CreditModelOption, ModelReasoningEffort } from '../../../../shared/contracts/credits'

const effortLabels: Record<ModelReasoningEffort, string> = { none: '关闭', minimal: '轻度', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }
const effortOrder: ModelReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
let closeActiveDetails: (() => void) | null = null

/** The row shows the current multiplier; activity labels sit beside the model name. */
export function ModelPriceSummary({ model }: { model: CreditModelOption }) {
  return <span className="whitespace-nowrap tabular-nums">{formatModelPrice(model.multiplier)}x</span>
}

export function ModelActivityBadge({ model }: { model: CreditModelOption }) {
  const label = model.activity?.name ?? (model.multiplier === 0 ? model.freePromotion ? '限时免费' : '免费' : null)
  return label ? <span className="max-w-full shrink-0 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-700 dark:text-emerald-400">{label}</span> : null
}

type Props = { model: CreditModelOption; children?: ReactNode; className?: string; reasoningEffort?: ModelReasoningEffort; onReasoningChange?: (effort: ModelReasoningEffort) => void }
export function ModelPriceDetails({ model, children, className = '', reasoningEffort, onReasoningChange }: Props) {
  const [open, setOpen] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const panelId = useId()
  const close = useCallback(() => {
    if (closeActiveDetails === close) closeActiveDetails = null
    clearTimeout(closeTimer.current); setOpen(false); setReasoningOpen(false)
  }, [])
  useEffect(() => () => {
    clearTimeout(closeTimer.current)
    if (closeActiveDetails === close) closeActiveDetails = null
  }, [close])
  const contains = useCallback((target: EventTarget | null) => target instanceof Node && Boolean(anchor.current?.contains(target) || panel.current?.contains(target)), [])
  const keepOpen = () => {
    if (closeActiveDetails !== close) { closeActiveDetails?.(); closeActiveDetails = close }
    clearTimeout(closeTimer.current); setOpen(true)
  }
  const leave = (target: EventTarget | null) => {
    if (contains(target) || contains(document.activeElement)) return
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(close, 160)
  }
  const [position, setPosition] = useState({ left: 8, top: 8, width: 300, maxHeight: 320 })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const vx = viewport?.offsetLeft ?? 0, vy = viewport?.offsetTop ?? 0
      const vw = viewport?.width ?? window.innerWidth, vh = viewport?.height ?? window.innerHeight
      if (rect.bottom < vy || rect.top > vy + vh || rect.right < vx || rect.left > vx + vw) { close(); return }
      const width = Math.min(300, Math.max(0, vw - 16))
      const fitsRight = rect.right + width + 10 <= vx + vw - 8, fitsLeft = rect.left - width - 10 >= vx + 8
      const above = Math.max(0, rect.top - vy - 18), below = Math.max(0, vy + vh - rect.bottom - 18)
      const vertical = !fitsLeft && !fitsRight, useAbove = above >= Math.min(320, (panel.current?.scrollHeight ?? 280) + 2) || above >= below
      const maxHeight = Math.min(320, vertical ? useAbove ? above : below : Math.max(0, vh - 16))
      const height = Math.min(maxHeight, (panel.current?.scrollHeight ?? 280) + 2)
      const left = fitsRight ? rect.right + 10 : fitsLeft ? rect.left - width - 10
        : Math.max(vx + 8, Math.min(rect.right - width, vx + vw - width - 8))
      const top = vertical ? useAbove ? rect.top - height - 10 : rect.bottom + 10 : Math.max(vy + 8, Math.min(rect.top, vy + vh - height - 8))
      setPosition({ left, top, width, maxHeight })
    }
    const outside = (event: PointerEvent | FocusEvent) => { if (!contains(event.target)) close() }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      ;(returnFocus.current ?? anchor.current?.querySelector<HTMLElement>('button, [tabindex]') ?? anchor.current)?.focus()
      close()
    }
    const parents: HTMLDetailsElement[] = []
    for (let parent = anchor.current?.closest('details'); parent; parent = parent.parentElement?.closest('details') ?? null) parents.push(parent)
    const parentToggle = () => { if (parents.some(parent => !parent.open)) close() }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place)
    window.addEventListener('pointerdown', outside); window.addEventListener('focusin', outside); window.addEventListener('keydown', escape)
    parents.forEach(parent => parent.addEventListener('toggle', parentToggle))
    return () => {
      clearTimeout(closeTimer.current)
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place)
      window.removeEventListener('pointerdown', outside); window.removeEventListener('focusin', outside); window.removeEventListener('keydown', escape)
      parents.forEach(parent => parent.removeEventListener('toggle', parentToggle))
    }
  }, [open, model, reasoningOpen, contains, close])
  const copy = modelPublicCopy(model.tier, model)
  const effort = reasoningEffort && model.reasoningEfforts.includes(reasoningEffort) ? reasoningEffort : model.defaultReasoningEffort
  const zone = model.activity?.timezone ?? 'Asia/Shanghai'
  const zoneLabel = zone === 'Asia/Shanghai' ? '北京时间' : zone === 'UTC' ? 'UTC' : zone
  const timestamp = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
  return <div ref={anchor} aria-label={model.label + '模型卡片'} aria-describedby={open ? panelId : undefined} tabIndex={children ? undefined : 0}
    data-model-price-open={open ? '' : undefined} className={'relative min-w-0 ' + className}
    onMouseEnter={keepOpen} onMouseLeave={event => leave(event.relatedTarget)}
    onFocusCapture={event => { if (anchor.current?.contains(event.target)) returnFocus.current = event.target; keepOpen() }}
    onBlur={event => { if (!contains(event.relatedTarget)) close() }}
    onKeyDown={event => {
      if (event.key === 'ArrowRight' && anchor.current?.contains(event.target as Node)) {
        event.preventDefault(); keepOpen()
        requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('button') ?? panel.current)?.focus())
      }
    }}
    onClickCapture={event => { if (event.target instanceof Node && anchor.current?.contains(event.target)) close() }}>
    {children ?? <span className="flex items-center justify-between gap-3 text-sm"><span>{model.label}</span><ModelPriceSummary model={model} /></span>}
    {open && createPortal(<div ref={panel} id={panelId} role="dialog" aria-label={model.label + '模型详情'} tabIndex={0}
      className="studio-workspace fixed z-[250] overflow-y-auto overscroll-contain rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-5 text-left text-[13px] font-normal leading-relaxed text-[var(--text-primary)] shadow-[0_16px_48px_rgba(0,0,0,.18)]"
      style={{ position: 'fixed', backgroundColor: 'color-mix(in srgb, var(--surface-default) 60%, var(--surface-elevated))', ...position }}
      onMouseEnter={keepOpen} onMouseLeave={event => leave(event.relatedTarget)} onFocus={keepOpen} onBlur={event => { if (!contains(event.relatedTarget)) close() }}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <h3 className="text-[15px] font-semibold leading-6">{model.label}</h3>
      <p className="mt-2 whitespace-pre-wrap text-[var(--text-secondary)]">{copy.publicDescription || '适合日常写作、内容梳理与文字修改。'}</p>
      {copy.publicFeatures.length ? <ul aria-label="模型特性" className="mt-3 flex flex-wrap gap-1.5">{copy.publicFeatures.map((feature, index) => <li key={index} className="max-w-full break-words rounded-md bg-[var(--surface-muted)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">{feature}</li>)}</ul> : null}
      <div className="mt-4 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
        <div className="flex min-h-12 items-center justify-between gap-4 py-2"><span className="font-medium">消耗速度</span><span className="whitespace-nowrap font-medium text-[var(--text-secondary)]"><ModelPriceSummary model={model} /> 倍率</span></div>
        {onReasoningChange ? <button type="button" aria-label={'编辑' + model.label + '思考模式'} aria-expanded={reasoningOpen}
          onClick={() => setReasoningOpen(value => !value)} className="flex min-h-12 w-full items-center justify-between gap-4 py-2 text-left hover:text-[var(--text-secondary)]">
          <span className="font-medium">思考强度</span><span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">{effortLabels[effort]}<ChevronRight className={'h-3.5 w-3.5 transition-transform ' + (reasoningOpen ? 'rotate-90' : '')} /></span>
        </button> : <div className="flex min-h-12 items-center justify-between gap-4 py-2"><span className="font-medium">思考强度</span><span className="text-[var(--text-secondary)]">{effortLabels[effort]}</span></div>}
      </div>
      {reasoningOpen && onReasoningChange ? <div role="group" aria-label={model.label + '思考强度选项'} className="mt-2 space-y-1">
        {effortOrder.filter(value => model.reasoningEfforts.includes(value)).map(value => <button key={value} type="button" aria-label={'设置' + model.label + '思考强度为' + effortLabels[value]} aria-pressed={value === effort}
          onClick={() => { onReasoningChange(value); setReasoningOpen(false) }} className="flex min-h-9 w-full items-center justify-between rounded-lg px-2.5 text-left hover:bg-[var(--surface-muted)]"><span>{effortLabels[value]}</span>{value === effort ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : null}</button>)}
      </div> : null}
      {model.freePromotion || model.activity?.name ? <div className="mt-3 space-y-1 text-xs leading-5 text-[var(--text-secondary)]">
        <p className="flex items-center gap-1.5 font-medium"><Clock3 className="h-3.5 w-3.5 shrink-0" />{model.activity?.name ?? '限时免费'}</p>
        {model.freePromotion ? <p>免费至{timestamp(model.freePromotion.endsAt)}（{zoneLabel}），之后为{formatModelPrice(model.freePromotion.afterMultiplier)}x。</p>
          : model.activity?.nextSwitchAt ? <p>下次调整：{timestamp(model.activity.nextSwitchAt)}（{zoneLabel}）</p> : null}
      </div> : null}
    </div>, anchor.current?.closest('dialog') ?? document.fullscreenElement ?? document.body)}
  </div>
}
