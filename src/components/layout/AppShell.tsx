import { defaultSiteSettings, effectiveSiteSettings } from '@/features/site-content/defaults'
import { usePublicSiteContent } from '@/features/site-content/public-api'
import AnnouncementBell from '@/features/site-content/AnnouncementBell'
import SiteSupportLink from '@/features/site-content/SiteSupportLink'
import { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, UIEvent, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, ChevronUp, Compass, FileText, Home, LoaderCircle, LogOut, MessageSquareMore, MoonStar, PenSquare, Settings, SunMedium, UserRound, Users, WifiOff } from 'lucide-react'

import { requestJson } from '@/app/api-client'
import { useToast } from '@/components/ui/toast-context'
import Button from '@/components/ui/Button'
import AppImage from '@/components/ui/AppImage'
import Surface from '@/components/ui/Surface'
import QuickCreateSheet from '@/components/layout/QuickCreateSheet'
import Avatar from '@/features/community/components/Avatar'
import { getInteractionBadges, listConversations } from '@/features/community/api'
import GlobalSearchBox from '@/features/search/GlobalSearchBox'
import { enterImmersiveFullscreen } from '@/lib/immersive-fullscreen'
import { isNativeApp } from '@/lib/native-app'
import { isWindowsDesktopApp } from '@/lib/desktop-app'
import { cn } from '@/lib/utils'
import { useDeviceType } from '@/hooks/useDeviceType'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useRevealHeader } from '@/hooks/useRevealHeader'
import { preloadProfilePage } from '@/features/profile/load-profile-page'
import { useShellStore } from '@/store/useShellStore'
import { mobileNavItems, workspaceLinks } from '@/types/app'

type AppShellProps = {
  title: string
  description: string
  children: ReactNode
}

// 底栏重复点击时需要刷新的 React Query key（按路由配置，未配置的路由仅回顶不刷新）
const bottomNavRefreshKeys: Record<string, readonly (readonly string[])[]> = {
  '/': [['home']],
  '/community': [
    ['community', 'posts'],
    ['community', 'topics'],
  ],
}
// 刷新冷却：冷却期内重复点击仅回顶，防止连点打爆接口
const NAV_REFRESH_COOLDOWN_MS = 3_000

