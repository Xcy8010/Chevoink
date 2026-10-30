// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import MemoryGraphCanvas from '../../src/features/studio/components/MemoryGraphCanvas'
import { routeMemoryGraph, solveMemoryGraph, type ReadableMemoryGraphEdge } from '../../src/features/studio/lib/memory-graph-layout'
import type { MemoryGraphLayoutRequest, MemoryGraphLayoutResult } from '../../src/features/studio/lib/memory-graph.worker'
import { memoryGraphFixture } from '../fixtures/memory-graph'

const state = vi.hoisted(() => ({ nodes: [] as Record<string, unknown>[], edges: [] as Record<string, unknown>[], minimap: {} as Record<string, unknown>, flow: {} as Record<string, unknown> }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges, children, ...props }: { nodes: typeof state.nodes; edges: typeof state.edges; children: React.ReactNode }) => {
    state.nodes = nodes; state.edges = edges; state.flow = props
    return <div data-testid="map">{nodes.map((node) => {
      const data = node.data as { memory: { id: string; label: string }; onSelect: (id: string) => void }
      return <button key={String(node.id)} onClick={() => data.onSelect(data.memory.id)}>{data.memory.label}</button>
    })}{children}</div>
  },
  MiniMap: (props: Record<string, unknown>) => { state.minimap = props; return <div data-testid="minimap" /> },
  Background: () => null, Controls: () => null, Handle: () => null, BaseEdge: () => null,
  BackgroundVariant: { Dots: 'dots' }, Position: { Left: 'left', Right: 'right' },
}))
vi.mock('../../src/features/studio/components/MemoryGraphGalaxy', () => ({ default: ({ nodes, selectedId, active }: { nodes: unknown[]; selectedId: string | null; active: boolean }) => <div data-testid="galaxy" data-nodes={nodes.length} data-selected={selectedId} data-active={String(active)} /> }))

