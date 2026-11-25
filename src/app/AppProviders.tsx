import { PropsWithChildren, useEffect, useLayoutEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

import { ACCOUNT_REQUIREMENT_EVENT, ApiClientError, requestJson } from '@/app/api-client'
import { useLiveConfiguration } from './live-configuration'
import { requestSessionSignIn } from './session-activity'
import { getSessionQueryScope, meQueryKey } from './session-query-cache'
import { DEVICE_SELECTION_KEY, readDeviceSelection, selectedDevice } from '@/lib/auth-token'
import { DeviceProvider } from '@/components/layout/DeviceProvider'
import { ToastProvider } from '@/components/ui/Toast'
import UpdateBanner from '@/components/ui/UpdateBanner'
import { hydrateReadingSync } from '@/features/home/reading-sync'
import { restoreNativeSystemBarsToTheme } from '@/lib/native-app'
import { useShellStore } from '@/store/useShellStore'
import type { UserMePayload } from '../../shared/contracts'

export default function AppProviders({ children }: PropsWithChildren) {
  const theme = useShellStore((state) => state.theme)
  const studioAppearance = useShellStore((state) => state.studioAppearance)
  const authStatus = useShellStore((state) => state.authStatus)
  const viewerId = useShellStore((state) => state.sessionUser?.id ?? null)
  const { client: queryClient, generation } = useShellStore(getSessionQueryScope)
  useLiveConfiguration(queryClient, authStatus, viewerId)
  const setSessionChecking = useShellStore((state) => state.setSessionChecking)
  const setSessionUnavailable = useShellStore((state) => state.setSessionUnavailable)
  const setGuest = useShellStore((state) => state.setGuest)
  const syncSessionUser = useShellStore((state) => state.syncSessionUser)

  useLayoutEffect(() => {
    if (authStatus !== 'checking') document.getElementById('app-loading')?.remove()
  }, [authStatus])

  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(theme)
    // 读取当前页面实际配色，同步 APP 系统栏与浏览器 theme-color。
    restoreNativeSystemBarsToTheme()
  }, [theme])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.studioReducedMotion = studioAppearance.reducedMotion ? 'true' : 'false'
    root.style.setProperty(
      '--studio-body-font',
      studioAppearance.bodyFont === 'serif'
        ? '"Noto Serif SC", "Songti SC", SimSun, serif'
        : '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    )
    root.style.setProperty('--studio-editor-font-size', `${studioAppearance.fontSize}px`)
    root.style.setProperty('--studio-editor-line-height', String(studioAppearance.lineHeight))
    root.style.setProperty('--studio-editor-max-width', `${studioAppearance.contentWidth}px`)
  }, [studioAppearance])

  useEffect(() => {
    let disposed = false
    let refreshingRequirements = false

    async function bootstrapShellSession(requirementsOnly = false, canRetrySelection = true) {
      const requestScope = getSessionQueryScope()
      const { client } = requestScope
      const { authTokens } = useShellStore.getState()
      const selection = selectedDevice()
      const isCurrentSession = () =>
        !disposed && getSessionQueryScope() === requestScope && useShellStore.getState().authTokens === authTokens
      function selectionChanged(confirmedId?: string) {
        const selected = selectedDevice()
        if (selected === selection || (selected && selected === confirmedId)) return false
        if (!requirementsOnly) {
          client.removeQueries({ queryKey: meQueryKey, exact: true })
          if (canRetrySelection) void bootstrapShellSession(false, false)
          else setSessionUnavailable()
        }
        return true
      }
      if (!requirementsOnly) setSessionChecking()

      try {
        // 经 react-query 缓存拉取：与页面级 ['community','me'] 查询共享同一请求/缓存，避免首屏重复请求 /api/users/me
        const payload = await client.fetchQuery({
          queryKey: meQueryKey,
          queryFn: () => requestJson<UserMePayload>('/api/users/me'),
          // Share in-flight requests with the route, but always verify this login at open.
          staleTime: 0,
          retry: false,
        })

        if (isCurrentSession()) {
          if (selectionChanged(payload.deviceSessionId)) return
          if (!payload.user) {
            setGuest()
            return
          }

          syncSessionUser({
            user: payload.user,
            deviceSessionId: payload.deviceSessionId,
            unreadMessageCount: payload.unreadMessageCount ?? 0,
            unreadNotificationCount: payload.unreadNotificationCount ?? 0,
          })

          // 登录后水合书架/阅读进度：拉取云端并合并本地，变更后刷新 /me 让书架列表重算
          if (!requirementsOnly) {
            const verifiedScope = getSessionQueryScope()
            void hydrateReadingSync().then((changed) => {
              if (changed && !disposed && getSessionQueryScope() === verifiedScope) {
                void verifiedScope.client.invalidateQueries({ queryKey: meQueryKey })
              }
            })
          }
        }
      } catch (error) {
        if (!isCurrentSession() || requirementsOnly) {
          return
        }
        if (selectionChanged()) return

        if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
          const previous = readDeviceSelection()?.userId ?? useShellStore.getState().lastVerifiedUserId
          if (error.status === 401 && (previous || error.code === 'AUTH_SESSION_IDLE')) {
            requestSessionSignIn()
            return
          }
          setGuest()
          return
        }

        setSessionUnavailable()
      }
    }

    function refreshAccountRequirements() {
      if (refreshingRequirements || useShellStore.getState().authStatus !== 'authenticated') return
      refreshingRequirements = true
      void bootstrapShellSession(true).finally(() => { refreshingRequirements = false })
    }

    function onDeviceSelection(event: StorageEvent) {
      if (event.key !== DEVICE_SELECTION_KEY) return
      const current = useShellStore.getState()
      if (current.authStatus === 'authenticated' && current.deviceSessionId && current.deviceSessionId !== selectedDevice()) {
        requestSessionSignIn()
      }
    }

    void bootstrapShellSession()
    window.addEventListener(ACCOUNT_REQUIREMENT_EVENT, refreshAccountRequirements)
    window.addEventListener('storage', onDeviceSelection)

    return () => {
      disposed = true
      window.removeEventListener(ACCOUNT_REQUIREMENT_EVENT, refreshAccountRequirements)
      window.removeEventListener('storage', onDeviceSelection)
    }
  }, [setGuest, setSessionChecking, setSessionUnavailable, syncSessionUser])

  return (
    <DeviceProvider>
      <ToastProvider>
        <QueryClientProvider key={generation} client={queryClient}>
          {children}
        </QueryClientProvider>
        <UpdateBanner />
      </ToastProvider>
    </DeviceProvider>
  )
}
