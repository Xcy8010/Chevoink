import { partitionGalaxyGraph } from './memory-galaxy-layout'
import type { MemoryGraphNode } from '../../../../shared/contracts/index.js'
import { memoryGraphNeighborhood, rectanglesOverlap, type GraphPoint, type GraphRect, type MemoryGraphRoutingEdge } from './memory-graph-layout'

export const DEFAULT_GALAXY_VIEW = { yaw: 0.35, pitch: -0.18, zoom: 1 }
export type GalaxyView = typeof DEFAULT_GALAXY_VIEW
export type GalaxyEntity = Pick<MemoryGraphNode, 'id' | 'label' | 'type'>
export type GalaxyScreenNode = GalaxyEntity & { x: number; y: number; depth: number; perspective: number; coreRadius: number; opacity: number; separation: number; nameOpacity: number; selected: boolean; neighbor: boolean; density: number; emissionRadius: number }
export type GalaxyProjectedPoint = { x: number; y: number; depth: number; perspective: number }
export type GalaxyCurve = { a: GraphPoint; first: GraphPoint; second: GraphPoint; b: GraphPoint; samples: GraphPoint[] }
export type GalaxyGeometry = { bandwidth: number; density: Map<string, number>; curves: Map<string, GalaxyCurve>; communities: Map<string, string>; centers: Map<string, GraphPoint> }
export type GalaxyLink = { id: string; source: string; target: string; type: string; a: GalaxyScreenNode; b: GalaxyScreenNode; curve: GalaxyCurve; path: GalaxyProjectedPoint[]; anchors: GalaxyProjectedPoint[]; endTangent: { x: number; y: number }; opacity: number; focused: boolean; internal: boolean }
export type GalaxyLabel = { id: string; kind: 'node' | 'edge'; owner: string; lines: string[]; box: GraphRect; anchor: { x: number; y: number }; opacity: number; size: number; selected: boolean }
export type GalaxyScene = { nodes: GalaxyScreenNode[]; links: GalaxyLink[]; labels: GalaxyLabel[] }
type MeasureText = (text: string, size: number, weight: number) => number
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const smooth = (min: number, max: number, n: number) => { const t = clamp((n - min) / (max - min), 0, 1); return t * t * (3 - 2 * t) }

export const GALAXY_CURVE_STEPS = 12
export function sampleGalaxyCurve(curve: Pick<GalaxyCurve, 'a' | 'first' | 'second' | 'b'>, t: number): GraphPoint {
  const u = 1 - t
  return { x: u ** 3 * curve.a.x + 3 * u * u * t * curve.first.x + 3 * u * t * t * curve.second.x + t ** 3 * curve.b.x, y: u ** 3 * curve.a.y + 3 * u * u * t * curve.first.y + 3 * u * t * t * curve.second.y + t ** 3 * curve.b.y, z: u ** 3 * curve.a.z + 3 * u * u * t * curve.first.z + 3 * u * t * t * curve.second.z + t ** 3 * curve.b.z }
}
const unitVector = (p: GraphPoint): GraphPoint => { const length = Math.hypot(p.x, p.y, p.z) || 1; return { x: p.x / length, y: p.y / length, z: p.z / length } }

