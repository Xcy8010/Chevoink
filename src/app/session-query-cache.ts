import { QueryClient } from '@tanstack/react-query'

import { useShellStore } from '@/store/useShellStore'
import type { UserMePayload } from '../../shared/contracts'

export const meQueryKey = ['community', 'me'] as const

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 30_000,
      },
    },
  })
}

let scope = { generation: 0, client: createQueryClient() }

export function getSessionQueryScope() {
  return scope
}

useShellStore.subscribe((current, previous) => {
  const viewerId = current.sessionUser?.id
  if (viewerId === previous.sessionUser?.id) return

  const { client, generation } = scope
  const nextClient = createQueryClient()
  const me = client.getQueryState<UserMePayload>(meQueryKey)
  // Reuse the just-verified bootstrap response for this owner.
  if (viewerId && me?.status === 'success' && me.data?.user?.id === viewerId) {
    nextClient.setQueryData(meQueryKey, me.data, { updatedAt: me.dataUpdatedAt })
  }
  // Rotate synchronously, including when React batches multiple identity changes.
  // Old requests and callbacks can only reach the retired client.
  scope = { generation: generation + 1, client: nextClient }
  client.clear()
})
