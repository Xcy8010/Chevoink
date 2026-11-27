import { BookOpen, Bookmark, BookmarkCheck, ChevronLeft, Heart, Link2, MoreHorizontal, PenLine, Send, Share2, UserRoundPlus } from 'lucide-react'
import ReportAction from '@/features/governance/ReportAction'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import ShareMenu from '@/features/community/components/ShareMenu'
import ShareToFriendSheet from '@/features/community/components/ShareToFriendSheet'
import type { CommunityShareDraft } from '@/features/community/share'
import type { NovelDetailState } from '../useNovelDetailState'

type DetailCtaRowProps = {
  state: NovelDetailState
  /** compact：手机底部固定操作栏模式（仅核心操作） */
  compact?: boolean
}

const secondaryButtonClass =
  'press-feedback inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-[var(--radius-pill)] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)]'

/** 作品操作组：开始阅读/继续阅读 + 加入书架 + 收藏 + 分享（+编辑/返回创作区）；
 * compact 模式下收藏与分享收进右侧 … 菜单，底栏只保留核心动作 */
export default function DetailCtaRow({ state, compact = false }: DetailCtaRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [friendSheetOpen, setFriendSheetOpen] = useState(false)
  const {
    novelId,
    navigate,
    detailTitle,
    detailCoverUrl,
    fromStudio,
    backHref,
    canEditNovelPage,
    setIsEditing,
    firstPublishedChapter,
    isStartingThis,
    readingProgress,
    inShelf,
    favoritedByViewer,
    handleContinueReading,
    handleToggleShelf,
    handleToggleFavorite,
    handleShare,
  } = state

  // 分享草稿：跳社区发帖时自动附上作品卡片
  const shareDraft: CommunityShareDraft | null = novelId
    ? { kind: 'novel', novel: { id: novelId, title: detailTitle, coverUrl: detailCoverUrl } }
    : null

  const primaryLabel = !firstPublishedChapter
    ? '暂未开放阅读'
    : isStartingThis
      ? '正在打开...'
      : readingProgress
        ? '继续阅读'
        : '开始阅读'

  return (
    <div className={compact ? 'flex items-center gap-2' : 'flex flex-wrap items-center gap-3'}>
      {fromStudio && !compact ? (
        <Link to={backHref} className={secondaryButtonClass + ' flex-none'}>
          <ChevronLeft className="h-4 w-4" />
          返回创作区
        </Link>
      ) : null}
      {canEditNovelPage && !compact ? (
        <button type="button" onClick={() => setIsEditing(true)} className={secondaryButtonClass + ' flex-none'}>
          <PenLine className="h-4 w-4" />
          编辑作品页
        </button>
      ) : null}

      <button
        type="button"
        onClick={handleToggleShelf}
        className={[
          secondaryButtonClass,
          inShelf ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : '',
        ].join(' ')}
        aria-pressed={inShelf}
      >
        {inShelf ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
        {inShelf ? '已在书架' : '加入书架'}
      </button>

      {compact ? null : (
        <button
          type="button"
          onClick={handleToggleFavorite}
          className={[secondaryButtonClass, favoritedByViewer ? 'border-rose-300 text-rose-500' : ''].join(' ')}
          aria-pressed={favoritedByViewer}
        >
          <Heart className={favoritedByViewer ? 'h-4 w-4 fill-rose-500 text-rose-500' : 'h-4 w-4'} />
          {favoritedByViewer ? '已收藏' : '收藏'}
        </button>
      )}

      <button
        type="button"
        onClick={handleContinueReading}
        disabled={!firstPublishedChapter || isStartingThis}
        className="press-feedback inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-[var(--radius-pill)] bg-[var(--color-brand)] px-5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand-hover)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <BookOpen className="h-4 w-4" />
        {primaryLabel}
      </button>

      {compact ? (
        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            className="press-feedback inline-flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            aria-label="更多操作"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>

          {menuOpen ? (
            <>
              {/* 透明遮罩：点菜单外任意处收起 */}
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
              <div className="absolute bottom-[52px] right-0 z-50 w-44 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-default)] py-1.5 shadow-[var(--shadow-modal)]">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    handleToggleFavorite()
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
                >
                  <Heart
                    className={favoritedByViewer ? 'h-4 w-4 fill-rose-500 text-rose-500' : 'h-4 w-4 text-[var(--text-secondary)]'}
                  />
                  {favoritedByViewer ? '取消收藏' : '收藏作品'}
                </button>
                {shareDraft ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      setFriendSheetOpen(true)
                    }}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
                  >
                    <UserRoundPlus className="h-4 w-4 text-[var(--text-secondary)]" />
                    发给好友
                  </button>
                ) : null}
                {shareDraft ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/community', { state: { share: shareDraft } })
                    }}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
                  >
                    <Send className="h-4 w-4 text-[var(--text-secondary)]" />
                    分享到社区
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    void handleShare()
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
                >
                  <Link2 className="h-4 w-4 text-[var(--text-secondary)]" />
                  复制链接
                </button>
                {novelId && <ReportAction target={{kind:'novel',id:novelId}} onOpen={()=>setMenuOpen(false)}/>}
              </div>
            </>
          ) : null}
        </div>
      ) : shareDraft ? (
        <ShareMenu
          share={shareDraft}
          url={`${window.location.origin}/novel/${novelId}`}
          wrapperClassName="flex-none"
          placement="down"
          triggerClassName="press-feedback inline-flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          triggerContent={<MoreHorizontal className="h-4 w-4" />}
          ariaLabel="作品更多操作"
        />
      ) : (
        <button
          type="button"
          onClick={() => void handleShare()}
          className="press-feedback inline-flex h-11 w-11 flex-none items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          aria-label="分享这本书"
        >
          <Share2 className="h-4 w-4" />
        </button>
      )}

      {friendSheetOpen && novelId ? (
        <ShareToFriendSheet
          message={{ type: 'novelCard', content: `分享作品《${detailTitle}》`, relatedId: String(novelId) }}
          onClose={() => setFriendSheetOpen(false)}
        />
      ) : null}
    </div>
  )
}
