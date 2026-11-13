import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, MessageSquareText, UserRound } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'

import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import AppImage from '@/components/ui/AppImage'
import {
  getAuthorName,
  getCoverUrl,
  getDisplayTitle,
  getNovelSummary,
  getPostExcerpt,
} from '@/features/discover/api'
import { searchAll } from '@/features/search/api'
import { cn } from '@/lib/utils'
import { formatWordCount } from '@/features/home/utils'
import type { NovelCard, Post, UserSummary } from '../../shared/contracts/index.js'

type ResultTabId = 'all' | 'novel' | 'author' | 'post'

const STATUS_LABEL: Record<string, string> = {
  published: '连载中',
  completed: '完结',
  archived: '已下架',
  draft: '草稿',
}

function NovelResultRow({ novel }: { novel: NovelCard }) {
  const cover = getCoverUrl(novel.coverUrl)

  return (
    <Link to={`/novel/${novel.id}`} className="group flex gap-4 py-4">
      {cover ? (
        <AppImage src={cover} alt={getDisplayTitle(novel)} className="h-[112px] w-[84px] shrink-0 rounded-md" />
      ) : (
        <div className="flex h-[112px] w-[84px] shrink-0 items-end rounded-md bg-[var(--surface-muted)] p-2">
          <p className="line-clamp-3 text-xs font-medium text-[var(--text-secondary)]">{getDisplayTitle(novel)}</p>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-1 text-base font-semibold text-[var(--text-primary)] transition-colors group-hover:text-[var(--color-brand)]">
          {getDisplayTitle(novel)}
        </h3>
        <p className="mt-1.5 line-clamp-2 text-sm leading-6 text-[var(--text-secondary)]">{getNovelSummary(novel.summary)}</p>
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">
          {getAuthorName(novel.author)} · {STATUS_LABEL[novel.status] ?? novel.status} · {formatWordCount(novel.wordCount)} · {novel.chapterCount} 章
        </p>
      </div>
    </Link>
  )
}

function AuthorResultRow({ author }: { author: UserSummary }) {
  return (
    <Link to={`/author/${author.id}`} className="group flex items-center gap-4 py-4">
      {author.avatarUrl ? (
        <img src={author.avatarUrl} alt={author.nickname} className="h-12 w-12 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)]">
          <UserRound className="h-5 w-5 text-[var(--text-tertiary)]" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--text-primary)] transition-colors group-hover:text-[var(--color-brand)]">
          {author.nickname}
        </p>
        <p className="mt-0.5 line-clamp-1 text-xs text-[var(--text-tertiary)]">{author.bio?.trim() || '这位作者还没有填写简介。'}</p>
      </div>
      <span className="shrink-0 rounded-[var(--radius-pill)] border border-[var(--border-subtle)] px-3 py-1 text-xs text-[var(--text-secondary)]">
        查看主页
      </span>
    </Link>
  )
}

function PostResultRow({ post }: { post: Post }) {
  return (
    <Link to={`/post/${post.id}`} className="group block py-4">
      <p className="line-clamp-2 text-sm leading-6 text-[var(--text-primary)] transition-colors group-hover:text-[var(--color-brand)]">
        {getPostExcerpt(post)}
      </p>
      <p className="mt-2 text-xs text-[var(--text-tertiary)]">
        {post.author.nickname} · {post.likeCount} 赞 · {post.commentCount} 评论
      </p>
    </Link>
  )
}

/** 全局搜索结果页：/search?q=keyword */
export default function SearchPage() {
  const [searchParams] = useSearchParams()
  const keyword = (searchParams.get('q') ?? '').trim()
  const [activeTab, setActiveTab] = useState<ResultTabId>('all')

  const query = useQuery({
    queryKey: ['search', keyword],
    queryFn: () => searchAll(keyword),
    enabled: keyword.length > 0,
  })

  const novels = useMemo(() => query.data?.novels ?? [], [query.data])
  const authors = useMemo(() => query.data?.authors ?? [], [query.data])
  const posts = useMemo(() => query.data?.posts ?? [], [query.data])
  const total = novels.length + authors.length + posts.length

  const tabs: Array<{ id: ResultTabId; label: string; count: number }> = [
    { id: 'all', label: '全部', count: total },
    { id: 'novel', label: '作品', count: novels.length },
    { id: 'author', label: '用户', count: authors.length },
    { id: 'post', label: '讨论', count: posts.length },
  ]

  if (!keyword) {
    return (
      <AppState
        scene="search"
        title="输入关键词开始搜索"
        description="可搜索书名、作者昵称或讨论。"
      />
    )
  }

  if (query.isLoading) {
    return <AppState tone="loading" title="正在搜索..." description={`正在为你查找与「${keyword}」相关的内容。`} />
  }

  if (query.isError && !query.data) {
    return (
      <AppState
        tone="error"
        title="搜索失败"
        description="请检查连接后重试。"
        primaryAction={{ label: '重新搜索', onClick: () => query.refetch(), busy: query.isFetching }}
      />
    )
  }

  const showNovels = (activeTab === 'all' || activeTab === 'novel') && novels.length > 0
  const showAuthors = (activeTab === 'all' || activeTab === 'author') && authors.length > 0
  const showPosts = (activeTab === 'all' || activeTab === 'post') && posts.length > 0
  const showEmpty = !showNovels && !showAuthors && !showPosts

  return (
    <div
      data-app-state-layout={showEmpty ? '' : undefined}
      className={cn('mx-auto w-full max-w-3xl space-y-6', showEmpty && 'flex min-h-0 flex-col')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'rounded-[var(--radius-pill)] px-4 py-1.5 text-sm transition-colors',
              activeTab === tab.id
                ? 'bg-[var(--color-brand)] font-semibold text-white'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            {tab.label}
            {tab.count > 0 ? <span className="ml-1 text-xs opacity-80">{tab.count}</span> : null}
          </button>
        ))}
      </div>
      {query.isError ? <AppStateRefreshNotice retry={query.refetch} busy={query.isFetching} /> : null}
      {showEmpty ? (
        <AppState
          scene="search"
          title={total === 0 ? `未找到「${keyword}」的结果` : `此分类中未找到「${keyword}」`}
          description={total === 0 ? '换个关键词试试。' : undefined}
          primaryAction={total > 0 ? { label: '查看全部结果', onClick: () => setActiveTab('all') } : { label: '去发现', href: '/discover' }}
          className="min-h-0 flex-1 md:min-h-0"
        />
      ) : null}

      {showNovels ? (
        <section>
          <h2 className="inline-flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
            <BookOpen className="h-5 w-5 text-[var(--text-tertiary)]" />
            相关作品
          </h2>
          <div className="mt-1 divide-y divide-[var(--border-subtle)]">
            {novels.map((novel) => (
              <NovelResultRow key={novel.id} novel={novel} />
            ))}
          </div>
        </section>
      ) : null}

      {showAuthors ? (
        <section>
          <h2 className="inline-flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
            <UserRound className="h-5 w-5 text-[var(--text-tertiary)]" />
            相关用户
          </h2>
          <div className="mt-1 divide-y divide-[var(--border-subtle)]">
            {authors.map((author) => (
              <AuthorResultRow key={author.id} author={author} />
            ))}
          </div>
        </section>
      ) : null}

      {showPosts ? (
        <section>
          <h2 className="inline-flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
            <MessageSquareText className="h-5 w-5 text-[var(--text-tertiary)]" />
            相关讨论
          </h2>
          <div className="mt-1 divide-y divide-[var(--border-subtle)]">
            {posts.map((post) => (
              <PostResultRow key={post.id} post={post} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
