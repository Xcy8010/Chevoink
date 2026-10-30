import { routeMemoryGraph, solveMemoryGraph, type GraphPoint, type MemoryGraphRoute, type MemoryGraphRoutingEdge } from './memory-graph-layout'

export type MemoryGraphLayoutRequest = { key: string; topologyKey: string; dimensions: 2 | 3; routeKey: string }
export type MemoryGraphLayoutResult = { key: string; positions: Map<string, GraphPoint>; routes: Map<string, MemoryGraphRoute> }

// The same-origin UI supplies typed graph data; the finite geometry work stays off the UI thread.
self.onmessage = ({ data }: MessageEvent<MemoryGraphLayoutRequest>) => {
  const positions = solveMemoryGraph(data.topologyKey, data.dimensions)
  const routes = data.dimensions === 2 ? routeMemoryGraph(JSON.parse(data.routeKey) as MemoryGraphRoutingEdge[], positions) : new Map<string, MemoryGraphRoute>()
  self.postMessage({ key: data.key, positions, routes } satisfies MemoryGraphLayoutResult)
}
