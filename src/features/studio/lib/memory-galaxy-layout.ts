type Point3D = { x: number; y: number; z: number }
type LinkPair = { source: string; target: string }
export const GALAXY_MEMBER_SPACING = 72

/** Exact positive modularity moves on the retained undirected unit-weight multigraph. */
export function partitionGalaxyGraph(ids: string[], edges: LinkPair[]): Map<string, string> {
  const ordered = [...ids].sort()
  const adjacency = new Map(ordered.map((id) => [id, new Map<string, number>()]))
  for (const { source, target } of edges) {
    adjacency.get(source)!.set(target, (adjacency.get(source)!.get(target) ?? 0) + 1)
    adjacency.get(target)!.set(source, (adjacency.get(target)!.get(source) ?? 0) + 1)
  }
  const degree = new Map(ordered.map((id) => [id, [...adjacency.get(id)!.values()].reduce((a, b) => a + b, 0)]))
  const assignment = new Map(ordered.map((id) => [id, id]))
  const total = new Map(degree)
  let moved: boolean
  do {
    moved = false
    for (const id of ordered) {
      const from = assignment.get(id)!
      const weights = new Map<string, number>()
      for (const [neighbor, weight] of adjacency.get(id)!) {
        const community = assignment.get(neighbor)!
        weights.set(community, (weights.get(community) ?? 0) + weight)
      }
      const k = degree.get(id)!
      let best = from; let bestGain = 0
      for (const candidate of [...weights.keys()].sort()) {
        if (candidate === from) continue
        const gain = 2 * edges.length * ((weights.get(candidate) ?? 0) - (weights.get(from) ?? 0)) - k * (total.get(candidate)! - total.get(from)! + k)
        if (gain > bestGain || (gain === bestGain && gain > 0 && candidate < best)) { best = candidate; bestGain = gain }
      }
      if (best === from) continue
      assignment.set(id, best); total.set(from, total.get(from)! - k); total.set(best, total.get(best)! + k)
      moved = true
    }
  } while (moved)
  // A move may disconnect the community it leaves. Only actual connected member components survive.
  const result = new Map<string, string>()
  for (const id of ordered) {
    if (result.has(id)) continue
    const group = assignment.get(id)!
    const queue = [id]; result.set(id, id)
    for (let i = 0; i < queue.length; i += 1) for (const neighbor of [...adjacency.get(queue[i])!.keys()].sort()) {
      if (!result.has(neighbor) && assignment.get(neighbor) === group) { result.set(neighbor, id); queue.push(neighbor) }
    }
  }
  return result
}

function sampleVolume(id: string, radius: number): Point3D {
  const fraction = (salt: number) => {
    let hash = 2166136261 ^ salt
    for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
    hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d); hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b)
    return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296
  }
  const z = fraction(15731) * 2 - 1
  const angle = fraction(789221) * Math.PI * 2
  const distance = radius * Math.cbrt(fraction(1376312589))
  const r = Math.sqrt(1 - z * z) * distance
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, z: z * distance }
}
const axes = ['x', 'y', 'z'] as const

