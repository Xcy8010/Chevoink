import { Skeleton } from '@/components/ui/Skeleton'

export type StudioPaneShape = 'document' | 'list' | 'graph' | 'memory' | 'dialog'

export default function StudioPaneSkeleton({ shape = 'list', label, bodyOnly = false }: {
  shape?: StudioPaneShape; label: string; bodyOnly?: boolean
}) {
  return <div role="status" aria-label={label} className={`flex h-full min-h-0 w-full flex-col overflow-hidden ${shape === 'dialog' ? '' : 'studio-pending'}`}>
    <span className="sr-only">{label}</span>
    {!bodyOnly && shape !== 'dialog' && <div aria-hidden="true" className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-4">
      <Skeleton className="size-3.5" /><Skeleton className="h-2.5 w-16" />
    </div>}
    {shape === 'graph' ? <div aria-hidden="true" className="relative grid min-h-28 flex-1 place-items-center">
      <div className="relative h-32 w-2/3 max-w-80">
        <div className="absolute left-1/4 top-1/4 h-1/2 w-1/2 rounded-l-xl border-y border-l border-[var(--border-subtle)]" />
        <div className="absolute left-[14%] top-1/2 w-[12%] border-t border-[var(--border-subtle)]" />
        <Skeleton className="absolute left-0 top-1/2 h-6 w-[20%] -translate-y-1/2 rounded-lg" />
        <Skeleton className="absolute right-0 top-1/4 h-6 w-[28%] -translate-y-1/2 rounded-lg" />
        <Skeleton className="absolute right-[6%] top-3/4 h-6 w-[22%] -translate-y-1/2 rounded-lg" />
      </div>
    </div> : shape === 'document' ? <div aria-hidden="true" className="space-y-5 p-5">
      {['w-11/12', 'w-full', 'w-3/5', 'w-10/12', 'w-4/5'].map(width => <Skeleton key={width} className={`h-2.5 ${width}`} />)}
    </div> : shape === 'memory' ? <div aria-hidden="true" className="space-y-5 px-4 py-5">
      <Skeleton className="h-2 w-full rounded-full" /><Skeleton className="h-3 w-20" />
      <div className="grid grid-cols-2 gap-2">{[0, 1, 2, 3].map(item => <Skeleton key={item} className="h-12 rounded-lg" />)}</div>
    </div> : <div aria-hidden="true" className="space-y-5 p-4">
      {(shape === 'dialog' ? ['w-28', 'w-20'] : ['w-3/5', 'w-4/5', 'w-2/5']).map(width => <div key={width} className="flex items-center gap-3">
        <Skeleton className="size-4 shrink-0 rounded-md" /><Skeleton className={`h-2.5 ${width}`} />
      </div>)}
    </div>}
  </div>
}