export default function AppShell({ title, description, children }: AppShellProps) {
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const publishedContent = usePublicSiteContent()
  const siteSettings = publishedContent.data?.settings
  const effectiveSettings = effectiveSiteSettings(siteSettings)
  const headerNavItems = effectiveSettings.navigation.map(item => ({href:item.url,label:item.label}))
  const quickCreateOpen = useShellStore((state) => state.quickCreateOpen)
  const closeQuickCreate = useShellStore((state) => state.closeQuickCreate)
  const toggleTheme = useShellStore((state) => state.toggleTheme)
  const theme = useShellStore((state) => state.theme)
  const fullscreenEnabled = useShellStore((state) => state.fullscreenEnabled)
  const fullscreenPromptSeen = useShellStore((state) => state.fullscreenPromptSeen)
  const chooseFullscreen = useShellStore((state) => state.chooseFullscreen)
  const authStatus = useShellStore((state) => state.authStatus)
  const sessionUser = useShellStore((state) => state.sessionUser)
  const setGuest = useShellStore((state) => state.setGuest)
  // 断网全局提示（番茄式）：已加载内容与本地缓存照常可用，仅提醒新数据拉不到
  const online = useOnlineStatus()
  const isHome = location.pathname === '/'
  const isDiscoverRoute = location.pathname === '/discover'
  const isSearchRoute = location.pathname === '/search'
  // 社区页信息流自身已足够明确，壳层大标题占空间，隐藏页头
  const isCommunityRoute = location.pathname === '/community'
  const isStudioRoute = location.pathname === '/studio' || location.pathname.startsWith('/studio/')
  const isReaderRoute = /^\/novel\/[^/]+\/read\/[^/]+$/.test(location.pathname)
  // 作品详情页自带书名主标题，壳层引导文案反而冗余，隐藏页头
  const isNovelDetailRoute = /^\/novel\/[^/]+$/.test(location.pathname)
  // 帖子详情页以正文为中心，壳层大标题会造成信息重复，同样隐藏
  const isPostDetailRoute = /^\/post\/[^/]+$/.test(location.pathname)
  // 消息页自带列表标题，壳层页头只会占掉聊天区高度，隐藏；主容器改为固定不滚动
  const isMessagesRoute = location.pathname === '/messages'
  // 聊天详情态（URL 带 conversationId）：手机端隐藏底部导航，让输入框贴底全屏聊天
  const isMessagesChatRoute = isMessagesRoute && new URLSearchParams(location.search).has('conversationId')
  // 手机端仅首页/发现/搜索保留顶部导航栏，其余页面隐藏并让内容顶上去
  const hideMobileHeader = !(isHome || isDiscoverRoute || isSearchRoute)
  // 关注粉丝/获赞明细页自带紧凑标题，壳层大标题多余，隐藏
  const isMeListRoute = location.pathname === '/me/follows' || location.pathname === '/me/likes'
  // 个人中心页自带头部卡片，壳层大标题多余，隐藏
  const isProfileRoute = location.pathname === '/me'
  // 设置页改用页面内返回按钮（与帖子详情同款），壳层大标题一并隐藏
  const isSettingsRoute = location.pathname === '/settings'
  const isAuthRoute = location.pathname === '/login' || location.pathname === '/register'
  const isAuthenticated = authStatus === 'authenticated' && !!sessionUser
  const accountRoute = authStatus === 'guest' ? '/login?redirect=%2Fme' : '/me'
  const mainScrollRef = useRef<HTMLDivElement | null>(null)
  // 各路由离开时的滚动位置：目前仅社区页返回时恢复上次浏览位置，其余页面仍回顶
  const scrollPositionsRef = useRef(new Map<string, number>())
  const queryClient = useQueryClient()
  // 底栏重复点击刷新：按路由记录上次刷新时间戳 + 顶部 spinner 展示态
  const navRefreshAtRef = useRef(new Map<string, number>())
  const [bottomNavRefreshing, setBottomNavRefreshing] = useState(false)
  const [headerSearchOpen, setHeaderSearchOpen] = useState(false)
  const [headerFocus, setHeaderFocus] = useState<'search' | 'controls' | null>(null)
  const mobileHeader = useDeviceType() === 'mobile'
  // 手机收起顶栏后仍可使用搜索，桌面顶栏则需要为搜索保持可见。
  const keepHeaderVisible = headerFocus === 'controls' || (!mobileHeader && (headerSearchOpen || headerFocus === 'search'))
  const { ref: headerRef, hidden: headerHidden } = useRevealHeader(keepHeaderVisible, mainScrollRef, location.pathname)
  const desktopAccountMenuRef = useRef<HTMLDivElement | null>(null)
  // 默认折叠，保证内容区最大宽度；展开状态仅影响桌面端(lg)，平板端常驻收起导航轨
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [desktopAccountMenuOpen, setDesktopAccountMenuOpen] = useState(false)
  const [inlineAccountExpanded, setInlineAccountExpanded] = useState(false)
  const [headerHeight, setHeaderHeight] = useState(64)

  // 全局未读汇总（私信 + 互动 + 新粉丝）：驱动底部导航/侧边栏的消息红点；
  // queryKey 与消息页共用，避免重复请求，30s 轻轮询保持新鲜
  const shellBadgesQuery = useQuery({
    queryKey: ['community', 'interaction-badges'],
    queryFn: getInteractionBadges,
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  })
  const shellConversationsQuery = useQuery({
    queryKey: ['community', 'conversations'],
    queryFn: () => listConversations(),
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  })
  const conversationUnread = (shellConversationsQuery.data?.items ?? []).reduce(
    (sum, item) => sum + item.unreadCount,
    0,
  )
  const totalUnread =
    conversationUnread +
    (shellBadgesQuery.data?.interactionsUnseen ?? 0) +
    (shellBadgesQuery.data?.followersUnseen ?? 0)
  // 所有红点数字上限 99，超过也只显示 99
  const unreadBadgeText = totalUnread > 99 ? '99' : `${totalUnread}`

  // 全站沉浸全屏（手机/平板/电脑通用，首次进入弹窗询问、设置页可改）：浏览器禁止页面
  // 加载时自动全屏，故开启后在用户每次点击/触摸时进入并持续保持；关闭开关后立即
  // 退出全屏且不再自动进入；不支持的环境静默降级（进入逻辑见 lib/immersive-fullscreen）
  useEffect(() => {
    // APP 壳内天生全屏，不使用网页 Fullscreen API（避免与原生全屏打架、强制横屏等）
    if (isNativeApp()) return
    if (!fullscreenEnabled) {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {})
      }
      return
    }

    window.addEventListener('pointerup', enterImmersiveFullscreen)
    return () => window.removeEventListener('pointerup', enterImmersiveFullscreen)
  }, [fullscreenEnabled])

  useEffect(() => {
    const headerEl = headerRef.current

    if (!headerEl) {
      return
    }

    const updateHeaderHeight = () => {
      setHeaderHeight(Math.ceil(headerEl.getBoundingClientRect().height))
    }

    updateHeaderHeight()

    const observer = new ResizeObserver(updateHeaderHeight)
    observer.observe(headerEl)
    window.addEventListener('resize', updateHeaderHeight)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateHeaderHeight)
    }
  }, [headerRef])

  useEffect(() => {
    const nextScrollRoot = mainScrollRef.current
    // 社区信息流返回时恢复离开前的滚动位置（数据在 React Query 缓存里可同步重建），其余路由回顶
    const savedTop =
      location.pathname === '/community' ? scrollPositionsRef.current.get('/community') ?? 0 : 0

    if (nextScrollRoot) {
      nextScrollRoot.scrollTo({ top: savedTop, behavior: 'auto' })
      if (savedTop > 0) {
        // 列表可能还没撑开高度，下一帧再对齐一次，避免恢复位置被截断
        requestAnimationFrame(() => {
          const scrollRoot = mainScrollRef.current
          if (scrollRoot && Math.abs(scrollRoot.scrollTop - savedTop) > 1) {
            scrollRoot.scrollTo({ top: savedTop, behavior: 'auto' })
          }
        })
      }
    }

    setDesktopAccountMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!desktopAccountMenuOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!desktopAccountMenuRef.current?.contains(event.target as Node)) {
        setDesktopAccountMenuOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDesktopAccountMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [desktopAccountMenuOpen])

  const handleMainScroll = (event: UIEvent<HTMLDivElement>) => {
    // 持续记录当前路由的滚动位置，供社区页返回时恢复
    scrollPositionsRef.current.set(location.pathname, event.currentTarget.scrollTop)
  }

  // 底栏重复点击当前路由：回顶 + 清滚动记忆；配置了刷新 key 的路由（发现/社区）再触发数据刷新
  const handleBottomNavClick = (event: ReactMouseEvent<HTMLAnchorElement>, target: string) => {
    if (location.pathname !== target) {
      return
    }

    event.preventDefault()
    // 清掉滚动记忆，避免刷新完又跳回旧位置
    scrollPositionsRef.current.delete(target)
    mainScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })

    const refreshKeys = bottomNavRefreshKeys[target]
    if (!refreshKeys) {
      return
    }

    const now = Date.now()
    if (now - (navRefreshAtRef.current.get(target) ?? 0) < NAV_REFRESH_COOLDOWN_MS) {
      return
    }

    navRefreshAtRef.current.set(target, now)
    setBottomNavRefreshing(true)
    Promise.all(refreshKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
      .catch((): undefined => undefined)
      .finally(() => setBottomNavRefreshing(false))
  }

  async function handleLogout() {
    try {
      await requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
    } catch {
      toast.error('暂时无法确认退出登录，请稍后重试。')
      return
    }
    setDesktopAccountMenuOpen(false)
    setGuest()
    navigate('/login', { replace: true })
  }

  const accountActionClass =
    'flex w-full items-center gap-3 rounded-[18px] px-3 py-3 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]'

  const accountPanelClass =
    'mt-3 grid gap-2 border-t border-[var(--border-subtle)] pt-3 sm:grid-cols-2'

  function closeAccountMenu() {
    setDesktopAccountMenuOpen(false)
  }

  function openAccountRoute(path: string) {
    closeAccountMenu()
    navigate(path)
  }

  function renderAccountMenuActions(layout: 'popover' | 'inline') {
    const containerClass =
      layout === 'popover'
        ? 'absolute inset-x-0 bottom-[calc(100%+12px)] z-20 rounded-[24px] border border-[var(--border-strong)] bg-[var(--surface-default)] p-2 shadow-[0_12px_28px_rgba(17,24,39,0.10)]'
        : accountPanelClass

    const actionButtonClass =
      layout === 'popover'
        ? accountActionClass
        : 'flex items-center gap-3 rounded-[18px] border border-[var(--border-subtle)] px-3 py-3 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]'

    return (
      <div className={containerClass}>
        <button type="button" className={actionButtonClass} onClick={() => openAccountRoute('/me')}>
          <UserRound className="h-4 w-4 text-[var(--text-secondary)]" />
          个人中心
        </button>
        <button type="button" className={actionButtonClass} onClick={() => openAccountRoute('/version')}>
          <span aria-hidden="true" className="w-4 text-center text-xs">v</span>应用版本
        </button>
        <button type="button" className={actionButtonClass} onClick={() => openAccountRoute('/settings')}>
          <Settings className="h-4 w-4 text-[var(--text-secondary)]" />
          设置
        </button>
        <button type="button" className={actionButtonClass} onClick={() => openAccountRoute('/studio')}>
          <FileText className="h-4 w-4 text-[var(--text-secondary)]" />
          我的创作
        </button>
        <SiteSupportLink href={effectiveSettings.contact.url} className={actionButtonClass} onClick={closeAccountMenu} />
        <button type="button" className={actionButtonClass} onClick={() => void handleLogout()}>
          <LogOut className="h-4 w-4 text-[var(--text-secondary)]" />
          退出登录
        </button>
      </div>
    )
  }

  function renderAccountCard(layout: 'sidebar' | 'inline') {
    const isSidebar = layout === 'sidebar'
    const inlineExpanded = isSidebar ? true : inlineAccountExpanded
    const isCompactInline = !isSidebar && !inlineExpanded

    if (isAuthenticated && sessionUser) {
      return (
        <div ref={isSidebar ? desktopAccountMenuRef : undefined} className="relative">
          {isSidebar && desktopAccountMenuOpen ? renderAccountMenuActions('popover') : null}

          <button
            type="button"
            onClick={() => {
              if (isSidebar) {
                setDesktopAccountMenuOpen((current) => !current)
                return
              }

              setInlineAccountExpanded((current) => !current)
            }}
            className={cn(
              'flex w-full items-center gap-3 text-left transition-colors hover:bg-[var(--surface-muted)]',
              isSidebar
                ? 'rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-3'
                : isCompactInline
                  ? 'rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-4 py-3'
                  : 'rounded-[22px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-4 py-4 md:px-5',
            )}
          >
            <Avatar
              name={sessionUser.nickname}
              src={sessionUser.avatarUrl}
              size="md"
              className={cn(!isSidebar && 'h-12 w-12')}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--text-primary)] md:text-[15px]">
                {sessionUser.nickname}
              </span>
              {!isCompactInline ? (
                <span className="block truncate text-xs text-[var(--text-secondary)] md:text-sm">
                  {sessionUser.emailAuthEnabled && sessionUser.email
                    ? sessionUser.email
                    : sessionUser.isAuthor ? '继续管理作品与资料' : '继续管理书架与资料'}
                </span>
              ) : null}
            </span>
            <ChevronUp
              className={cn(
                'h-4 w-4 shrink-0 text-[var(--text-secondary)] transition-transform',
                !(isSidebar ? desktopAccountMenuOpen : inlineExpanded) && 'rotate-180',
              )}
            />
          </button>

          {!isSidebar && inlineExpanded ? renderAccountMenuActions('inline') : null}
        </div>
      )
    }

    return (
      <div
        className={cn(
          'space-y-3 rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-default)]',
          isSidebar ? 'px-3 py-3' : isCompactInline ? 'px-4 py-3' : 'px-4 py-4 md:px-5',
        )}
      >
        <button
          type="button"
          onClick={() => {
            if (!isSidebar) {
              setInlineAccountExpanded((current) => !current)
            }
          }}
          className={cn('flex w-full items-center gap-3 text-left', !isSidebar && 'transition-colors hover:bg-[var(--surface-muted)] rounded-[18px]')}
        >
          <span className="inline-flex aspect-square h-11 w-11 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-muted)] text-[var(--text-secondary)]">
            <UserRound className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">登录后同步你的内容</p>
            {!isCompactInline ? (
              <p className="text-xs text-[var(--text-secondary)] md:text-sm">书架、创作和资料会一起保留。</p>
            ) : null}
          </div>
          {!isSidebar ? (
            <ChevronUp
              className={cn(
                'ml-auto h-4 w-4 shrink-0 text-[var(--text-secondary)] transition-transform',
                !inlineExpanded && 'rotate-180',
              )}
            />
          ) : null}
        </button>
        {inlineExpanded ? (
          <div className={cn('flex gap-2', !isSidebar && 'sm:max-w-[320px]')}>
            <Button className="flex-1" variant="secondary" onClick={() => navigate('/login?redirect=%2Fme')}>
              登录
            </Button>
            <Button className="flex-1" variant="primary" onClick={() => navigate('/register?redirect=%2Fme')}>
              注册
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  function renderCollapsedRailItem(href: string, label: string) {
    const Icon =
      href === '/'
        ? Home
        : href === '/discover'
          ? Compass
          : href === '/studio'
            ? PenSquare
            : href === '/community'
              ? Users
              : MessageSquareMore

    return (
      <NavLink
        key={href}
        to={href === '/me' ? accountRoute : href}
        title={label}
        className={({ isActive }) =>
          cn(
            'inline-flex h-11 w-11 items-center justify-center rounded-[16px] border transition-colors',
            isActive
              ? 'border-[var(--border-contrast)] bg-[var(--surface-contrast)] text-[var(--text-contrast)]'
              : 'border-transparent text-[var(--text-secondary)] hover:border-[var(--border-subtle)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]',
          )
        }
      >
        <span className="relative inline-flex">
          <Icon className="h-4 w-4" />
          {/* 折叠态只提示有新消息，不显示具体数字 */}
          {href === '/messages' && totalUnread > 0 ? (
            <span className="absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-rose-500" />
          ) : null}
        </span>
      </NavLink>
    )
  }

  const railNavClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex w-full min-h-[44px] items-center justify-start rounded-[var(--radius-pill)] border border-transparent px-4 py-2.5 text-sm font-medium transition-colors',
      isActive
        ? 'border-[var(--border-contrast)] bg-[var(--surface-contrast)] text-[var(--text-contrast)]'
        : 'text-[var(--text-secondary)] hover:border-[var(--border-subtle)] hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]',
    )

  const bottomNavClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'app-bottom-link flex min-h-11 min-w-0 items-center justify-center rounded-[var(--radius-pill)] px-3 py-2 text-sm font-medium transition-colors',
      isActive
        ? 'is-selected bg-transparent'
        : 'hover:bg-transparent',
    )

  return (
    <div
      data-app-shell
      // 壳高随软键盘收缩（iOS 等不缩小布局视口的浏览器），消息输入栏、评论框等随之被顶到键盘上方
      className="flex h-[calc(100dvh-var(--keyboard-inset,0px))] flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]"
      data-site-header-hidden={headerHidden}
      style={{ '--app-header-height': `${headerHeight}px`, '--app-header-visible-height': headerHidden ? '0px' : `${headerHeight}px` } as CSSProperties}
    >
      {online ? null : (
        <div className="flex shrink-0 items-center justify-center gap-1.5 bg-[var(--surface-muted)] px-3 pb-1.5 pt-[calc(var(--safe-top)+4px)] text-xs text-[var(--text-secondary)]">
          <WifiOff className="h-3.5 w-3.5" />
          当前无网络连接，部分内容可能无法实时更新
        </div>
      )}
      {/* IDE 式布局：侧边栏贴视口左缘常驻文档流，收起/展开只变宽度，右侧内容区随之自然靠拢 */}
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            'hidden shrink-0 md:flex md:h-full md:flex-col md:overflow-y-auto md:transition-[width] md:duration-200',
            !isReaderRoute && 'md:pt-[var(--app-header-height)]',
            isAuthRoute && 'md:hidden',
            isStudioRoute && 'md:hidden',
            'md:w-[64px]',
            sidebarExpanded ? 'lg:w-[284px]' : 'lg:w-[64px]',
          )}
        >
          {sidebarExpanded ? (
            <div className="hidden min-h-full w-full flex-col px-3 pb-5 pt-[calc(var(--safe-top)+14px)] lg:flex">
              {/* 导航与账号整合为一张卡片：顶部收起按钮 + 导航链接，底部头像账号区 */}
              <Surface
                as="nav"
                tone="muted"
                padding="sm"
                className="flex flex-1 flex-col border-[var(--border-strong)] bg-[color:var(--surface-default)]/72 shadow-none rounded-[28px]"
              >
                <div className="flex items-center justify-end px-2 pb-1 pt-1">
                  <button
                    type="button"
                    onClick={() => setSidebarExpanded(false)}
                    aria-label="收起侧边栏"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-[14px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-1 px-1 py-2">
                  {workspaceLinks
                    .filter((item) => item.href !== '/me')
                    .map((item) => (
                      <NavLink
                        key={item.href}
                        to={item.href === '/me' ? accountRoute : item.href}
                        className={railNavClass}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          {item.label}
                          {item.href === '/messages' && totalUnread > 0 ? (
                            <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-rose-500 px-1 text-center text-[11px] font-semibold leading-none tabular-nums text-white">
                              {unreadBadgeText}
                            </span>
                          ) : null}
                        </span>
                      </NavLink>
                    ))}
                </div>
                <div className="mt-auto border-t border-[var(--border-subtle)] px-1 pb-1 pt-2">
                  {renderAccountCard('sidebar')}
                </div>
              </Surface>
            </div>
          ) : null}

          {/* 收起态导航轨：平板端(md)常驻，桌面端展开时隐藏 */}
          <div
            className={cn(
              'flex min-h-full w-full flex-col items-center px-2 pb-5 pt-[calc(var(--safe-top)+14px)]',
              sidebarExpanded && 'lg:hidden',
            )}
          >
              <button
                type="button"
                onClick={() => setSidebarExpanded(true)}
                aria-label="展开侧边栏"
                className="inline-flex h-11 w-11 items-center justify-center rounded-[16px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
              >
                <ChevronRight className="h-4 w-4" />
              </button>

              <div className="mt-4 flex flex-col items-center gap-3">
                {workspaceLinks.filter((item) => item.href !== '/me').map((item) => renderCollapsedRailItem(item.href, item.label))}
              </div>

              <div className="mt-auto flex flex-col items-center gap-3 border-t border-[var(--border-subtle)] pt-4">
                {isAuthenticated && sessionUser ? (
                  <div className="group relative">
                    <button
                      type="button"
                      title={sessionUser.nickname}
                      onClick={() => navigate('/me')}
                      onPointerEnter={preloadProfilePage}
                      onFocus={preloadProfilePage}
                      onPointerDown={preloadProfilePage}
                      className="inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] transition-colors hover:bg-[var(--surface-muted)]"
                    >
                      <Avatar name={sessionUser.nickname} src={sessionUser.avatarUrl} size="md" className="h-11 w-11 border-0 bg-transparent" />
                    </button>
                    {/* fixed 脱离 aside 的 overflow 裁剪，pl-6 与头像区域重叠避免悬停闪断 */}
                    <div className="invisible fixed bottom-5 left-[52px] z-50 pl-6 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                      <div className="w-60 rounded-[24px] border border-[var(--border-strong)] bg-[var(--surface-default)] p-2 shadow-[0_12px_28px_rgba(17,24,39,0.12)]">
                        <div className="flex items-center gap-3 rounded-[18px] px-3 py-3">
                          <Avatar name={sessionUser.nickname} src={sessionUser.avatarUrl} size="md" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                              {sessionUser.nickname}
                            </span>
                            <span className="block truncate text-[11px] leading-4 text-[var(--text-tertiary)]">
                              {sessionUser.emailAuthEnabled && sessionUser.email ? sessionUser.email : sessionUser.bio?.trim() || '-'}
                            </span>
                          </span>
                        </div>
                        <div className="my-1 border-t border-[var(--border-subtle)]" />
                        <button type="button" className={accountActionClass} onClick={() => navigate('/me')}>
                          <UserRound className="h-4 w-4 text-[var(--text-secondary)]" />
                          个人中心
                        </button>
                        <button type="button" className={accountActionClass} onClick={() => navigate('/settings')}>
                          <Settings className="h-4 w-4 text-[var(--text-secondary)]" />
                          设置
                        </button>
                        <button type="button" className={accountActionClass} onClick={() => navigate('/studio')}>
                          <FileText className="h-4 w-4 text-[var(--text-secondary)]" />
                          我的创作
                        </button>
                        <SiteSupportLink href={effectiveSettings.contact.url} className={accountActionClass} />
                        <button type="button" className={accountActionClass} onClick={() => void handleLogout()}>
                          <LogOut className="h-4 w-4 text-[var(--text-secondary)]" />
                          退出登录
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    title="登录或注册"
                    onClick={() => navigate('/login?redirect=%2Fme')}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border-subtle)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                  >
                    <UserRound className="h-4 w-4" />
                  </button>
                )}
              </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {/* 聊天详情态手机端全出血：去掉壳层水平留白，返回键/输入栏贴近屏幕边缘（气泡与输入框有自身内边距兜底） */}
          <div
            className={cn(
              'mx-auto flex h-full max-w-[var(--shell-max-width)] flex-col px-4 md:px-6 xl:px-8',
              (isMessagesChatRoute || isCommunityRoute) && 'mobile:px-0',
              isStudioRoute && 'max-w-none px-0 md:px-0 xl:px-0',
            )}
          >
            <header
              ref={headerRef}
              data-site-header
              className={cn(
                'site-reveal-header fixed left-0 right-0 top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 pt-[var(--safe-top)]',
                isStudioRoute && 'hidden lg:hidden',
                isReaderRoute && 'hidden md:hidden',
                hideMobileHeader && !isStudioRoute && !isReaderRoute && 'hidden md:block',
              )}
              data-hidden={headerHidden}
              onFocusCapture={event => {
                if (!event.target.matches(':focus-visible')) {
                  setHeaderFocus(null)
                  return
                }
                setHeaderFocus(event.target.closest('.site-header-search') ? 'search' : 'controls')
              }}
              onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeaderFocus(null) }}
            >
              <div className="site-header-row relative flex h-14 items-center gap-2 md:h-16">
                <Link to="/" className="site-header-identity flex shrink-0 items-center gap-2" aria-label={effectiveSettings.name + '首页'}>
                  <AppImage src={!effectiveSettings.logoUrl || effectiveSettings.logoUrl === defaultSiteSettings.logoUrl ? '/chevoink-agent.png' : effectiveSettings.logoUrl} alt={effectiveSettings.name + ' Logo'} className="h-10 w-10 shrink-0 md:h-11 md:w-11" priority />
                  <span className="hidden text-base font-semibold md:block">{effectiveSettings.name}</span>
                </Link>
                <nav aria-label="站点导航" className="site-header-navigation hidden min-w-0 items-center overflow-x-auto md:flex">
                  {headerNavItems.map((item) => item.href.startsWith('/') ? (
                    <NavLink key={item.href} to={item.href}>{item.label}</NavLink>
                  ) : (
                    <a key={item.href} href={item.href} target="_blank" rel="noopener noreferrer">{item.label}</a>
                  ))}
                </nav>
                <GlobalSearchBox onOpenChange={setHeaderSearchOpen} className="site-header-search min-w-0 flex-1" />
                <div className="site-header-actions flex shrink-0 items-center gap-0.5">
                  {!isStudioRoute && !isReaderRoute && <AnnouncementBell placement="site" />}
                  <Button onClick={toggleTheme} variant="ghost" className="hidden h-11 w-11 px-0 md:inline-flex" aria-label="切换主题">
                    {theme === 'light' ? <MoonStar className="h-5 w-5" /> : <SunMedium className="h-5 w-5" />}
                  </Button>
                  <NavLink to="/messages" aria-label="消息" className="hidden h-11 w-11 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] md:flex">
                    <span className="relative inline-flex">
                      <MessageSquareMore className="h-5 w-5" />
                      {totalUnread > 0 ? <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-rose-500" /> : null}
                    </span>
                  </NavLink>
                </div>
              </div>
            </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <main
            ref={mainScrollRef}
            data-app-main-scroll
            onScroll={handleMainScroll}
            className={cn(
              'app-main-scroll min-h-0 flex-1 overscroll-contain lg:self-stretch',
              isStudioRoute || isReaderRoute || isMessagesRoute
                ? 'overflow-hidden'
                : // 只声明 overflow-y-auto 时 overflow-x 会隐式变成 auto，子元素负外边距溢出会让整页可横滑，这里明确封死横向
                  'overflow-x-hidden overflow-y-auto',
            )}
          >
            <div
              className={cn(
                'app-main-content space-y-4 pb-[calc(88px+var(--safe-bottom))] pr-0.5 pt-[calc(var(--app-header-height)+12px)] md:space-y-6 md:pb-8',
                // 手机端隐藏顶部导航栏的页面：内容顶上去，只留安全区间距（studio 保持原行为）
                hideMobileHeader && !isStudioRoute && 'mobile:pt-[calc(var(--safe-top)+12px)]',
                isCommunityRoute && 'space-y-0 md:space-y-0 mobile:pr-0 mobile:pt-[var(--safe-top)]',
                isReaderRoute && 'flex h-full min-h-0 flex-col space-y-4 pb-0 md:pb-0 md:pt-0',
                // 创作区手机端由自己的底部导航接管，不再为全局底栏留白
                isStudioRoute && 'flex h-full min-h-0 flex-col space-y-4 md:space-y-4 pb-0 md:pb-0',
                isStudioRoute && '!space-y-0 !pt-0',
                // 消息页：列式铺满剩余高度，手机端避让底部导航，桌面端留少量底边距；app-messages-main 供键盘打开时收紧底部留白
                isMessagesRoute && 'app-messages-main flex h-full min-h-0 flex-col space-y-0 pb-[calc(76px+var(--safe-bottom))] md:pb-6',
                // 聊天详情态：底栏已隐藏，手机端只留安全区，输入框贴底
                isMessagesChatRoute && 'mobile:pb-[var(--safe-bottom)]',
                // 作品详情页手机端底栏已隐藏，底部留白交给页面自己的贴底操作栏控制
                isNovelDetailRoute && 'mobile:pb-4',
                // 帖子详情/设置/关注粉丝/获赞明细：底栏隐藏后不再为它预留 88px 底部占位
                (isPostDetailRoute || isSettingsRoute || isMeListRoute) && 'mobile:pb-6',
              )}
              style={{ '--app-header-height': `${headerHeight}px` } as CSSProperties}
            >
              {!isHome ? (
                <section
                  className={cn(
                    'app-route-heading space-y-2 px-0.5 pt-1 md:space-y-3 md:pt-2',
                    (isDiscoverRoute || location.pathname === '/rankings') && 'hidden',
                    isStudioRoute && 'hidden',
                    isReaderRoute && 'hidden',
                    isNovelDetailRoute && 'hidden',
                    isPostDetailRoute && 'hidden',
                    isMessagesRoute && 'hidden',
                    isMeListRoute && 'hidden',
                    isProfileRoute && 'hidden',
                    isSettingsRoute && 'hidden',
                    isCommunityRoute && 'hidden',
                    // 登录/注册页自带页面标题，壳层大标题隐藏
                    isAuthRoute && 'hidden',
                  )}
                >
                  <h1 className="max-w-4xl text-[1.625rem] font-semibold tracking-tight text-[var(--text-primary)] md:text-[2rem]">
                    {title}
                  </h1>
                  <p className="max-w-3xl text-sm leading-6 text-[var(--text-secondary)] md:text-base md:leading-7">
                    {description}
                  </p>
                </section>
              ) : null}
              {children}
            </div>
          </main>
        </div>
          </div>
        </div>
      </div>

      <nav
        className={cn(
          'app-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-subtle)] bg-[color:var(--surface-default)]/96 px-4 pb-[calc(12px+var(--safe-bottom))] pt-3 backdrop-blur md:hidden',
          isReaderRoute && 'hidden',
          // 创作区有自己的底部导航（对话/写作/章节/更多），隐藏全局底栏
          isStudioRoute && 'hidden',
          // 聊天详情态：隐藏底栏让输入框贴底，返回会话列表后恢复
          isMessagesChatRoute && 'hidden',
          // 作品详情页手机端自带贴底操作栏 + 左上返回，隐藏全局底栏让阅读动线更沉浸
          isNovelDetailRoute && 'hidden',
          // 帖子详情以正文为中心：底部评论栏自带贴底入口，隐藏全局底栏
          isPostDetailRoute && 'hidden',
          // 设置页为全屏表单动线，隐藏底栏
          isSettingsRoute && 'hidden',
          // 关注粉丝/获赞明细（互动消息）为紧凑列表页，隐藏底栏
          isMeListRoute && 'hidden',
        )}
      >
        <div className="mx-auto grid max-w-lg grid-cols-5 items-center gap-2">
          {mobileNavItems.slice(0, 2).map((item) => (
            <NavLink
              key={item.href}
              to={item.href === '/me' ? accountRoute : item.href}
              onClick={(event) => handleBottomNavClick(event, item.href === '/me' ? accountRoute : item.href)}
              onPointerEnter={item.href === '/me' ? preloadProfilePage : undefined}
              onFocus={item.href === '/me' ? preloadProfilePage : undefined}
              onPointerDown={item.href === '/me' ? preloadProfilePage : undefined}
              className={({ isActive }) => bottomNavClass({ isActive: isActive || (item.href === '/' && (isDiscoverRoute || isSearchRoute || location.pathname === '/rankings')) })}
            >
              <span className="relative">
                {(
                  <>
                    <span className="sr-only">{item.label}</span>
                    {item.href === '/messages' ? <MessageSquareMore className="h-[22px] w-[22px]" aria-hidden /> : <Compass className="h-[22px] w-[22px]" aria-hidden />}
                  </>
                )}
                {item.href === '/messages' && totalUnread > 0 ? (
                  <span className="absolute -right-3 -top-2 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-center text-[10px] font-semibold leading-none tabular-nums text-white">
                    {unreadBadgeText}
                  </span>
                ) : null}
              </span>
            </NavLink>
          ))}
          <Button onClick={() => navigate('/studio')} variant="ghost" className="app-bottom-create h-11 w-11 justify-self-center px-0" aria-label="进入创作区">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7"><rect x="2.5" y="3.5" width="19" height="17" rx="5" /><path d="M12 8v8m-4-4h8" /></svg>
          </Button>
          {mobileNavItems.slice(2).map((item) => (
            <NavLink
              key={item.href}
              to={item.href === '/me' ? accountRoute : item.href}
              onClick={(event) => handleBottomNavClick(event, item.href === '/me' ? accountRoute : item.href)}
              onPointerEnter={item.href === '/me' ? preloadProfilePage : undefined}
              onFocus={item.href === '/me' ? preloadProfilePage : undefined}
              onPointerDown={item.href === '/me' ? preloadProfilePage : undefined}
              className={({ isActive }) => bottomNavClass({ isActive: isActive || (item.href === '/' && (isDiscoverRoute || isSearchRoute || location.pathname === '/rankings')) })}
            >
              {(
                <>
                  <span className="sr-only">{item.label}</span>
                  {item.href === '/community' ? <Users className="h-[22px] w-[22px]" aria-hidden /> : <UserRound className="h-[22px] w-[22px]" aria-hidden />}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* 底栏重复点击刷新时的顶部 spinner，与下拉刷新视觉一致 */}
      {bottomNavRefreshing ? (
        <div className="pointer-events-none fixed inset-x-0 top-[calc(var(--safe-top)+56px)] z-[60] flex justify-center md:hidden">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[var(--shadow-card)]">
            <LoaderCircle className="h-5 w-5 animate-spin text-[var(--color-brand)]" />
          </span>
        </div>
      ) : null}

      <QuickCreateSheet open={quickCreateOpen} onClose={closeQuickCreate} />

      {/* 首次进入网站的全屏选择弹窗：默认不开启全屏，由用户自己选；选择后不再弹出，
          「开启」按钮点击本身就是用户手势，可直接进入全屏；APP 壳内天生全屏，不弹 */}
      {!fullscreenPromptSeen && !isNativeApp() && !isWindowsDesktopApp() ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-[380px] rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">选择浏览方式</h3>
            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              开启全屏模式可获得更沉浸的阅读体验；之后随时可在设置中更改。
            </p>
            <div className="mt-5 flex gap-3">
              <Button
                type="button"
                variant="primary"
                className="flex-1"
                onClick={() => {
                  chooseFullscreen(true)
                  enterImmersiveFullscreen()
                }}
              >
                喜欢全屏
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => chooseFullscreen(false)}
              >
                不要全屏
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
