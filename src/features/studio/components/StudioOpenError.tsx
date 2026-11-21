import { useLocation, useNavigate } from 'react-router-dom'

import { ApiClientError } from '@/app/api-client'
import { requestSessionSignIn } from '@/app/session-activity'
import AppState from '@/components/ui/AppState'
import { useShellStore } from '@/store/useShellStore'

export default function StudioOpenError({ error, retry, title = '创作中心暂时无法打开', retryLabel = '重新连接' }: {
  error: unknown
  retry: () => void | Promise<unknown>
  title?: string
  retryLabel?: string
}) {
  const { pathname, search, hash } = useLocation()
  const navigate = useNavigate()
  const sessionExpired = error instanceof ApiClientError && error.status === 401

  function signInAgain() {
    if (useShellStore.getState().authStatus !== 'guest') requestSessionSignIn()
    else navigate('/login?' + new URLSearchParams({ redirect: pathname + search + hash }).toString())
  }

  return (
    <AppState
      tone="error"
      scene={sessionExpired ? 'welcome' : error instanceof ApiClientError && error.status === 404 ? 'search' : 'connection'}
      className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:min-h-0"
      title={sessionExpired ? '请重新登录' : title}
      description={sessionExpired ? '登录已过期。' : error instanceof ApiClientError && error.status < 500 ? error.message : '请稍后重试。'}
      primaryAction={sessionExpired ? { label: '重新登录', onClick: signInAgain } : { label: retryLabel, onClick: retry }}
      secondaryAction={{ label: '返回首页', onClick: () => navigate('/') }}
    />
  )
}
