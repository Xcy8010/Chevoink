import { PropsWithChildren, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ApiClientError, requestJson } from '@/app/api-client'
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
  const setSessionChecking = useShellStore((state) => state.setSessionChecking)
  const setSessionUnavailable = useShellStore((state) => state.setSessionUnavailable)
  const setGuest = useShellStore((state) => state.setGuest)
  const syncSessionUser = useShellStore((state) => state.syncSessionUser)

  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(theme)
    // 清掉 index.html 引导脚本预置的内联背景色，交还给 CSS 变量接管，避免运行时切主题后残留旧色
    document.documentElement.style.backgroundColor = ''
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

    async function bootstrapShellSession() {
      setSessionChecking()

      try {
        // 经 react-query 缓存拉取：与页面级 ['community','me'] 查询共享同一请求/缓存，避免首屏重复请求 /api/users/me
        const payload = await queryClient.fetchQuery({
          queryKey: ['community', 'me'],
          queryFn: () => requestJson<UserMePayload>('/api/users/me'),
          staleTime: 30_000,
          retry: false,
        })

        if (!disposed) {
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
          void hydrateReadingSync().then((changed) => {
            if (changed && !disposed) {
              void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
            }
          })
        }
      } catch (error) {
        if (disposed) {
          return
        }

        if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
          setGuest()
          return
        }

        setSessionUnavailable()
      }
    }

    void bootstrapShellSession()

    return () => {
      disposed = true
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
