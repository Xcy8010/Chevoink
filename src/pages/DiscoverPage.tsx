import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, ChevronRight, LoaderCircle, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import AppImage from '@/components/ui/AppImage'
import { DiscoverSkeleton } from '@/components/ui/Skeleton'
import { asArray, getAuthorName, getCoverUrl, getDisplayTitle, getNovelSummary, getSafeTags, listNovels } from '@/features/discover/api'
import { buildBoardNovels, hotScore } from '@/features/discover/ranking'
import { useForYouRecommendations } from '@/features/discover/useForYouRecommendations'
import { useStartReading } from '@/features/discover/useStartReading'
import { formatWordCount } from '@/features/home/utils'
import type { NovelCard } from '../../shared/contracts/index.js'
import '@/features/discover/discover-gallery.css'

const sortTabs = [
  { id: 'all', label: '综合推荐' }, { id: 'updated', label: '最近更新' },
  { id: 'wordCount', label: '长篇优先' }, { id: 'chapterCount', label: '章节更多' },
] as const

function BookCover({ novel, priority = false }: { novel: NovelCard; priority?: boolean }) {
  const cover = getCoverUrl(novel.coverUrl)
  const fallback = <span className="discover-cover-fallback"><span>{getDisplayTitle(novel)}</span><small>{getAuthorName(novel.author)}</small></span>
  return <span className="discover-book-cover">{cover
    ? <AppImage src={cover} alt={getDisplayTitle(novel)} className="h-full w-full" priority={priority} fallback={fallback} />
    : fallback}</span>
}

