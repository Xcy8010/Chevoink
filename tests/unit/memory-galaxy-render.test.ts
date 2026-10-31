import { describe, expect, it } from 'vitest'
import { buildGalaxyScene, DEFAULT_GALAXY_VIEW, GALAXY_CURVE_STEPS, galaxyClusterExposure, galaxyDrawOrder, galaxyPaintOrder, galaxyHitRadius, pickGalaxyNode, prepareGalaxyGeometry, sampleGalaxyCurve } from '../../src/features/studio/lib/memory-galaxy-render'
import { buildReadableMemoryGraphEdges, memoryGraphNeighborhood, memoryGraphTopologyKey, rectanglesOverlap, solveMemoryGraph } from '../../src/features/studio/lib/memory-graph-layout'
import { memoryGraphFixture, memoryGraphHubFixture } from '../fixtures/memory-graph'

const nodes = memoryGraphFixture.nodes
const edges = buildReadableMemoryGraphEdges(memoryGraphFixture.edges, new Set(nodes.map((n) => n.id)), nodes.length)
const points = solveMemoryGraph(memoryGraphTopologyKey(nodes.map((n) => n.id), edges), 3)
const measure = (text: string, size: number) => [...text].length * size * 0.65
const scene = (zoom = 1, selected: string | null = null, width = 1200, height = 800) => buildGalaxyScene(nodes, edges, points, { ...DEFAULT_GALAXY_VIEW, zoom }, width, height, selected, measure)

