import { useCallback, useEffect, useRef } from 'react'
import { updateNovelPlanFile } from '../api'
import { registerDesktopSave } from '@/lib/desktop-lifecycle'

/** Batches one document's latest edit; changing documents flushes the previous payload. */
export function usePlanSync() {
  const timer = useRef<number | null>(null)
  const pending = useRef<{ artifactId: string; title: string; content: string } | null>(null)
  const inflight = useRef(new Set<Promise<void>>())
  const documentWrites = useRef(new Map<string, Promise<void>>())
  const failed = useRef(new Map<string, unknown>())
  const flushPlanServerSync = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const payload = pending.current
    pending.current = null
    if (payload) {
      // Serialize a document's writes so a slow older request cannot overwrite a newer save.
      // Different documents remain independent; the existing debounce remains unchanged.
      const previous = documentWrites.current.get(payload.artifactId)
      const send = () => updateNovelPlanFile(payload.artifactId, { title: payload.title, content: payload.content })
      const request = (previous ? previous.then(send) : send()).then(() => {
        failed.current.delete(payload.artifactId)
      }).catch((error: unknown) => {
        failed.current.set(payload.artifactId, error)
        // Preserve the existing retry-on-next-edit behavior.
      }).finally(() => {
        inflight.current.delete(request)
        if (documentWrites.current.get(payload.artifactId) === request) documentWrites.current.delete(payload.artifactId)
      })
      documentWrites.current.set(payload.artifactId, request)
      inflight.current.add(request)
    }
  }, [])
  const schedulePlanServerSync = useCallback((artifactId: string, title: string, content: string) => {
    if (pending.current && pending.current.artifactId !== artifactId) flushPlanServerSync()
    pending.current = { artifactId, title, content }
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      flushPlanServerSync()
    }, 800)
  }, [flushPlanServerSync])
  const awaitPlanServerSync = useCallback(async () => {
    flushPlanServerSync()
    await Promise.all([...inflight.current])
    if (failed.current.size) throw failed.current.values().next().value
    if (pending.current || inflight.current.size) throw new Error('计划仍有新修改正在保存，请稍后再切换作品。')
  }, [flushPlanServerSync])
  useEffect(() => registerDesktopSave(async () => {
    flushPlanServerSync()
    await Promise.all([...inflight.current])
    return !pending.current && inflight.current.size === 0 && failed.current.size === 0
  }), [flushPlanServerSync])
  return { flushPlanServerSync, schedulePlanServerSync, awaitPlanServerSync }
}
