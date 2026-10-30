import { useEffect, useRef } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import type { MemoryGraphNode } from '../../../../shared/contracts/index.js'
import { memoryGraphNeighborhood, memoryNodeColor, projectMemoryPoint, rectanglesOverlap, type GraphPoint, type GraphRect, type ReadableMemoryGraphEdge } from '../lib/memory-graph-layout'

type Props = {
  nodes: MemoryGraphNode[]
  edges: ReadableMemoryGraphEdge[]
  points: Map<string, GraphPoint>
  selectedId: string | null
  onSelect: (id: string | null) => void
  active: boolean
}
type ScreenPoint = ReturnType<typeof projectMemoryPoint> & { id: string; radius: number }

export default function MemoryGraphGalaxy({ nodes, edges, points, selectedId, onSelect, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef({ yaw: 0.35, pitch: -0.18, zoom: 1 })
  const redrawRef = useRef<() => void>(() => {})
  const projectedRef = useRef<ScreenPoint[]>([])

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let frame = 0
    let visible: boolean = active
    let width = 1
    let height = 1
    const radius = Math.max(180, ...[...points.values()].map((p) => Math.hypot(p.x, p.y, p.z)))
    const neighbors = memoryGraphNeighborhood(selectedId, edges)
    const selectedEdges = edges.filter((e) => e.source === selectedId || e.target === selectedId)
    const orderedEdges = [...edges.filter((e) => !selectedEdges.includes(e)), ...selectedEdges]
    const draw = () => {
      frame = 0
      if (!visible || document.hidden || !active || width < 2 || height < 2) return
      const ctx = context
      ctx.clearRect(0, 0, width, height)
      const backdrop = ctx.createRadialGradient(width * 0.53, height * 0.45, 10, width * 0.5, height * 0.5, Math.max(width, height) * 0.8)
      backdrop.addColorStop(0, '#162939')
      backdrop.addColorStop(0.55, '#0b1724')
      backdrop.addColorStop(1, '#050b13')
      ctx.fillStyle = backdrop
      ctx.fillRect(0, 0, width, height)
      // A fixed star field: no particles, timers, postprocessing or perpetual animation.
      for (let i = 0; i < 160; i += 1) {
        const x = ((Math.sin(i * 127.1 + 1) * 43758.5453) % 1 + 1) % 1 * width
        const y = ((Math.sin(i * 311.7 + 3) * 96321.9123) % 1 + 1) % 1 * height
        ctx.fillStyle = i % 6 === 0 ? '#c9d8e677' : '#9eb4ca33'
        ctx.fillRect(x, y, i % 9 === 0 ? 1.5 : 1, i % 9 === 0 ? 1.5 : 1)
      }
      const view = viewRef.current
      const projected = new Map(nodes.map((node) => {
        const p = points.get(node.id)!
        return [node.id, { ...projectMemoryPoint(p, view.yaw, view.pitch, view.zoom, width, height, radius), id: node.id, radius: Math.max(3.2, 5 * projectMemoryPoint(p, view.yaw, view.pitch, view.zoom, width, height, radius).perspective) }]
      }))
      projectedRef.current = [...projected.values()].sort((a, b) => a.depth - b.depth)
      const labels: GraphRect[] = [...projected.values()].map((p) => ({ x: p.x - p.radius - 3, y: p.y - p.radius - 3, width: p.radius * 2 + 6, height: p.radius * 2 + 6 }))
      const edgeLabels: { text: string; x: number; y: number; focused: boolean }[] = []
      orderedEdges.forEach((edge, i) => {
        const a = projected.get(edge.source)
        const b = projected.get(edge.target)
        if (!a || !b) return
        const focused = edge.source === selectedId || edge.target === selectedId
        ctx.strokeStyle = focused ? '#a6d5f3dd' : selectedId ? '#7795ac17' : edge.type === '同章出现' ? '#7097ad26' : '#93afc35c'
        ctx.lineWidth = focused ? 1.5 : 0.7
        const dx = b.x - a.x
        const dy = b.y - a.y
        const distance = Math.max(1, Math.hypot(dx, dy))
        const bend = (i % 2 ? 1 : -1) * Math.min(35, distance * 0.14)
        const cx = (a.x + b.x) / 2 - dy / distance * bend
        const cy = (a.y + b.y) / 2 + dx / distance * bend
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(cx, cy, b.x, b.y)
        ctx.stroke()
        if (edge.type !== '同章出现') {
          const tangentLength = Math.max(1, Math.hypot(b.x - cx, b.y - cy))
          const ux = (b.x - cx) / tangentLength
          const uy = (b.y - cy) / tangentLength
          const tip = { x: b.x - ux * (b.radius + 3), y: b.y - uy * (b.radius + 3) }
          ctx.fillStyle = ctx.strokeStyle
          ctx.beginPath()
          ctx.moveTo(tip.x, tip.y)
          ctx.lineTo(tip.x - ux * 6 - uy * 2.5, tip.y - uy * 6 + ux * 2.5)
          ctx.lineTo(tip.x - ux * 6 + uy * 2.5, tip.y - uy * 6 - ux * 2.5)
          ctx.closePath()
          ctx.fill()
        }
        if (edge.type !== '同章出现' && (focused || (!selectedId && view.zoom > 1.65))) edgeLabels.push({ text: edge.type, x: (a.x + b.x + 2 * cx) / 4, y: (a.y + b.y + 2 * cy) / 4, focused })
      })
      const drawLabel = (text: string, x: number, y: number, color: string, required: boolean) => {
        ctx.font = '11px system-ui, sans-serif'
        const textWidth = ctx.measureText(text).width
        let box: GraphRect | undefined
        for (const dy of [0, -18, 18, -36, 36, -54, 54]) {
          const candidate = { x: x - textWidth / 2 - 4, y: y + dy - 12, width: textWidth + 8, height: 17 }
          if (candidate.x < 2 || candidate.x + candidate.width > width - 2 || candidate.y < 2 || candidate.y + candidate.height > height - 2) continue
          if (!labels.some((rect) => rectanglesOverlap(candidate, rect, 2))) { box = candidate; break }
        }
        if (!box && !required) return
        box ??= { x: Math.max(2, Math.min(width - textWidth - 10, x - textWidth / 2 - 4)), y: Math.max(2, Math.min(height - 19, y - 12)), width: textWidth + 8, height: 17 }
        labels.push(box)
        ctx.fillStyle = '#0b1724e8'
        ctx.fillRect(box.x, box.y, box.width, box.height)
        ctx.fillStyle = color
        ctx.textAlign = 'left'
        ctx.fillText(text, box.x + 4, box.y + 12)
      }
      // Draw far nodes first; nearby stars correctly occlude distant stars.
      const orderedNodes = [...nodes].sort((a, b) => projected.get(b.id)!.depth - projected.get(a.id)!.depth)
      orderedNodes.forEach((node) => {
        const p = projected.get(node.id)!
        const focused = neighbors.has(node.id)
        ctx.globalAlpha = selectedId && !focused ? 0.18 : 1
        ctx.fillStyle = memoryNodeColor(node.type)
        if (node.id === selectedId) {
          ctx.strokeStyle = '#e2f3ff'
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.radius + 5, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      })
      const labelOrder = [...orderedNodes.filter((n) => !neighbors.has(n.id)), ...orderedNodes.filter((n) => neighbors.has(n.id))]
      // Focus labels get the first claim on space; unrelated labels yield to them.
      labelOrder.reverse().forEach((node) => {
        const p = projected.get(node.id)!
        const focused = neighbors.has(node.id)
        if (selectedId && !focused) return
        const label = node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label
        drawLabel(label, p.x, p.y - p.radius - 6, node.id === selectedId ? '#fff' : '#d6e5ef', focused)
      })
      edgeLabels.reverse().forEach((label) => drawLabel(label.text, label.x, label.y, '#b6d8ed', label.focused))
    }
    const requestDraw = () => {
      if (!frame && visible && active && !document.hidden) frame = window.requestAnimationFrame(draw)
    }
    redrawRef.current = requestDraw
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      requestDraw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (!visible) { window.cancelAnimationFrame(frame); frame = 0 }
      else requestDraw()
    })
    intersection.observe(canvas)
    const visibility = () => {
      if (document.hidden) { window.cancelAnimationFrame(frame); frame = 0 }
      else requestDraw()
    }
    document.addEventListener('visibilitychange', visibility)
    const pointers = new Map<number, { x: number; y: number }>()
    let down = { x: 0, y: 0 }
    let moved = false
    const pointerDown = (event: PointerEvent) => {
      canvas.focus({ preventScroll: true })
      canvas.setPointerCapture(event.pointerId)
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      down = { x: event.clientX, y: event.clientY }
      moved = pointers.size > 1
    }
    const pointerMove = (event: PointerEvent) => {
      const before = pointers.get(event.pointerId)
      if (!before) {
        const rect = canvas.getBoundingClientRect()
        const hit = projectedRef.current.find((p) => Math.hypot(p.x - event.clientX + rect.left, p.y - event.clientY + rect.top) < Math.max(14, p.radius + 6))
        canvas.title = hit ? nodes.find((node) => node.id === hit.id)!.label : ''
        return
      }
      const next = { x: event.clientX, y: event.clientY }
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1]
      if (other) {
        const oldDistance = Math.hypot(before.x - other.x, before.y - other.y)
        const newDistance = Math.hypot(next.x - other.x, next.y - other.y)
        viewRef.current.zoom = Math.min(4.5, Math.max(0.4, viewRef.current.zoom * newDistance / Math.max(1, oldDistance)))
        moved = true
      } else {
        if (Math.hypot(next.x - down.x, next.y - down.y) > 4) moved = true
        if (moved) {
          viewRef.current.yaw += (next.x - before.x) * 0.006
          viewRef.current.pitch = Math.max(-1.45, Math.min(1.45, viewRef.current.pitch + (next.y - before.y) * 0.006))
        }
      }
      pointers.set(event.pointerId, next)
      requestDraw()
    }
    const pointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId)
      if (!moved && event.type !== 'pointercancel') {
        const rect = canvas.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        const hit = projectedRef.current.find((p) => Math.hypot(p.x - x, p.y - y) < Math.max(14, p.radius + 6))
        onSelect(hit?.id ?? null)
      }
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      viewRef.current.zoom = Math.min(4.5, Math.max(0.4, viewRef.current.zoom * Math.exp(-event.deltaY * 0.001)))
      requestDraw()
    }
    const keyDown = (event: KeyboardEvent) => {
      const view = viewRef.current
      if (event.key === 'ArrowLeft') view.yaw -= 0.12
      else if (event.key === 'ArrowRight') view.yaw += 0.12
      else if (event.key === 'ArrowUp') view.pitch = Math.max(-1.45, view.pitch - 0.12)
      else if (event.key === 'ArrowDown') view.pitch = Math.min(1.45, view.pitch + 0.12)
      else if (event.key === '+' || event.key === '=') view.zoom = Math.min(4.5, view.zoom * 1.2)
      else if (event.key === '-') view.zoom = Math.max(0.4, view.zoom / 1.2)
      else if (event.key === 'Escape') onSelect(null)
      else return
      event.preventDefault()
      requestDraw()
    }
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerup', pointerUp)
    canvas.addEventListener('pointercancel', pointerUp)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('keydown', keyDown)
    resize()
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', pointerUp)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('keydown', keyDown)
      redrawRef.current = () => {}
    }
  }, [nodes, edges, points, selectedId, onSelect, active])

  const zoom = (factor: number) => {
    viewRef.current.zoom = Math.min(4.5, Math.max(0.4, viewRef.current.zoom * factor))
    redrawRef.current()
  }
  return <div className="memory-galaxy">
    <canvas ref={canvasRef} tabIndex={0} role="img" aria-label="三维星系关系网，拖动或方向键旋转，滚轮或加减键缩放" />
    <div className="memory-graph-controls memory-galaxy-controls" aria-label="星系视图控制">
      <button type="button" title="放大" aria-label="放大星系" onClick={() => zoom(1.25)}><Plus size={16} /></button>
      <button type="button" title="缩小" aria-label="缩小星系" onClick={() => zoom(0.8)}><Minus size={16} /></button>
      <button type="button" title="适应视图" aria-label="适应星系视图" onClick={() => { viewRef.current = { yaw: 0.35, pitch: -0.18, zoom: 1 }; redrawRef.current() }}><Maximize size={15} /></button>
    </div>
    <div className="memory-galaxy-accessible" aria-label="星系实体">
      {nodes.map((node) => <button key={node.id} type="button" aria-pressed={selectedId === node.id} onClick={() => onSelect(node.id)}>{node.label}</button>)}
    </div>
  </div>
}
