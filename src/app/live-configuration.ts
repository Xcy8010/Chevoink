import { useEffect } from 'react'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { buildApiUrl } from './api-base'

const announcementKeys = [['site-content', 'announcement-inbox'], ['site-content', 'public']] as const
const modelKeys = [['credits', 'summary'], ['credits', 'usage'], ['ai', 'public-config'], ['admin', 'models']] as const
type ConfigurationTopic = 'announcements' | 'models' | 'all'
const pendingRefresh = new WeakMap<QueryClient, { keys: Set<QueryKey>; done: Promise<void> }>()

/** A single save can arrive by server event, browser broadcast and mutation response. */
export function refreshConfigurationQueries(client: QueryClient, topic: ConfigurationTopic) {
  const keys = topic === 'announcements' ? announcementKeys : topic === 'models' ? modelKeys : [...announcementKeys, ...modelKeys]
  const pending = pendingRefresh.get(client)
  if (pending) {
    keys.forEach(key => pending.keys.add(key))
    return pending.done
  }
  const batch = new Set<QueryKey>(keys)
  const done = new Promise<void>(resolve => window.setTimeout(resolve, 50)).then(async () => {
    pendingRefresh.delete(client)
    await Promise.all([...batch].map(async queryKey => {
      await client.cancelQueries({ queryKey, predicate: query => query.state.fetchStatus === 'fetching' && query.state.data === undefined })
      await client.invalidateQueries({ queryKey })
    }))
  })
  pendingRefresh.set(client, { keys: batch, done })
  return done
}

export function useLiveConfiguration(client: QueryClient, authStatus: string, viewerId: string | null) {
  useEffect(() => {
    if (authStatus !== 'guest' && authStatus !== 'authenticated' || typeof EventSource === 'undefined') return
    let source: EventSource | undefined
    let retryNeeded = false

    function refresh(topic: ConfigurationTopic) {
      if (document.visibilityState !== 'hidden') void refreshConfigurationQueries(client, topic)
    }

    function updateConnection() {
      if (document.visibilityState === 'hidden') {
        retryNeeded = true
        source?.close()
        source = undefined
      } else if (!source) {
        source = new EventSource(buildApiUrl('/api/site-content/updates'), { withCredentials: true })
        source.addEventListener('announcements', () => refresh('announcements'))
        source.addEventListener('models', () => refresh('models'))
        source.onopen = () => {
          if (retryNeeded) refresh('all')
          retryNeeded = true
        }
        source.onerror = () => { retryNeeded = true }
      }
    }

    updateConnection()
    document.addEventListener('visibilitychange', updateConnection)
    return () => {
      source?.close()
      document.removeEventListener('visibilitychange', updateConnection)
    }
  }, [authStatus, client, viewerId])
}

type ModelPriceSchedule = {
  freePromotion?: { endsAt: string } | null
  activity?: { nextSwitchAt: string | null; asOf: string } | null
}

export function nextModelPriceRefreshAt(models: readonly ModelPriceSchedule[], updatedAt: number, serverAsOf?: string) {
  let next = Infinity
  for (const model of models) {
    const asOf = Date.parse(serverAsOf ?? model.activity?.asOf ?? '')
    const snapshotTime = Number.isFinite(asOf) ? asOf : updatedAt
    for (const boundary of [model.freePromotion?.endsAt, model.activity?.nextSwitchAt]) {
      const time = Date.parse(boundary ?? '')
      if (time > snapshotTime) next = Math.min(next, updatedAt + time - snapshotTime)
    }
  }
  return Number.isFinite(next) ? next + 50 : undefined
}

/** Schedule one refresh of the shared query at its earliest price boundary. */
export function useModelPriceRefresh(client: QueryClient, queryKey: QueryKey, dueAt: number | undefined) {
  useEffect(() => {
    if (dueAt === undefined) return
    const deadline = dueAt
    let timer: number
    let refreshed = false
    function refreshWhenDue() {
      window.clearTimeout(timer)
      if (refreshed || document.visibilityState === 'hidden') return
      const remaining = deadline - Date.now()
      if (remaining > 0) timer = window.setTimeout(refreshWhenDue, Math.min(remaining, 2_147_483_647))
      else {
        refreshed = true
        void client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false })
      }
    }
    refreshWhenDue()
    document.addEventListener('visibilitychange', refreshWhenDue)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', refreshWhenDue)
    }
  }, [client, dueAt, queryKey])
}