/** A controllable worker: the test, never render(), chooses when geometry returns. */
class LayoutWorker {
  static instances: LayoutWorker[] = []
  onmessage: ((event: MessageEvent<MemoryGraphLayoutResult>) => void) | null = null
  onerror: (() => void) | null = null
  request!: MemoryGraphLayoutRequest
  queuedHandler: LayoutWorker['onmessage'] = null
  terminated = false
  constructor(readonly url: URL, readonly options: WorkerOptions) { LayoutWorker.instances.push(this) }
  postMessage(request: MemoryGraphLayoutRequest) { this.request = request; this.queuedHandler = this.onmessage }
  terminate() { this.terminated = true }
  complete() {
    const positions = solveMemoryGraph(this.request.topologyKey, this.request.dimensions)
    const routes = this.request.dimensions === 2 ? routeMemoryGraph(JSON.parse(this.request.routeKey) as ReadableMemoryGraphEdge[], positions) : new Map()
    // Deliver a queued callback even after terminate to exercise the obsolete-request guard.
    this.queuedHandler?.({ data: { key: this.request.key, positions, routes } } as MessageEvent<MemoryGraphLayoutResult>)
  }
}
const latestWorker = () => LayoutWorker.instances[LayoutWorker.instances.length - 1]
const finish = (worker = latestWorker()) => act(() => worker.complete())
beforeEach(() => { LayoutWorker.instances = []; state.nodes = []; state.edges = []; vi.stubGlobal('Worker', LayoutWorker) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('关系网视图交互', () => {
  it('异步布局完整图谱，缩略图几何一致且不按端点边界裁剪自定义标签', () => {
    render(<MemoryGraphCanvas graph={memoryGraphFixture} />)
    expect(screen.getByRole('status').textContent).toContain('正在布局')
    expect(screen.queryByTestId('map')).toBeNull()
    expect(LayoutWorker.instances).toHaveLength(1)
    expect(latestWorker().request.dimensions).toBe(2)
    expect(latestWorker().options).toEqual({ type: 'module' })
    finish()
    expect(screen.queryByRole('status')).toBeNull()
    expect(state.nodes).toHaveLength(103)
    expect(state.edges).toHaveLength(145)
    expect(state.nodes.every((node) => node.width === 156 && node.height === 48)).toBe(true)
    expect(state.minimap).toMatchObject({ position: 'bottom-left', pannable: true, zoomable: true, style: { width: 160, height: 112 } })
    expect(state.flow.onlyRenderVisibleElements).not.toBe(true)
    const color = state.minimap.nodeColor as (node: Record<string, unknown>) => string
    expect(color(state.nodes[0])).not.toBe(color(state.nodes[1]))
  })
  it('选择同时突出邻居和直接连线，详情可查看完整关系', () => {
    render(<MemoryGraphCanvas graph={memoryGraphFixture} />)
    finish()
    fireEvent.click(screen.getByRole('button', { name: '测试实体 1' }))
    expect(state.nodes.find((node) => node.id === 'node-090')!.className).toContain('is-dimmed')
    expect(state.nodes.find((node) => node.id === 'node-001')!.className).not.toContain('is-dimmed')
    const incident = state.edges.filter((edge) => edge.source === 'node-000' || edge.target === 'node-000')
    expect(incident.every((edge) => (edge.data as { focused: boolean }).focused)).toBe(true)
    expect(screen.getByLabelText('直接关系').textContent).toContain('测试实体 14')
    fireEvent.click(screen.getByRole('button', { name: '关闭实体详情' }))
    expect(state.nodes.some((node) => String(node.className).includes('is-dimmed'))).toBe(false)
    expect(LayoutWorker.instances).toHaveLength(1)
  })
  it('星系布局仅首次访问计算，切换和同拓扑轮询保持选择及原视图实例', () => {
    const { rerender } = render(<MemoryGraphCanvas graph={memoryGraphFixture} />)
    finish()
    const map = screen.getByTestId('map')
    fireEvent.click(screen.getByRole('button', { name: '测试实体 1' }))
    fireEvent.click(screen.getByRole('button', { name: '三维星系视图' }))
    expect(LayoutWorker.instances).toHaveLength(2)
    expect(latestWorker().request.dimensions).toBe(3)
    expect(screen.getByTestId('map')).toBe(map)
    expect(screen.getByRole('status')).toBeTruthy()
    finish()
    const galaxy = screen.getByTestId('galaxy')
    expect(galaxy.dataset).toMatchObject({ nodes: '103', selected: 'node-000', active: 'true' })
    fireEvent.click(screen.getByRole('button', { name: '关系图视图' }))
    expect(screen.getByTestId('map')).toBe(map)
    expect(screen.getByTestId('galaxy')).toBe(galaxy)
    expect(galaxy.dataset.active).toBe('false')
    rerender(<MemoryGraphCanvas graph={{ ...memoryGraphFixture, nodes: [...memoryGraphFixture.nodes], edges: memoryGraphFixture.edges.map((edge) => ({ ...edge, confidence: 0.95 })) }} />)
    fireEvent.click(screen.getByRole('button', { name: '三维星系视图' }))
    expect(screen.getByTestId('galaxy')).toBe(galaxy)
    expect(state.nodes.find((n) => n.id === 'node-000')!.className).toContain('is-focused')
    expect(LayoutWorker.instances).toHaveLength(2)
  })
  it('拓扑替换终止旧计算并忽略迟到结果，卸载终止当前计算', () => {
    const { rerender, unmount } = render(<MemoryGraphCanvas graph={memoryGraphFixture} />)
    const obsolete = latestWorker()
    const replacement = { ...memoryGraphFixture, nodes: memoryGraphFixture.nodes.slice(0, 102), edges: memoryGraphFixture.edges.filter((e) => e.source !== 'node-102' && e.target !== 'node-102') }
    rerender(<MemoryGraphCanvas graph={replacement} />)
    const current = latestWorker()
    expect(obsolete.terminated).toBe(true)
    finish(obsolete)
    expect(screen.queryByTestId('map')).toBeNull()
    finish(current)
    expect(state.nodes).toHaveLength(102)
    const map = screen.getByTestId('map')
    rerender(<MemoryGraphCanvas graph={memoryGraphFixture} />)
    expect(screen.getByTestId('map')).toBe(map)
    expect(screen.getByRole('status')).toBeTruthy()
    const unfinished = latestWorker()
    unmount()
    expect(unfinished.terminated).toBe(true)
  })
  it('离开尚在计算的星系会终止计算，返回后重新请求', () => {
    render(<MemoryGraphCanvas graph={memoryGraphFixture} />)
    finish()
    fireEvent.click(screen.getByRole('button', { name: '三维星系视图' }))
    const obsolete = latestWorker()
    fireEvent.click(screen.getByRole('button', { name: '关系图视图' }))
    expect(obsolete.terminated).toBe(true)
    finish(obsolete)
    expect(screen.queryByTestId('galaxy')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '三维星系视图' }))
    expect(latestWorker()).not.toBe(obsolete)
    finish()
    expect(screen.getByTestId('galaxy').dataset.active).toBe('true')
  })
  it('计算错误不滞留为加载中，可以明确重试', () => {
    render(<MemoryGraphCanvas graph={memoryGraphFixture} />)
    act(() => latestWorker().onerror?.())
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(LayoutWorker.instances).toHaveLength(2)
    expect(screen.getByRole('status')).toBeTruthy()
    finish()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(state.nodes).toHaveLength(103)
  })
})