/** Density and world-space trajectories are prepared once per points/link dataset, never per frame. */
export function prepareGalaxyGeometry(points: Map<string, GraphPoint>, edges: MemoryGraphRoutingEdge[]): GalaxyGeometry {
  const entries = [...points]
  const communities = partitionGalaxyGraph(entries.map(([id]) => id), edges)
  const members = new Map<string, GraphPoint[]>()
  for (const [id, point] of entries) { const key = communities.get(id)!; const values = members.get(key) ?? []; values.push(point); members.set(key, values) }
  const centers = new Map([...members].map(([key, values]) => [key, values.reduce((sum, point) => ({ x: sum.x + point.x / values.length, y: sum.y + point.y / values.length, z: sum.z + point.z / values.length }), { x: 0, y: 0, z: 0 })]))
  const nearest = entries.map(() => Infinity)
  for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) {
    const a = entries[i][1]; const b = entries[j][1]
    const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    nearest[i] = Math.min(nearest[i], distance); nearest[j] = Math.min(nearest[j], distance)
  }
  const spacing = nearest.filter((distance) => Number.isFinite(distance) && distance > 0).sort((a, b) => a - b)
  const bandwidth = spacing.length ? spacing[Math.floor(spacing.length / 2)] * 1.6 : 1
  const rawDensity = new Map<string, number>()
  const flow = new Map<string, GraphPoint>()
  for (const [id, point] of entries) {
    let density = 0; const sum = { x: 0, y: 0, z: 0 }
    for (const [otherId, other] of entries) {
      if (id === otherId) continue
      const distance = Math.hypot(point.x - other.x, point.y - other.y, point.z - other.z)
      const weight = Math.exp(-(distance * distance) / (2 * bandwidth * bandwidth))
      density += weight; sum.x += (other.x - point.x) * weight; sum.y += (other.y - point.y) * weight; sum.z += (other.z - point.z) * weight
    }
    rawDensity.set(id, density)
    flow.set(id, density ? { x: sum.x / density, y: sum.y / density, z: sum.z / density } : sum)
  }
  const sortedDensity = [...rawDensity.values()].sort((a, b) => a - b)
  const referenceDensity = Math.max(1, sortedDensity[Math.floor(sortedDensity.length / 2)] ?? 0)
  const density = new Map([...rawDensity].map(([id, value]) => [id, value / (value + referenceDensity)]))
  const neighbors = new Map(entries.map(([id]) => [id, new Set<string>()]))
  for (const edge of edges) { neighbors.get(edge.source)!.add(edge.target); neighbors.get(edge.target)!.add(edge.source) }
  const localFlow = new Map(entries.map(([id, point]) => {
    const adjacent = [...neighbors.get(id)!]
    const mean = adjacent.reduce((sum, target) => { const p = points.get(target)!; return { x: sum.x + (p.x - point.x) / adjacent.length, y: sum.y + (p.y - point.y) / adjacent.length, z: sum.z + (p.z - point.z) / adjacent.length } }, { x: 0, y: 0, z: 0 })
    const field = flow.get(id)!
    return [id, { x: mean.x * 0.65 + field.x * 0.35, y: mean.y * 0.65 + field.y * 0.35, z: mean.z * 0.65 + field.z * 0.35 }]
  }))
  const curves = new Map<string, GalaxyCurve>()
  for (const edge of edges) {
    const a = points.get(edge.source)!; const b = points.get(edge.target)!
    const direction = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const along = unitVector(direction)
    const atA = localFlow.get(edge.source)!; const atB = localFlow.get(edge.target)!
    const perpendicular = (p: GraphPoint) => { const dot = p.x * along.x + p.y * along.y + p.z * along.z; return { x: p.x - dot * along.x, y: p.y - dot * along.y, z: p.z - dot * along.z } }
    const lateralA = perpendicular(atA); const lateralB = perpendicular(atB)
    const internal = communities.get(edge.source) === communities.get(edge.target)
    const firstCenter = centers.get(communities.get(edge.source)!)!
    const secondCenter = centers.get(communities.get(edge.target)!)!
    const corridor = { x: secondCenter.x - firstCenter.x, y: secondCenter.y - firstCenter.y, z: secondCenter.z - firstCenter.z }
    // Existing cross-community links share a spatial corridor; short internal links stay understated/local.
    const first = internal ? { x: a.x + direction.x * 0.32 + lateralA.x * 0.18, y: a.y + direction.y * 0.32 + lateralA.y * 0.18, z: a.z + direction.z * 0.32 + lateralA.z * 0.18 } : { x: a.x + corridor.x * 0.3 + (firstCenter.x - a.x) * 0.22, y: a.y + corridor.y * 0.3 + (firstCenter.y - a.y) * 0.22, z: a.z + corridor.z * 0.3 + (firstCenter.z - a.z) * 0.22 }
    const second = internal ? { x: b.x - direction.x * 0.32 + lateralB.x * 0.18, y: b.y - direction.y * 0.32 + lateralB.y * 0.18, z: b.z - direction.z * 0.32 + lateralB.z * 0.18 } : { x: b.x - corridor.x * 0.3 + (secondCenter.x - b.x) * 0.22, y: b.y - corridor.y * 0.3 + (secondCenter.y - b.y) * 0.22, z: b.z - corridor.z * 0.3 + (secondCenter.z - b.z) * 0.22 }
    const curve = { a, first, second, b, samples: [] as GraphPoint[] }
    curve.samples = Array.from({ length: GALAXY_CURVE_STEPS + 1 }, (_, i) => sampleGalaxyCurve(curve, i / GALAXY_CURVE_STEPS))
    curves.set(edge.id, curve)
  }
  return { bandwidth, density, curves, communities, centers }
}

