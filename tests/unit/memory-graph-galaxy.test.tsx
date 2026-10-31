// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import MemoryGraphGalaxy from '../../src/features/studio/components/MemoryGraphGalaxy'
import * as galaxyRender from '../../src/features/studio/lib/memory-galaxy-render'
import { buildGalaxyScene, DEFAULT_GALAXY_VIEW, GALAXY_CURVE_STEPS, galaxyDrawOrder, galaxyPaintOrder } from '../../src/features/studio/lib/memory-galaxy-render'
import { buildReadableMemoryGraphEdges, memoryGraphTopologyKey, solveMemoryGraph } from '../../src/features/studio/lib/memory-graph-layout'
import { memoryGraphFixture } from '../fixtures/memory-graph'

const nodes = memoryGraphFixture.nodes
const edges = buildReadableMemoryGraphEdges(memoryGraphFixture.edges, new Set(nodes.map((n) => n.id)), nodes.length)
const points = solveMemoryGraph(memoryGraphTopologyKey(nodes.map((n) => n.id), edges), 3)
const relationTexts = new Set(edges.map((e) => e.type))
const onSelect = vi.fn()
let clock = 0
let nextFrame = 0
let reducedMotion = true
let width = 960
const frames = new Map<number, FrameRequestCallback>()
const resizeCallbacks: (() => void)[] = []
function canvasContext() {
  const drawnFrames: string[][] = []
  return {
    drawnFrames,
    clearRect: vi.fn(() => drawnFrames.push([])),
    fillText: vi.fn((text: string) => drawnFrames[drawnFrames.length - 1]?.push(text)),
    strokeText: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), setTransform: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), save: vi.fn(), restore: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: [...text].length * 7 })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  }
}
const contexts = new Map<HTMLCanvasElement, ReturnType<typeof canvasContext>>()
const latestText = (canvas: HTMLCanvasElement) => contexts.get(canvas)!.drawnFrames.at(-1) ?? []
function flush() {
  let passes = 0
  act(() => {
    while (frames.size && passes < 40) {
      passes += 1; clock += 20
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(clock))
    }
  })
  expect(frames.size).toBe(0)
  return passes
}
function tap(canvas: HTMLCanvasElement, x: number, y: number) {
  for (const type of ['pointerdown', 'pointerup']) {
    const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    fireEvent(canvas, event)
  }
}
function Harness({ active = true }: { active?: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={selectedId} onSelect={setSelectedId} active={active} />
}
beforeEach(() => {
  clock = 0; nextFrame = 0; reducedMotion = true; width = 960; frames.clear(); contexts.clear(); resizeCallbacks.length = 0; onSelect.mockClear()
  vi.spyOn(galaxyRender, 'prepareGalaxyGeometry')
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 640, width, height: 640, toJSON: () => ({}) }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, canvasContext())
    return contexts.get(this)! as unknown as CanvasRenderingContext2D
  })
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallbacks.push(callback) } observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  HTMLCanvasElement.prototype.hasPointerCapture = () => true
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('真实星系 Canvas 绘制契约', () => {
  it('默认远景实际绘制103个细小双层星核，关系线/名称/关系文字均不绘制', () => {
    render(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={null} onSelect={onSelect} active />)
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    expect(flush()).toBe(1)
    const ctx = contexts.get(canvas)!
    expect(ctx.arc).toHaveBeenCalledTimes(206)
    expect(ctx.moveTo).not.toHaveBeenCalled()
    expect(ctx.lineTo).not.toHaveBeenCalled()
    expect(ctx.stroke).not.toHaveBeenCalled()
    expect(ctx.fillText).not.toHaveBeenCalled()
    expect(ctx.fillRect).not.toHaveBeenCalled()
    expect(ctx.drawImage).toHaveBeenCalledTimes(207)
    const output = buildGalaxyScene(nodes, edges, points, DEFAULT_GALAXY_VIEW, width, 640, null, (text) => [...text].length * 7)
    const wings = [...contexts].filter(([asset]) => asset.width === 64 && asset.height === 64)
    expect(wings).toHaveLength(3)
    for (const [, asset] of wings) {
      const gradient = asset.createRadialGradient.mock.results[0].value
      const colors = gradient.addColorStop.mock.calls.map((call: [number, string]) => call[1])
      expect(colors.every((color: string) => color.length === 9 && Number.parseInt(color.slice(-2), 16) < 255)).toBe(true)
      const opacity = colors.map((color: string) => Number.parseInt(color.slice(-2), 16))
      expect(opacity[0]).toBeGreaterThan(0)
      expect(opacity.at(-1)).toBe(0)
      expect(opacity.every((alpha: number, i: number) => i === 0 || alpha < opacity[i - 1])).toBe(true)
      expect(colors.some((color: string) => color.slice(0, 7) === '#ffffff')).toBe(false)
    }
    output.nodes.forEach((node, i) => {
      const emission = ctx.drawImage.mock.calls[i + 1]
      expect(wings.some(([asset]) => asset === emission[0])).toBe(true)
      expect(emission[3]).toBeCloseTo(node.emissionRadius * 2)
      expect(Number(emission[3])).toBeLessThanOrEqual(node.coreRadius * 15)
    })
  })
  it('缩放后实际绘制完整145条曲线，深度分批保持星核遮挡且不恢复关系文字', () => {
    render(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={null} onSelect={onSelect} active />)
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    flush()
    const ctx = contexts.get(canvas)!
    ctx.arc.mockClear()
    fireEvent.wheel(canvas, { deltaY: -Math.log(1.3) / 0.001 }); flush()
    const output = buildGalaxyScene(nodes, edges, points, { ...DEFAULT_GALAXY_VIEW, zoom: 1.3 }, width, 640, null, (text) => [...text].length * 7)
    const primitives = galaxyDrawOrder(output)
    const nativeBatches = galaxyPaintOrder(output).filter((primitive) => primitive.kind === 'threads')
    const segmentCount = edges.length * GALAXY_CURVE_STEPS
    expect(ctx.moveTo.mock.calls.slice(0, segmentCount)).toEqual(nativeBatches.flatMap((batch) => batch.segments).map((segment) => [segment.from.x, segment.from.y]))
    expect(ctx.lineTo.mock.calls.slice(0, segmentCount)).toEqual(nativeBatches.flatMap((batch) => batch.segments).map((segment) => [segment.to.x, segment.to.y]))
    const styles = new Set(output.links.map((link) => [link.focused, link.internal, link.type === '同章出现'].join(':'))).size
    expect(nativeBatches.length).toBeLessThanOrEqual((nodes.length + 1) * styles)
    const threads = primitives.filter((p) => p.kind === 'thread')
    expect(new Set(threads.map((p) => p.link.id))).toEqual(new Set(edges.map((e) => e.id)))
    const actualOrder = [...ctx.moveTo.mock.invocationCallOrder.slice(0, segmentCount).map((order) => ({ kind: 'thread', order })), ...ctx.arc.mock.invocationCallOrder.filter((_, i) => i % 2 === 0).map((order) => ({ kind: 'star', order }))].sort((a, b) => a.order - b.order)
    expect(actualOrder.map((p) => p.kind)).toEqual(primitives.map((p) => p.kind))
    expect(latestText(canvas).some((text) => relationTexts.has(text))).toBe(false)
  })
  it('靠近后只绘制适合空间的名称；即使最大缩放也不绘制未选中的关系文字或黑色标签墙', () => {
    render(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={null} onSelect={onSelect} active />)
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    flush()
    fireEvent.wheel(canvas, { deltaY: -Math.log(2.4) / 0.001 }); flush()
    expect(latestText(canvas).length).toBeGreaterThan(0)
    expect(latestText(canvas).length).toBeLessThan(nodes.length)
    fireEvent.wheel(canvas, { deltaY: -10000 }); flush()
    expect(contexts.get(canvas)!.fillText.mock.calls.some(([text]) => relationTexts.has(text))).toBe(false)
    expect(contexts.get(canvas)!.fillRect).not.toHaveBeenCalled()
  })
  it('真实点击选中只绘制直接关系，取消立即清空，选择和模式访问不重置相机', () => {
    const view = render(<Harness />)
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    flush()
    fireEvent.wheel(canvas, { deltaY: -Math.log(2.4) / 0.001 }); flush()
    const projected = buildGalaxyScene(nodes, edges, points, { ...DEFAULT_GALAXY_VIEW, zoom: 2.4 }, width, 640, null, (text) => [...text].length * 7)
    const selected = [...projected.nodes].filter((node) => node.x > 30 && node.x < width - 30 && node.y > 30 && node.y < 610).sort((a, b) => a.depth - b.depth)[0]
    tap(canvas, selected.x, selected.y); flush()
    expect(screen.getByRole('button', { name: selected.label }).getAttribute('aria-pressed')).toBe('true')
    const incidentTypes = new Set(edges.filter((e) => e.source === selected.id || e.target === selected.id).map((e) => e.type))
    const actualRelations = latestText(canvas).filter((text) => relationTexts.has(text))
    expect(actualRelations.length).toBeGreaterThan(0)
    expect(actualRelations.every((text) => incidentTypes.has(text))).toBe(true)
    const ctx = contexts.get(canvas)!
    const ring = ctx.arc.mock.calls.find(([x, y, radius]) => Math.abs(Number(x) - selected.x) < 0.001 && Math.abs(Number(y) - selected.y) < 0.001 && Math.abs(Number(radius) - selected.coreRadius - 4.5) < 0.001)
    expect(ring).toBeTruthy()
    const allocations = contexts.size
    view.rerender(<Harness active={false} />); flush()
    ctx.arc.mockClear()
    view.rerender(<Harness />); flush()
    expect(contexts.size).toBe(allocations)
    expect(ctx.arc.mock.calls.some(([x, y]) => Math.abs(Number(x) - selected.x) < 0.001 && Math.abs(Number(y) - selected.y) < 0.001)).toBe(true)
    const blank = [{ x: 8, y: 8 }, { x: width - 8, y: 8 }, { x: 8, y: 632 }, { x: width - 8, y: 632 }, { x: width / 2, y: 8 }].find((point) => projected.nodes.every((node) => Math.hypot(node.x - point.x, node.y - point.y) > 30))
    expect(blank).toBeTruthy()
    tap(canvas, blank!.x, blank!.y); flush()
    expect(latestText(canvas).some((text) => relationTexts.has(text))).toBe(false)
  })
  it.each([0, 1, 2, 3])('375px 实际 Canvas 保留屏幕边缘 %s 的所选名称', (direction) => {
    width = 375
    const entities = nodes.slice(0, 5)
    const coordinates = [{ x: -100, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 0, y: -100, z: 0 }, { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }]
    const positions = new Map(entities.map((node, i) => [node.id, coordinates[i]]))
    const links = entities.slice(0, 4).map((node, i) => ({ ...edges[0], id: `edge-${i}`, source: entities[4].id, target: node.id, type: '同行' }))
    const base = buildGalaxyScene(entities, links, positions, DEFAULT_GALAXY_VIEW, width, 640, null, (text) => [...text].length * 7)
    const point = base.nodes[direction]
    const horizontal = direction < 2
    const middle = horizontal ? width / 2 : 320
    const coordinate = horizontal ? point.x : point.y
    const edge = direction % 2 === 0 ? 3 : middle * 2 - 3
    const zoom = (edge - middle) / (coordinate - middle)
    render(<MemoryGraphGalaxy nodes={entities} edges={links} points={positions} selectedId={point.id} onSelect={onSelect} active />)
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    flush(); fireEvent.wheel(canvas, { deltaY: -Math.log(zoom) / 0.001 }); flush()
    expect(latestText(canvas)).toContain(point.label)
  })
  it('缓存背景与星辉在选择/重绘中复用，只在实际尺寸变化时重建背景', () => {
    const view = render(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={null} onSelect={onSelect} active />)
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    flush()
    expect(contexts.size).toBe(5)
    expect(galaxyRender.prepareGalaxyGeometry).toHaveBeenCalledTimes(1)
    expect(contexts.get(canvas)!.createRadialGradient).not.toHaveBeenCalled()
    expect([...contexts.values()].some((ctx) => ctx.createRadialGradient.mock.calls.length > 100)).toBe(true)
    view.rerender(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={nodes[10].id} onSelect={onSelect} active />); flush()
    expect(contexts.size).toBe(5)
    expect(galaxyRender.prepareGalaxyGeometry).toHaveBeenCalledTimes(1)
    expect(contexts.get(canvas)!.createRadialGradient).not.toHaveBeenCalled()
    expect([...contexts.values()].some((ctx) => ctx.createRadialGradient.mock.calls.length > 100)).toBe(true)
    view.rerender(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={null} onSelect={onSelect} active />); flush()
    expect(contexts.size).toBe(5)
    width = 1100
    act(() => resizeCallbacks.forEach((callback) => callback())); flush()
    expect(contexts.size).toBe(6)
    expect(galaxyRender.prepareGalaxyGeometry).toHaveBeenCalledTimes(1)
    expect(contexts.get(canvas)!.fillText).toHaveBeenCalled()
  })
  it('淡入有界结束；reduced-motion单帧完成；隐藏、非活动和卸载后无绘制循环', () => {
    reducedMotion = false
    const view = render(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={null} onSelect={onSelect} active />)
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    flush()
    fireEvent.wheel(canvas, { deltaY: -Math.log(2.4) / 0.001 })
    expect(flush()).toBeGreaterThan(1)
    const count = contexts.get(canvas)!.clearRect.mock.calls.length
    clock += 10000; flush()
    expect(contexts.get(canvas)!.clearRect).toHaveBeenCalledTimes(count)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.wheel(canvas, { deltaY: 20 }); flush()
    expect(contexts.get(canvas)!.clearRect).toHaveBeenCalledTimes(count)
    hidden.mockReturnValue(false); fireEvent(document, new Event('visibilitychange')); flush()
    reducedMotion = true
    view.rerender(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={nodes[10].id} onSelect={onSelect} active />)
    expect(flush()).toBe(1)
    view.rerender(<MemoryGraphGalaxy nodes={nodes} edges={edges} points={points} selectedId={nodes[10].id} onSelect={onSelect} active={false} />)
    fireEvent.click(screen.getByRole('button', { name: '放大星系' })); expect(flush()).toBe(0)
    view.unmount(); expect(frames.size).toBe(0)
  })
})
