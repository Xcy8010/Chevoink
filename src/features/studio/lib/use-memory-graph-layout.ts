import { useCallback, useEffect, useState } from 'react'
import type { MemoryGraphLayoutRequest, MemoryGraphLayoutResult } from './memory-graph.worker'

/** Keep the last geometry mounted while a replacement is solved, preserving each renderer's browsing state. */
export function useMemoryGraphLayout(topologyKey: string, routeKey: string, dimensions: 2 | 3, enabled: boolean, cache?: Map<number, MemoryGraphLayoutResult>) {
  const key = JSON.stringify([topologyKey, routeKey, dimensions])
  const [layout, setLayout] = useState<MemoryGraphLayoutResult | null>(() => {
    const saved = cache?.get(dimensions)
    return saved?.key === key ? saved : null
  })
  const [failureKey, setFailureKey] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const completedKey = layout?.key
  useEffect(() => {
    if (!enabled || completedKey === key) return
    let worker: Worker | undefined
    let cancelled = false
    const fail = () => { if (!cancelled) setFailureKey(key) }
    try {
      worker = new Worker(new URL('./memory-graph.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = ({ data }: MessageEvent<MemoryGraphLayoutResult>) => {
        if (!cancelled) { cache?.set(dimensions, data); setLayout(data); setFailureKey(null) }
      }
      worker.onerror = fail
      worker.onmessageerror = fail
      worker.postMessage({ key, topologyKey, routeKey, dimensions } satisfies MemoryGraphLayoutRequest)
    } catch {
      fail()
    }
    return () => {
      cancelled = true
      if (!worker) return
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
  }, [key, topologyKey, routeKey, dimensions, enabled, attempt, completedKey, cache])
  const retry = useCallback(() => { setFailureKey(null); setAttempt((value) => value + 1) }, [])
  return { layout, pending: enabled && completedKey !== key && failureKey !== key, failed: enabled && failureKey === key, retry }
}