export function galaxyDrawOrder(scene: GalaxyScene) {
  const primitives: ({ kind: 'star'; depth: number; node: GalaxyScreenNode } | { kind: 'thread'; depth: number; link: GalaxyLink; from: GalaxyProjectedPoint; to: GalaxyProjectedPoint })[] = scene.nodes.map((node) => ({ kind: 'star', depth: node.depth, node }))
  for (const link of scene.links) for (let i = 1; i < link.path.length; i += 1) primitives.push({ kind: 'thread', depth: (link.path[i - 1].depth + link.path[i].depth) / 2, link, from: link.path[i - 1], to: link.path[i] })
  return primitives.sort((a, b) => b.depth - a.depth || (a.kind === b.kind ? 0 : a.kind === 'thread' ? -1 : 1))
}

export function galaxyClusterExposure(density: number) { return 1 - Math.exp(-2.8 * Math.pow(density, 3)) }

/** Each batch stays between the same two real star-depth planes, retaining every curve subpath. */
export function galaxyPaintOrder(scene: GalaxyScene) {
  const ordered = galaxyDrawOrder(scene)
  type Thread = Extract<(typeof ordered)[number], { kind: 'thread' }>
  type Batch = { kind: 'threads'; segments: Thread[]; opacity: number; width: number; focused: boolean; hint: boolean; internal: boolean }
  const result: (Extract<(typeof ordered)[number], { kind: 'star' }> | Batch)[] = []
  const pending = new Map<number, Batch>()
  const flush = () => {
    for (const batch of pending.values()) {
      batch.opacity = Math.min(1, batch.opacity / batch.segments.length); batch.width /= batch.segments.length
      result.push(batch)
    }
    pending.clear()
  }
  for (const primitive of ordered) {
    if (primitive.kind === 'star') { flush(); result.push(primitive); continue }
    const { link, from, to } = primitive
    const hint = link.type === '同章出现'
    const style = (link.focused ? 2 : 0) + (hint ? 1 : 0) + (link.internal ? 4 : 0)
    let batch = pending.get(style)
    if (!batch) { batch = { kind: 'threads', segments: [], opacity: 0, width: 0, focused: link.focused, hint, internal: link.internal }; pending.set(style, batch) }
    const depth = (from.perspective + to.perspective) / 2
    batch.opacity += link.opacity * depth / ((link.a.perspective + link.b.perspective) / 2)
    batch.width += (link.focused ? 1 : 0.65) * Math.sqrt(depth)
    batch.segments.push(primitive)
  }
  flush()
  return result
}

function rotate(point: GraphPoint, view: GalaxyView) {
  const x = point.x * Math.cos(view.yaw) + point.z * Math.sin(view.yaw)
  const z = -point.x * Math.sin(view.yaw) + point.z * Math.cos(view.yaw)
  return { x, y: point.y * Math.cos(view.pitch) - z * Math.sin(view.pitch), z: point.y * Math.sin(view.pitch) + z * Math.cos(view.pitch) }
}

