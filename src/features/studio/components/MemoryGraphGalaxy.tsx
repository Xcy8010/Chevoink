import { useEffect, useMemo, useRef } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import type { MemoryGraphNode } from '../../../../shared/contracts/index.js'
import type { GraphPoint, MemoryGraphRoutingEdge, ReadableMemoryGraphEdge } from '../lib/memory-graph-layout'
import { buildGalaxyScene, createGalaxyBackdrop, createGalaxyWingSprite, DEFAULT_GALAXY_VIEW, galaxyClusterExposure, galaxyPaintOrder, pickGalaxyNode, prepareGalaxyGeometry, type GalaxyScreenNode } from '../lib/memory-galaxy-render'

type Props = { nodes: MemoryGraphNode[]; edges: ReadableMemoryGraphEdge[]; points: Map<string, GraphPoint>; selectedId: string | null; onSelect: (id: string | null) => void; active: boolean }
type GalaxyAssets = { wings: Map<string, HTMLCanvasElement>; backdrop: HTMLCanvasElement | null; width: number; height: number; dpr: number }

export default function MemoryGraphGalaxy({ nodes, edges, points, selectedId, onSelect, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef({ ...DEFAULT_GALAXY_VIEW })
  const redrawRef = useRef<() => void>(() => {})
  const projectedRef = useRef<GalaxyScreenNode[]>([])
  const assetsRef = useRef<GalaxyAssets | null>(null)
  const labelOpacityRef = useRef(new Map<string, number>())

  const curveKey = JSON.stringify(edges.map(({ id, source, target, type }) => ({ id, source, target, type })))
  const geometry = useMemo(() => prepareGalaxyGeometry(points, JSON.parse(curveKey) as MemoryGraphRoutingEdge[]), [points, curveKey])
  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    if (!assetsRef.current) assetsRef.current = {
      wings: new Map([['character', createGalaxyWingSprite('#98c8f2')], ['item', createGalaxyWingSprite('#e5c291')], ['neutral', createGalaxyWingSprite('#cddbe7')]]),
      backdrop: null, width: 0, height: 0, dpr: 0,
    }
    const assets = assetsRef.current
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    let visible: boolean = active
    let width = 1
    let height = 1
    let transitionStarted = 0
    let fromOpacity = new Map(labelOpacityRef.current)
    const draw = (time: number) => {
      frame = 0
      if (!visible || document.hidden || !active || width < 2 || height < 2) return
      const ctx = context
      ctx.clearRect(0, 0, width, height)
      ctx.globalAlpha = 1
      ctx.drawImage(assets.backdrop!, 0, 0, width, height)
      const scene = buildGalaxyScene(nodes, edges, points, viewRef.current, width, height, selectedId, (text, size, weight) => {
        ctx.font = `${weight} ${size}px system-ui, sans-serif`
        return ctx.measureText(text).width
      }, geometry)
      projectedRef.current = scene.nodes
      // Optical emission accumulates only around real, spatially dense 3D neighborhoods.
      // Faint tinted wings contain no white core. Their footprint follows the tiny apparent star, not world-space spacing.
      ctx.save(); ctx.globalCompositeOperation = 'screen'
      for (const node of scene.nodes) {
        if (node.density <= 0) continue
        const sprite = assets.wings.get(node.type === 'character' || node.type === 'item' ? node.type : 'neutral')!
        ctx.globalAlpha = node.opacity * galaxyClusterExposure(node.density) * 0.55
        ctx.drawImage(sprite, node.x - node.emissionRadius, node.y - node.emissionRadius, node.emissionRadius * 2, node.emissionRadius * 2)
      }
      ctx.restore(); ctx.globalAlpha = 1
      // Stars and sampled world-space threads share one painter order, so orbit reveals real depth/occlusion.
      ctx.lineCap = 'round'
      for (const primitive of galaxyPaintOrder(scene)) {
        if (primitive.kind === 'threads') {
          if (primitive.opacity === 0) continue
          // One stroke per style between actual star planes, rather than one styled stroke per segment.
          ctx.globalAlpha = primitive.opacity; ctx.strokeStyle = '#bed0dd'; ctx.lineWidth = primitive.width
          ctx.beginPath()
          for (const { from, to } of primitive.segments) { ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y) }
          ctx.stroke()
          if (primitive.focused && !primitive.hint) for (const { link, to } of primitive.segments) {
            if (to !== link.path[link.path.length - 1]) continue
            const length = Math.max(1, Math.hypot(link.endTangent.x, link.endTangent.y))
            const ux = link.endTangent.x / length; const uy = link.endTangent.y / length
            const x = link.b.x - ux * (link.b.coreRadius + 3); const y = link.b.y - uy * (link.b.coreRadius + 3)
            ctx.globalAlpha = link.opacity * Math.min(1, to.perspective * 0.7); ctx.fillStyle = '#d0e0eb'
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * 4 - uy * 1.8, y - uy * 4 + ux * 1.8); ctx.lineTo(x - ux * 4 + uy * 1.8, y - uy * 4 - ux * 1.8); ctx.closePath(); ctx.fill()
          }
          continue
        }
        const node = primitive.node
        const halo = node.coreRadius * 2.7 + 1
        const sprite = assets.wings.get(node.type === 'character' || node.type === 'item' ? node.type : 'neutral')!
        ctx.globalAlpha = node.opacity
        ctx.drawImage(sprite, node.x - halo, node.y - halo, halo * 2, halo * 2)
        ctx.fillStyle = '#f1f6fc'
        ctx.beginPath(); ctx.arc(node.x, node.y, node.coreRadius, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = Math.min(1, node.opacity + 0.08); ctx.fillStyle = '#ffffff'
        ctx.beginPath(); ctx.arc(node.x, node.y, node.coreRadius * 0.38, 0, Math.PI * 2); ctx.fill()
        if (node.selected) {
          ctx.globalAlpha = 0.8; ctx.strokeStyle = '#deefff'; ctx.lineWidth = 0.9
          ctx.beginPath(); ctx.arc(node.x, node.y, node.coreRadius + 4.5, 0, Math.PI * 2); ctx.stroke()
        }
      }
      const progress = reducedMotion ? 1 : Math.min(1, Math.max(0, (time - transitionStarted) / 160))
      const eased = progress * progress * (3 - 2 * progress)
      let transitioning = false
      const currentOpacity = new Map<string, number>()
      for (const label of scene.labels) {
        const previous = fromOpacity.get(label.id) ?? 0
        const opacity = previous + (label.opacity - previous) * eased
        currentOpacity.set(label.id, opacity)
        if (Math.abs(label.opacity - previous) > 0.005 && progress < 1) transitioning = true
        ctx.save(); ctx.globalAlpha = opacity
        if (label.selected) { ctx.fillStyle = '#050a1066'; ctx.fillRect(label.box.x - 2, label.box.y - 1, label.box.width + 4, label.box.height + 2) }
        const nearest = { x: Math.max(label.box.x, Math.min(label.box.x + label.box.width, label.anchor.x)), y: Math.max(label.box.y, Math.min(label.box.y + label.box.height, label.anchor.y)) }
        if (Math.hypot(nearest.x - label.anchor.x, nearest.y - label.anchor.y) > 20) {
          ctx.strokeStyle = '#a6bed533'; ctx.lineWidth = 0.55; ctx.beginPath(); ctx.moveTo(label.anchor.x, label.anchor.y); ctx.lineTo(nearest.x, nearest.y); ctx.stroke()
        }
        ctx.font = `${label.selected ? 600 : 400} ${label.size}px system-ui, sans-serif`
        ctx.textAlign = 'left'; ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = '#020408c9'; ctx.fillStyle = label.selected ? '#f5faff' : label.kind === 'edge' ? '#aec4d3' : '#cfdae3'
        label.lines.forEach((line, i) => { ctx.strokeText(line, label.box.x + 3, label.box.y + 12 + i * 15); ctx.fillText(line, label.box.x + 3, label.box.y + 12 + i * 15) })
        ctx.restore()
      }
      labelOpacityRef.current = currentOpacity
      ctx.globalAlpha = 1
      // Only opacity changes get a short finite follow-up. Geometry, particles and physics never run while idle.
      if (transitioning) scheduleFrame()
    }
    const scheduleFrame = () => {
      if (!frame && visible && active && !document.hidden) frame = window.requestAnimationFrame(draw)
    }
    const requestDraw = () => {
      transitionStarted = performance.now()
      fromOpacity = new Map(labelOpacityRef.current)
      scheduleFrame()
    }
    redrawRef.current = requestDraw
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const pixelWidth = Math.max(1, Math.round(width * dpr)); const pixelHeight = Math.max(1, Math.round(height * dpr))
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (width > 1 && height > 1 && (!assets.backdrop || assets.width !== width || assets.height !== height || assets.dpr !== dpr)) {
        assets.backdrop = createGalaxyBackdrop(width, height, dpr); assets.width = width; assets.height = height; assets.dpr = dpr
      }
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
        const hit = pickGalaxyNode(projectedRef.current, event.clientX - rect.left, event.clientY - rect.top)
        canvas.title = hit?.label ?? ''
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
        const hit = pickGalaxyNode(projectedRef.current, x, y)
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
  }, [nodes, edges, points, selectedId, onSelect, active, geometry])

  const zoom = (factor: number) => {
    viewRef.current.zoom = Math.min(4.5, Math.max(0.4, viewRef.current.zoom * factor))
    redrawRef.current()
  }
  return <div className="memory-galaxy">
    <canvas ref={canvasRef} tabIndex={0} role="img" aria-label="三维星系关系网，拖动或方向键旋转，滚轮或加减键缩放" />
    <div className="memory-graph-controls memory-galaxy-controls" aria-label="星系视图控制">
      <button type="button" title="放大" aria-label="放大星系" onClick={() => zoom(1.25)}><Plus size={16} /></button>
      <button type="button" title="缩小" aria-label="缩小星系" onClick={() => zoom(0.8)}><Minus size={16} /></button>
      <button type="button" title="适应视图" aria-label="适应星系视图" onClick={() => { viewRef.current = { ...DEFAULT_GALAXY_VIEW }; redrawRef.current() }}><Maximize size={15} /></button>
    </div>
    <div className="memory-galaxy-accessible" aria-label="星系实体">
      {nodes.map((node) => <button key={node.id} type="button" aria-pressed={selectedId === node.id} onClick={() => onSelect(node.id)}>{node.label}</button>)}
    </div>
  </div>
}
