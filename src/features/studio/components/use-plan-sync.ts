import { useCallback, useEffect, useRef } from 'react'
import { updateNovelPlanFile } from '../api'
import type { NovelPlanFileItem } from '../api'
import type { PlanMetadataPatch } from '../../../../shared/contracts/novel-plans'
import { registerDesktopSave } from '@/lib/desktop-lifecycle'

type PlanSavePayload = { artifactId: string; title: string; content?: string; expectedPlanHash?: string; novelId?: string }
type PlanSyncFeedback = (state: 'saving' | 'saved' | 'error', message: string, novelId?: string) => void

/** Batches one document's latest edit; changing documents flushes the previous payload. */
export function usePlanSync(onSaved?: (item: NovelPlanFileItem, novelId?: string, savedContent?: string) => void, onFeedback?: PlanSyncFeedback) {
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  const onFeedbackRef = useRef(onFeedback)
  onFeedbackRef.current = onFeedback
  const versions = useRef(new Map<string, { hash: string; bases: Set<string> }>())
  const timer = useRef<number | null>(null)
  const pending = useRef<PlanSavePayload | null>(null)
  const inflight = useRef(new Set<Promise<void>>())
  const documentWrites = useRef(new Map<string, Promise<void>>())
  const failed = useRef(new Map<string, { error: unknown; payload: PlanSavePayload }>())
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
      let sentHash: string | undefined
      const send = () => {
        onFeedbackRef.current?.('saving', '正在保存计划…', payload.novelId)
        const version = versions.current.get(payload.artifactId)
        sentHash = version && payload.expectedPlanHash && version.bases.has(payload.expectedPlanHash) ? version.hash : payload.expectedPlanHash
        return updateNovelPlanFile(payload.artifactId, { title: payload.title, ...(payload.content !== undefined ? { content: payload.content, ...(sentHash ? { expectedPlanHash: sentHash } : {}) } : {}) })
      }
      const request = (previous ? previous.then(send) : send()).then((item) => {
        if (item?.planHash) {
          const version = versions.current.get(payload.artifactId)
          const bases = version && sentHash === version.hash ? version.bases : new Set<string>()
          if (sentHash) bases.add(sentHash)
          bases.add(item.planHash)
          versions.current.set(payload.artifactId, { hash: item.planHash, bases })
        }
        if (item) onSavedRef.current?.(item, payload.novelId, payload.content)
        failed.current.delete(payload.artifactId)
        const remainingFailure = [...failed.current.values()].find(failure => failure.payload.novelId === payload.novelId)
        if (!remainingFailure) onFeedbackRef.current?.('saved', '计划已保存。', payload.novelId)
      }).catch((error: unknown) => {
        failed.current.set(payload.artifactId, { error, payload })
        onFeedbackRef.current?.('error', error instanceof Error ? error.message : '计划保存失败，修改仍保留在编辑区。', payload.novelId)
        // Keep the failed text for a later edit or rename; never retry a conflict automatically.
      }).finally(() => {
        inflight.current.delete(request)
        if (documentWrites.current.get(payload.artifactId) === request) documentWrites.current.delete(payload.artifactId)
      })
      documentWrites.current.set(payload.artifactId, request)
      inflight.current.add(request)
    }
  }, [])
  const schedulePlanServerSync = useCallback((artifactId: string, title: string, content?: string, expectedPlanHash?: string, novelId?: string) => {
    if (pending.current && pending.current.artifactId !== artifactId) flushPlanServerSync()
    const previous = pending.current?.artifactId === artifactId ? pending.current : failed.current.get(artifactId)?.payload
    pending.current = { artifactId, title, content: content ?? previous?.content, expectedPlanHash: expectedPlanHash ?? previous?.expectedPlanHash, novelId }
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      flushPlanServerSync()
    }, 800)
  }, [flushPlanServerSync])
  const awaitPlanServerSync = useCallback(async () => {
    flushPlanServerSync()
    await Promise.all([...inflight.current])
    if (failed.current.size) throw failed.current.values().next().value?.error
    if (pending.current || inflight.current.size) throw new Error('计划仍有新修改正在保存，请稍后再切换作品。')
  }, [flushPlanServerSync])
  const savePlanMetadata = useCallback(async (artifactId: string, patch: PlanMetadataPatch & { title?: string }, novelId?: string) => {
    await awaitPlanServerSync()
    const version = versions.current.get(artifactId)
    const expectedPlanHash = version && patch.expectedPlanHash && version.bases.has(patch.expectedPlanHash) ? version.hash : patch.expectedPlanHash
    const request = updateNovelPlanFile(artifactId, { ...patch, expectedPlanHash }).then(item => {
      const bases = version && expectedPlanHash === version.hash ? version.bases : new Set<string>()
      if (expectedPlanHash) bases.add(expectedPlanHash)
      bases.add(item.planHash)
      versions.current.set(artifactId, { hash: item.planHash, bases })
      onSavedRef.current?.(item, novelId)
      return item
    })
    const tracked = request.then(() => {}, () => {}).finally(() => {
      inflight.current.delete(tracked)
      if (documentWrites.current.get(artifactId) === tracked) documentWrites.current.delete(artifactId)
    })
    inflight.current.add(tracked)
    documentWrites.current.set(artifactId, tracked)
    return request
  }, [awaitPlanServerSync])
  useEffect(() => registerDesktopSave(async () => {
    flushPlanServerSync()
    await Promise.all([...inflight.current])
    return !pending.current && inflight.current.size === 0 && failed.current.size === 0
  }), [flushPlanServerSync])
  return { flushPlanServerSync, schedulePlanServerSync, awaitPlanServerSync, savePlanMetadata }
}
