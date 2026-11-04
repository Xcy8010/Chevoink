import { useId, useState, type PointerEvent } from 'react'

export type TrendSeries = { label: string; values: number[]; color?: string }
const W = 800, H = 240, L = 56, R = 18, T = 18, B = 28
const format = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })

/** Shared scale and HTML axes with a keyboard/touch equivalent of the pointer tooltip. */
export default function TrendLineChart({ labels, values = [], series, label = '趋势统计' }: { labels: string[]; values?: number[]; series?: TrendSeries[]; label?: string }) {
  const id = useId().replace(/:/g, '')
  const [active, setActive] = useState<number | null>(null)
  const lines = series ?? [{ label, values, color: 'var(--chart-1)' }]
  const count = Math.max(0, ...lines.map(line => line.values.length))
  const max = Math.max(0, ...lines.flatMap(line => line.values))
  const power = 10 ** Math.floor(Math.log10(max || 1))
  const upper = max ? Math.ceil(max / power / 2) * power * 2 : 1
  const x = (index: number) => L + (count === 1 ? .5 : index / (count - 1)) * (W - L - R)
  const y = (value: number) => T + (1 - value / upper) * (H - T - B)
  const selected = active === null ? null : Math.min(active, count - 1)
  const ticks = Array.from({ length: 5 }, (_, index) => upper * index / 4)
  const xTicks = Array.from({ length: count }, (_, index) => index).filter(index => index === count - 1 || index % Math.max(1, Math.ceil((count - 1) / 5)) === 0)
  const pointFromPointer = (event: PointerEvent<HTMLDivElement>) => { const bounds = event.currentTarget.getBoundingClientRect(); if (bounds.width) setActive(Math.max(0, Math.min(count - 1, Math.round((((event.clientX - bounds.left) / bounds.width * W) - L) / (W - L - R) * (count - 1))))) }
  if (!count) return <div role="status" className="admin-chart-empty">暂无趋势数据</div>
  return <div className="admin-chart">
    {lines.length > 1 ? <div className="mb-4 flex flex-wrap gap-5 text-xs text-[var(--text-secondary)]">{lines.map((line, index) => <span key={line.label} className="inline-flex items-center gap-2"><i className="h-2 w-2 rounded-full" style={{ background: line.color ?? `var(--chart-${index + 1})` }} />{line.label}</span>)}</div> : null}
    <div className="relative" role="group" aria-label={label} tabIndex={0}
      onFocus={() => setActive(0)} onBlur={() => setActive(null)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
        event.preventDefault()
        if (event.key === 'Escape') setActive(null)
        else setActive(current => event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : Math.max(0, Math.min(count - 1, (current ?? 0) + (event.key === 'ArrowRight' ? 1 : -1))))
      }}
      onPointerMove={pointFromPointer} onPointerDown={pointFromPointer}
      onPointerLeave={event => { if (document.activeElement !== event.currentTarget) setActive(null) }}>
      <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[240px] w-full overflow-visible">
        <defs>{lines.map((line, index) => <linearGradient key={line.label} id={`${id}-${index}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={line.color ?? `var(--chart-${index + 1})`} stopOpacity=".18" /><stop offset="100%" stopColor={line.color ?? `var(--chart-${index + 1})`} stopOpacity=".01" /></linearGradient>)}</defs>
        {ticks.map(tick => <line key={tick} x1={L} x2={W - R} y1={y(tick)} y2={y(tick)} stroke="var(--border-default)" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />)}
        {lines.map((line, index) => {
          const points = line.values.map((value, i) => `${x(i)},${y(value)}`).join(' ')
          const color = line.color ?? `var(--chart-${index + 1})`
          return <g key={line.label}>
            {line.values.length > 1 ? <polygon points={`${x(0)},${H - B} ${points} ${x(line.values.length - 1)},${H - B}`} fill={`url(#${id}-${index})`} /> : null}
            <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {line.values.length === 1 ? <circle cx={x(0)} cy={y(line.values[0])} r="4" fill={color} /> : null}
            {selected !== null && line.values[selected] !== undefined ? <circle cx={x(selected)} cy={y(line.values[selected])} r="4" fill="var(--surface-default)" stroke={color} strokeWidth="2" /> : null}
          </g>
        })}
        {selected !== null ? <line x1={x(selected)} x2={x(selected)} y1={T} y2={H - B} stroke="var(--text-tertiary)" strokeDasharray="4 4" /> : null}
      </svg>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 text-[11px] leading-none text-[var(--text-tertiary)]">{ticks.map(tick => <span key={tick} className="absolute left-0 -translate-y-1/2" style={{ top: `${y(tick) / H * 100}%` }}>{new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(tick)}</span>)}</div>
      {selected !== null ? <div role="status" aria-live="polite" className="admin-chart-tooltip" style={{ left: `${Math.max(20, Math.min(75, x(selected) / W * 100))}%` }}><p className="mb-1 font-medium">{labels[selected] ?? `第 ${selected + 1} 项`}</p>{lines.map((line, index) => <p key={line.label} className="flex items-center gap-2"><i className="h-2 w-2 rounded-full" style={{ background: line.color ?? `var(--chart-${index + 1})` }} />{line.label}<strong className="ml-auto pl-4 tabular-nums">{line.values[selected] === undefined ? '未采集' : format(line.values[selected])}</strong></p>)}</div> : null}
    </div>
    <div aria-hidden="true" className="relative h-6 text-[11px] text-[var(--text-tertiary)]">{xTicks.map(index => <span key={index} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${x(index) / W * 100}%` }}>{labels[index] ?? ''}</span>)}</div>
    <span className="sr-only">使用左右方向键查看数据，Home 与 End 跳至首尾。</span>
  </div>
}
