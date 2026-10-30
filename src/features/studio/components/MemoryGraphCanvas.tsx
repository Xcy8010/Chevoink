import { useId, useMemo, useState, type CSSProperties } from 'react'
import { Background, BackgroundVariant, BaseEdge, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { LoaderCircle, Network, Orbit, X } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import type { MemoryGraph, MemoryGraphNode } from '../../../../shared/contracts/index.js'
import { buildReadableMemoryGraphEdges, MEMORY_NODE_HEIGHT, MEMORY_NODE_WIDTH, memoryGraphNeighborhood, memoryGraphTopologyKey, memoryNodeColor, type MemoryGraphRoute } from '../lib/memory-graph-layout'
import { useMemoryGraphLayout } from '../lib/use-memory-graph-layout'
import MemoryGraphGalaxy from './MemoryGraphGalaxy'
import './memory-graph.css'

type FlowNode = Node<{ memory: MemoryGraphNode; onSelect: (id: string) => void; selected: boolean; dimmed: boolean }, 'memory'>
type FlowEdge = Edge<{ route: MemoryGraphRoute; text: string; hint: boolean; focused: boolean; dimmed: boolean }, 'memory'>

function MemoryNode({ data }: NodeProps<FlowNode>) {
  return <>
    <Handle type="target" position={Position.Left} />
    <button type="button" className="memory-entity" title={`${data.memory.label} · ${data.memory.type}`} aria-label={data.memory.label} aria-pressed={data.selected} onClick={() => data.onSelect(data.memory.id)}>
      <span className="memory-entity-dot" /><span>{data.memory.label}</span>
    </button>
    <Handle type="source" position={Position.Right} />
  </>
}

function MemoryRelationship({ id, data }: EdgeProps<FlowEdge>) {
  const arrowId = "memory-arrow-" + useId().replace(/:/g, '')
  if (!data) return null
  const { route, text, hint, focused, dimmed } = data
  const color = focused ? 'var(--text-primary)' : 'var(--text-tertiary)'
  const center = { x: route.label.x + route.label.width / 2, y: route.label.y + route.label.height / 2 }
  return <g className="memory-relationship" opacity={dimmed ? 0.1 : focused ? 1 : hint ? 0.3 : 0.65}>
    {!hint ? <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill={color} /></marker></defs> : null}
    <BaseEdge id={id} path={route.path} markerEnd={hint ? undefined : `url(#${arrowId})`} style={{ stroke: color, strokeWidth: focused ? 2 : hint ? 0.8 : 1.2 }} />
    {!hint ? <g className="memory-relationship-label">
      <title>{text}</title>
      {Math.hypot(center.x - route.anchor.x, center.y - route.anchor.y) > 18 ? <path d={`M ${route.anchor.x} ${route.anchor.y} L ${center.x} ${center.y}`} stroke={color} strokeWidth={0.6} strokeDasharray="3 3" fill="none" /> : null}
      <rect {...route.label} rx={5} fill="var(--surface-default)" stroke={focused ? 'var(--border-strong)' : 'none'} />
      <text x={center.x} y={center.y} textAnchor="middle" dominantBaseline="central" fill={color} fontSize={11} fontWeight={focused ? 600 : 400}>{text}</text>
    </g> : null}
  </g>
}
const nodeTypes = { memory: MemoryNode }
const edgeTypes = { memory: MemoryRelationship }

export default function MemoryGraphCanvas({ graph }: { graph: MemoryGraph }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'map' | 'galaxy'>('map')
  const [galaxyVisited, setGalaxyVisited] = useState(false)
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null
  const effectiveSelectedId = selected?.id ?? null
  const visibleIds = useMemo(() => new Set(graph.nodes.map((node) => node.id)), [graph.nodes])
  const readableEdges = useMemo(() => buildReadableMemoryGraphEdges(graph.edges, visibleIds, graph.nodes.length), [graph.edges, visibleIds, graph.nodes.length])
  // Topology keys remain equal across polling responses with identical entities and links.
  const topologyKey = memoryGraphTopologyKey(graph.nodes.map((node) => node.id), readableEdges)
  const routeKey = JSON.stringify(readableEdges.map(({ id, source, target, type }) => ({ id, source, target, type })))
  const mapLayout = useMemoryGraphLayout(topologyKey, routeKey, 2, mode === 'map')
  const galaxyLayout = useMemoryGraphLayout(topologyKey, '', 3, galaxyVisited && mode === 'galaxy')
  const mapPositions = mapLayout.layout?.positions
  const routes = mapLayout.layout?.routes
  const galaxyPositions = galaxyLayout.layout?.positions
  const currentLayout = mode === 'map' ? mapLayout : galaxyLayout
  const galaxyNodes = useMemo(() => graph.nodes.filter((node) => galaxyPositions?.has(node.id)), [graph.nodes, galaxyPositions])
  const galaxyEdges = useMemo(() => readableEdges.filter((edge) => galaxyPositions?.has(edge.source) && galaxyPositions.has(edge.target)), [readableEdges, galaxyPositions])
  const neighbors = useMemo(() => memoryGraphNeighborhood(effectiveSelectedId, readableEdges), [effectiveSelectedId, readableEdges])
  const nodes = useMemo<FlowNode[]>(() => graph.nodes.filter((memory) => mapPositions?.has(memory.id)).map((memory) => ({
    id: memory.id,
    type: 'memory',
    position: mapPositions!.get(memory.id)!,
    width: MEMORY_NODE_WIDTH,
    height: MEMORY_NODE_HEIGHT,
    initialWidth: MEMORY_NODE_WIDTH,
    initialHeight: MEMORY_NODE_HEIGHT,
    data: { memory, onSelect: setSelectedId, selected: memory.id === effectiveSelectedId, dimmed: effectiveSelectedId !== null && !neighbors.has(memory.id) },
    className: `memory-map-node${memory.id === effectiveSelectedId ? ' is-focused' : ''}${effectiveSelectedId !== null && !neighbors.has(memory.id) ? ' is-dimmed' : ''}`,
    style: { '--memory-node-color': memoryNodeColor(memory.type), width: MEMORY_NODE_WIDTH, height: MEMORY_NODE_HEIGHT } as CSSProperties,
    draggable: false,
    focusable: false,
    selectable: false,
  })), [graph.nodes, mapPositions, effectiveSelectedId, neighbors])
  const edges = useMemo<FlowEdge[]>(() => readableEdges.filter((edge) => routes?.has(edge.id) && mapPositions?.has(edge.source) && mapPositions.has(edge.target)).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'memory',
    data: { route: routes!.get(edge.id)!, text: edge.type, hint: edge.type === '同章出现', focused: edge.source === effectiveSelectedId || edge.target === effectiveSelectedId, dimmed: effectiveSelectedId !== null && edge.source !== effectiveSelectedId && edge.target !== effectiveSelectedId },
    selectable: false,
    focusable: false,
  })), [readableEdges, routes, mapPositions, effectiveSelectedId])
  const relations = selected ? readableEdges.filter((edge) => edge.source === selected.id || edge.target === selected.id) : []
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))

  return <div className={`memory-flow memory-graph relative h-full min-h-[300px] w-full overflow-hidden${mode === 'galaxy' ? ' is-galaxy' : ''}`}>
    <div className="memory-map-view" hidden={mode !== 'map'}>
      {mapLayout.layout ? <ReactFlow<FlowNode, FlowEdge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        fitView fitViewOptions={{ padding: 0.18, maxZoom: 1.15 }}
        minZoom={0.08} maxZoom={2.2} nodesDraggable={false} nodesConnectable={false}
        elementsSelectable={false} panOnDrag zoomOnScroll zoomOnPinch preventScrolling
        onPaneClick={() => setSelectedId(null)} proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} position="top-right" />
        <MiniMap pannable zoomable position="bottom-left" style={{ width: 160, height: 112 }} nodeStrokeWidth={0} nodeBorderRadius={5} ariaLabel="关系网缩略图" nodeColor={(node) => memoryNodeColor(String((node.data as { memory?: MemoryGraphNode }).memory?.type ?? ''))} nodeClassName={(node) => effectiveSelectedId && !neighbors.has(node.id) ? 'memory-minimap-dimmed' : ''} />
      </ReactFlow> : null}
    </div>
    {galaxyVisited ? <div className="memory-galaxy-view" hidden={mode !== 'galaxy'}>{galaxyPositions ? <MemoryGraphGalaxy nodes={galaxyNodes} edges={galaxyEdges} points={galaxyPositions} selectedId={effectiveSelectedId} onSelect={setSelectedId} active={mode === 'galaxy'} /> : null}</div> : null}
    {currentLayout.pending ? <div className="memory-graph-loading" role="status"><LoaderCircle size={16} className="animate-spin" />正在布局关系网…</div> : null}
    {currentLayout.failed ? <div className="memory-graph-loading" role="alert">关系网布局载入失败。<button type="button" onClick={currentLayout.retry}>重试</button></div> : null}
    <div className="memory-graph-controls memory-graph-modes" role="group" aria-label="关系网视图">
      <button type="button" title="关系图" aria-label="关系图视图" aria-pressed={mode === 'map'} onClick={() => setMode('map')}><Network size={17} /></button>
      <button type="button" title="三维星系" aria-label="三维星系视图" aria-pressed={mode === 'galaxy'} onClick={() => { setGalaxyVisited(true); setMode('galaxy') }}><Orbit size={18} /></button>
    </div>
    <div className="memory-graph-legend" aria-label="实体颜色"><span><i style={{ background: memoryNodeColor('character') }} />人物</span><span><i style={{ background: memoryNodeColor('item') }} />物品</span><span><i style={{ background: memoryNodeColor('location') }} />其他实体</span></div>
    {selected ? <aside className="memory-graph-detail" aria-label="实体详情">
      <div className="flex items-start gap-2">
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: memoryNodeColor(selected.type) }} />
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium text-[var(--text-primary)]">{selected.label}</p><p className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">{selected.type}</p></div>
        <button type="button" onClick={() => setSelectedId(null)} className="memory-detail-close" aria-label="关闭实体详情" title="关闭实体详情"><X size={15} /></button>
      </div>
      {selected.description ? <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-secondary)]">{selected.description}</p> : null}
      {selected.aliases.length ? <p className="mt-2 break-words text-[10px] leading-5 text-[var(--text-tertiary)]">别名：{selected.aliases.join('、')}</p> : null}
      {relations.length ? <ul className="memory-detail-relations" aria-label="直接关系">{relations.map((edge) => {
        const outgoing = edge.source === selected.id
        const other = nodeById.get(outgoing ? edge.target : edge.source)
        return <li key={edge.id}><button type="button" onClick={() => setSelectedId(other!.id)}><span className="memory-relation-direction" aria-label={outgoing ? '指向' : '来自'}>{outgoing ? '→' : '←'}</span><span><strong>{other?.label}</strong><span>{edge.type}{edge.state ? ` · ${edge.state}` : ''}{edge.occurrences > 1 ? ` ×${edge.occurrences}` : ''}</span></span></button></li>
      })}</ul> : null}
    </aside> : null}
  </div>
}