export default function DiscoverPage() {
  const [sortBy, setSortBy] = useState<(typeof sortTabs)[number]['id']>('all')
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTag = searchParams.get('tag')
  const novelsQuery = useQuery({
    queryKey: ['discover-novels'],
    queryFn: () => listNovels({ page: 1, pageSize: 24, publishedOnly: true }),
  })
  const { startReading, isStarting, pendingNovelId } = useStartReading()
  const allNovels = asArray(novelsQuery.data?.items).filter(novel => novel.status !== 'draft')
  const novels = activeTag ? allNovels.filter(novel => getSafeTags(novel.tags).includes(activeTag)) : allNovels
  const sortedNovels = [...novels].sort((left, right) => {
    if (sortBy === 'updated') return new Date(right.lastPublishedAt ?? right.updatedAt).getTime() - new Date(left.lastPublishedAt ?? left.updatedAt).getTime()
    if (sortBy === 'wordCount') return right.wordCount - left.wordCount
    if (sortBy === 'chapterCount') return right.chapterCount - left.chapterCount
    return hotScore(right) - hotScore(left)
  })
  const gallery = sortedNovels.slice(0, 6)
  const tags = [...new Set(allNovels.flatMap(novel => getSafeTags(novel.tags)))].slice(0, 8)
  if (activeTag && !tags.includes(activeTag)) tags.push(activeTag)
  const forYou = useForYouRecommendations({ fallbackPool: novels, excludeIds: gallery.map(novel => novel.id) })
  const freshNovels = buildBoardNovels('new', novels, 6)
  const popularNovels = buildBoardNovels('popular', novels, 5)

  function selectTag(tag: string | null) {
    const next = new URLSearchParams(searchParams)
    if (tag) next.set('tag', tag)
    else next.delete('tag')
    setSearchParams(next)
  }

  if (novelsQuery.isLoading) return <DiscoverSkeleton />
  if (novelsQuery.isError && !novelsQuery.data) return (
    <AppState tone="error" title="暂时连不上书库" description="请稍后再试。" primaryAction={{ label: '重新连接', onClick: () => novelsQuery.refetch() }} />
  )
  if (allNovels.length === 0) return (
    <AppState scene="reading" title="书库还在等待新的故事" description="稍后再来看看。" primaryAction={{ label: '回到首页', href: '/' }} />
  )

  return (
    <div className="discover-gallery-page">
      <h1 className="sr-only">发现好书</h1>
      <div className="discover-controls">
        <div className="discover-categories" aria-label="作品分类">
          {[null, ...tags].map(tag => <button key={tag ?? 'all'} type="button" aria-pressed={activeTag === tag} onClick={() => selectTag(tag)}>{tag ?? '全部'}</button>)}
        </div>
        <label className="discover-sort"><span className="sr-only">作品排序</span>
          <select value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)}>{sortTabs.map(tab => <option key={tab.id} value={tab.id}>{tab.label}</option>)}</select>
        </label>
      </div>
      {novelsQuery.isError && <AppStateRefreshNotice retry={() => novelsQuery.refetch()} busy={novelsQuery.isFetching} />}
      {novels.length === 0 ? (
        <AppState scene="search" title="这个分类还没有作品" description="换个分类，继续挑一本好书。" primaryAction={{ label: '查看全部', onClick: () => selectTag(null) }} />
      ) : <>
        <section className="discover-gallery" aria-label="发现好书">
          <div className="discover-gallery-books" key={(activeTag ?? 'all') + ':' + sortBy}>
            {gallery.map((novel, index) => <article className="discover-gallery-book" key={novel.id}>
              <Link to={'/novel/' + novel.id} className="discover-cover-link" aria-label={'查看《' + getDisplayTitle(novel) + '》'}><BookCover novel={novel} priority={index < 3} /></Link>
              <div className="discover-book-caption"><Link to={'/novel/' + novel.id}><h2>{getDisplayTitle(novel)}</h2></Link><p>{getAuthorName(novel.author)}</p></div>
              <div className="discover-book-peek">
                <p>{getNovelSummary(novel.summary)}</p>
                <button type="button" onClick={() => startReading(novel.id)} disabled={isStarting}>
                  {isStarting && pendingNovelId === novel.id ? <LoaderCircle className="motion-safe:animate-spin" /> : <ArrowUpRight />}
                  {isStarting && pendingNovelId === novel.id ? '正在打开' : '开始阅读'}
                </button>
              </div>
            </article>)}
          </div>
        </section>
        {forYou.items.length > 0 && <section className="discover-section" aria-labelledby="discover-for-you">
          <div className="discover-section-heading"><h2 id="discover-for-you">为你推荐</h2></div>
          <div className="discover-recommendations">
            {forYou.items.map(({ novel, reason }) => <article className="discover-recommendation" key={novel.id}>
              <Link to={'/novel/' + novel.id} onClick={() => forYou.reportClick(novel.id)} className="discover-recommendation-cover"><BookCover novel={novel} /></Link>
              <div className="discover-recommendation-copy">
                <Link to={'/novel/' + novel.id} onClick={() => forYou.reportClick(novel.id)}><h3>{getDisplayTitle(novel)}</h3></Link>
                <p className="discover-book-meta">{getAuthorName(novel.author)} · {formatWordCount(novel.wordCount)}</p>
                <p className="discover-book-summary">{getNovelSummary(novel.summary)}</p>
                {reason && <p className="discover-reason">{reason}</p>}
                <button className="discover-read-link" type="button" disabled={isStarting} onClick={() => { forYou.reportClick(novel.id); startReading(novel.id) }}>
                  {isStarting && pendingNovelId === novel.id ? '正在打开…' : '开始阅读'}<ChevronRight size={14} />
                </button>
              </div>
              <button className="discover-dismiss" type="button" aria-label={'对《' + getDisplayTitle(novel) + '》不感兴趣'} title="不感兴趣" onClick={() => forYou.reportDismiss(novel.id)}><X size={15} /></button>
            </article>)}
          </div>
        </section>}
        <section className="discover-section" aria-labelledby="discover-new">
          <div className="discover-section-heading"><h2 id="discover-new">最近上新</h2><Link to="/rankings?board=new">全部<ChevronRight size={14} /></Link></div>
          <div className="discover-new-books">{freshNovels.map(novel => <Link className="discover-new-book" key={novel.id} to={'/novel/' + novel.id}><BookCover novel={novel} /><h3>{getDisplayTitle(novel)}</h3><p>{getAuthorName(novel.author)}</p></Link>)}</div>
        </section>
        <section className="discover-section discover-popular" aria-labelledby="discover-popular">
          <div className="discover-section-heading"><h2 id="discover-popular">人气书单</h2><Link to="/rankings?board=popular">榜单<ChevronRight size={14} /></Link></div>
          <ol>{popularNovels.map((novel, index) => <li key={novel.id}><Link to={'/novel/' + novel.id}><span className="discover-rank">{String(index + 1).padStart(2, '0')}</span><span><strong>{getDisplayTitle(novel)}</strong><small>{getAuthorName(novel.author)}</small></span><ChevronRight size={15} /></Link></li>)}</ol>
        </section>
      </>}
    </div>
  )
}
