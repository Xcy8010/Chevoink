import { formatModelPrice } from '../../../../shared/model-price-format'
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
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

export function ModelPriceDetails({ model }: { model: CreditModelOption }) {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const anchor = useRef<HTMLDetailsElement>(null)
  const trigger = useRef<HTMLElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const panelId = useId()
  const close = useCallback(() => { clearTimeout(closeTimer.current); pinned.current = false; setOpen(false) }, [])
  const [position, setPosition] = useState({ left: 8, top: 8, width: 288, maxHeight: 320, above: false })
  const contains = useCallback((target: EventTarget | null) => target instanceof Node && (anchor.current?.contains(target) || panel.current?.contains(target)), [])
  const keepOpen = () => { clearTimeout(closeTimer.current); setOpen(true) }
  const leave = (target: EventTarget | null) => {
    if (pinned.current || contains(target) || contains(document.activeElement)) return
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(close, 160)
  }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const vx = viewport?.offsetLeft ?? 0, vy = viewport?.offsetTop ?? 0
      const vw = viewport?.width ?? window.innerWidth, vh = viewport?.height ?? window.innerHeight
      if (rect.bottom < vy || rect.top > vy + vh || rect.right < vx || rect.left > vx + vw) { close(); return }
      const width = Math.min(288, Math.max(0, vw - 16))
      const aboveSpace = Math.max(0, rect.top - vy - 14)
      const belowSpace = Math.max(0, vy + vh - rect.bottom - 14)
      const naturalHeight = Math.min(320, (panel.current?.scrollHeight ?? 318) + 2)
      const above = belowSpace < naturalHeight && aboveSpace > belowSpace
      setPosition({ left: Math.max(vx + 8, Math.min(rect.right - width, vx + vw - width - 8)),
        top: above ? rect.top - 6 : rect.bottom + 6, width, maxHeight: Math.min(320, above ? aboveSpace : belowSpace), above })
    }
    const outside = (event: PointerEvent | FocusEvent) => { if (!contains(event.target)) close() }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      trigger.current?.focus()
      close()
    }
    // Native parent details can close independently of this portal.
    const parents: HTMLDetailsElement[] = []
    for (let parent = anchor.current?.parentElement?.closest('details'); parent; parent = parent.parentElement?.closest('details') ?? null) parents.push(parent)
    const parentToggle = () => { if (parents.some(parent => !parent.open)) close() }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    viewportListeners('addEventListener')
    window.addEventListener('pointerdown', outside); window.addEventListener('focusin', outside); window.addEventListener('keydown', escape)
    for (const parent of parents) parent.addEventListener('toggle', parentToggle)
    function viewportListeners(method: 'addEventListener' | 'removeEventListener') {
      window.visualViewport?.[method]('resize', place)
      window.visualViewport?.[method]('scroll', place)
    }
    return () => {
      clearTimeout(closeTimer.current)
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
      viewportListeners('removeEventListener')
      window.removeEventListener('pointerdown', outside); window.removeEventListener('focusin', outside); window.removeEventListener('keydown', escape)
      for (const parent of parents) parent.removeEventListener('toggle', parentToggle)
    }
  }, [open, model, contains, close])
  const zone = model.activity?.timezone ?? 'Asia/Shanghai'
  const timestamp = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value))
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return <details ref={anchor} open={open} data-model-price-open={open ? '' : undefined} className="relative shrink-0 text-xs font-normal" onMouseEnter={keepOpen} onMouseLeave={event => leave(event.relatedTarget)} onBlur={event => { if (!contains(event.relatedTarget)) close() }}>
    <summary ref={trigger} aria-controls={panelId} aria-expanded={open} onPointerDown={event => { if (event.pointerType === 'touch') event.preventDefault() }} aria-label={`${model.label}价格与能力详情`} className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2" onFocus={keepOpen} onClick={event => { event.preventDefault(); event.stopPropagation(); clearTimeout(closeTimer.current); if (pinned.current) close(); else { pinned.current = true; setOpen(true) } }}><Info className="h-3.5 w-3.5" /></summary>
    {open && createPortal(<div ref={panel} id={panelId} role="tooltip" tabIndex={0} className="studio-workspace fixed z-[250] space-y-2 overflow-y-auto overscroll-contain rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-solid)] p-3 text-left text-xs font-normal text-[var(--text-primary)] shadow-xl"
      style={{ position: 'fixed', left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, transform: position.above ? 'translateY(-100%)' : undefined }}
      onMouseEnter={keepOpen} onMouseLeave={event => leave(event.relatedTarget)} onFocus={keepOpen} onBlur={event => { if (!contains(event.relatedTarget)) close() }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <p className="font-medium">{model.label}</p>
      {model.publicDescription && <p className="whitespace-pre-wrap">{model.publicDescription}</p>}
      {model.publicFeatures?.length ? <ul className="list-inside list-disc">{model.publicFeatures.map((feature, index) => <li key={index}>{feature}</li>)}</ul> : null}
      <p>基础倍率 {model.activity?.name && (model.baseMultiplier ?? model.multiplier) > model.multiplier ? <s>{formatModelPrice(model.baseMultiplier ?? model.multiplier)}x</s> : <span>{formatModelPrice(model.baseMultiplier ?? model.multiplier)}x</span>} · 当前 <span>{formatModelPrice(model.multiplier)}x</span></p>
      {model.discountRatio !== undefined && model.discountRatio !== null && <p>当前 / 基础 {formatModelPrice(model.discountRatio)}</p>}
      {model.basePricing && <p>基础价格 / 百万 Token：输入 {formatModelPrice(model.basePricing.inputPerMillion)} · 缓存 {formatModelPrice(model.basePricing.cachePerMillion)} · 输出 {formatModelPrice(model.basePricing.outputPerMillion)} Credits</p>}
      {model.pricing ? <p>当前价格 / 百万 Token：输入 {formatModelPrice(model.pricing.inputPerMillion)} · 缓存 {formatModelPrice(model.pricing.cachePerMillion)} · 输出 {formatModelPrice(model.pricing.outputPerMillion)} Credits</p> : <p>当前计价：max（输入 Token，输出 Token × 10）× {formatModelPrice(model.multiplier)} / 10,000 Credits</p>}
      <p>思考强度：{model.reasoningEfforts.join('、')} · 默认 {model.defaultReasoningEffort}</p>
      <p>图片输入：{model.visionEnabled ? '支持' : '不支持'}</p>
      {model.freePromotion && <p>限时免费至 {timestamp(model.freePromotion.endsAt)}（{zone}），到期倍率 {formatModelPrice(model.freePromotion.afterMultiplier)}x</p>}
      {model.activity && <><p>活动时区：{zone}{model.activity.name ? ' · 当前 ' + model.activity.name : ''}</p>{model.activity.rules.map((rule, index) => <p key={index}>{rule.name}（{rule.enabled ? '启用' : '停用'}）：{rule.startDate ?? '不限开始'} 至 {rule.endDate ? rule.endDate + '（不含）' : '不限结束'}；周{rule.weekdays.map(day => weekdays[day]).join('、')}；{rule.allDay ? '全天' : rule.startTime + '–' + rule.endTime + (rule.endTime < rule.startTime ? '（跨夜，按开始日）' : '')}；{formatModelPrice(rule.multiplierBps / 10000)}x</p>)}{model.activity.nextSwitchAt && <p>下次切换：{timestamp(model.activity.nextSwitchAt)}（{zone}）</p>}</>}
    </div>, trigger.current?.closest('dialog') ?? document.fullscreenElement ?? document.body)}
  </details>
}