/** Camera framing uses the actual volume, with a fixed reference fit so orbit never auto-flattens its depth. */
export function galaxyFrame(points: Map<string, GraphPoint>, width: number, height: number) {
  const all = [...points.values()]
  const center = all.reduce((sum, p) => ({ x: sum.x + p.x / Math.max(1, all.length), y: sum.y + p.y / Math.max(1, all.length), z: sum.z + p.z / Math.max(1, all.length) }), { x: 0, y: 0, z: 0 })
  const radius = Math.max(1, ...all.map((p) => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z)))
  const cameraDistance = radius * 1.85
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
  for (const point of all) {
    const p = rotate({ x: point.x - center.x, y: point.y - center.y, z: point.z - center.z }, DEFAULT_GALAXY_VIEW)
    const perspective = cameraDistance / (cameraDistance + p.z)
    minX = Math.min(minX, p.x * perspective); maxX = Math.max(maxX, p.x * perspective)
    minY = Math.min(minY, p.y * perspective); maxY = Math.max(maxY, p.y * perspective)
  }
  const referenceCenter = { x: all.length ? (minX + maxX) / 2 : 0, y: all.length ? (minY + maxY) / 2 : 0 }
  return { center, cameraDistance, referenceCenter, scale: Math.min(width / Math.max(radius * 0.24, maxX - minX), height / Math.max(radius * 0.24, maxY - minY)) * 0.84 }
}

function project(point: GraphPoint, view: GalaxyView, width: number, height: number, frame: ReturnType<typeof galaxyFrame>) {
  const p = rotate({ x: point.x - frame.center.x, y: point.y - frame.center.y, z: point.z - frame.center.z }, view)
  const perspective = frame.cameraDistance / (frame.cameraDistance + p.z)
  return { x: width / 2 + (p.x * perspective - frame.referenceCenter.x) * frame.scale * view.zoom, y: height / 2 + (p.y * perspective - frame.referenceCenter.y) * frame.scale * view.zoom, depth: p.z, perspective }
}

export function galaxyHitRadius(node: Pick<GalaxyScreenNode, 'coreRadius'>) { return Math.max(14, node.coreRadius + 7) }
export function pickGalaxyNode(nodes: GalaxyScreenNode[], x: number, y: number) {
  return [...nodes].sort((a, b) => a.depth - b.depth).find((node) => Math.hypot(node.x - x, node.y - y) < galaxyHitRadius(node))
}

