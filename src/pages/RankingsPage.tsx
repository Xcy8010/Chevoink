import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, LoaderCircle } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { ApiClientError } from '@/app/api-client'
import AppImage from '@/components/ui/AppImage'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { RankingsSkeleton } from '@/components/ui/Skeleton'
import { asArray, getAuthorName, getCoverUrl, getDisplayTitle, listNovels } from '@/features/discover/api'
import { RANKING_BOARDS, CATEGORY_RANKING_TAGS, buildBoardNovels, buildCategoryBoardNovels } from '@/features/discover/ranking'
import { useStartReading } from '@/features/discover/useStartReading'
import '@/features/discover/rankings.css'

export default function RankingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const boardParam = searchParams.get('board')
  // 分类榜沿用 ?board=科幻 等直接链接。
  const category = CATEGORY_RANKING_TAGS.find(tag => tag === boardParam) ?? ''
  const board = RANKING_BOARDS.find(entry => entry.id === boardParam) ?? RANKING_BOARDS[0]
  const boardLabel = category ? `${category}榜` : board.label

  const novelsQuery = useQuery({
    queryKey: ['rankings-novels'],
    queryFn: () => listNovels({ page: 1, pageSize: 60, publishedOnly: true }),
  })
  const { startReading, isStarting, pendingNovelId } = useStartReading()
  const allNovels = useMemo(
    () => asArray(novelsQuery.data?.items).filter(novel => novel.status !== 'draft'),
    [novelsQuery.data],
  )
  const boardNovels = useMemo(
    () => category ? buildCategoryBoardNovels(category, allNovels, 20) : buildBoardNovels(board.id, allNovels, 20),
    [board.id, category, allNovels],
  )

  function selectBoard(id: string) {
    setSearchParams(id === 'hot' ? {} : { board: id })
  }

  if (novelsQuery.isLoading) return <RankingsSkeleton />

  if (novelsQuery.isError && !novelsQuery.data) {
    const unavailable = novelsQuery.error instanceof ApiClientError && novelsQuery.error.status === 404
    return (
      <AppState
        tone="error"
        title={unavailable ? '榜单暂不可用' : '榜单暂时没有打开'}
        description={unavailable ? undefined : '请检查连接后重试。'}
        primaryAction={{ label: '重新加载', onClick: () => novelsQuery.refetch(), busy: novelsQuery.isFetching }}
      />
    )
  }

  return (
    <div className="rankings-page">
      <h1 className="sr-only">作品榜单</h1>
      <div className="rankings-controls">
        <nav className="rankings-boards" aria-label="榜单类型">
          {RANKING_BOARDS.map(entry => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={!category && entry.id === board.id}
              onClick={() => selectBoard(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <label className="rankings-category">
          <span className="sr-only">分类榜</span>
          <select value={category} onChange={event => selectBoard(event.target.value || board.id)}>
            <option value="">分类榜</option>
            {CATEGORY_RANKING_TAGS.map(tag => <option key={tag} value={tag}>{tag}榜</option>)}
          </select>
        </label>
      </div>

      {novelsQuery.isError && <AppStateRefreshNotice retry={novelsQuery.refetch} busy={novelsQuery.isFetching} />}
      {boardNovels.length === 0 ? (
        <AppState
          className="rankings-empty"
          scene={allNovels.length === 0 ? 'reading' : 'search'}
          title={allNovels.length === 0 ? '暂无上榜作品' : '当前榜单暂无作品'}
          primaryAction={allNovels.length === 0
            ? { label: '去发现', href: '/discover' }
            : { label: '查看热门榜', onClick: () => selectBoard('hot') }}
        />
      ) : (
        <ol className="rankings-list" aria-label={boardLabel}>
          {boardNovels.map((novel, index) => {
            const title = getDisplayTitle(novel)
            const author = getAuthorName(novel.author)
            const cover = getCoverUrl(novel.coverUrl)
            const detail = `/novel/${novel.id}`
            const pending = isStarting && pendingNovelId === novel.id
            const coverFallback = <span className="rankings-cover-fallback"><span>{title}</span></span>
            return (
              <li key={novel.id} className="rankings-row">
                <span className="rankings-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <Link to={detail} className="rankings-cover" tabIndex={-1} aria-label={`查看《${title}》详情`}>
                  {cover ? (
                    <AppImage src={cover} alt="" className="h-full w-full" priority={index < 3} fallback={coverFallback} />
                  ) : coverFallback}
                </Link>
                <div className="rankings-copy">
                  <h2><Link to={detail}>{title}</Link></h2>
                  <p className="rankings-author">{author}</p>
                  {novel.summary?.trim() && <p className="rankings-summary">{novel.summary.trim()}</p>}
                </div>
                <button
                  type="button"
                  className="rankings-read"
                  onClick={() => startReading(novel.id)}
                  aria-label={`${pending ? '正在打开' : '阅读'}《${title}》`}
                  disabled={isStarting}
                >
                  {pending ? '打开中' : '阅读'}
                  {pending ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <ArrowUpRight aria-hidden="true" />}
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
