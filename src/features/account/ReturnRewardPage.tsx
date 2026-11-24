import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { Gift } from 'lucide-react'
import { ApiClientError, requestJson } from '@/app/api-client'
import AppState from '@/components/ui/AppState'
import { useToast } from '@/components/ui/toast-context'
import { useShellStore } from '@/store/useShellStore'
import { returnRewardPendingKey, returnRewardTokenFormat } from '../../../shared/return-reward'

const claimPath = '/return-reward'
const credits = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 })

type RewardReceipt = {
  amountMilli: number
  workspacePath: string
  alreadyClaimed: boolean
}

export default function ReturnRewardPage() {
  const { hash } = useLocation()
  const navigate = useNavigate()
  const authStatus = useShellStore(state => state.authStatus)
  const userId = useShellStore(state => state.sessionUser?.id)
  const token = hash ? hash.slice(1) : sessionStorage.getItem(returnRewardPendingKey) ?? ''

  if (!returnRewardTokenFormat.test(token)) {
    return <AppState title="领取链接无效" description="请从创作活动邮件重新打开领取链接。" secondaryAction={{ label: '前往创作', href: '/studio' }}/>
  }
  if (authStatus === 'checking') return <AppState tone="loading" title="正在确认登录状态"/>
  if (authStatus === 'unavailable') {
    return <AppState tone="error" title="暂时无法确认登录状态" primaryAction={{ label: '重新加载', onClick: () => window.location.reload() }}/>
  }
  if (authStatus !== 'authenticated' || !userId) {
    return <AppState title="登录领取回归奖励" description="请使用收到邀请邮件的启创墨域账号。"
      primaryAction={{ label: '去登录', onClick: () => {
        sessionStorage.setItem(returnRewardPendingKey, token)
        void navigate('/login?redirect=' + encodeURIComponent(claimPath))
      } }}/>
  }
  return <ReturnRewardClaim key={userId + ':' + token} token={token}/>
}

function ReturnRewardClaim({ token }: { token: string }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const claim = useMutation({
    mutationFn: () => requestJson<RewardReceipt>('/api/credits/return-reward/claim', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['credits'] })
      void client.invalidateQueries({ queryKey: ['site-content', 'announcement-inbox'] })
    },
  })

  const error = claim.error
  const message = error instanceof ApiClientError ? error.message : '暂时无法领取，请稍后重试。'
  const unavailable = error instanceof ApiClientError && (error.status === 404 || error.status === 410)
  return <AppState icon={<Gift size={28}/>} title="领取回归奖励" description="奖励额度会直接加入当前账号的奖励余额。"
    details={error ? <p role="alert">{message}</p> : undefined}
    primaryAction={unavailable ? undefined : {
      label: '确认领取',
      pendingLabel: '正在领取…',
      busy: claim.isPending,
      onClick: () => {
        claim.mutate(undefined, {
          onSuccess: ({ amountMilli, alreadyClaimed, workspacePath }) => {
            if (sessionStorage.getItem(returnRewardPendingKey) === token) sessionStorage.removeItem(returnRewardPendingKey)
            if (alreadyClaimed) {
              toast.info('回归奖励已领取。')
            } else {
              toast.success(`领取成功，${credits.format(amountMilli / 1000)} Credits 已到账。`)
            }
            const workspace = /^studio(?:\/novel\/[A-Za-z0-9_-]+)?$/.test(workspacePath) ? '/' + workspacePath : '/studio'
            void navigate(workspace, { replace: true })
          },
        })
      },
    }}
    secondaryAction={{ label: '前往创作区', href: '/studio' }}/>
}
