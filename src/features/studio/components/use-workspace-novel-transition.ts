import { useCallback, useEffect, useRef } from 'react'

/** One outgoing save, newest navigation intent, fenced by the actual workspace owner. */
export function useWorkspaceNovelTransition<Owner>({ owner, novelId, save, navigate, onError }: {
  owner: Owner; novelId: string; save: () => Promise<void>
  navigate: (novelId: string, sessionId?: string) => void; onError: (error: unknown) => void
}) {
  const latest = useRef({ owner, novelId, save, navigate, onError })
  latest.current = { owner, novelId, save, navigate, onError }
  const intent = useRef(0), saving = useRef<{ owner: Owner; promise: Promise<void> } | null>(null)
  useEffect(() => () => { intent.current++ }, [])
  return useCallback(async (target: string, sessionId?: string) => {
    const revision = ++intent.current, current = latest.current
    // Selecting A while A -> B is saving cancels B, including before any await.
    if (target === current.novelId && !sessionId) return
    try {
      if (saving.current?.owner !== current.owner) {
        const promise = Promise.resolve().then(() => {
          if (latest.current.owner !== current.owner) throw new Error('作品或任务已经切换。')
          return current.save()
        })
        const flight = { owner: current.owner, promise }
        saving.current = flight
        void promise.finally(() => { if (saving.current === flight) saving.current = null }).catch(() => {})
      }
      await saving.current.promise
      if (revision !== intent.current || latest.current.owner !== current.owner) return
      latest.current.navigate(target, sessionId)
    } catch (error) {
      if (revision === intent.current && latest.current.owner === current.owner) latest.current.onError(error)
    }
  }, [])
}
