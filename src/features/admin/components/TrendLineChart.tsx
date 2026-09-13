import { useMemo, useState, type PointerEvent } from 'react'

type SparklinePoint = { x: number; y: number; value: number }

type HoverState = { index: number; xPercent: number; yPercent: number }

const WIDTH = 300
const HEIGHT = 156
const PADDING_LEFT = 34
const PADDING_RIGHT = 8
const PADDING_TOP = 14
const PADDING_BOTTOM = 26

function getAxisUpperBound(value: number): number {
  if (value <= 0) {
    return 1
  }
  const exponent = 10 ** Math.floor(Math.log10(value))
  const normalized = value / exponent
  if (normalized <= 1) return exponent
  if (normalized <= 2) return 2 * exponent
  if (normalized <= 5) return 5 * exponent
  return 10 * exponent
}

function formatAxisLabel(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function buildSparkline(values: number[], labels: string[]) {
  const series = values.length ? values : [0]
  const availableWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT
  const availableHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM
  const max = Math.max(...series, 0)
  const upperBound = getAxisUpperBound(max)
  const yStep = upperBound / 4

  const points = series.map<SparklinePoint>((value, index) => {
    const ratio = series.length === 1 ? 0.5 : index / (series.length - 1)
    const x = PADDING_LEFT + availableWidth * ratio
    const normalizedY = (1 - value / upperBound) * availableHeight
    return { x: Number(x.toFixed(2)), y: Number((PADDING_TOP + normalizedY).toFixed(2)), value }
  })

  const linePoints = points.map((point) => `${point.x},${point.y}`).join(' ')

  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = upperBound - yStep * index
    const ratio = value / Math.max(upperBound, 1)
    return { label: formatAxisLabel(value), y: PADDING_TOP + availableHeight * (1 - ratio) }
  })

  const xTicks = points
    .map((point, index) => ({
      label: index % Math.max(1, Math.ceil((series.length - 1) / 3)) !== 0 && index !== series.length - 1 ? '' : labels[index] ?? '',
      x: point.x,
    }))
    .filter((item) => item.label)

  return { points, linePoints, yTicks, xTicks }
}

/** 近 7 日单指标折线统计图：横向网格 + Y 轴刻度 + 悬停十字线与数值气泡 */
export default function TrendLineChart({ labels, values }: { labels: string[]; values: number[] }) {
  const [hover, setHover] = useState<HoverState | null>(null)
  const chart = useMemo(() => buildSparkline(values, labels), [values, labels])

  const handleMouseMove = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!chart.points.length || bounds.width <= 0) {
      setHover(null)
      return
    }
    const relativeX = ((event.clientX - bounds.left) / bounds.width) * WIDTH
    let closestIndex = 0
    let closestDistance = Number.POSITIVE_INFINITY
    chart.points.forEach((point, index) => {
      const distance = Math.abs(point.x - relativeX)
      if (distance < closestDistance) {
        closestDistance = distance
        closestIndex = index
      }
    })
    const point = chart.points[closestIndex]
    setHover({
      index: closestIndex,
      xPercent: (point.x / WIDTH) * 100,
      yPercent: (point.y / HEIGHT) * 100,
    })
  }

  const hovered = hover ? chart.points[hover.index] : null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative" onPointerMove={handleMouseMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="h-[132px] w-full overflow-visible">
          {chart.yTicks.map((tick) => (
            <g key={`y-${tick.label}`}>
              <line
                x1={PADDING_LEFT}
                y1={tick.y}
                x2={WIDTH - PADDING_RIGHT}
                y2={tick.y}
                stroke="var(--border-default)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text x={0} y={tick.y + 4} fill="var(--text-tertiary)" fontSize={9} fontWeight={500}>
                {tick.label}
              </text>
            </g>
          ))}
          {chart.xTicks.map((tick) => (
            <line
              key={`x-${tick.label}`}
              x1={tick.x}
              y1={PADDING_TOP}
              x2={tick.x}
              y2={HEIGHT - PADDING_BOTTOM}
              stroke="var(--border-default)"
              strokeOpacity={0.55}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          <polyline
            points={chart.linePoints}
            fill="none"
            stroke="var(--color-info)"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {hovered ? (
            <>
              <line
                x1={hovered.x}
                y1={PADDING_TOP}
                x2={hovered.x}
                y2={HEIGHT - PADDING_BOTTOM}
                stroke="var(--text-tertiary)"
                strokeOpacity={0.45}
                strokeWidth={1}
              />
              <circle cx={hovered.x} cy={hovered.y} r={4} fill="var(--surface-default)" stroke="var(--color-info)" strokeWidth={1.5} />
            </>
          ) : null}
        </svg>

        {hovered && hover ? (
          <div
            className="pointer-events-none absolute z-10 min-w-[72px] -translate-x-1/2 -translate-y-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-solid)] px-3 py-2 shadow-lg"
            style={{
              left: `${Math.min(Math.max(hover.xPercent, 20), 80)}%`,
              top: `${Math.max(hover.yPercent - 8, 6)}%`,
            }}
          >
            <p className="text-[11px] font-semibold text-[var(--text-primary)]">{labels[hover.index] ?? ''}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-info)]" />
              {hovered.value}
            </p>
          </div>
        ) : null}
      </div>

      <div className="relative h-5 text-[9px] text-[var(--text-tertiary)]">
        {chart.xTicks.map((tick) => (
          <span key={`axis-${tick.label}`} className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap" style={{ left: `${(tick.x / WIDTH) * 100}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  )
}