/** Screen-space LOD and collision planning use every entity, without a label-count or entity cap. */
export function buildGalaxyScene(nodes: GalaxyEntity[], edges: MemoryGraphRoutingEdge[], points: Map<string, GraphPoint>, view: GalaxyView, width: number, height: number, selectedId: string | null, measure: MeasureText, geometry = prepareGalaxyGeometry(points, edges)): GalaxyScene {
  const frame = galaxyFrame(points, width, height)
  const neighbors = memoryGraphNeighborhood(selectedId, edges)
  const degree = new Map<string, number>()
  for (const edge of edges) { degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1); degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1) }
  const projected: GalaxyScreenNode[] = nodes.map((node) => {
    const p = project(points.get(node.id)!, view, width, height, frame)
    const connectivity = Math.sqrt(degree.get(node.id) ?? 0)
    const density = geometry.density.get(node.id) ?? 0
    const selected = node.id === selectedId
    const neighbor = neighbors.has(node.id)
    // Intrinsic variation is stable per real entity; depth and connectivity still shape its apparent light.
    let hash = 2166136261
    for (const character of node.id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
    const luminosity = (hash >>> 0) / 4294967296
    const coreRadius = (0.34 + 0.48 * Math.pow(p.perspective, 1.5) + connectivity * 0.045) * (0.7 + luminosity * 0.6) * Math.pow(view.zoom, 0.2)
    const brightness = clamp((0.38 + 0.42 * Math.pow(p.perspective, 0.8) + connectivity * 0.018) * (0.72 + luminosity * 0.28), 0.28, 1)
    return { ...node, ...p, coreRadius, opacity: selected ? 1 : brightness * (selectedId && !neighbor ? 0.14 : 1), selected, neighbor, separation: Infinity, nameOpacity: 0, density, emissionRadius: coreRadius * (4 + density * 3.5) }
  })
  projected.forEach((node, i) => {
    projected.forEach((other, j) => { if (i !== j) node.separation = Math.min(node.separation, Math.hypot(node.x - other.x, node.y - other.y) - node.coreRadius - other.coreRadius) })
    // The overview gate is exactly zero at default fit. Depth and local space then reveal names individually.
    node.nameOpacity = selectedId ? node.selected ? 1 : node.neighbor ? 0.82 : 0 : smooth(1.08, 1.6, view.zoom) * smooth(1.55, 3.2, view.zoom * node.perspective) * smooth(12, 54, node.separation)
  })
  const nodeMap = new Map(projected.map((n) => [n.id, n]))
  const links: GalaxyLink[] = edges.map((edge) => {
    const a = nodeMap.get(edge.source)!
    const b = nodeMap.get(edge.target)!
    const curve = geometry.curves.get(edge.id)!
    const path = curve.samples.map((point) => project(point, view, width, height, frame))
    const anchors = [0.5, 0.35, 0.65].map((t) => project(sampleGalaxyCurve(curve, t), view, width, height, frame))
    const endControl = project(curve.second, view, width, height, frame)
    const endTangent = { x: b.x - endControl.x, y: b.y - endControl.y }
    const internal = geometry.communities.get(edge.source) === geometry.communities.get(edge.target)
    const focused = edge.source === selectedId || edge.target === selectedId
    const depthAlpha = clamp((a.perspective + b.perspective) / 2, 0.5, 1.8)
    return { ...edge, a, b, curve, path, anchors, endTangent, focused, internal, opacity: focused ? Math.min(0.8, 0.48 * depthAlpha) : (selectedId ? 0.018 : (edge.type === '同章出现' ? 0.035 : internal ? 0.045 : 0.2) * depthAlpha) * smooth(1.08, 1.8, view.zoom) }
  })
  const occupied: GraphRect[] = projected.map((n) => ({ x: n.x - n.coreRadius - 3, y: n.y - n.coreRadius - 3, width: (n.coreRadius + 3) * 2, height: (n.coreRadius + 3) * 2 }))
  const labels: GalaxyLabel[] = []
  const place = (label: Omit<GalaxyLabel, 'box'>, candidates: { x: number; y: number; anchor?: { x: number; y: number } }[], width: number, height: number) => {
    for (const p of candidates) {
      const box = { x: p.x, y: p.y, width, height }
      if (box.x < 8 || box.y < 8 || box.x + width > widthLimit - 8 || box.y + height > heightLimit - 8 || occupied.some((other) => rectanglesOverlap(box, other, 3))) continue
      labels.push({ ...label, anchor: p.anchor ?? label.anchor, box }); occupied.push(box); return
    }
    if (label.selected) {
      // Selection has the first text reservation. Edge-of-screen names must not disappear
      // merely because a dim unrelated star occupies the otherwise best label position.
      const node = nodeMap.get(label.owner)!
      const ownCore = { x: node.x - node.coreRadius - 3, y: node.y - node.coreRadius - 3, width: (node.coreRadius + 3) * 2, height: (node.coreRadius + 3) * 2 }
      const choices = candidates.map((p) => ({ x: clamp(p.x, 8, widthLimit - width - 8), y: clamp(p.y, 8, heightLimit - height - 8), width, height }))
      const score = (box: GraphRect) => (rectanglesOverlap(box, ownCore, 2) ? 10000 : 0) + occupied.filter((other) => rectanglesOverlap(box, other, 2)).length * 20 + Math.hypot(box.x + box.width / 2 - node.x, box.y + box.height / 2 - node.y) * 0.01
      choices.sort((a, b) => score(a) - score(b))
      const box = choices[0]
      labels.push({ ...label, box }); occupied.push(box)
    }
  }
  const widthLimit = width
  const heightLimit = height
  const priorities = [...projected].sort((a, b) => Number(b.selected) - Number(a.selected) || b.nameOpacity - a.nameOpacity || b.separation - a.separation || a.depth - b.depth || a.id.localeCompare(b.id))
  for (const node of priorities) {
    if (node.nameOpacity < 0.035) continue
    const size = node.selected ? 12 : 11
    const weight = node.selected ? 600 : 400
    const lines: string[] = []
    if (node.selected) {
      let line = ''
      for (const character of node.label) {
        if (line && measure(line + character, size, weight) > Math.min(280, width - 32)) { lines.push(line); line = '' }
        line += character
      }
      if (line) lines.push(line)
    } else lines.push(node.label)
    const labelWidth = Math.max(...lines.map((line) => measure(line, size, weight))) + 6
    const labelHeight = lines.length * 15 + 2
    const gap = node.coreRadius + 8
    const candidates = [
      { x: node.x - labelWidth / 2, y: node.y - gap - labelHeight },
      { x: node.x + gap, y: node.y - labelHeight / 2 },
      { x: node.x - labelWidth / 2, y: node.y + gap },
      { x: node.x - gap - labelWidth, y: node.y - labelHeight / 2 },
      { x: node.x + gap + 8, y: node.y - gap - labelHeight },
      { x: node.x - gap - labelWidth - 8, y: node.y + gap },
    ]
    place({ id: `node:${node.id}`, kind: 'node', owner: node.id, lines, anchor: { x: node.x, y: node.y }, opacity: node.nameOpacity, size, selected: node.selected }, candidates, labelWidth, labelHeight)
  }
  // Relation text is a selection-only layer, including at maximum zoom.
  if (selectedId) for (const link of links.filter((link) => link.focused && link.type !== '同章出现')) {
    const size = 10.5
    const labelWidth = measure(link.type, size, 400) + 6
    const labelHeight = 16
    const dx = link.b.x - link.a.x
    const dy = link.b.y - link.a.y
    const length = Math.max(1, Math.hypot(dx, dy))
    const candidates: { x: number; y: number; anchor?: { x: number; y: number } }[] = []
    let anchor = { x: 0, y: 0 }
    for (const [i, p] of link.anchors.entries()) {
      if (i === 0) anchor = p
      for (const offset of [0, 13, -13, 26, -26]) candidates.push({ x: p.x - dy / length * offset - labelWidth / 2, y: p.y + dx / length * offset - labelHeight / 2, anchor: p })
    }
    place({ id: `edge:${link.id}`, kind: 'edge', owner: link.id, lines: [link.type], anchor, opacity: 0.86, size, selected: false }, candidates, labelWidth, labelHeight)
  }
  return { nodes: projected, links, labels }
}

