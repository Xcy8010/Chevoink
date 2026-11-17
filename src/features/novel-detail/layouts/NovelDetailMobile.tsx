import { ChevronLeft, ChevronRight, PenLine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import AppImage from '@/components/ui/AppImage'
import Avatar from '@/features/community/components/Avatar'
import ImageLightbox from '@/features/studio/components/ImageLightbox'
import DetailCtaRow from '../components/DetailCtaRow'
import DetailStatsRow from '../components/DetailStatsRow'
import { DetailTabContent, DetailTabs } from '../components/DetailTabs'
import { novelStatusMap, type NovelDetailState } from '../useNovelDetailState'

type NovelDetailMobileProps = {
  state: NovelDetailState
}

/** 手机端详情页：竖版封面完整显示（模糊底图烘托），信息右排 + 底部固定操作栏 */
export default function NovelDetailMobile({ state }: NovelDetailMobileProps) {
  const [coverPreviewOpen, setCoverPreviewOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  // 返回防跌回阅读器：旧版历史栈可能把阅读器条目留在作品页前一条，
  // 回退落地后若仍是阅读器路由则继续回退，直到离开阅读器段
  const skipReaderRef = useRef(false)
  useEffect(() => {
    if (!skipReaderRef.current) return
    skipReaderRef.current = false
    if (!/^\/novel\/[^/]+\/read\//.test(location.pathname)) return
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) {
      skipReaderRef.current = true
      navigate(-1)
    } else {
      navigate('/', { replace: true })
    }
  }, [location, navigate])
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
    canEditNovelPage,
    setIsEditing,
  } = state

  if (!detail) {
    return null
  }

  // 左上返回：有站内历史则回退，否则兜底回首页（深链直接进入时 history 无站内记录）
  const handleBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) {
      skipReaderRef.current = true
      navigate(-1)
    } else {
      navigate('/')
    }
  }

  return (
    <div className="pb-40">
      {/* 左上返回：hero 容器之外，与帖子详情同款灰色箭头+文字（无圆形容器）；
          不用负外边距，整体稍右移避免被左侧安全区裁切 */}
      <button
        type="button"
        onClick={handleBack}
        className="press-feedback mb-2 inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-1.5 py-1 text-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
      >
        <ChevronLeft className="h-4 w-4" />
        返回
      </button>

      {/* hero：封面按 20:27 原比例完整展示，不再被横向 banner 裁切 */}
      <section className="relative -mx-4 overflow-hidden">
        {detailCoverUrl ? (
          <>
            <div
              aria-hidden
              className="absolute inset-0 scale-125 bg-cover bg-center blur-2xl"
              style={{ backgroundImage: `url(${detailCoverUrl})` }}
            />
            <div aria-hidden className="absolute inset-0 bg-black/60" />
          </>
        ) : (
          <div aria-hidden className="absolute inset-0 bg-[linear-gradient(135deg,var(--color-brand)_0%,#16233a_100%)]" />
        )}

        {canEditNovelPage ? (
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="absolute right-4 top-3 z-10 inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-pill)] border border-white/25 bg-black/30 px-3 text-xs font-medium text-white backdrop-blur transition-colors hover:bg-black/45"
          >
            <PenLine className="h-3.5 w-3.5" />
            编辑
          </button>
        ) : null}

        {/* 左内边距比常规多 4px：封面稍右移，避免贴左侧安全区被裁切 */}
        <div className="relative flex gap-4 pb-5 pl-5 pr-4 pt-6">
          {detailCoverUrl ? (
            <button
              type="button"
              onClick={() => setCoverPreviewOpen(true)}
              className="block shrink-0 self-start cursor-zoom-in"
              aria-label="查看封面大图"
            >
              <AppImage
                src={detailCoverUrl}
                alt={detailTitle}
                priority
                className="aspect-[20/27] w-[108px] rounded-[10px] shadow-[0_10px_26px_rgba(0,0,0,0.45)]"
              />
            </button>
          ) : (
            <div className="flex aspect-[20/27] w-[108px] shrink-0 flex-col justify-end self-start rounded-[10px] bg-white/12 p-3">
              <p className="text-[15px] font-semibold leading-snug text-white">{detailTitle}</p>
            </div>
          )}

          <div className="min-w-0 flex-1 self-center">
            <h1 className="text-xl font-bold leading-snug text-white">{detailTitle}</h1>
            {/* 作者信息块：头像 + 名字 + 箭头，整块可点进入作者主页 */}
            {authorId ? (
              <Link
                to={`/author/${authorId}`}
                className="press-feedback mt-2 inline-flex max-w-full items-center gap-2 rounded-[var(--radius-pill)] bg-white/12 py-1 pl-1 pr-2.5 backdrop-blur transition-colors hover:bg-white/20"
              >
                <Avatar
                  name={authorName}
                  src={detail.novel.author.avatarUrl}
                  size="sm"
                  className="h-6 w-6 border-white/25"
                />
                <span className="truncate text-sm text-white/90">{authorName}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/60" />
              </Link>
            ) : (
              <p className="mt-1.5 text-sm text-white/85">{authorName}</p>
            )}
            <p className="mt-2 text-xs text-white/70">
              {detail.novel.categoryName} · {novelStatusMap[detail.novel.status]}
            </p>
          </div>
        </div>
      </section>

      <div className="mt-4 space-y-5">
        <DetailStatsRow state={state} />

        <div>
          <p
            className={[
              'text-sm leading-7 text-[var(--text-secondary)]',
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

          {detailTags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
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
        </div>

        <div>
          <DetailTabs state={state} />
          <DetailTabContent state={state} dense />
        </div>
      </div>

      {/* 全局底栏在本路由隐藏：操作栏直接贴底（含安全区），不再为底栏让位 */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-subtle)] bg-[color:var(--surface-default)]/96 px-4 pb-[calc(10px+var(--bottom-bar-inset))] pt-2.5 backdrop-blur">
        <DetailCtaRow state={state} compact />
      </div>

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
