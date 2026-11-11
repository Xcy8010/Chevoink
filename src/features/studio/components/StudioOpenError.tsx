import { useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'

import { ApiClientError } from '@/app/api-client'
import AppState from '@/components/ui/AppState'
import { useShellStore } from '@/store/useShellStore'

export default function StudioOpenError({ error, retry, title = '创作中心暂时无法打开', retryLabel = '重新连接' }: {
  error: unknown
  retry: () => void
  title?: string
  retryLabel?: string
}) {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const sessionExpired = error instanceof ApiClientError && error.status === 401

  function signInAgain() {
    useShellStore.getState().setGuest()
    queryClient.clear()
    navigate('/login?' + new URLSearchParams({ redirect: pathname + search }).toString())
  }

  return (
    <AppState
      tone="error"
      className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:min-h-0"
      title={sessionExpired ? '请重新登录' : title}
      description={sessionExpired ? '登录已过期，重新登录后可以继续创作。' : error instanceof ApiClientError ? error.message : '请稍后重试。'}
      primaryAction={sessionExpired ? { label: '重新登录', onClick: signInAgain } : { label: retryLabel, onClick: retry }}
      secondaryAction={{ label: '返回首页', onClick: () => navigate('/') }}
    />
  )
}
