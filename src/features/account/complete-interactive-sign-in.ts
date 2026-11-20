import type { QueryClient } from '@tanstack/react-query'

import { hydrateReadingSync } from '@/features/home/reading-sync'
import { useShellStore } from '@/store/useShellStore'
import type { AuthSessionPayload, UserMePayload } from '../../../shared/contracts'

const meKey = ['community', 'me'] as const

export function completeInteractiveSignIn(client: QueryClient, session: AuthSessionPayload) {
  const cached = client.getQueryState<UserMePayload>(meKey)
  // Discard the guest request and any response belonging to a previous account
  // before a protected route can mount under the newly authenticated session.
  if (cached?.status !== 'success' || cached.data?.user?.id !== session.user.id) {
    client.removeQueries({ queryKey: meKey, exact: true })
  }

  useShellStore.getState().setAuthenticated(session)
  void client.invalidateQueries()
  void hydrateReadingSync().then(changed => {
    if (changed && useShellStore.getState().sessionUser?.id === session.user.id) {
      void client.invalidateQueries({ queryKey: meKey })
    }
  })
}
