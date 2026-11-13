import { UserRound } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { Skeleton } from '@/components/ui/Skeleton'
import Avatar from '@/features/community/components/Avatar'
import { useShellStore } from '@/store/useShellStore'
import GlobalSearchBox from '@/features/search/GlobalSearchBox'
import { useRevealHeader } from '@/hooks/useRevealHeader'
import { preloadProfilePage } from '@/features/profile/load-profile-page'

const feedStackClass = 'divide-y divide-[var(--border-subtle)] md:space-y-4 md:divide-y-0'

type CommunityPageLayoutProps = {
  toolbar: ReactNode
  topicRail: ReactNode
  children: ReactNode
}

export function CommunityPageLayout({ toolbar, topicRail, children }: CommunityPageLayoutProps) {
  const user = useShellStore(state => state.sessionUser)
  const [searchOpen, setSearchOpen] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const { ref, hidden } = useRevealHeader(searchOpen || focusWithin)
  useEffect(() => {
    if (!searchOpen) return
    const root = ref.current?.closest<HTMLElement>('[data-app-main-scroll]')
    if (!root) return
    const previousOverflow = root.style.overflowY
    root.style.overflowY = 'hidden'
    return () => { root.style.overflowY = previousOverflow }
  }, [ref, searchOpen])
  return (
    <section
      data-community-layout
      data-search-open={searchOpen}
      aria-label="社区讨论"
      className="mx-auto w-full min-w-0 max-w-[720px]"
    >
      <header ref={ref} data-community-header data-hidden={hidden} onFocusCapture={event => setFocusWithin(event.target.matches(':focus-visible'))} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false) }} className="community-reveal-header border-b border-[var(--border-subtle)] md:mb-3 md:border-0">
        <div className="relative grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 md:hidden">
          <Link
            data-community-search-chrome
            to={user ? '/me' : '/login?redirect=%2Fcommunity'}
            aria-label={user ? '我的主页' : '去登录'}
            onPointerEnter={user ? preloadProfilePage : undefined}
            onFocus={user ? preloadProfilePage : undefined}
            onPointerDown={user ? preloadProfilePage : undefined}
            className="press-feedback grid h-10 w-10 place-items-center justify-self-start rounded-full text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
          >
            {user ? <Avatar name={user.nickname} src={user.avatarUrl} size="sm" /> : <UserRound className="h-5 w-5" />}
          </Link>
          <Link data-community-search-chrome to="/" aria-label="启创墨域首页" className="press-feedback grid h-12 w-12 place-items-center rounded-full">
            <img src="/chevoink-agent.png" alt="" width="46" height="46" className="h-[46px] w-[46px] object-contain" />
          </Link>
          <GlobalSearchBox compact onOpenChange={setSearchOpen} className="justify-self-end" />
        </div>
        <div data-community-search-chrome aria-hidden={searchOpen} ref={node => { if (node) node.inert = searchOpen }}>
        <div className="flex h-12 items-stretch md:px-1">
          {toolbar}
        </div>
        {topicRail}
        </div>
      </header>
      <div data-community-feed-content aria-hidden={searchOpen} ref={node => { if (node) node.inert = searchOpen }}>{children}</div>
    </section>
  )
}

export function CommunityFeedRows({ children }: { children: ReactNode }) {
  return <div className={feedStackClass}>{children}</div>
}

export function CommunityFeedSkeleton() {
  return (
    <div
      data-community-feed-skeleton
      className="mobile:[&_.skeleton-shimmer]:animate-none"
      aria-busy="true"
      aria-label="讨论加载中"
    >
      <CommunityFeedRows>
        {[0, 1, 2].map((row) => (
          <div key={row} className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 px-3 py-3 md:grid-cols-[44px_minmax(0,1fr)] md:rounded-[var(--radius-lg)] md:border md:border-[var(--border-subtle)] md:bg-[var(--surface-default)] md:px-5 md:pb-3 md:pt-4">
            <Skeleton className="row-span-2 h-10 w-10 self-start rounded-full md:row-span-1 md:h-11 md:w-11" />
            <div className="flex h-6 min-w-0 items-center gap-2 md:h-11">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-8" />
              <Skeleton className="ml-auto h-3 w-4" />
            </div>
            <div className="col-start-2 mt-0.5 space-y-2 md:col-span-2 md:col-start-1 md:mt-2.5">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-3/4" />
            </div>
            <div className="col-start-2 mt-2 flex h-9 items-center gap-8 md:col-span-2 md:col-start-1">
              {[0, 1, 2].map((action) => <Skeleton key={action} className="h-3.5 w-8" />)}
            </div>
          </div>
        ))}
      </CommunityFeedRows>
    </div>
  )
}

export function CommunityPageSkeleton() {
  return (
    <CommunityPageLayout
      toolbar={(
        <div className="grid w-full grid-cols-2 items-center justify-items-center md:w-40" aria-hidden>
          <Skeleton className="h-4 w-10 mobile:animate-none" />
          <Skeleton className="h-4 w-10 mobile:animate-none" />
        </div>
      )}
      topicRail={(
        <div className="flex h-11 items-center gap-3 overflow-hidden px-3 md:px-1" aria-hidden>
          {['w-12', 'w-16', 'w-14', 'w-[68px]'].map((width) => (
            <Skeleton key={width} className={`h-8 ${width} shrink-0 rounded-full motion-reduce:animate-none mobile:animate-none`} />
          ))}
        </div>
      )}
    >
      <CommunityFeedSkeleton />
    </CommunityPageLayout>
  )
}
