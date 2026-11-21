import { Suspense, useEffect, useLayoutEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes, useLocation, useNavigate, type Location } from 'react-router-dom'

import { appRoutes } from '@/app/route-config'
import AccountAccessGate from '@/app/routes/AccountAccessGate'
import AuthPage from '@/app/routes/AuthPage'
import AppShell from '@/components/layout/AppShell'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { requiresLegacyEmailBinding } from '@/features/account/account-access'
import { useShellStore } from '@/store/useShellStore'
import { listenForSessionActivity, REAUTHENTICATION_REQUIRED } from './session-activity'
import { readDeviceSelection } from '@/lib/auth-token'

/** 未指定专属骨架的懒加载路由通用占位 */
const defaultRouteFallback = (
  <div className="space-y-4 py-2" aria-busy="true" aria-label="页面加载中">
    <Skeleton className="h-7 w-48" />
    <SkeletonText lines={4} />
    <Skeleton className="h-40 w-full rounded-[var(--radius-xl)]" />
  </div>
)

function AppRoutes() {
  const location = useLocation()
  const navigate = useNavigate()
  const previousPage = useRef<Location | null>(null)
  const client = useQueryClient()
  const viewer = useShellStore(state => state.authStatus === 'authenticated' ? state.sessionUser?.id : null)
  const tokens = useShellStore(state => state.authTokens)
  const deviceId = useShellStore(state => state.deviceSessionId)
  useEffect(() => {
    if (!viewer || !deviceId) return
    return listenForSessionActivity(viewer, deviceId, () => {
      const current = useShellStore.getState()
      return current.sessionUser?.id === viewer && current.deviceSessionId === deviceId && current.authTokens === tokens
    })
  }, [viewer, deviceId, tokens])
  useLayoutEffect(() => {
    function onExpiry() {
      const shell = useShellStore.getState()
      if (shell.authStatus === 'guest') return
      const owner = shell.sessionUser?.id ?? readDeviceSelection()?.userId ?? shell.lastVerifiedUserId
      window.dispatchEvent(new Event('chevoink:session-expired'))
      previousPage.current = null
      shell.setGuest()
      client.clear()
      if (!/^\/(?:login|register)\/?$/i.test(location.pathname)) {
        const redirect = location.pathname + location.search + location.hash
        navigate('/login?' + new URLSearchParams({ redirect }), { replace: true, state: { resumeOwner: owner ?? '' } })
      }
    }
    window.addEventListener(REAUTHENTICATION_REQUIRED, onExpiry)
    return () => window.removeEventListener(REAUTHENTICATION_REQUIRED, onExpiry)
  }, [client, location, navigate])
  const path = location.pathname.toLowerCase().replace(/\/+$/, '')
  const authMode = path === '/login' ? 'login' : path === '/register' ? 'register' : undefined
  const checkingSession = useShellStore(state => state.authStatus === 'checking')
  const needsVerifiedPhone = useShellStore(state => state.authStatus === 'authenticated'
    && (state.sessionUser?.studioPhoneVerificationRequired
      ?? (state.sessionUser?.emailAuthEnabled === true && !state.sessionUser.phoneVerified)))
  const needsEmailBinding = useShellStore(state => state.authStatus === 'authenticated' && requiresLegacyEmailBinding(state.sessionUser))
  const studio = path === '/studio' || path.startsWith('/studio/')
  const studioPhoneRequired = studio && needsVerifiedPhone
  const studioBlocked = studio && (needsVerifiedPhone || needsEmailBinding)
  const hasOverlay = Boolean(authMode || studioBlocked)
  useLayoutEffect(() => {
    if (!hasOverlay && path !== '/create' && !/^\/admin(?:\/|$)/.test(path)) previousPage.current = location
  }, [hasOverlay, location, path])
  const previous = previousPage.current
  const canShowPrevious = previous && !(studioBlocked && /^\/studio(?:\/|$)/i.test(previous.pathname))
  const background = hasOverlay ? (canShowPrevious ? previous : '/') : location
  const closeOverlay = () => navigate(background, { replace: true })

  return (
    <AccountAccessGate studioPhoneRequired={studioPhoneRequired} closeStudioGate={closeOverlay}>
      <Routes location={background}>
        {appRoutes.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={
              route.useShell === false ? (
                <div className="app-standalone-route">
                  <Suspense fallback={route.fallback ?? defaultRouteFallback}>{route.element}</Suspense>
                </div>
              ) : (
                // Suspense 放在壳内：顶栏/底栏立即可交互，只内容区显示骨架
                <AppShell title={route.title} description={route.description}>
                  <Suspense key={route.path} fallback={route.fallback ?? defaultRouteFallback}>
                    {route.element}
                  </Suspense>
                </AppShell>
              )
            }
          />
        ))}
      </Routes>
      {authMode && !checkingSession && <AuthPage mode={authMode} onClose={closeOverlay} />}
    </AccountAccessGate>
  )
}

export default function AppRouter() {
  return <BrowserRouter><AppRoutes /></BrowserRouter>
}
