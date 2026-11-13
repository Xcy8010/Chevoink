import { Link } from 'react-router-dom'

import Empty from '@/components/Empty'
import AppImage from '@/components/ui/AppImage'
import { getAuthorName, getCoverUrl, getDisplayTitle, getNovelSummary } from '@/features/discover/api'
import type { NovelCard } from '../../../../shared/contracts'

type RelatedNovelsPanelProps = {
  novels: NovelCard[]
  /** grid：主区域网格卡片；list：桌面右栏紧凑列表 */
  variant?: 'grid' | 'list'
}

function RelatedCover({ novel, className }: { novel: NovelCard; className?: string }) {
  const coverUrl = getCoverUrl(novel.coverUrl)
  const title = getDisplayTitle(novel)

  if (coverUrl) {
    return (
      <AppImage
        src={coverUrl}
        alt={title}
        className={['aspect-[3/4] self-start rounded-[var(--radius-md)] border border-[var(--border-subtle)]', className ?? ''].join(' ')}
      />
    )
  }

  return (
    <div
      className={[
        'flex aspect-[3/4] items-end self-start rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3',
        className ?? '',
      ].join(' ')}
    >
      <p className="line-clamp-4 text-xs font-medium text-[var(--text-primary)]">{title}</p>
    </div>
  )
}

/** 相关推荐：grid 变体用于主区，list 变体用于桌面右栏 */
export default function RelatedNovelsPanel({ novels, variant = 'grid' }: RelatedNovelsPanelProps) {
  if (novels.length === 0) {
    return <Empty title="暂无相关推荐" />
  }

  if (variant === 'list') {
    return (
      <div className="space-y-3">
        {novels.slice(0, 5).map((novel) => (
          <Link
            key={novel.id}
            to={`/novel/${novel.id}`}
            className="flex gap-3 rounded-[var(--radius-lg)] p-2 transition-colors hover:bg-[var(--surface-muted)]"
          >
            <RelatedCover novel={novel} className="w-12 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-1 text-sm font-medium text-[var(--text-primary)]">
                {getDisplayTitle(novel)}
              </span>
              <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">{getAuthorName(novel.author)}</span>
              {/* 不能和 block 同用：display:block 会覆盖 line-clamp 的 -webkit-box 导致截断失效；
                  外层按两行行高（40px）精确裁剪：QQ/微信 X5 内核下 line-clamp 的 overflow 裁剪不可靠，
                  只靠 clamp 会漏出被横截的第三行；内层 max-height 同时禁用 X5 字体自动放大 */}
              <span className="mt-1 block h-10 overflow-hidden">
                <span className="line-clamp-2 max-h-10 text-xs leading-5 text-[var(--text-secondary)]">
                  {getNovelSummary(novel.summary)}
                </span>
              </span>
            </span>
          </Link>
        ))}
      </div>
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {novels.map((novel) => (
        <Link
          key={novel.id}
          to={`/novel/${novel.id}`}
          className="hover-lift grid grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-3 transition-colors hover:border-[var(--border-strong)]"
        >
          <RelatedCover novel={novel} className="w-full" />
          <span className="min-w-0">
            <span className="line-clamp-1 text-sm font-medium text-[var(--text-primary)]">
              {getDisplayTitle(novel)}
            </span>
            <span className="mt-1 block text-xs text-[var(--text-tertiary)]">{getAuthorName(novel.author)}</span>
            {/* 外层按两行行高精确裁剪 + 内层禁用字体自动放大，避免 QQ/微信 X5 内核漏出被横截的第三行 */}
            <span className="mt-2 block h-10 overflow-hidden">
              <span className="line-clamp-2 max-h-10 text-xs leading-5 text-[var(--text-secondary)]">
                {getNovelSummary(novel.summary)}
              </span>
            </span>
          </span>
        </Link>
      ))}
    </div>
  )
}
