import type { MemoryGraphEdge } from '../../../../shared/contracts/index.js'

export type ReadableMemoryGraphEdge = MemoryGraphEdge & { occurrences: number }
export type GraphPoint = { x: number; y: number; z: number }
export type GraphRect = { x: number; y: number; width: number; height: number }
export const MEMORY_NODE_WIDTH = 156
export const MEMORY_NODE_HEIGHT = 48
export const memoryNodeColor = (type: string) => type === 'character' ? '#69b5ef' : type === 'item' ? '#e5b873' : '#a5afb9'

/** Semantic relations are never capped. Repeated chapter co-occurrence is an undirected visual hint. */
export function buildReadableMemoryGraphEdges(edges: MemoryGraphEdge[], visibleIds: Set<string>, _visibleNodeCount: number): ReadableMemoryGraphEdge[] {
  const semantic = new Map<string, ReadableMemoryGraphEdge>()
  const coOccurrences = new Map<string, ReadableMemoryGraphEdge>()
  for (const edge of edges) {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target) || edge.source === edge.target) continue
    const coOccurrence = edge.type === '同章出现'
    const [source, target] = coOccurrence ? [edge.source, edge.target].sort() : [edge.source, edge.target]
    const key = JSON.stringify(coOccurrence ? [source, target] : [source, target, edge.type, edge.state])
    const collection = coOccurrence ? coOccurrences : semantic
    const current = collection.get(key)
    if (current) {
      current.occurrences += 1
      current.confidence = Math.max(current.confidence, edge.confidence)
    } else collection.set(key, { ...edge, id: `${coOccurrence ? 'co-occurrence' : 'semantic'}:${key}`, source, target, occurrences: 1 })
  }
  return [...semantic.values(), ...coOccurrences.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function memoryGraphNeighborhood(selected: string | null, edges: Pick<MemoryGraphEdge, 'source' | 'target'>[]): Set<string> {
  const ids = new Set<string>()
  if (selected === null) return ids
  ids.add(selected)
  for (const edge of edges) {
    if (edge.source === selected) ids.add(edge.target)
    if (edge.target === selected) ids.add(edge.source)
  }
  return ids
}

export function memoryGraphTopologyKey(ids: string[], edges: Pick<MemoryGraphEdge, 'source' | 'target'>[]): string {
  return JSON.stringify([ids.slice().sort(), edges.map(({ source, target }) => [source, target]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])
}

/** Deterministic, finite spring/repulsion solve. No frame loop or ongoing physics after layout. */
export function solveMemoryGraph(topologyKey: string, dimensions: 2 | 3): Map<string, GraphPoint> {
  const [ids, links] = JSON.parse(topologyKey) as [string[], [string, string][]]
  const count = ids.length
  const radius = Math.max(180, Math.sqrt(count) * (dimensions === 2 ? 120 : 70))
  const points = ids.map((_, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5))
    const z = dimensions === 3 ? 1 - 2 * (i + 0.5) / count : 0
    const r = dimensions === 3 ? Math.sqrt(1 - z * z) * radius : Math.sqrt((i + 0.5) / Math.max(count, 1)) * radius
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, z: z * radius }
  })
  const indices = new Map(ids.map((id, i) => [id, i]))
  const springs = links.map(([a, b]) => [indices.get(a), indices.get(b)]).filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined && pair[0] !== pair[1])
  const velocity = points.map(() => ({ x: 0, y: 0, z: 0 }))
  for (let tick = 0; tick < 180; tick += 1) {
    const cooling = 1 - tick / 200
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const dx = points[a].x - points[b].x || 0.01
        const dy = points[a].y - points[b].y || 0.01
        const dz = points[a].z - points[b].z
        const distance = Math.max(20, Math.hypot(dx, dy, dz))
        const force = Math.min(14, (dimensions === 2 ? 14000 : 8500) / (distance * distance))
        for (const axis of ['x', 'y', 'z'] as const) {
          const delta = axis === 'x' ? dx : axis === 'y' ? dy : dz
          velocity[a][axis] += delta / distance * force
          velocity[b][axis] -= delta / distance * force
        }
      }
    }
    for (const [a, b] of springs) {
      const dx = points[b].x - points[a].x
      const dy = points[b].y - points[a].y
      const dz = points[b].z - points[a].z
      const distance = Math.max(1, Math.hypot(dx, dy, dz))
      const force = (distance - (dimensions === 2 ? 260 : 170)) * 0.018
      for (const axis of ['x', 'y', 'z'] as const) {
        const delta = axis === 'x' ? dx : axis === 'y' ? dy : dz
        velocity[a][axis] += delta / distance * force
        velocity[b][axis] -= delta / distance * force
      }
    }
    let movement = 0
    points.forEach((point, i) => {
      for (const axis of ['x', 'y', 'z'] as const) {
        velocity[i][axis] = (velocity[i][axis] - point[axis] * 0.0008) * 0.7
        const step = Math.max(-18, Math.min(18, velocity[i][axis])) * cooling
        point[axis] += step
        movement += Math.abs(step)
      }
    })
    if (tick > 50 && movement < count * 0.025) break
  }
  // Solve card spacing in an aspect-normalized metric: equal force distances represent equal card clearance.
  // Raw pixel penetration favors the short Y dimension and packs a wide-card graph into a tall column.
  if (dimensions === 2) {
    const clearanceX = MEMORY_NODE_WIDTH + 48
    const clearanceY = MEMORY_NODE_HEIGHT + 65
    const aspectScale = Math.sqrt(clearanceX / clearanceY)
    points.forEach((point) => { point.x *= aspectScale; point.y /= aspectScale })
    for (let tick = 0; tick < 120; tick += 1) {
      let overlaps = 0
      for (let a = 0; a < count; a += 1) {
        for (let b = a + 1; b < count; b += 1) {
          const dx = points[b].x - points[a].x
          const dy = points[b].y - points[a].y
          const ox = clearanceX - Math.abs(dx)
          const oy = clearanceY - Math.abs(dy)
          if (ox <= 0 || oy <= 0) continue
          overlaps += 1
          const axis = ox / clearanceX < oy / clearanceY ? 'x' : 'y'
          const push = ((axis === 'x' ? ox : oy) / 2 + 0.5) * (axis === 'x' ? Math.sign(dx) || 1 : Math.sign(dy) || 1)
          points[a][axis] -= push
          points[b][axis] += push
        }
      }
      if (!overlaps) break
    }
  }
  return new Map(ids.map((id, i) => [id, points[i]]))
}

