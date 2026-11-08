import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import { useShellStore } from '@/store/useShellStore'
import type {
  AnnouncementInbox,
  ReadAnnouncementsRequest,
  ReadAnnouncementsResult,
} from '../../../shared/contracts/site-content'

const endpoint = '/api/site-content/announcements'

export function useAnnouncementInbox(enabled = true, includeGuest = false) {
  const authStatus = useShellStore(state => state.authStatus)
  const viewerId = useShellStore(state => state.authStatus === 'authenticated' ? state.sessionUser?.id ?? null : null)
  const queryKey = ['site-content', 'announcement-inbox', viewerId] as const
  const client = useQueryClient()
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const inbox = await requestJson<AnnouncementInbox>(endpoint)
      if (inbox.viewerId !== viewerId) throw new Error('登录状态已变更，请刷新后重试。')
      return inbox
    },
    enabled: enabled && (authStatus === 'authenticated' || (includeGuest && authStatus === 'guest')),
    staleTime: 15_000,
    refetchInterval: ({ state }) => {
      const data = state.data
      if (!data?.nextBoundaryAt) return 60_000
      const remaining = Date.parse(data.nextBoundaryAt) - Date.parse(data.serverNow) - (Date.now() - state.dataUpdatedAt)
      return Math.max(250, Math.min(60_000, remaining + 100))
    },
  })
  const read = useMutation({
    mutationFn: (input: ReadAnnouncementsRequest) => requestJson<ReadAnnouncementsResult>(endpoint + '/read', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    onSuccess: async ({ readVersionIds }, { viewerId: owner }) => {
      const ownerKey = ['site-content', 'announcement-inbox', owner] as const
      await client.cancelQueries({ queryKey: ownerKey })
      const ids = new Set(readVersionIds)
      client.setQueryData<AnnouncementInbox>(ownerKey, current => current && ({
        ...current,
        items: current.items.map(item => ids.has(item.versionId) ? { ...item, unread: false } : item),
      }))
      await client.invalidateQueries({ queryKey: ownerKey })
    },
  })
  return { query, read, viewerId }
}
