import { ApiClientError } from '@/app/api-client'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { Skeleton, SkeletonCover, SkeletonText } from '@/components/ui/Skeleton'
import { useDevice } from '@/components/layout/device-context'
import EditNovelDialog from '@/features/novel-detail/components/EditNovelDialog'
import NovelDetailDesktop from '@/features/novel-detail/layouts/NovelDetailDesktop'
import NovelDetailMobile from '@/features/novel-detail/layouts/NovelDetailMobile'
import NovelDetailTablet from '@/features/novel-detail/layouts/NovelDetailTablet'
import { useNovelDetailState } from '@/features/novel-detail/useNovelDetailState'
import NovelCoverCropDialog from '@/features/studio/components/NovelCoverCropDialog'

function NovelDetailSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 md:grid-cols-[160px_minmax(0,1fr)]">
        <SkeletonCover className="aspect-[20/27] w-full md:w-[160px]" />
        <div className="space-y-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-32" />
          <SkeletonText lines={3} />
          <div className="flex gap-3 pt-2">
            <Skeleton className="h-11 w-32 rounded-[var(--radius-pill)]" />
            <Skeleton className="h-11 w-36 rounded-[var(--radius-pill)]" />
          </div>
        </div>
      </div>
      <div className="rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5">
        <Skeleton className="h-5 w-48" />
        <div className="mt-4 space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </div>
    </div>
  )
}

export default function NovelDetailPage() {
  const { device } = useDevice()
  const state = useNovelDetailState()

  const missing = state.detailQuery.error instanceof ApiClientError && state.detailQuery.error.status === 404
  if (!state.novelId || missing) {
    return (
      <AppState
        scene="search"
        title="找不到这本书"
        primaryAction={{
          label: '去分类发现',
          href: '/discover',
        }}
      />
    )
  }

  if (state.detailQuery.isLoading) {
    return <NovelDetailSkeleton />
  }

  const accessDenied = state.detailQuery.error instanceof ApiClientError
    && (state.detailQuery.error.status === 401 || state.detailQuery.error.status === 403)
  if (state.detailQuery.isError && (!state.detail || accessDenied)) {
    return (
      <AppState
        tone="error"
        title="作品详情暂时没有打开"
        description={accessDenied ? state.detailQuery.error?.message : '请稍后重试。'}
        primaryAction={{
          label: '重新加载',
          onClick: () => state.detailQuery.refetch(),
          busy: state.detailQuery.isFetching,
        }}
        secondaryAction={{
          label: '回到发现页',
          href: '/discover',
        }}
      />
    )
  }

  if (!state.detail) {
    return null
  }

  return (
    <>
      {state.detailQuery.isError ? <AppStateRefreshNotice retry={state.detailQuery.refetch} busy={state.detailQuery.isFetching} /> : null}
      <input
        ref={state.coverInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            state.setPendingCoverUploadFile(file)
          }
          event.target.value = ''
        }}
      />

      {device === 'mobile' ? (
        <NovelDetailMobile state={state} />
      ) : device === 'tablet' ? (
        <NovelDetailTablet state={state} />
      ) : (
        <NovelDetailDesktop state={state} />
      )}

      <EditNovelDialog state={state} />
      <NovelCoverCropDialog
        open={Boolean(state.pendingCoverUploadFile)}
        file={state.pendingCoverUploadFile}
        busy={state.uploadCoverMutation.isPending}
        onClose={() => {
          if (!state.uploadCoverMutation.isPending) {
            state.setPendingCoverUploadFile(null)
          }
        }}
        onConfirm={(crop) => state.uploadCoverMutation.mutate(crop)}
      />
    </>
  )
}
