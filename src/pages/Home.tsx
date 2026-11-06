import { SiteAnnouncements, SiteInformation } from '@/features/site-content/public'
import { useState } from 'react'

import AppState from '@/components/ui/AppState'
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
  const { data, isLoading, isError, error, isFetching, refetch } = useHomeData()
  // 分类筛选：点击导航标签后在首页底部展示同标签作品，不跳发现页
  const [activeCategory, setActiveCategory] = useState('')

  if (isLoading) {
    return <HomeSkeleton />
  }

  if (isError) {
    return (
      <AppState
        tone="error"
        title="首页暂时没有打开"
        description={error instanceof Error ? error.message : '连接似乎中断了，请稍后再试。'}
        primaryAction={{
          label: isFetching ? '重新连接中...' : '重新连接',
          onClick: () => void refetch(),
        }}
      />
    )
  }

  if (!data || (data.bannerNovels.length === 0 && data.featuredNovels.length === 0)) {
    return (
      <AppState
        tone="empty"
        title="还没有找到可阅读的内容"
        description="换个时间再来看看，新作品和更新内容会在这里出现。"
        primaryAction={{
          label: '去分类发现',
          href: '/discover',
        }}
      />
    )
  }

  if (device === 'mobile') {
    return <HomeMobileLayout data={data} activeCategory={activeCategory} onSelectCategory={setActiveCategory} />
  }

  if (device === 'tablet') {
    return <HomeTabletLayout data={data} activeCategory={activeCategory} onSelectCategory={setActiveCategory} />
  }

  return <HomeDesktopLayout data={data} activeCategory={activeCategory} onSelectCategory={setActiveCategory} />
}
