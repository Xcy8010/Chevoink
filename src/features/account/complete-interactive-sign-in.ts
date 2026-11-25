import type { QueryClient } from '@tanstack/react-query'

import { getSessionQueryScope, meQueryKey } from '@/app/session-query-cache'
import { hydrateReadingSync } from '@/features/home/reading-sync'
import { useShellStore } from '@/store/useShellStore'
import type { AuthSessionPayload, UserMePayload } from '../../../shared/contracts'

export function completeInteractiveSignIn(client: QueryClient, session: AuthSessionPayload) {
  const previousScope = getSessionQueryScope()
  const cached = client.getQueryState<UserMePayload>(meQueryKey)
  // Discard the guest request and any response belonging to a previous account
  // before a protected route can mount under the newly authenticated session.
  if (cached?.status !== 'success' || cached.data?.user?.id !== session.user.id) {
    client.removeQueries({ queryKey: meQueryKey, exact: true })
  }

  useShellStore.getState().setAuthenticated(session)
  const signedInScope = getSessionQueryScope()
  const sessionClient = client === previousScope.client ? signedInScope.client : client
  if (sessionClient === client) void client.invalidateQueries()
  void hydrateReadingSync().then(changed => {
    if (changed && getSessionQueryScope() === signedInScope) {
      void sessionClient.invalidateQueries({ queryKey: meQueryKey })
    }
  })
}
