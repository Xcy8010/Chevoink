import { Heart, Link2, MessageSquareMore, MoreHorizontal, Star, Trash2, UserRoundPlus } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'

import { useToast } from '@/components/ui/toast-context'
import AppImage from '@/components/ui/AppImage'
import { deletePost, setPostBookmark, setPostLike } from '@/features/community/api'
import { patchPostInCaches, removePostFromCaches } from '@/features/community/post-cache'
import Avatar from '@/features/community/components/Avatar'
import AuthorReferenceCard from '@/features/community/components/AuthorReferenceCard'
import NovelReferenceCard from '@/features/community/components/NovelReferenceCard'
import PostImageViewer from '@/features/community/components/PostImageViewer'
import ShareToFriendSheet from '@/features/community/components/ShareToFriendSheet'
import ConfirmDialog from '@/features/studio/components/ConfirmDialog'
import { useShellStore } from '@/store/useShellStore'
import { formatCompactCount, formatRelativeTime } from '@/features/community/utils'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { splitContentByTopics } from '../../../../shared/contracts/index.js'
import type { Post } from '../../../../shared/contracts/index.js'

type PostCardProps = {
  post: Post
  compact?: boolean
  /** 详情页模式：去掉卡片外壳与跳转行为，正文不截断，作为页面主内容平铺展示 */
  flat?: boolean
  timeline?: boolean
}

const TRUNCATE_THRESHOLD = 180