describe('星系真实体积与屏幕文字层级', () => {
  it('远景保留完整实体/关系，完全不显示名称或关系文字', () => {
    const far = scene()
    expect(far.nodes).toHaveLength(103)
    expect(far.links).toHaveLength(145)
    expect(far.labels).toHaveLength(0)
    expect(far.nodes.every((n) => n.nameOpacity === 0)).toBe(true)
    expect(far.links.every((link) => link.opacity === 0)).toBe(true)
    const probe = buildGalaxyScene(nodes.slice(0, 2), [], new Map([[nodes[0].id, { x: 0, y: 0, z: -100 }], [nodes[1].id, { x: 0, y: 0, z: 100 }]]), { yaw: 0, pitch: 0, zoom: 1 }, 1200, 800, null, measure)
    const reversed = buildGalaxyScene(nodes.slice(0, 2), [], new Map([[nodes[0].id, { x: 0, y: 0, z: 100 }], [nodes[1].id, { x: 0, y: 0, z: -100 }]]), { yaw: 0, pitch: 0, zoom: 1 }, 1200, 800, null, measure)
    expect(probe.nodes[0].coreRadius).toBeGreaterThan(reversed.nodes[0].coreRadius)
    expect(probe.nodes[0].opacity).toBeGreaterThan(reversed.nodes[0].opacity)
  })
  it('细小星核有稳定个体差异，辉光尺度随星核而不是世界空间间距扩大', () => {
    const entities = nodes.slice(0, 20)
    const positions = new Map(entities.map((node, i) => [node.id, { x: i * 20, y: 0, z: 0 }]))
    const view = { yaw: 0, pitch: 0, zoom: 1 }
    const output = buildGalaxyScene(entities, [], positions, view, 1200, 800, null, measure)
    const repeated = buildGalaxyScene([...entities].reverse(), [], positions, view, 1200, 800, null, measure)
    expect(new Set(output.nodes.map((node) => node.coreRadius)).size).toBeGreaterThan(5)
    expect(new Set(output.nodes.map((node) => node.opacity)).size).toBeGreaterThan(5)
    for (const node of output.nodes) {
      expect(node.coreRadius).toBeGreaterThan(0)
      expect(node.coreRadius).toBeLessThan(1.1)
      expect(node.emissionRadius).toBeLessThanOrEqual(node.coreRadius * 7.5)
      const other = repeated.nodes.find((candidate) => candidate.id === node.id)!
      expect(other.coreRadius).toBe(node.coreRadius)
      expect(other.opacity).toBe(node.opacity)
    }
  })
  it('关系线从远景零透明度连续显现，选择始终显示真实直接关系', () => {
    const outputs = [1, 1.3, 1.6, 1.8].map((zoom) => scene(zoom))
    expect(outputs.every((output) => output.links.length === 145)).toBe(true)
    for (let i = 0; i < edges.length; i += 1) {
      expect(outputs[0].links[i].opacity).toBe(0)
      expect(outputs[1].links[i].opacity).toBeGreaterThan(0)
      expect(outputs[2].links[i].opacity).toBeGreaterThan(outputs[1].links[i].opacity)
      expect(outputs[3].links[i].opacity).toBeGreaterThan(outputs[2].links[i].opacity)
    }
    const focused = scene(1, nodes[0].id)
    expect(focused.links.some((link) => link.focused)).toBe(true)
    expect(focused.links.every((link) => link.focused ? link.opacity > 0 : link.opacity === 0)).toBe(true)
  })
  it('靠近按深度、局部空间渐进显示名称，任何未选中缩放均无关系文字', () => {
    const near = scene(2.4)
    const names = near.labels.filter((label) => label.kind === 'node')
    expect(names.length).toBeGreaterThan(0)
    expect(names.length).toBeLessThan(nodes.length)
    expect(new Set(names.map((label) => Math.round(label.opacity * 100))).size).toBeGreaterThan(5)
    for (const zoom of [1, 1.25, 1.8, 2.4, 3.5, 4.5]) expect(scene(zoom).labels.some((label) => label.kind === 'edge')).toBe(false)
    expect(scene(2.4, null, 375, 700).labels.length).toBeLessThan(names.length)
  })
  it('选中时只安排所选实体、直接邻居和入出语义边标签，取消后清空关系文字', () => {
    const far = scene()
    const selected = [...far.nodes].sort((a, b) => Math.hypot(a.x - 600, a.y - 400) - Math.hypot(b.x - 600, b.y - 400))[0].id
    const focused = scene(1, selected)
    const neighborhood = memoryGraphNeighborhood(selected, edges)
    const incident = new Set(edges.filter((e) => e.source === selected || e.target === selected).map((e) => e.id))
    expect(focused.labels.find((label) => label.owner === selected)?.selected).toBe(true)
    expect(focused.labels.some((label) => label.kind === 'edge')).toBe(true)
    expect(focused.labels.every((label) => label.kind === 'node' ? neighborhood.has(label.owner) : incident.has(label.owner))).toBe(true)
    expect(focused.links.every((link) => link.focused === incident.has(link.id))).toBe(true)
    expect(scene(1, null).labels).toHaveLength(0)
  })
  it('名称与边文字均无强制重叠或错锚，屏幕拥挤时让位给所选名称', () => {
    const near = scene(2.4)
    const selected = near.nodes.find((n) => n.x > 100 && n.x < 1100 && n.y > 100 && n.y < 700)!.id
    for (const output of [near, scene(2.4, selected), scene(1, selected, 375, 700)]) {
      for (let i = 0; i < output.labels.length; i += 1) {
        const label = output.labels[i]
        expect(label.box.x).toBeGreaterThanOrEqual(8)
        for (let j = i + 1; j < output.labels.length; j += 1) expect(rectanglesOverlap(label.box, output.labels[j].box)).toBe(false)
        if (label.kind === 'node') {
          const owner = output.nodes.find((n) => n.id === label.owner)!
          expect(label.anchor).toEqual({ x: owner.x, y: owner.y })
        } else {
          const owner = output.links.find((link) => link.id === label.owner)!
          expect(owner.anchors.map(({ x, y }) => ({ x, y }))).toContainEqual({ x: label.anchor.x, y: label.anchor.y })
          expect(Math.hypot(Math.max(label.box.x, Math.min(label.box.x + label.box.width, label.anchor.x)) - label.anchor.x, Math.max(label.box.y, Math.min(label.box.y + label.box.height, label.anchor.y)) - label.anchor.y)).toBeLessThan(28)
        }
      }
    }
    const crowdedNodes = nodes.slice(0, 15)
    const crowdedPoints = new Map(crowdedNodes.map((n) => [n.id, { x: 0, y: 0, z: 0 }]))
    const crowdedEdges = crowdedNodes.slice(1).map((n, i) => ({ id: `crowd-${i}`, source: crowdedNodes[0].id, target: n.id, type: '同行' }))
    const crowded = buildGalaxyScene(crowdedNodes, crowdedEdges, crowdedPoints, DEFAULT_GALAXY_VIEW, 375, 700, crowdedNodes[0].id, measure)
    expect(crowded.labels[0].owner).toBe(crowdedNodes[0].id)
    expect(crowded.labels.length).toBeLessThan(crowdedNodes.length)
    for (let i = 0; i < crowded.labels.length; i += 1) for (let j = i + 1; j < crowded.labels.length; j += 1) expect(rectanglesOverlap(crowded.labels[i].box, crowded.labels[j].box)).toBe(false)
  })
  it('密度来自真实三维邻域而非度数或屏幕重叠，离群高连接点不形成假星团', () => {
    const positions = new Map(Array.from({ length: 10 }, (_, i) => [`cluster-${i}`, { x: 400 + Math.cos(i) * 8, y: Math.sin(i) * 8, z: (i % 3) * 4 }]))
    positions.set('front', { x: 0, y: 0, z: -2000 }); positions.set('back', { x: 0, y: 0, z: 2000 })
    const links = Array.from({ length: 10 }, (_, i) => ({ id: `test-${i}`, source: 'front', target: `cluster-${i}`, type: '同行' }))
    const geometry = prepareGalaxyGeometry(positions, links)
    expect(geometry.density.size).toBe(12)
    expect(geometry.density.get('cluster-0')!).toBeGreaterThan(geometry.density.get('front')!)
    expect(galaxyClusterExposure(geometry.density.get('cluster-0')!)).toBeGreaterThan(galaxyClusterExposure(geometry.density.get('front')!))
    const withNeighbor = new Map(positions); withNeighbor.set('extra-real-neighbor', { x: 408.2, y: 0.2, z: 0 })
    expect(prepareGalaxyGeometry(withNeighbor, links).density.get('cluster-0')!).toBeGreaterThan(geometry.density.get('cluster-0')!)
    expect(geometry.density.get('front')!).toBeLessThan(0.01)
    expect(geometry.density.get('back')!).toBeLessThan(0.01)
    expect(geometry.curves.size).toBe(10)
    expect(prepareGalaxyGeometry(new Map([['alone', { x: 0, y: 0, z: 0 }]]), []).density.get('alone')).toBe(0)
  })
  it('全部真实边使用稳定三维曲线，端点正确、体积弯曲随旋转投影并按深度穿插恒星', () => {
    const geometry = prepareGalaxyGeometry(points, edges)
    expect(new Set(geometry.curves.keys())).toEqual(new Set(edges.map((edge) => edge.id)))
    let curved = 0; let nonPlanar = 0
    for (const edge of edges) {
      const curve = geometry.curves.get(edge.id)!
      expect(curve.samples).toHaveLength(GALAXY_CURVE_STEPS + 1)
      expect(sampleGalaxyCurve(curve, 0)).toEqual(points.get(edge.source))
      expect(sampleGalaxyCurve(curve, 1)).toEqual(points.get(edge.target))
      const middle = sampleGalaxyCurve(curve, 0.5)
      if (Math.hypot(middle.x - (curve.a.x + curve.b.x) / 2, middle.y - (curve.a.y + curve.b.y) / 2, middle.z - (curve.a.z + curve.b.z) / 2) > 1) curved += 1
      const a = { x: curve.first.x - curve.a.x, y: curve.first.y - curve.a.y, z: curve.first.z - curve.a.z }
      const b = { x: curve.second.x - curve.a.x, y: curve.second.y - curve.a.y, z: curve.second.z - curve.a.z }
      const c = { x: curve.b.x - curve.a.x, y: curve.b.y - curve.a.y, z: curve.b.z - curve.a.z }
      if (Math.abs(a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x)) > 1) nonPlanar += 1
    }
    expect(curved).toBeGreaterThan(100); expect(nonPlanar).toBeGreaterThan(100)
    const normal = buildGalaxyScene(nodes, edges, points, DEFAULT_GALAXY_VIEW, 1200, 800, null, measure, geometry)
    const rotated = buildGalaxyScene(nodes, edges, points, { yaw: 1.6, pitch: 0.5, zoom: 1 }, 1200, 800, nodes[0].id, measure, geometry)
    expect(rotated.links[0].curve).toBe(geometry.curves.get(edges[0].id))
    expect(rotated.links[0].path[6].depth).not.toBe(normal.links[0].path[6].depth)
    expect(rotated.links[0].path[6].x).not.toBe(normal.links[0].path[6].x)
    for (const link of normal.links) {
      expect(link.path[0].x).toBe(link.a.x); expect(link.path[0].y).toBe(link.a.y)
      expect(link.path[link.path.length - 1].x).toBe(link.b.x); expect(link.path[link.path.length - 1].y).toBe(link.b.y)
      expect(Math.hypot(link.endTangent.x, link.endTangent.y)).toBeGreaterThan(0)
    }
    const order = galaxyDrawOrder(normal)
    expect(order.filter((p) => p.kind === 'star')).toHaveLength(103)
    expect(order.filter((p) => p.kind === 'thread')).toHaveLength(145 * GALAXY_CURVE_STEPS)
    for (let i = 1; i < order.length; i += 1) expect(order[i].depth).toBeLessThanOrEqual(order[i - 1].depth)
    expect(order.findIndex((p) => p.kind === 'star')).toBeLessThan(order.map((p) => p.kind).lastIndexOf('thread'))
  })
  it('实际恒星深度平面内合并线段笔画，全部145条曲线/样本保留且不跨恒星遮挡', () => {
    for (const selected of [null, nodes[0].id]) {
      const output = scene(1, selected)
      const paint = galaxyPaintOrder(output)
      const batches = paint.filter((primitive) => primitive.kind === 'threads')
      const segments = batches.flatMap((batch) => batch.segments)
      expect(segments).toHaveLength(145 * GALAXY_CURVE_STEPS)
      expect(new Set(segments.map((segment) => segment.link.id))).toEqual(new Set(edges.map((edge) => edge.id)))
      expect(paint.filter((primitive) => primitive.kind === 'star')).toHaveLength(103)
      const styles = new Set(output.links.map((link) => [link.focused, link.internal, link.type === '同章出现'].join(':'))).size
      expect(batches.length).toBeLessThanOrEqual((nodes.length + 1) * styles)
      let previousDepth = Infinity
      for (let i = 0; i < paint.length; i += 1) {
        const primitive = paint[i]
        if (primitive.kind === 'star') { previousDepth = primitive.depth; continue }
        const nextStar = paint.slice(i + 1).find((candidate) => candidate.kind === 'star')
        const nextDepth = nextStar?.kind === 'star' ? nextStar.depth : -Infinity
        expect(primitive.opacity).toBeGreaterThanOrEqual(0); expect(primitive.opacity).toBeLessThanOrEqual(1); expect(primitive.opacity > 0).toBe(primitive.focused)
        for (const segment of primitive.segments) {
          expect(segment.depth).toBeLessThanOrEqual(previousDepth)
          expect(segment.depth).toBeGreaterThanOrEqual(nextDepth)
          expect(segment.link.focused).toBe(primitive.focused)
          expect(segment.link.internal).toBe(primitive.internal)
          expect(segment.link.type === '同章出现').toBe(primitive.hint)
        }
      }
    }
  })
  it('宽星团辉光平滑、有限且集中于三维过密区域，稀疏区域不形成均匀雾层', () => {
    expect(galaxyClusterExposure(0)).toBe(0)
    expect(galaxyClusterExposure(1)).toBeLessThan(1)
    let previous = 0
    for (let i = 0; i <= 100; i += 1) {
      const exposure = galaxyClusterExposure(i / 100)
      expect(exposure).toBeGreaterThanOrEqual(previous)
      expect(exposure).toBeLessThanOrEqual(1)
      previous = exposure
    }
  })
  it('真实枢纽图形成非共面体积和不同径向距离，而非固定正半径的花瓣壳层', () => {
    const hub = memoryGraphHubFixture
    const links = buildReadableMemoryGraphEdges(hub.edges, new Set(hub.nodes.map((n) => n.id)), hub.nodes.length)
    const positions = solveMemoryGraph(memoryGraphTopologyKey(hub.nodes.map((n) => n.id), links), 3)
    const all = [...positions.values()]
    const mean = all.reduce((sum, p) => ({ x: sum.x + p.x / all.length, y: sum.y + p.y / all.length, z: sum.z + p.z / all.length }), { x: 0, y: 0, z: 0 })
    const covariance = (a: 'x' | 'y' | 'z', b: 'x' | 'y' | 'z') => all.reduce((sum, p) => sum + (p[a] - mean[a]) * (p[b] - mean[b]) / all.length, 0)
    const xx = covariance('x', 'x'); const yy = covariance('y', 'y'); const zz = covariance('z', 'z')
    const xy = covariance('x', 'y'); const xz = covariance('x', 'z'); const yz = covariance('y', 'z')
    const determinant = xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz)
    // Rotation-invariant volume check: a merely tilted plane still has zero covariance determinant.
    expect(determinant / ((xx + yy + zz) / 3) ** 3).toBeGreaterThan(0.2)
    const center = positions.get(hub.nodes[0].id)!
    const radii = hub.nodes.slice(1, 47).map((node) => positions.get(node.id)!).map((p) => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z))
    const average = radii.reduce((sum, value) => sum + value, 0) / radii.length
    expect(Math.min(...radii) / Math.max(...radii)).toBeLessThan(0.45)
    expect(average / Math.max(...radii)).toBeLessThan(0.83)
    expect(Math.sqrt(radii.reduce((sum, value) => sum + (value - average) ** 2, 0) / radii.length) / average).toBeGreaterThan(0.15)
  })
  it('四个屏幕边缘的所选名称均先保留，邻居和边文字拥挤时让位', () => {
    const entities = nodes.slice(0, 5)
    const positions = new Map(entities.map((node, i) => [node.id, [{ x: -100, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 0, y: -100, z: 0 }, { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }][i]]))
    const links = entities.slice(0, 4).map((node, i) => ({ id: `edge-${i}`, source: entities[4].id, target: node.id, type: '同行' }))
    const width = 375; const height = 700
    const base = buildGalaxyScene(entities, links, positions, DEFAULT_GALAXY_VIEW, width, height, null, measure)
    for (let i = 0; i < 4; i += 1) {
      const point = base.nodes[i]
      const horizontal = i < 2
      const middle = horizontal ? width / 2 : height / 2
      const coordinate = horizontal ? point.x : point.y
      const edge = i % 2 === 0 ? 3 : middle * 2 - 3
      const zoom = (edge - middle) / (coordinate - middle)
      const output = buildGalaxyScene(entities, links, positions, { ...DEFAULT_GALAXY_VIEW, zoom }, width, height, point.id, measure)
      const selected = output.nodes.find((node) => node.id === point.id)!
      expect(selected.x).toBeGreaterThanOrEqual(0); expect(selected.x).toBeLessThanOrEqual(width)
      expect(selected.y).toBeGreaterThanOrEqual(0); expect(selected.y).toBeLessThanOrEqual(height)
      const label = output.labels.find((item) => item.owner === point.id)!
      expect(label.lines.join('')).toBe(point.label)
      expect(label.box.x).toBeGreaterThanOrEqual(8); expect(label.box.x + label.box.width).toBeLessThanOrEqual(width - 8)
      expect(label.box.y).toBeGreaterThanOrEqual(8); expect(label.box.y + label.box.height).toBeLessThanOrEqual(height - 8)
      expect(output.labels.filter((item) => item !== label).some((item) => rectanglesOverlap(item.box, label.box))).toBe(false)
    }
  })
  it('显式枢纽拓扑保留103/145并显示所选枢纽名称，关系文字仍只属于真实直接边', () => {
    const hub = memoryGraphHubFixture
    const links = buildReadableMemoryGraphEdges(hub.edges, new Set(hub.nodes.map((n) => n.id)), hub.nodes.length)
    const positions = solveMemoryGraph(memoryGraphTopologyKey(hub.nodes.map((n) => n.id), links), 3)
    const selected = hub.nodes[0].id
    const output = buildGalaxyScene(hub.nodes, links, positions, DEFAULT_GALAXY_VIEW, 375, 700, selected, measure)
    expect(output.nodes).toHaveLength(103); expect(output.links).toHaveLength(145)
    expect(links.filter((link) => link.source === selected || link.target === selected).length).toBeGreaterThan(40)
    expect(output.labels.find((label) => label.owner === selected)?.lines.join('')).toBe(hub.nodes[0].label)
    const incident = new Set(links.filter((link) => link.source === selected || link.target === selected).map((link) => link.id))
    expect(output.labels.filter((label) => label.kind === 'edge').every((label) => incident.has(label.owner))).toBe(true)
  })
  it('细小星核仍有独立触摸命中范围，孤立实体完整保留，旋转改变真实深度', () => {
    const single = buildGalaxyScene([nodes[0]], [], new Map([[nodes[0].id, { x: 20, y: -10, z: 30 }]]), DEFAULT_GALAXY_VIEW, 375, 700, null, measure)
    const node = single.nodes[0]
    expect(single.nodes).toHaveLength(1)
    expect(node.coreRadius).toBeLessThan(3)
    expect(galaxyHitRadius(node)).toBe(14)
    expect(pickGalaxyNode(single.nodes, node.x + 12, node.y)?.id).toBe(node.id)
    expect(pickGalaxyNode(single.nodes, node.x + 16, node.y)).toBeUndefined()
    const far = scene()
    const rotated = buildGalaxyScene(nodes, edges, points, { yaw: DEFAULT_GALAXY_VIEW.yaw + 1.4, pitch: 0.4, zoom: 1 }, 1200, 800, null, measure)
    expect(rotated.nodes[0].depth).not.toBe(far.nodes[0].depth)
    expect(rotated.nodes[0].coreRadius).not.toBe(far.nodes[0].coreRadius)
    expect(rotated.nodes[0].x).not.toBe(far.nodes[0].x)
  })
})