/** Two finite geometry levels, both based on existing edges. Coarse centers are never returned as entities. */
export function solveGalaxyLayout(ids: string[], edges: LinkPair[]): Map<string, Point3D> {
  const ordered = [...ids].sort()
  const partition = partitionGalaxyGraph(ordered, edges)
  const members = new Map<string, string[]>()
  for (const id of ordered) { const key = partition.get(id)!; const group = members.get(key) ?? []; group.push(id); members.set(key, group) }
  const groups = [...members.keys()].sort()
  const radii = new Map(groups.map((id) => [id, GALAXY_MEMBER_SPACING * Math.cbrt(members.get(id)!.length)]))
  const centers = new Map(groups.map((id) => [id, groups.length === 1 ? { x: 0, y: 0, z: 0 } : sampleVolume(`community:${id}`, GALAXY_MEMBER_SPACING * Math.cbrt(ordered.length) * 2.8)]))
  const centerSeeds = new Map([...centers].map(([id, p]) => [id, { ...p }]))
  const velocity = new Map(groups.map((id) => [id, { x: 0, y: 0, z: 0 }]))
  const coarseEdges = new Map<string, { source: string; target: string; weight: number }>()
  for (const edge of edges) {
    const a = partition.get(edge.source)!; const b = partition.get(edge.target)!
    if (a === b) continue
    const [source, target] = [a, b].sort(); const key = JSON.stringify([source, target])
    const current = coarseEdges.get(key)
    if (current) current.weight += 1
    else coarseEdges.set(key, { source, target, weight: 1 })
  }
  for (let tick = 0; tick < 180; tick += 1) {
    for (let a = 0; a < groups.length; a += 1) for (let b = a + 1; b < groups.length; b += 1) {
      const first = groups[a]; const second = groups[b]; const p = centers.get(first)!; const q = centers.get(second)!
      const delta = { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z }; const distance = Math.max(1, Math.hypot(delta.x, delta.y, delta.z))
      const clearance = radii.get(first)! + radii.get(second)! + GALAXY_MEMBER_SPACING * 0.35
      const push = Math.max(0, clearance - distance) * 0.12 + GALAXY_MEMBER_SPACING ** 2 / (distance * distance) * 0.04
      for (const axis of axes) { const step = delta[axis] / distance * push; velocity.get(first)![axis] -= step; velocity.get(second)![axis] += step }
    }
    for (const edge of coarseEdges.values()) {
      const p = centers.get(edge.source)!; const q = centers.get(edge.target)!
      const delta = { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z }; const distance = Math.max(1, Math.hypot(delta.x, delta.y, delta.z))
      const target = radii.get(edge.source)! + radii.get(edge.target)! + GALAXY_MEMBER_SPACING / Math.sqrt(edge.weight)
      const force = (distance - target) * 0.018 * Math.sqrt(edge.weight)
      for (const axis of axes) { const step = delta[axis] / distance * force; velocity.get(edge.source)![axis] += step; velocity.get(edge.target)![axis] -= step }
    }
    for (const id of groups) for (const axis of axes) {
      const p = centers.get(id)!; const seed = centerSeeds.get(id)!; const v = velocity.get(id)!
      v[axis] = (v[axis] - p[axis] * 0.0018 + (seed[axis] - p[axis]) * 0.0015) * 0.7
      p[axis] += Math.max(-GALAXY_MEMBER_SPACING * 0.2, Math.min(GALAXY_MEMBER_SPACING * 0.2, v[axis])) * (1 - tick / 200)
    }
  }
  const result = new Map<string, Point3D>()
  for (const group of groups) {
    const memberIds = members.get(group)!
    const positions = new Map(memberIds.map((id) => [id, sampleVolume(id, radii.get(group)!)]))
    const seeds = new Map([...positions].map(([id, p]) => [id, { ...p }]))
    const speeds = new Map(memberIds.map((id) => [id, { x: 0, y: 0, z: 0 }]))
    const internal = edges.filter((edge) => partition.get(edge.source) === group && partition.get(edge.target) === group)
    for (let tick = 0; tick < 160; tick += 1) {
      for (let a = 0; a < memberIds.length; a += 1) for (let b = a + 1; b < memberIds.length; b += 1) {
        const first = memberIds[a]; const second = memberIds[b]; const p = positions.get(first)!; const q = positions.get(second)!
        const delta = { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z }; const distance = Math.max(1, Math.hypot(delta.x, delta.y, delta.z))
        const reach = GALAXY_MEMBER_SPACING * 1.6
        const push = Math.max(0, 1 - distance / reach) ** 2 * GALAXY_MEMBER_SPACING * 0.14
        for (const axis of axes) { const step = delta[axis] / distance * push; speeds.get(first)![axis] -= step; speeds.get(second)![axis] += step }
      }
      for (const edge of internal) {
        const a = positions.get(edge.source)!; const b = positions.get(edge.target)!
        for (const axis of axes) { const step = (b[axis] - a[axis]) * 0.012; speeds.get(edge.source)![axis] += step; speeds.get(edge.target)![axis] -= step }
      }
      for (const id of memberIds) for (const axis of axes) {
        const p = positions.get(id)!; const seed = seeds.get(id)!; const v = speeds.get(id)!
        v[axis] = (v[axis] + (seed[axis] - p[axis]) * 0.0025) * 0.68
        p[axis] += Math.max(-GALAXY_MEMBER_SPACING * 0.12, Math.min(GALAXY_MEMBER_SPACING * 0.12, v[axis])) * (1 - tick / 180)
      }
    }
    const mean = [...positions.values()].reduce((sum, p) => ({ x: sum.x + p.x / memberIds.length, y: sum.y + p.y / memberIds.length, z: sum.z + p.z / memberIds.length }), { x: 0, y: 0, z: 0 })
    const center = centers.get(group)!
    for (const id of memberIds) { const p = positions.get(id)!; result.set(id, { x: center.x + p.x - mean.x, y: center.y + p.y - mean.y, z: center.z + p.z - mean.z }) }
  }
  return new Map(ordered.map((id) => [id, result.get(id)!]))
}
