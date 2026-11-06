import { formatModelPrice } from '../../../../shared/model-price-format'
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { CreditModelOption } from '../../../../shared/contracts/credits'

/** Values and activity identity come from the server's current price projection. */
export function ModelPriceSummary({ model }: { model: CreditModelOption }) {
  const base = model.baseMultiplier ?? model.multiplier
  const discounted = Boolean(model.activity?.name) && base > model.multiplier
  return <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1 break-words">
    {model.activity?.name && <span>{model.activity.name}</span>}
    {discounted && <s className="text-[var(--text-tertiary)]">{formatModelPrice(base)}x</s>}
    <span>{formatModelPrice(model.multiplier)}x</span>
  </span>
}

export function ModelPriceDetails({ model, children, className = '' }: { model: CreditModelOption; children?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const panelId = useId()
  const close = useCallback(() => { clearTimeout(closeTimer.current); setOpen(false) }, [])
  const contains = useCallback((target: EventTarget | null) => target instanceof Node && Boolean(anchor.current?.contains(target) || panel.current?.contains(target)), [])
  const keepOpen = () => { clearTimeout(closeTimer.current); setOpen(true) }
  const leave = (target: EventTarget | null) => {
    if (contains(target) || contains(document.activeElement)) return
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(close, 160)
  }
  const [position, setPosition] = useState({ left: 8, top: 8, width: 288, maxHeight: 320 })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const vx = viewport?.offsetLeft ?? 0, vy = viewport?.offsetTop ?? 0
      const vw = viewport?.width ?? window.innerWidth, vh = viewport?.height ?? window.innerHeight
      if (rect.bottom < vy || rect.top > vy + vh || rect.right < vx || rect.left > vx + vw) { close(); return }
      const width = Math.min(288, Math.max(0, vw - 16))
      const fitsLeft = rect.left - width - 10 >= vx + 8, fitsRight = rect.right + width + 10 <= vx + vw - 8
      const above = Math.max(0, rect.top - vy - 18), below = Math.max(0, vy + vh - rect.bottom - 18)
      const vertical = !fitsLeft && !fitsRight, useAbove = above >= Math.min(320, (panel.current?.scrollHeight ?? 318) + 2) || above >= below
      const maxHeight = Math.min(320, vertical ? useAbove ? above : below : Math.max(0, vh - 16))
      const height = Math.min(maxHeight, (panel.current?.scrollHeight ?? 318) + 2)
      const left = fitsLeft ? rect.left - width - 10 : fitsRight ? rect.right + 10
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
  }, [open, model, contains, close])
  const zone = model.activity?.timezone ?? 'Asia/Shanghai'
  const timestamp = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value))
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return <div ref={anchor} aria-label={`${model.label}模型卡片`} aria-describedby={open ? panelId : undefined} tabIndex={children ? undefined : 0}
    data-model-price-open={open ? '' : undefined} className={`relative min-w-0 ${className}`}
    onMouseEnter={keepOpen} onMouseLeave={event => leave(event.relatedTarget)}
    onFocusCapture={event => { if (anchor.current?.contains(event.target)) returnFocus.current = event.target; keepOpen() }}
    onBlur={event => { if (!contains(event.relatedTarget)) close() }}
    onClickCapture={event => { if (event.target instanceof Node && anchor.current?.contains(event.target)) close() }}>
    {children ?? <span className="flex items-center justify-between gap-3 text-sm"><span>{model.label}</span><ModelPriceSummary model={model} /></span>}
    {open && createPortal(<div ref={panel} id={panelId} role="tooltip" tabIndex={0} className="studio-workspace fixed z-[250] space-y-2 overflow-y-auto overscroll-contain rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-solid)] p-3 text-left text-xs font-normal text-[var(--text-primary)] shadow-xl"
      style={{ position: 'fixed', ...position }}
      onMouseEnter={keepOpen} onMouseLeave={event => leave(event.relatedTarget)} onFocus={keepOpen} onBlur={event => { if (!contains(event.relatedTarget)) close() }}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <p className="font-medium">{model.label}</p>
      {model.publicDescription && <p className="whitespace-pre-wrap">{model.publicDescription}</p>}
      {model.publicFeatures?.length ? <ul className="list-inside list-disc">{model.publicFeatures.map((feature, index) => <li key={index}>{feature}</li>)}</ul> : null}
      <p>基础倍率 {model.activity?.name && (model.baseMultiplier ?? model.multiplier) > model.multiplier ? <s>{formatModelPrice(model.baseMultiplier ?? model.multiplier)}x</s> : <span>{formatModelPrice(model.baseMultiplier ?? model.multiplier)}x</span>} · 当前 <span>{formatModelPrice(model.multiplier)}x</span></p>
      {model.discountRatio !== undefined && model.discountRatio !== null && <p>当前 / 基础 {formatModelPrice(model.discountRatio)}</p>}
      <p>思考强度：{model.reasoningEfforts.join('、')} · 默认 {model.defaultReasoningEffort}</p>
      {model.freePromotion && <p>限时免费至 {timestamp(model.freePromotion.endsAt)}（{zone}），到期倍率 {formatModelPrice(model.freePromotion.afterMultiplier)}x</p>}
      {model.activity && <><p>活动时区：{zone}{model.activity.name ? ' · 当前 ' + model.activity.name : ''}</p>{model.activity.rules.map((rule, index) => <p key={index}>{rule.name}（{rule.enabled ? '启用' : '停用'}）：{rule.startDate ?? '不限开始'} 至 {rule.endDate ? rule.endDate + '（不含）' : '不限结束'}；周{rule.weekdays.map(day => weekdays[day]).join('、')}；{rule.allDay ? '全天' : rule.startTime + '–' + rule.endTime + (rule.endTime < rule.startTime ? '（跨夜，按开始日）' : '')}；{formatModelPrice(rule.multiplierBps / 10000)}x</p>)}{model.activity.nextSwitchAt && <p>下次切换：{timestamp(model.activity.nextSwitchAt)}（{zone}）</p>}</>}
    </div>, anchor.current?.closest('dialog') ?? document.fullscreenElement ?? document.body)}
  </div>
}
