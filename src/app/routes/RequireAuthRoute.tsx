import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import AppState from '@/components/ui/AppState'
import LoadingMark from '@/components/ui/LoadingMark'
import { useShellStore } from '@/store/useShellStore'

type RequireAuthRouteProps = {
  children: ReactNode
  title?: string
  description?: string
  centered?: boolean
}

export default function RequireAuthRoute({
  children,
  title = '登录后即可继续查看这里的内容',
  description = '登录后，你的书架、草稿和个人记录都会继续保留。',
  centered = false,
}: RequireAuthRouteProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const authStatus = useShellStore((state) => state.authStatus)
  const isAuthenticated = useShellStore((state) => state.authStatus === 'authenticated' && !!state.sessionUser)
  const stateClassName = centered ? 'flex-1 shrink-0' : undefined
  const renderState = (state: ReactNode) => centered
    ? <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{state}</div>
    : state

  if (authStatus === 'checking') {
    return renderState(<LoadingMark className="grid min-h-40 flex-1 place-items-center" />)
  }

  if (authStatus === 'unavailable') {
    return renderState(
      <AppState
        className={stateClassName}
        tone="error"
        title="暂时无法打开这里"
        description="账户状态还没有准备好，请稍后再试，或先回到首页继续浏览。"
        primaryAction={{ label: '返回首页', href: '/' }}
        secondaryAction={{ label: '重新加载', onClick: () => window.location.reload() }}
      />
    )
  }

  if (!isAuthenticated) {
    const redirect = encodeURIComponent(`${location.pathname}${location.search}`)

    return renderState(
      <AppState
        className={stateClassName}
        icon={centered ? <img src="/favicon.png" alt="Chevoink" width={72} height={72} className="h-[72px] w-[72px] rounded-2xl object-contain" /> : undefined}
        title={title}
        description={description}
        primaryAction={{ label: '去登录', onClick: () => navigate(`/login?redirect=${redirect}`) }}
        secondaryAction={{ label: '创建账户', onClick: () => navigate(`/register?redirect=${redirect}`) }}
      />
    )
  }

  return <>{children}</>
}
