import { useQueryClient } from '@tanstack/react-query'

import { useShellStore } from '@/store/useShellStore'
import type { AuthTokenPair, User, UserMePayload } from '../../../shared/contracts'

export function useUpdateAccountSession() {
  const queryClient = useQueryClient()
  return (user: User, tokens?: AuthTokenPair) => {
    const shell = useShellStore.getState()
    if (shell.sessionUser?.id !== user.id) return false
    const payload = { user, unreadMessageCount: shell.unreadMessageCount, unreadNotificationCount: shell.unreadNotificationCount }
    if (tokens) shell.setAuthenticated({ ...payload, tokens })
    else shell.syncSessionUser(payload)
    queryClient.setQueryData<UserMePayload>(['community', 'me'], previous => previous?.user?.id === user.id ? { ...previous, user } : previous)
    return true
  }
}