/** These canvas assets are created once per renderer (stars) or actual backing-size change (deep field). */
export function createGalaxyWingSprite(tint: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  glow.addColorStop(0, `${tint}70`); glow.addColorStop(0.12, `${tint}46`); glow.addColorStop(0.3, `${tint}18`); glow.addColorStop(0.58, `${tint}03`); glow.addColorStop(1, `${tint}00`)
  ctx.fillStyle = glow; ctx.fillRect(0, 0, 64, 64)
  return canvas
}
export function createGalaxyBackdrop(width: number, height: number, dpr: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#020408'; ctx.fillRect(0, 0, width, height)
  let seed = 412903
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = 0; i < Math.round(width * height / 1500); i += 1) {
    const x = random() * width; const y = random() * height
    const luminosity = Math.pow(random(), 2.4)
    const size = 0.35 + luminosity * 0.85
    const tint = random() > 0.86 ? '229,198,151' : '186,209,237'
    const halo = 2 + luminosity * 3
    const glow = ctx.createRadialGradient(x, y, 0, x, y, halo)
    glow.addColorStop(0, `rgba(${tint},${0.12 + luminosity * 0.2})`)
    glow.addColorStop(0.22, `rgba(${tint},${0.025 + luminosity * 0.045})`)
    glow.addColorStop(1, `rgba(${tint},0)`)
    ctx.fillStyle = glow; ctx.fillRect(x - halo, y - halo, halo * 2, halo * 2)
    ctx.fillStyle = `rgba(${tint},${0.18 + luminosity * 0.4})`; ctx.fillRect(x, y, size, size)
  }
  return canvas
}
