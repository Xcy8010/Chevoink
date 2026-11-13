import { SiteAnnouncements, SiteInformation } from '@/features/site-content/public'
import { useState } from 'react'

import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { HomeSkeleton } from '@/components/ui/Skeleton'
import { useDevice } from '@/components/layout/device-context'
import HomeDesktopLayout from '@/features/home/layouts/HomeDesktopLayout'
import HomeMobileLayout from '@/features/home/layouts/HomeMobileLayout'
import HomeTabletLayout from '@/features/home/layouts/HomeTabletLayout'
import { useHomeData } from '@/features/home/useHomeData'

/**
 * 首页：同一数据层，三端渲染不同布局组件树。
 * - 手机端：单列沉浸，消费优先
 * - 平板端：双列网格 + 双栏并行，阅读增强
 * - 电脑端：主内容 + 右侧信息聚合面板
 */
export default function Home() {
  return <><SiteAnnouncements scope="home" /><HomeContent /><SiteInformation /></>
}

function HomeContent() {
  const { device } = useDevice()
  const { data, isLoading, isError, isFetching, refetch } = useHomeData()
  // 分类筛选：点击导航标签后在首页底部展示同标签作品，不跳发现页
  const [activeCategory, setActiveCategory] = useState('')

  if (isLoading) {
    return <HomeSkeleton />
  }

  if (isError && !data) {
    return (
      <AppState
        tone="error"
        title="首页暂时没有打开"
        description="请检查连接后重试。"
        primaryAction={{
          label: '重新连接',
          onClick: () => refetch(),
          busy: isFetching,
        }}
      />
    )
  }

  const refreshNotice = isError && data ? <AppStateRefreshNotice retry={refetch} busy={isFetching} /> : null

  if (!data || (data.bannerNovels.length === 0 && data.featuredNovels.length === 0)) {
    return (
      <><AppState
        tone="empty"
        scene="reading"
        title="还没有可阅读的作品"
        primaryAction={{
          label: '去分类发现',
          href: '/discover',
        }}
      />{refreshNotice}</>
    )
  }

  if (device === 'mobile') {
    return <>{refreshNotice}<HomeMobileLayout data={data} activeCategory={activeCategory} onSelectCategory={setActiveCategory} /></>
  }

  if (device === 'tablet') {
    return <>{refreshNotice}<HomeTabletLayout data={data} activeCategory={activeCategory} onSelectCategory={setActiveCategory} /></>
  }

  return <>{refreshNotice}<HomeDesktopLayout data={data} activeCategory={activeCategory} onSelectCategory={setActiveCategory} /></>
}
