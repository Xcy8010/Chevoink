import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import AppState from '@/components/ui/AppState'
import LoadingMark from '@/components/ui/LoadingMark'
import { useShellStore } from '@/store/useShellStore'

type RequireAuthRouteProps = {
  children: ReactNode
  title?: string
  description?: string
  centered?: boolean
  checkingFallback?: ReactNode
}

export default function RequireAuthRoute({
  children,
  title = '登录后继续',
  description,
  centered = false,
  checkingFallback,
}: RequireAuthRouteProps) {
  const location = useLocation()
  const authStatus = useShellStore((state) => state.authStatus)
  const isAuthenticated = useShellStore((state) => state.authStatus === 'authenticated' && !!state.sessionUser)
  const stateClassName = centered ? 'flex-1 shrink-0' : undefined
  const renderState = (state: ReactNode) => centered
    ? <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{state}</div>
    : state

  if (authStatus === 'checking') {
    return renderState(checkingFallback ?? <LoadingMark className="grid min-h-40 flex-1 place-items-center" />)
  }

  if (authStatus === 'unavailable') {
    return renderState(
      <AppState
        className={stateClassName}
        tone="error"
        title="账户状态暂时无法确认"
        description="请重新加载页面。"
        primaryAction={{ label: '重新加载', onClick: () => window.location.reload() }}
        secondaryAction={{ label: '返回首页', href: '/' }}
      />
    )
  }

  if (!isAuthenticated) {
    const redirect = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)

    return renderState(
      <AppState
        className={stateClassName}
        scene="welcome"
        title={title}
        description={description}
        primaryAction={{ label: '去登录', href: `/login?redirect=${redirect}` }}
        secondaryAction={{ label: '创建账户', href: `/register?redirect=${redirect}` }}
      />
    )
  }

  return <>{children}</>
}
