import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import { useShellStore } from '@/store/useShellStore'
import type {
  AnnouncementInbox,
  ReadAnnouncementsRequest,
  ReadAnnouncementsResult,
} from '../../../shared/contracts/site-content'

const endpoint = '/api/site-content/announcements'
const inboxKey = ['site-content', 'announcement-inbox'] as const
const announcementChannel = 'chevoink-announcements'
const refreshInterval = 15_000

function refreshAnnouncementQueries(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: inboxKey }, { cancelRefetch: false }),
    client.invalidateQueries({ queryKey: ['site-content', 'public'] }, { cancelRefetch: false }),
  ])
}

export function refreshPublishedAnnouncements(client: QueryClient) {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(announcementChannel)
    channel.postMessage('changed')
    channel.close()
  }
  return refreshAnnouncementQueries(client)
}

export function useAnnouncementInbox(enabled = true, includeGuest = false) {
  const authStatus = useShellStore(state => state.authStatus)
  const viewerId = useShellStore(state => state.authStatus === 'authenticated' ? state.sessionUser?.id ?? null : null)
  const queryKey = [...inboxKey, viewerId] as const
  const client = useQueryClient()
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(announcementChannel)
    channel.onmessage = event => {
      if (event.data === 'changed') void refreshAnnouncementQueries(client)
    }
    return () => channel.close()
  }, [client, enabled])
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const inbox = await requestJson<AnnouncementInbox>(endpoint, { signal, cache: 'no-store' })
      if (inbox.viewerId !== viewerId) throw new Error('登录状态已变更，请刷新后重试。')
      return inbox
    },
    enabled: enabled && (authStatus === 'authenticated' || (includeGuest && authStatus === 'guest')),
    staleTime: refreshInterval,
    refetchOnWindowFocus: 'always',
    refetchInterval: ({ state }) => {
      const data = state.data
      if (!data?.nextBoundaryAt) return refreshInterval
      const remaining = Date.parse(data.nextBoundaryAt) - Date.parse(data.serverNow) - (Date.now() - state.dataUpdatedAt)
      return Math.max(250, Math.min(refreshInterval, remaining + 100))
    },
  })
  const read = useMutation({
    mutationFn: (input: ReadAnnouncementsRequest) => requestJson<ReadAnnouncementsResult>(endpoint + '/read', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    onSuccess: async ({ readVersionIds, readNotificationIds }, { viewerId: owner }) => {
      const ownerKey = [...inboxKey, owner] as const
      await client.cancelQueries({ queryKey: ownerKey })
      const ids = new Set(readVersionIds)
      const privateIds = new Set(readNotificationIds)
      client.setQueryData<AnnouncementInbox>(ownerKey, current => current && ({
        ...current,
        items: current.items.map(item => ids.has(item.versionId) ? { ...item, unread: false } : item),
        ...(current.personalItems && {
          personalItems: current.personalItems.map(item => privateIds.has(item.id) ? { ...item, unread: false } : item),
        }),
      }))
      await client.invalidateQueries({ queryKey: ownerKey })
    },
  })
  return { query, read, viewerId }
}
