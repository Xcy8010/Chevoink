import { PropsWithChildren, useEffect, useLayoutEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ACCOUNT_REQUIREMENT_EVENT, ApiClientError, requestJson } from '@/app/api-client'
import { useLiveConfiguration } from './live-configuration'
import { DeviceProvider } from '@/components/layout/DeviceProvider'
import { ToastProvider } from '@/components/ui/Toast'
import UpdateBanner from '@/components/ui/UpdateBanner'
import { hydrateReadingSync } from '@/features/home/reading-sync'
import { restoreNativeSystemBarsToTheme } from '@/lib/native-app'
import { useShellStore } from '@/store/useShellStore'
import type { UserMePayload } from '../../shared/contracts'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
})

export default function AppProviders({ children }: PropsWithChildren) {
  const theme = useShellStore((state) => state.theme)
  const studioAppearance = useShellStore((state) => state.studioAppearance)
  const authStatus = useShellStore((state) => state.authStatus)
  const viewerId = useShellStore((state) => state.sessionUser?.id ?? null)
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

    async function bootstrapShellSession(requirementsOnly = false) {
      const owner = useShellStore.getState().sessionUser?.id
      if (!requirementsOnly) setSessionChecking()

      try {
        // 经 react-query 缓存拉取：与页面级 ['community','me'] 查询共享同一请求/缓存，避免首屏重复请求 /api/users/me
        const payload = await queryClient.fetchQuery({
          queryKey: ['community', 'me'],
          queryFn: () => requestJson<UserMePayload>('/api/users/me'),
          staleTime: requirementsOnly ? 0 : 30_000,
          retry: false,
        })

        if (!disposed && (!requirementsOnly || useShellStore.getState().sessionUser?.id === owner)) {
          if (!payload.user) {
            setGuest()
            return
          }

          syncSessionUser({
            user: payload.user,
            unreadMessageCount: payload.unreadMessageCount ?? 0,
            unreadNotificationCount: payload.unreadNotificationCount ?? 0,
          })

          // 登录后水合书架/阅读进度：拉取云端并合并本地，变更后刷新 /me 让书架列表重算
          if (!requirementsOnly) {
            void hydrateReadingSync().then((changed) => {
              if (changed && !disposed) {
                void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
              }
            })
          }
        }
      } catch (error) {
        if (disposed || requirementsOnly) {
          return
        }

        if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
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

    void bootstrapShellSession()
    window.addEventListener(ACCOUNT_REQUIREMENT_EVENT, refreshAccountRequirements)

    return () => {
      disposed = true
      window.removeEventListener(ACCOUNT_REQUIREMENT_EVENT, refreshAccountRequirements)
    }
  }, [setGuest, setSessionChecking, setSessionUnavailable, syncSessionUser])

  return (
    <QueryClientProvider client={queryClient}>
      <DeviceProvider>
        <ToastProvider>
          {children}
          <UpdateBanner />
        </ToastProvider>
      </DeviceProvider>
    </QueryClientProvider>
  )
}
