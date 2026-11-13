import { ArrowDownWideNarrow, ArrowUpNarrowWide, Lock, MoveRight } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import Empty from '@/components/Empty'
import { isPublicReadableChapter } from '@/features/discover/api'
import type { ChapterListItem, VolumeListItem } from '../../../../shared/contracts'

const numberFormatter = new Intl.NumberFormat('zh-CN')

const formatWordCount = (value: number) => {
  if (value >= 10000) {
    const formatted = (Math.round((value / 10000) * 10) / 10).toFixed(1).replace(/\.0$/, '')
    return `${formatted}万字`
  }

  return `${numberFormatter.format(value)} 字`
}

const formatDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value))
    : ''

type ChapterDirectoryProps = {
  chapters: ChapterListItem[]
  volumes: VolumeListItem[]
  novelId: string
  /** 本地阅读进度命中的章节，高亮"在读" */
  currentChapterId: string | null
  /** 紧凑模式（手机端单行） */
  dense?: boolean
  /** 展示更新时间与状态列（桌面端） */
  showMeta?: boolean
  /** 限制最大高度并内部滚动（桌面端侧栏场景） */
  scrollable?: boolean
}

/** 章节目录：序号 + 标题 + 字数/时间，分隔线列表排布，支持正倒序切换与“在读”高亮 */
export default function ChapterDirectory({
  chapters,
  volumes,
  novelId,
  currentChapterId,
  dense = false,
  showMeta = false,
  scrollable = false,
}: ChapterDirectoryProps) {
  const [reversed, setReversed] = useState(false)

  const orderedChapters = useMemo(() => {
    const sorted = [...chapters].sort((left, right) => left.orderIndex - right.orderIndex)
    return reversed ? sorted.reverse() : sorted
  }, [chapters, reversed])

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[var(--text-primary)]">
          章节目录
          <span className="ml-2 text-xs font-normal text-[var(--text-tertiary)]">共 {chapters.length} 章</span>
        </p>
        <button
          type="button"
          onClick={() => setReversed((current) => !current)}
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--border-subtle)] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          aria-label={reversed ? '切换为正序' : '切换为倒序'}
        >
          {reversed ? (
            <ArrowDownWideNarrow className="h-3.5 w-3.5" />
          ) : (
            <ArrowUpNarrowWide className="h-3.5 w-3.5" />
          )}
          {reversed ? '倒序' : '正序'}
        </button>
      </div>

      {chapters.length === 0 ? (
        <div className="mt-4">
          <Empty title="还没有公开章节" />
        </div>
      ) : (
        <div
          className={[
            'mt-2 divide-y divide-[var(--border-subtle)]',
            scrollable ? 'max-h-[calc(100vh-18rem)] overflow-y-auto pr-1' : '',
          ].join(' ')}
        >
          {orderedChapters.map((chapter, index) => {
            const isReadable = isPublicReadableChapter(chapter)
            const isReading = currentChapterId === chapter.id
            const previous = index > 0 ? orderedChapters[index - 1] : null
            const volume = volumes.find((item) => item.id === chapter.volumeId)
            const showVolumeHeading = !previous || previous.volumeId !== chapter.volumeId
            const volumeHeading = showVolumeHeading ? (
              <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-[var(--border-subtle)] bg-[var(--surface-default)]/95 px-1 py-2 backdrop-blur">
                <span className="text-xs font-semibold text-[var(--text-primary)]">{volume ? `第 ${volume.orderIndex} 卷 · ${volume.title}` : '未分卷章节'}</span>
                <span className="text-[10px] text-[var(--text-tertiary)]">卷内目录</span>
              </div>
            ) : null

            if (!isReadable) {
              return (
                <Fragment key={chapter.id}>
                {volumeHeading}
                <div
                  className={[
                    'flex items-center gap-3 opacity-45',
                    dense ? 'py-2.5' : 'py-3',
                  ].join(' ')}
                >
                  <span className="w-7 shrink-0 text-right text-xs tabular-nums text-[var(--text-tertiary)]">
                    {chapter.orderInVolume}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-secondary)]">
                    {chapter.title}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-tertiary)]">
                    <Lock className="h-3.5 w-3.5" />
                    未开放
                  </span>
                </div>
                </Fragment>
              )
            }

            return (
              <Fragment key={chapter.id}>
              {volumeHeading}
              <Link
                to={`/novel/${novelId}/read/${chapter.id}`}
                className={[
                  'group flex items-center gap-3 transition-colors hover:bg-[var(--surface-muted)]',
                  dense ? 'py-2.5' : 'py-3',
                ].join(' ')}
              >
                <span
                  className={[
                    'w-7 shrink-0 text-right text-xs tabular-nums',
                    isReading ? 'font-semibold text-[var(--color-brand)]' : 'text-[var(--text-tertiary)]',
                  ].join(' ')}
                >
                  {chapter.orderInVolume}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span
                      className={[
                        'truncate text-[15px]',
                        isReading ? 'font-semibold text-[var(--color-brand)]' : 'text-[var(--text-primary)]',
                      ].join(' ')}
                    >
                      {chapter.title}
                    </span>
                    {isReading ? (
                      <span className="shrink-0 rounded-[var(--radius-pill)] bg-[var(--color-brand)] px-2 py-0.5 text-[10px] font-medium text-white">
                        在读
                      </span>
                    ) : null}
                  </span>
                  {showMeta ? null : (
                    <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">
                      {formatWordCount(chapter.wordCount)}
                    </span>
                  )}
                </span>
                {showMeta ? (
                  <span className="flex shrink-0 items-center gap-4 text-xs text-[var(--text-tertiary)]">
                    <span className="tabular-nums">{formatWordCount(chapter.wordCount)}</span>
                    <span className="hidden tabular-nums sm:inline">{formatDate(chapter.publishedAt)}</span>
                  </span>
                ) : (
                  <MoveRight
                    className={[
                      'h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5',
                      isReading ? 'text-[var(--color-brand)]' : 'text-[var(--text-tertiary)]',
                    ].join(' ')}
                  />
                )}
              </Link>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
