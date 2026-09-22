import { useState } from 'react'
import { Link } from 'react-router-dom'

import AppImage from '@/components/ui/AppImage'
import Avatar from '@/features/community/components/Avatar'
import ImageLightbox from '@/features/studio/components/ImageLightbox'
import DetailCtaRow from '../components/DetailCtaRow'
import DetailStatsRow from '../components/DetailStatsRow'
import { DetailTabContent, DetailTabs } from '../components/DetailTabs'
import RelatedNovelsPanel from '../components/RelatedNovelsPanel'
import {
  formatDetailDateTime,
  formatDetailWordCount,
  novelStatusMap,
  novelVisibilityMap,
  type NovelDetailState,
} from '../useNovelDetailState'

const numberFormatter = new Intl.NumberFormat('zh-CN')

type NovelDetailDesktopProps = {
  state: NovelDetailState
}

/** 电脑端详情页：扁平化排版——封面+信息直接铺在页面上，右栏单容器分组，避免卡片嵌套 */
export default function NovelDetailDesktop({ state }: NovelDetailDesktopProps) {
  const [coverPreviewOpen, setCoverPreviewOpen] = useState(false)
  const {
    detail,
    detailTitle,
    detailCoverUrl,
    authorName,
    authorId,
    detailSummary,
    detailTags,
    summaryExpanded,
    setSummaryExpanded,
    firstPublishedChapter,
    latestPublishedChapter,
    relatedNovels,
  } = state

  if (!detail) {
    return null
  }

  const { author } = detail.novel

  return (
    <div className="grid items-start gap-10 pb-10 pt-2 xl:grid-cols-[minmax(0,1fr)_296px]">
      <div className="min-w-0">
        {/* 书籍主信息：无卡片包裹，直接排布 */}
        <section className="flex gap-8">
          <div className="shrink-0">
            {detailCoverUrl ? (
              <button
                type="button"
                onClick={() => setCoverPreviewOpen(true)}
                className="block cursor-zoom-in"
                aria-label="查看封面大图"
              >
                <AppImage
                  src={detailCoverUrl}
                  alt={detailTitle}
                  priority
                  className="aspect-[20/27] w-[190px] rounded-[var(--radius-lg)] shadow-[0_16px_36px_rgba(17,24,39,0.16)]"
                />
              </button>
            ) : (
              <div className="flex aspect-[20/27] w-[190px] flex-col justify-end rounded-[var(--radius-lg)] bg-[var(--surface-contrast)] p-5 shadow-[0_16px_36px_rgba(17,24,39,0.16)]">
                <p className="text-xs text-[var(--text-contrast)]/70">{authorName}</p>
                <p className="mt-2 text-lg font-semibold text-[var(--text-contrast)]">{detailTitle}</p>
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <h1 className="text-[30px] font-bold leading-tight tracking-tight text-[var(--text-primary)]">
                {detailTitle}
              </h1>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-[var(--text-tertiary)]">
                {authorId ? (
                  <Link
                    to={`/author/${authorId}`}
                    className="text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--color-brand)]"
                  >
                    {authorName}
                  </Link>
                ) : (
                  <span className="text-sm font-medium text-[var(--text-secondary)]">{authorName}</span>
                )}
                <span aria-hidden>·</span>
                <span>{detail.novel.categoryName}</span>
                <span aria-hidden>·</span>
                <span>{novelStatusMap[detail.novel.status]}</span>
                <span aria-hidden>·</span>
                <span>{novelVisibilityMap[detail.novel.visibility]}</span>
              </div>
            </div>

            <DetailStatsRow state={state} />

            <div>
              <p
                className={[
                  'max-w-3xl text-sm leading-7 text-[var(--text-secondary)]',
                  summaryExpanded ? '' : 'line-clamp-3',
                ].join(' ')}
              >
                {detailSummary}
              </p>
              <button
                type="button"
                onClick={() => setSummaryExpanded(!summaryExpanded)}
                className="mt-1 text-sm font-medium text-[var(--color-brand)]"
              >
                {summaryExpanded ? '收起' : '展开全部'}
              </button>
            </div>

            {detailTags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {detailTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-[var(--radius-pill)] bg-[var(--surface-muted)] px-3 py-1 text-xs text-[var(--text-secondary)]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="pt-1">
              <DetailCtaRow state={state} />
            </div>
          </div>
        </section>

        {/* 目录/评论/推荐：贴页面排布，靠 Tab 下划线分区 */}
        <section className="mt-10">
          <DetailTabs state={state} />
          <DetailTabContent state={state} showMeta />
        </section>
      </div>

      <aside className="sticky top-24 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-5 py-4">
        <div className="pb-5">
          <div className="flex items-center gap-3">
            <Avatar name={authorName} src={author.avatarUrl ?? null} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{authorName}</p>
              <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                {numberFormatter.format(author.followerCount)} 关注 · {author.novelCount} 部作品
              </p>
            </div>
            {authorId ? (
              <Link
                to={`/author/${authorId}`}
                className="inline-flex h-8 shrink-0 items-center rounded-[var(--radius-pill)] border border-[var(--border-subtle)] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--color-brand)] hover:text-[var(--color-brand)]"
              >
                主页
              </Link>
            ) : null}
          </div>
        </div>

        <div className="border-t border-[var(--border-subtle)] py-5">
          <p className="text-sm font-semibold text-[var(--text-primary)]">开读信息</p>
          <dl className="mt-3 space-y-2.5 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-[var(--text-tertiary)]">从这里开始</dt>
              <dd className="min-w-0 truncate text-right font-medium text-[var(--text-primary)]">
                {firstPublishedChapter?.title ?? '目录整理中'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-[var(--text-tertiary)]">首章字数</dt>
              <dd className="text-right text-[var(--text-secondary)]">
                {firstPublishedChapter ? formatDetailWordCount(firstPublishedChapter.wordCount) : '稍后再来看看'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-[var(--text-tertiary)]">最新章节</dt>
              <dd className="min-w-0 truncate text-right text-[var(--text-secondary)]">
                {latestPublishedChapter?.title ?? '暂未更新'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-[var(--text-tertiary)]">最近更新</dt>
              <dd className="text-right text-[var(--text-secondary)]">
                {formatDetailDateTime(detail.novel.lastPublishedAt)}
              </dd>
            </div>
          </dl>
        </div>

        <div className="border-t border-[var(--border-subtle)] pt-5">
          <p className="text-sm font-semibold text-[var(--text-primary)]">相关推荐</p>
          <div className="mt-3">
            <RelatedNovelsPanel novels={relatedNovels} variant="list" />
          </div>
        </div>
      </aside>

      {coverPreviewOpen && detailCoverUrl ? (
        <ImageLightbox
          src={detailCoverUrl}
          alt={detailTitle}
          onClose={() => setCoverPreviewOpen(false)}
        />
      ) : null}
    </div>
  )
}
