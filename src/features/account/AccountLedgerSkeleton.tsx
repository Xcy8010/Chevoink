import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'

export default function AccountLedgerSkeleton({ label }: { label: string }) {
  return (
    <div className="px-5 py-9 sm:px-8 lg:px-12 lg:py-11" role="status" aria-busy="true" aria-label={label}>
      <div className="max-w-[1040px] space-y-6">
        <Skeleton className="h-8 w-32" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
        <div className="rounded-2xl border border-[var(--border-subtle)] p-5">
          <SkeletonText lines={5} />
        </div>
      </div>
    </div>
  )
}
