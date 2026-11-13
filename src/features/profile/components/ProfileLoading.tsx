import { Skeleton } from '@/components/ui/Skeleton'

export function ProfileRouteSkeleton() {
  return (
    <div className="space-y-5 md:space-y-6" role="status" aria-busy="true" aria-label="个人中心加载中">
      <div>
        <Skeleton className="aspect-[3/1] w-full rounded-[var(--radius-xl)]" />
        <div className="flex items-start justify-between px-1 sm:px-2">
          <Skeleton className="relative -mt-9 h-[76px] w-[76px] rounded-full border-4 border-[var(--app-bg)] sm:-mt-12 sm:h-24 sm:w-24" />
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-9 w-20 rounded-[var(--radius-pill)]" />
          </div>
        </div>
        <div className="mt-2.5 space-y-2 px-1 sm:px-2">
          <Skeleton className="h-7 w-32 sm:h-8" />
          <Skeleton className="h-6 w-2/3 max-w-sm" />
          <div className="flex h-5 items-center gap-4 sm:gap-5">
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-3 w-9" />)}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-4 divide-x divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] py-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col items-center gap-1.5 px-2 sm:items-start sm:px-4">
            <Skeleton className="h-6 w-8 sm:h-8" />
            <Skeleton className="h-3 w-9" />
          </div>
        ))}
      </div>
      <div>
        <div className="flex border-b border-[var(--border-subtle)]">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex flex-1 justify-center py-4 sm:flex-none sm:px-6">
              <Skeleton className="h-3 w-9" />
            </div>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="aspect-[3/4] w-full rounded-[var(--radius-lg)]" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
