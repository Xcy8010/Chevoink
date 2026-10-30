import { useCallback, useEffect, useState } from 'react'
import type { MemoryGraphLayoutRequest, MemoryGraphLayoutResult } from './memory-graph.worker'

/** Keep the last geometry mounted while a replacement is solved, preserving each renderer's browsing state. */
export function useMemoryGraphLayout(topologyKey: string, routeKey: string, dimensions: 2 | 3, enabled: boolean) {
  const key = JSON.stringify([topologyKey, routeKey, dimensions])
  const [layout, setLayout] = useState<MemoryGraphLayoutResult | null>(null)
  const [failureKey, setFailureKey] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const completedKey = layout?.key
  useEffect(() => {
    if (!enabled || completedKey === key) return
    const worker = new Worker(new URL('./memory-graph.worker.ts', import.meta.url), { type: 'module' })
    let cancelled = false
    worker.onmessage = ({ data }: MessageEvent<MemoryGraphLayoutResult>) => {
      if (!cancelled) { setLayout(data); setFailureKey(null) }
    }
    worker.onerror = () => { if (!cancelled) setFailureKey(key) }
    worker.postMessage({ key, topologyKey, routeKey, dimensions } satisfies MemoryGraphLayoutRequest)
    return () => {
      cancelled = true
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
  }, [key, topologyKey, routeKey, dimensions, enabled, attempt, completedKey])
  const retry = useCallback(() => { setFailureKey(null); setAttempt((value) => value + 1) }, [])
  return { layout, pending: enabled && completedKey !== key && failureKey !== key, failed: enabled && failureKey === key, retry }
}