export function rectanglesOverlap(a: GraphRect, b: GraphRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
}

export type MemoryGraphRoutingEdge = Pick<ReadableMemoryGraphEdge, 'id' | 'source' | 'target' | 'type'>
export type MemoryGraphRoute = { path: string; label: GraphRect; anchor: { x: number; y: number } }

/** Distinct curved lanes avoid shared orthogonal segments; labels reserve space against cards and other labels. */
export function routeMemoryGraph(edges: MemoryGraphRoutingEdge[], positions: Map<string, GraphPoint>): Map<string, MemoryGraphRoute> {
  const nodeRects = [...positions.values()].map((p) => ({ x: p.x, y: p.y, width: MEMORY_NODE_WIDTH, height: MEMORY_NODE_HEIGHT }))
  const occupied = [...nodeRects]
  const routes = new Map<string, MemoryGraphRoute>()
  const pairs = new Map<string, number>()
  const outside = Math.max(0, ...nodeRects.map((r) => r.y + r.height)) + 40
  let overflowY = outside
  for (const edge of edges) {
    const source = positions.get(edge.source)
    const target = positions.get(edge.target)
    if (!source || !target) continue
    const a = { x: source.x + MEMORY_NODE_WIDTH / 2, y: source.y + MEMORY_NODE_HEIGHT / 2 }
    const b = { x: target.x + MEMORY_NODE_WIDTH / 2, y: target.y + MEMORY_NODE_HEIGHT / 2 }
    const dx = b.x - a.x
    const dy = b.y - a.y
    const distance = Math.max(1, Math.hypot(dx, dy))
    const normal = { x: -dy / distance, y: dx / distance }
    const pair = JSON.stringify([edge.source, edge.target].sort())
    const lane = pairs.get(pair) ?? 0
    pairs.set(pair, lane + 1)
    const pointAt = (t: number, bend: number) => ({ x: a.x + dx * t + normal.x * bend * 2 * t * (1 - t), y: a.y + dy * t + normal.y * bend * 2 * t * (1 - t) })
    let bend = (lane % 2 ? -1 : 1) * (32 + Math.ceil(lane / 2) * 65)
    let bestHits = Infinity
    // Try both sides of intervening cards. Fixed candidates bound route construction cost.
    for (const candidate of [bend, -bend, bend + 150, -bend - 150, bend + 360, -bend - 360]) {
      let hits = 0
      for (let step = 2; step < 19; step += 1) {
        const p = pointAt(step / 20, candidate)
        for (const [id, obstacle] of positions) {
          if (id === edge.source || id === edge.target) continue
          if (p.x > obstacle.x - 8 && p.x < obstacle.x + MEMORY_NODE_WIDTH + 8 && p.y > obstacle.y - 8 && p.y < obstacle.y + MEMORY_NODE_HEIGHT + 8) hits += 1
        }
      }
      if (hits < bestHits) { bestHits = hits; bend = candidate }
      if (hits === 0) break
    }
    // Meet the card boundary along the curve tangent instead of drawing through its text.
    const control = { x: (a.x + b.x) / 2 + normal.x * bend, y: (a.y + b.y) / 2 + normal.y * bend }
    const boundary = (center: { x: number; y: number }, toward: { x: number; y: number }) => {
      const vx = toward.x - center.x
      const vy = toward.y - center.y
      const scale = 1 / Math.max(Math.abs(vx) / (MEMORY_NODE_WIDTH / 2), Math.abs(vy) / (MEMORY_NODE_HEIGHT / 2), 0.01)
      return { x: center.x + vx * scale, y: center.y + vy * scale }
    }
    const start = boundary(a, control)
    const end = boundary(b, control)
    const path = `M ${start.x},${start.y} Q ${control.x},${control.y} ${end.x},${end.y}`
    const width = Math.max(44, [...edge.type].reduce((n, c) => n + (c.codePointAt(0)! > 255 ? 11 : 7), 16))
    let label: GraphRect | undefined
    let anchor = pointAt(0.5, bend)
    if (edge.type !== '同章出现') {
      for (const t of [0.5, 0.35, 0.65, 0.22, 0.78, 0.12, 0.88]) {
        const p = pointAt(t, bend)
        for (const offset of [0, 22, -22, 45, -45, 72, -72, 110, -110, 160, -160, 230, -230]) {
          const rect = { x: p.x + normal.x * offset - width / 2, y: p.y + normal.y * offset - 11, width, height: 22 }
          if (!occupied.some((other) => rectanglesOverlap(rect, other, 7))) { label = rect; anchor = p; break }
        }
        if (label) break
      }
      if (!label) {
        label = { x: anchor.x - width / 2, y: overflowY, width, height: 22 }
        while (occupied.some((other) => rectanglesOverlap(label!, other, 7))) label.y += 32
        overflowY = label.y + 32
      }
      occupied.push(label)
    }
    routes.set(edge.id, { path, label: label ?? { x: anchor.x, y: anchor.y, width: 0, height: 0 }, anchor })
  }
  return routes
}

export function projectMemoryPoint(point: GraphPoint, yaw: number, pitch: number, zoom: number, width: number, height: number, radius: number) {
  const x = point.x * Math.cos(yaw) + point.z * Math.sin(yaw)
  const z = -point.x * Math.sin(yaw) + point.z * Math.cos(yaw)
  const y = point.y * Math.cos(pitch) - z * Math.sin(pitch)
  const depth = point.y * Math.sin(pitch) + z * Math.cos(pitch)
  const perspective = radius * 3 / (radius * 3 + depth)
  const scale = Math.min(width, height) * 0.34 / radius * zoom * perspective
  return { x: width / 2 + x * scale, y: height / 2 + y * scale, depth, scale, perspective }
}
