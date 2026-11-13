import { BookOpen } from 'lucide-react'

import AppState from '@/components/ui/AppState'
import { getProgressPercent, type ReadingProgressEntry } from '@/features/home/reading-progress'

export type ShelfBook = {
  key: string
  novelId: string | null
  title: string
  coverUrl: string | null
  summary: string
}

type ShelfPanelProps = {
  items: ShelfBook[]
  progressMap: Record<string, ReadingProgressEntry>
  onOpenNovel: (novelId: string) => void
  onDiscover: () => void
}

/** 书架面板：封面网格 + 阅读进度覆盖层 */
export default function ShelfPanel({ items, progressMap, onOpenNovel, onDiscover }: ShelfPanelProps) {
  if (items.length === 0) {
    return (
      <AppState
        scene="reading"
        title="书架还空着"
        description="去发现页挑一本书。"
        primaryAction={{ label: '去发现', onClick: onDiscover }}
        className="min-h-[280px]"
      />
    )
  }

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((item) => {
        const progress = item.novelId ? progressMap[item.novelId] : undefined
        const percent = progress ? getProgressPercent(progress) : null

        return (
          <button
            key={item.key}
            type="button"
            onClick={() => item.novelId && onOpenNovel(item.novelId)}
            className="group min-w-0 text-left"
          >
            <div className="hover-lift">
              {item.coverUrl ? (
                <img
                  src={item.coverUrl}
                  alt={item.title}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[3/4] w-full rounded-[var(--radius-lg)] object-cover"
                />
              ) : (
                <div className="flex aspect-[3/4] w-full flex-col justify-end rounded-[var(--radius-lg)] bg-[var(--surface-muted)] p-3">
                  <p className="line-clamp-4 text-xs font-medium text-[var(--text-primary)]">{item.title}</p>
                </div>
              )}
              <div className="pt-2">
                <p className="line-clamp-2 text-sm font-medium leading-6 text-[var(--text-primary)]">{item.title}</p>
                {progress && percent !== null ? (
                  <div className="mt-2 space-y-1.5">
                    <div className="h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
                      <div
                        className="h-full rounded-full bg-[var(--color-brand)] transition-[width] duration-[var(--duration-normal)]"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <p className="flex items-center gap-1 text-[11px] text-[var(--color-brand)]">
                      <BookOpen className="h-3 w-3" />
                      读至第{progress.chapterOrder + 1}章 · {percent}%
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--text-tertiary)]">
                    {item.summary || '继续回到正文阅读。'}
                  </p>
                )}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