/** 帖子卡片（方案 8.3.3）：人格化头部 + 5 行截断 + 互动栏动效 */
const PostCard = memo(function PostCard({ post, compact = false, flat = false, timeline = false }: PostCardProps) {
  const navigate = useNavigate()
  const { search } = useLocation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [liked, setLiked] = useState(Boolean(post.likedByViewer))
  const [favorited, setFavorited] = useState(Boolean(post.bookmarkedByViewer))
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const [shareSheetOpen, setShareSheetOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const isOwnPost = useShellStore((state) => state.sessionUser?.id === post.author.id)
  const shareMenuRef = useRef<HTMLDivElement>(null)

  // 服务端 viewer 状态刷新后同步本地状态
  useEffect(() => {
    setLiked(Boolean(post.likedByViewer))
  }, [post.likedByViewer])
  useEffect(() => {
    setFavorited(Boolean(post.bookmarkedByViewer))
  }, [post.bookmarkedByViewer])
  useEffect(() => {
    if (!timeline || !shareMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !shareMenuRef.current?.contains(event.target)) {
        setShareMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShareMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [shareMenuOpen, timeline])

  const fullContent = compact ? post.excerpt : post.content
  const shouldTruncate = !flat && !expanded && fullContent.length > TRUNCATE_THRESHOLD
  const imageUrls = post.imageUrls.filter(Boolean)
  // 以服务端计数为基线，叠加本地乐观增量
  const likeCount = Math.max(0, post.likeCount + Number(liked) - Number(Boolean(post.likedByViewer)))
  const favoriteCount = Math.max(0, post.favoriteCount + Number(favorited) - Number(Boolean(post.bookmarkedByViewer)))

  const openDetail = () => navigate(`/post/${post.id}`, timeline ? { state: { communitySearch: search } } : undefined)

  const handleToggleLike = (event: React.MouseEvent) => {
    event.stopPropagation()
    const next = !liked
    setLiked(next)
    setPostLike(post.id, next)
      .then((data) => {
        // 把服务端权威状态写回所有含该帖子的缓存，保证列表与详情页点赞一致
        patchPostInCaches(queryClient, post.id, { likedByViewer: data.liked, likeCount: data.likeCount })
      })
      .catch((error) => {
        setLiked(!next)
        toast.error(error instanceof Error ? error.message : '操作失败，请稍后再试')
      })
  }

  const handleToggleBookmark = (event: React.MouseEvent) => {
    event.stopPropagation()
    const next = !favorited
    setFavorited(next)
    setPostBookmark(post.id, next)
      .then((data) => {
        patchPostInCaches(queryClient, post.id, {
          bookmarkedByViewer: data.bookmarked,
          favoriteCount: data.favoriteCount,
        })
      })
      .catch((error) => {
        setFavorited(!next)
        toast.error(error instanceof Error ? error.message : '操作失败，请稍后再试')
      })
  }

  const handleShare = async (event: React.MouseEvent) => {
    event.stopPropagation()
    setShareMenuOpen(false)
    const url = `${window.location.origin}/post/${post.id}`
    if (await copyToClipboard(url)) {
      toast.success('链接已复制，去分享给朋友吧')
    } else {
      toast.error('复制失败，请手动复制地址栏链接')
    }
  }

  const handleDelete = async () => {
    if (deleting) return
    setDeleting(true)
    try {
      await deletePost(post.id)
      removePostFromCaches(queryClient, post.id)
      toast.success('动态已删除')
      setDeleteConfirmOpen(false)
      // 详情页里删除后直接返回，避免停在已失效的内容页
      if (flat) {
        navigate(-1)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败，请稍后再试')
    } finally {
      setDeleting(false)
    }
  }

  const actionButtonClass = (active: boolean) =>
    cn(
      'press-feedback inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 text-xs transition-colors',
      active ? 'text-[var(--color-brand)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
    )

  const moreActions = (
    <div
      ref={shareMenuRef}
      className={cn('relative shrink-0', timeline && 'mobile:h-6 mobile:w-10')}
    >
      <button
        type="button"
        aria-label="更多操作"
        aria-expanded={shareMenuOpen}
        onClick={(event) => {
          event.stopPropagation()
          setShareMenuOpen((value) => !value)
        }}
        className={cn(
          actionButtonClass(false),
          timeline && 'mobile:absolute mobile:right-0 mobile:top-1/2 mobile:h-11 mobile:w-11 mobile:-translate-y-1/2 mobile:justify-end mobile:px-1.5',
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {shareMenuOpen && !timeline ? (
        <div
          className="fixed inset-0 z-40"
          onClick={(event) => {
            event.stopPropagation()
            setShareMenuOpen(false)
          }}
          aria-hidden
        />
      ) : null}
      {shareMenuOpen ? (
        <div className={cn(
          'absolute right-0 z-50 w-44 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-default)] py-1.5 shadow-[var(--shadow-modal)]',
          timeline ? 'top-full mobile:mt-2.5' : 'bottom-[42px]',
        )}>
          {isOwnPost ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setShareMenuOpen(false)
                setDeleteConfirmOpen(true)
              }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[rgb(153,27,27)] transition-colors hover:bg-[var(--surface-muted)]"
            >
              <Trash2 className="h-4 w-4" />
              删除
            </button>
          ) : null}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setShareMenuOpen(false)
              setShareSheetOpen(true)
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
          >
            <UserRoundPlus className="h-4 w-4 text-[var(--text-secondary)]" />
            发给好友
          </button>
          <button
            type="button"
            onClick={handleShare}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
          >
            <Link2 className="h-4 w-4 text-[var(--text-secondary)]" />
            复制链接
          </button>
        </div>
      ) : null}
    </div>
  )

  const timelineBodyClass = timeline && 'mobile:col-start-2 md:px-5'

  return (
    <article
      onClick={flat ? undefined : openDetail}
      data-community-post={timeline ? post.id : undefined}
      className={cn(
        timeline && 'cursor-pointer motion-reduce:[&_.skeleton-shimmer]:animate-none mobile:grid mobile:grid-cols-[40px_minmax(0,1fr)] mobile:gap-x-3 mobile:px-3 mobile:py-3 mobile:[&_.skeleton-shimmer]:animate-none md:rounded-[var(--radius-lg)] md:border md:border-[var(--border-subtle)] md:bg-[var(--surface-default)] md:pb-3 md:pt-4',
        !flat && !timeline && 'hover-lift cursor-pointer rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-4 shadow-[var(--shadow-card)] sm:p-5',
      )}
    >
      {/* 人格化头部 */}
      <div className={timeline ? 'mobile:contents md:flex md:items-center md:gap-3 md:px-5' : 'flex items-center gap-3'}>
        <Link
          to={`/author/${post.author.id}`}
          aria-label={`查看 ${post.author.nickname} 的主页`}
          onClick={(event) => event.stopPropagation()}
          className={timeline ? 'shrink-0 mobile:row-span-2 mobile:self-start' : undefined}
        >
          <Avatar
            name={post.author.nickname}
            src={post.author.avatarUrl}
            size="md"
            className={timeline ? 'mobile:h-10 mobile:w-10' : undefined}
          />
        </Link>
        <div className={timeline ? 'flex min-w-0 flex-1 items-center gap-1.5 mobile:col-start-2 mobile:min-h-6 md:gap-3' : 'contents'}>
          <div className={cn('min-w-0 flex-1', timeline && 'flex items-baseline gap-1.5 md:gap-2')}>
            {/* 昵称链接收窄到内容宽，右侧空白仍可进入帖子详情。 */}
            <Link
              to={`/author/${post.author.id}`}
              onClick={(event) => event.stopPropagation()}
              className="inline-block max-w-full truncate align-top text-sm font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--color-brand)]"
            >
              {post.author.nickname}
            </Link>
            <time dateTime={post.createdAt} className={cn('text-xs text-[var(--text-tertiary)]', timeline ? 'shrink-0' : 'mt-0.5 block')}>
              {formatRelativeTime(post.createdAt)}
            </time>
          </div>
          {post.topic ? (
            <span className={cn(
              'shrink-0 text-[11px] font-medium text-[var(--color-brand)]',
              timeline ? 'max-w-[25%] truncate' : 'rounded-[var(--radius-pill)] bg-[var(--color-brand-soft)] px-2.5 py-1',
            )}>
              {post.topic.name}
            </span>
          ) : null}
          {timeline ? moreActions : null}
        </div>
      </div>

      {/* 正文：默认 5 行截断 */}
      <div className={cn(timeline ? 'min-w-0 mobile:mt-0.5 md:mt-2.5' : 'mt-3', timelineBodyClass)}>
        <p
          className={cn(
            'whitespace-pre-wrap text-[var(--text-primary)]',
            flat ? 'text-[15px] leading-8' : 'text-sm leading-7',
            timeline && 'break-words',
            shouldTruncate ? 'line-clamp-5' : '',
          )}
        >
          {splitContentByTopics(fullContent).map((segment, index) =>
            segment.type === 'topic' ? (
              <Link
                key={`${index}-${segment.name}`}
                to={`/community/topic/${encodeURIComponent(segment.name)}`}
                onClick={(event) => event.stopPropagation()}
                className="font-medium text-[var(--color-brand)] hover:underline"
              >
                {segment.text}
              </Link>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </p>
        {!flat && fullContent.length > TRUNCATE_THRESHOLD ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setExpanded((value) => !value)
            }}
            className="press-feedback mt-1 text-sm font-medium text-[var(--color-brand)]"
          >
            {expanded ? '收起' : '展开全部'}
          </button>
        ) : null}
      </div>

      {/* 时间流预留媒体尺寸，详情保留自然比例，点击均可全屏查看。 */}
      {imageUrls.length === 1 ? (
        <button
          type="button"
          aria-label="查看配图"
          onClick={(event) => {
            event.stopPropagation()
            setPreviewIndex(0)
          }}
          className={cn(
            'mt-3 block cursor-zoom-in overflow-hidden',
            timeline
              ? 'relative aspect-[16/10] w-full bg-[var(--surface-muted)] [content-visibility:auto] mobile:col-start-2 mobile:rounded-[var(--radius-md)] mobile:border mobile:border-[var(--border-subtle)]'
              : 'w-fit max-w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)]',
          )}
        >
          <AppImage
            src={imageUrls[0]}
            alt="配图 1"
            natural={!timeline}
            fit={timeline ? 'contain' : 'cover'}
            className={timeline ? '!absolute inset-0' : undefined}
            placeholderClassName="aspect-[4/3] h-auto max-h-[340px] w-[260px] max-w-full"
            imgClassName={timeline ? undefined : 'h-auto max-h-[340px] w-auto max-w-full'}
          />
        </button>
      ) : imageUrls.length > 1 ? (
        <div
          className={cn(
            'mt-3 grid',
            imageUrls.length === 2 || imageUrls.length === 4 ? 'grid-cols-2' : 'grid-cols-3',
            timeline
              ? 'gap-0.5 mobile:col-start-2 mobile:overflow-hidden mobile:rounded-[var(--radius-md)] mobile:border mobile:border-[var(--border-subtle)]'
              : cn('gap-1.5', imageUrls.length === 2 || imageUrls.length === 4 ? 'max-w-[300px]' : 'max-w-[440px]'),
          )}
        >
          {imageUrls.map((url, index) => (
            <button
              key={`${index}-${url}`}
              type="button"
              aria-label={`查看第 ${index + 1} 张配图`}
              onClick={(event) => {
                event.stopPropagation()
                setPreviewIndex(index)
              }}
              className={cn(
                'block cursor-zoom-in overflow-hidden',
                timeline
                  ? 'relative aspect-square bg-[var(--surface-muted)] [content-visibility:auto]'
                  : 'rounded-[var(--radius-md)] border border-[var(--border-subtle)]',
              )}
            >
              <AppImage
                src={url}
                alt={`配图 ${index + 1}`}
                fit={timeline ? 'contain' : 'cover'}
                className={timeline ? '!absolute inset-0' : 'aspect-square h-full w-full'}
              />
            </button>
          ))}
        </div>
      ) : null}

      {post.relatedNovel ? (
        <div className={cn('mt-3 min-w-0', timelineBodyClass)} onClick={(event) => event.stopPropagation()}>
          <NovelReferenceCard novel={post.relatedNovel} />
        </div>
      ) : null}

      {post.sharedUser ? (
        <div className={cn('mt-3 min-w-0', timelineBodyClass)} onClick={(event) => event.stopPropagation()}>
          <AuthorReferenceCard author={post.sharedUser} />
        </div>
      ) : null}

      {/* 互动栏 */}
      <div className={cn('flex items-center justify-between', timeline ? 'mt-2' : 'mt-3 border-t border-[var(--border-subtle)] pt-2', timelineBodyClass)}>
        <div className={cn('flex items-center gap-1', timeline && 'mobile:-ml-2.5')}>
          <button
            type="button"
            aria-label="点赞"
            onClick={handleToggleLike}
            className={actionButtonClass(liked)}
          >
            <Heart
              className={cn(
                'h-4 w-4 transition-transform [transition-duration:var(--duration-fast)]',
                liked ? 'scale-125 fill-[var(--color-brand)]' : '',
              )}
            />
            {formatCompactCount(likeCount)}
          </button>
          <button
            type="button"
            aria-label="评论"
            onClick={(event) => {
              event.stopPropagation()
              openDetail()
            }}
            className={actionButtonClass(false)}
          >
            <MessageSquareMore className="h-4 w-4" />
            {formatCompactCount(post.commentCount)}
          </button>
          <button
            type="button"
            aria-label="收藏"
            onClick={handleToggleBookmark}
            className={actionButtonClass(favorited)}
          >
            <Star
              className={cn(
                'h-4 w-4 transition-transform [transition-duration:var(--duration-fast)]',
                favorited ? 'scale-125 fill-[var(--color-brand)]' : '',
              )}
            />
            {formatCompactCount(favoriteCount)}
          </button>
        </div>
        {timeline ? null : moreActions}
      </div>

      {shareSheetOpen ? (
        <span onClick={(event) => event.stopPropagation()}>
          <ShareToFriendSheet
            message={{
              type: 'postCard',
              content: `分享帖子：${(post.excerpt || post.content).replace(/\s+/g, ' ').slice(0, 60)}`,
              relatedId: String(post.id),
            }}
            onClose={() => setShareSheetOpen(false)}
          />
        </span>
      ) : null}

      {previewIndex !== null && imageUrls.length > 0 ? (
        <PostImageViewer images={imageUrls} initialIndex={previewIndex} onClose={() => setPreviewIndex(null)} />
      ) : null}

      {/* 弹窗经 portal 渲染到 body，但 React 事件仍会沿虚拟 DOM 冒泡到卡片的 openDetail，
          这里阻断冒泡，避免点确认/取消时同时跳转帖子详情 */}
      {deleteConfirmOpen ? (
        <span onClick={(event) => event.stopPropagation()}>
          <ConfirmDialog
            open={deleteConfirmOpen}
            title="确认删除这条动态"
            description="删除后，这条动态及其评论、点赞、收藏都会一起移除，且无法恢复。确定要删除吗？"
            confirmLabel="确定删除"
            cancelLabel="取消"
            tone="danger"
            busy={deleting}
            onConfirm={() => void handleDelete()}
            onCancel={() => {
              if (!deleting) setDeleteConfirmOpen(false)
            }}
          />
        </span>
      ) : null}
    </article>
  )
})

export default PostCard
