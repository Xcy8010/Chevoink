import { Clock3, PenLine } from 'lucide-react'

import AppState from '@/components/ui/AppState'
import Button from '@/components/ui/Button'
import { formatRelativeTime } from '@/features/community/utils'
import { getDisplayTitle } from '@/features/discover/api'
import type { Novel, ProfileDraftItem } from '../../../../shared/contracts'

type CreationPanelProps = {
  drafts: ProfileDraftItem[]
  novels: Novel[]
  onOpenStudio: () => void
  onOpenNovelStudio: (novelId: string) => void
  onOpenNovel: (novelId: string) => void
}

/** 创作面板：创作中心入口 + 最近草稿 + 作品网格（继续创作） */
export default function CreationPanel({
  drafts,
  novels,
  onOpenStudio,
  onOpenNovelStudio,
  onOpenNovel,
}: CreationPanelProps) {
  return (
    <div className="space-y-5">
      {/* 顶部入口：左文右钮一行平铺，不包盒子；小屏文案截断不换行 */}
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm text-[var(--text-secondary)]">
          <PenLine className="h-4 w-4 shrink-0 text-[var(--color-brand)]" />
          <span className="truncate">灵感来了就继续写，进度会自动存进草稿。</span>
        </p>
        <Button variant="primary" size="sm" className="shrink-0" onClick={onOpenStudio}>
          进入创作中心
        </Button>
      </div>

      {drafts.length > 0 ? (
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
            <Clock3 className="h-4 w-4 text-[var(--text-tertiary)]" />
            最近草稿
          </div>
          <div className="mt-2 divide-y divide-[var(--border-subtle)]">
            {drafts.slice(0, 3).map((draft) => (
              <button
                key={draft.id}
                type="button"
                onClick={() => onOpenNovelStudio(draft.novelId)}
                className="flex w-full items-center justify-between px-1 py-3 text-left transition-colors hover:bg-[var(--surface-muted)]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{draft.title}</span>
                  <span className="mt-1 block truncate text-xs text-[var(--text-tertiary)]">{draft.summary}</span>
                </span>
                <span className="ml-4 shrink-0 text-xs text-[var(--text-tertiary)]">
                  {formatRelativeTime(draft.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {novels.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {novels.map((novel) => (
            <article key={novel.id} className="min-w-0">
              {novel.coverUrl ? (
                <img
                  src={novel.coverUrl}
                  alt={getDisplayTitle(novel)}
                  className="aspect-[3/4] w-full rounded-[var(--radius-lg)] object-cover"
                />
              ) : (
                <div className="flex aspect-[3/4] w-full flex-col justify-end rounded-[var(--radius-lg)] bg-[var(--surface-muted)] p-3">
                  <p className="line-clamp-4 text-xs font-medium text-[var(--text-primary)]">{getDisplayTitle(novel)}</p>
                </div>
              )}
              <div className="pt-2.5">
                <p className="line-clamp-2 text-sm font-medium leading-6 text-[var(--text-primary)]">{getDisplayTitle(novel)}</p>
                <p className="mt-1 truncate text-[11px] text-[var(--text-tertiary)] sm:text-xs">
                  {novel.chapterCount} 章 · {novel.wordCount} 字
                </p>
                {/* 小屏两钮平分宽度、缩字号不换行，保证窄卡片里也能水平一行摆下 */}
                <div className="mt-2.5 flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 flex-1 px-2 text-xs sm:h-9 sm:text-sm"
                    onClick={() => onOpenNovel(novel.id)}
                  >
                    查看
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    className="h-8 flex-1 px-2 text-xs sm:h-9 sm:text-sm"
                    onClick={() => onOpenNovelStudio(novel.id)}
                  >
                    继续写
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <AppState
          scene="writing"
          title="还没有创作内容"
          primaryAction={{ label: '开始创作', onClick: onOpenStudio }}
          className="min-h-[280px]"
        />
      )}
    </div>
  )
}
