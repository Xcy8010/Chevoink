import AppState from '@/components/ui/AppState'

export default function NotFoundPage() {
  return (
    <AppState
      scene="search"
      eyebrow="404"
      title="页面找不到了"
      description="这个地址可能已失效。"
      primaryAction={{ label: '返回首页', href: '/' }}
      secondaryAction={{ label: '去发现', href: '/discover' }}
    />
  )
}
