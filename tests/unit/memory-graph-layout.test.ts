import { describe, expect, it } from 'vitest'
import type { MemoryGraphEdge } from '../../shared/contracts/index.js'
import { buildReadableMemoryGraphEdges, MEMORY_NODE_HEIGHT, MEMORY_NODE_WIDTH, memoryGraphNeighborhood, memoryGraphTopologyKey, memoryNodeColor, projectMemoryPoint, rectanglesOverlap, routeMemoryGraph, solveMemoryGraph } from '../../src/features/studio/lib/memory-graph-layout.js'
import { memoryGraphFixture } from '../fixtures/memory-graph.js'

function edge(id: string, source: string, target: string, type = '同章出现'): MemoryGraphEdge {
  return { id, source, target, type, state: null, confidence: 0.55, sourceId: id }
}
const ids = memoryGraphFixture.nodes.map((n) => n.id)
const edges = buildReadableMemoryGraphEdges(memoryGraphFixture.edges, new Set(ids), ids.length)
const topology = memoryGraphTopologyKey(ids, edges)
const positions = solveMemoryGraph(topology, 2)

describe('记忆图谱可读性投影', () => {
  it('聚合同一人物对重复共现，保留全部不同关系', () => {
    expect(buildReadableMemoryGraphEdges([edge('1', 'a', 'b'), edge('2', 'b', 'a'), edge('3', 'a', 'b')], new Set(['a', 'b']), 2)).toMatchObject([{ source: 'a', target: 'b', occurrences: 3 }])
    const input = [edge('s1', 'a', 'z', '师徒'), edge('s2', 'a', 'z', '师徒'), ...['b', 'c', 'd', 'e', 'f', 'g'].map((target, i) => edge(String(i), 'a', target))]
    const result = buildReadableMemoryGraphEdges(input, new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'z']), 8)
    expect(result.filter((e) => e.type === '师徒')).toMatchObject([{ occurrences: 2 }])
    expect(result.filter((e) => e.type === '同章出现')).toHaveLength(6)
  })
  it('103 个实体和 145 条语义关系不被截断', () => {
    expect(positions.size).toBe(103)
    expect(edges).toHaveLength(145)
    expect(new Set(edges.map((e) => `${e.source}:${e.target}:${e.type}`)).size).toBe(145)
  })
  it('人物、物品分别统一主色，其他实体保持中性色与真实类型', () => {
    expect(memoryNodeColor('character')).not.toBe(memoryNodeColor('item'))
    expect(memoryNodeColor('location')).toBe(memoryNodeColor('organization'))
    expect(memoryNodeColor('location')).not.toBe(memoryNodeColor('item'))
  })
  it('选择仅突出本身及直接邻居，包括入边', () => {
    const links = [edge('1', 'a', 'b'), edge('2', 'c', 'a'), edge('3', 'b', 'd')]
    expect([...memoryGraphNeighborhood('a', links)].sort()).toEqual(['a', 'b', 'c'])
    expect(memoryGraphNeighborhood(null, links).size).toBe(0)
  })
  it('相同拓扑轮询或重排不改变位置，关系参与布局', () => {
    const reordered = memoryGraphTopologyKey([...ids].reverse(), [...edges].reverse())
    expect(reordered).toBe(topology)
    expect(solveMemoryGraph(reordered, 2)).toEqual(positions)
    expect(solveMemoryGraph(memoryGraphTopologyKey(ids, []), 2)).not.toEqual(positions)
  })
  it('矩形节点不重叠，位置不形成固定行列网格', () => {
    const rects = [...positions.values()].map((p) => ({ ...p, width: MEMORY_NODE_WIDTH, height: MEMORY_NODE_HEIGHT }))
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) expect(rectanglesOverlap(rects[i], rects[j], 12)).toBe(false)
    expect(new Set(rects.map((r) => Math.round(r.x))).size).toBeGreaterThan(60)
    expect(new Set(rects.map((r) => Math.round(r.y))).size).toBeGreaterThan(60)
    const width = Math.max(...rects.map((r) => r.x + r.width)) - Math.min(...rects.map((r) => r.x))
    const height = Math.max(...rects.map((r) => r.y + r.height)) - Math.min(...rects.map((r) => r.y))
    // A wide card's short height must not bias every collision into a tall column.
    expect(width / height).toBeGreaterThan(1.25)
    expect(width / height).toBeLessThan(2.2)
  })
  it('所有关系均有曲线路由，语义标签避开节点与其他标签', () => {
    const routes = routeMemoryGraph(edges, positions)
    expect(routes.size).toBe(145)
    const labels = [...routes.values()].map((r) => r.label)
    const rects = [...positions.values()].map((p) => ({ ...p, width: MEMORY_NODE_WIDTH, height: MEMORY_NODE_HEIGHT }))
    for (let i = 0; i < labels.length; i += 1) {
      expect(rects.some((rect) => rectanglesOverlap(labels[i], rect))).toBe(false)
      for (let j = i + 1; j < labels.length; j += 1) expect(rectanglesOverlap(labels[i], labels[j])).toBe(false)
    }
    expect([...routes.values()].every((r) => r.path.includes(' Q '))).toBe(true)
  })
  it('平行与逆向关系具有独立曲线路径和完整标签', () => {
    const input = buildReadableMemoryGraphEdges([edge('1', 'a', 'b', '朋友'), edge('2', 'a', 'b', '同行'), edge('3', 'b', 'a', '认识')], new Set(['a', 'b']), 2)
    const points = new Map([['a', { x: 0, y: 0, z: 0 }], ['b', { x: 450, y: 0, z: 0 }]])
    expect(new Set([...routeMemoryGraph(input, points).values()].map((r) => r.path)).size).toBe(3)
  })
  it('星系求解产生真实深度且旋转改变透视投影', () => {
    const points = solveMemoryGraph(topology, 3)
    expect(points.size).toBe(103)
    expect(new Set([...points.values()].map((p) => Math.round(p.z))).size).toBeGreaterThan(40)
    const point = points.get(ids[10])!
    const a = projectMemoryPoint(point, 0, 0, 1, 1000, 700, 1000)
    const b = projectMemoryPoint(point, Math.PI / 2, 0.3, 1, 1000, 700, 1000)
    expect(a.x).not.toBe(b.x)
    expect(a.depth).not.toBe(b.depth)
    expect(Number.isFinite(b.scale)).toBe(true)
  })
})
