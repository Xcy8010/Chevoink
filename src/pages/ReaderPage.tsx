import { ApiClientError } from '@/app/api-client'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { ReaderSkeleton } from '@/components/ui/Skeleton'
import { useDevice } from '@/components/layout/device-context'
import ReaderDesktop from '@/features/reader/layouts/ReaderDesktop'
import ReaderMobile from '@/features/reader/layouts/ReaderMobile'
import ReaderTablet from '@/features/reader/layouts/ReaderTablet'
import { useReaderState } from '@/features/reader/useReaderState'

/**
 * 阅读器入口：共享数据层 + 三端布局分发。
 * - 手机：全屏沉浸手势阅读（ReaderMobile）
 * - 平板：横屏双栏 / 竖屏单栏（ReaderTablet）
 * - 电脑：目录 + 正文 + 评论三栏（ReaderDesktop）
 */
export default function ReaderPage() {
  const { device } = useDevice()
  const state = useReaderState()

  const error = state.readerQuery.error
  const missing = error instanceof ApiClientError && error.status === 404
  if (!state.novelId || !state.chapterId || missing) {
    return (
      <AppState
        scene="search"
        title="找不到这一章"
        primaryAction={state.novelId
          ? { label: '返回作品详情', href: `/novel/${state.novelId}` }
          : { label: '去发现', href: '/discover' }}
      />
    )
  }

  if (state.readerQuery.isLoading) {
    return <ReaderSkeleton />
  }

  const accessDenied = error instanceof ApiClientError && (error.status === 401 || error.status === 403)
  if (state.readerQuery.isError && (!state.reader || accessDenied)) {
    return (
      <AppState
        tone="error"
        title="这一章暂时没有打开"
        description={accessDenied ? error.message : '请检查连接后重试。'}
        primaryAction={{
          label: '重新加载',
          onClick: () => state.readerQuery.refetch(),
          busy: state.readerQuery.isFetching,
        }}
        secondaryAction={{ label: '回到详情页', href: `/novel/${state.novelId}` }}
      />
    )
  }

  if (device === 'mobile') {
    return <ReaderMobile state={state} />
  }

  const refreshNotice = state.readerQuery.isError
    ? <AppStateRefreshNotice retry={state.readerQuery.refetch} busy={state.readerQuery.isFetching} />
    : null

  if (device === 'tablet') {
    return <>{refreshNotice}<ReaderTablet state={state} /></>
  }

  return <>{refreshNotice}<ReaderDesktop state={state} /></>
}
