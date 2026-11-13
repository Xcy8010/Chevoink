import { useQuery } from '@tanstack/react-query'
import { BookOpen, Bookmark, FileText, PenLine } from 'lucide-react'
import { ChangeEvent, FormEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ApiClientError, requestJson } from '@/app/api-client'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { PostListSkeleton } from '@/components/ui/Skeleton'
import Button from '@/components/ui/Button'
import ImageCropperDialog from '@/components/ui/ImageCropperDialog'
import TextInput from '@/components/ui/TextInput'
import { useToast } from '@/components/ui/toast-context'
import { getMe, listFavoriteNovels, listPosts } from '@/features/community/api'
import Avatar from '@/features/community/components/Avatar'
import { getCoverUrl, listNovelCardsByIds } from '@/features/discover/api'
import { getAllReadingProgress } from '@/features/home/reading-progress'
import { getLocalShelf, subscribeShelfChange, updateShelfCovers } from '@/features/home/local-shelf'
import { getProfileImageUploadError, prepareAvatarImage, readFileAsDataUrl } from '@/lib/image-compress'
import { PROFILE_IMAGE_MAX_MB } from '../../shared/contracts/api.js'
import CreationPanel from '@/features/profile/components/CreationPanel'
import ProfileHeader from '@/features/profile/components/ProfileHeader'
import { ProfileRouteSkeleton } from '@/features/profile/components/ProfileLoading'
import ShelfPanel, { type ShelfBook } from '@/features/profile/components/ShelfPanel'
import { useShellStore } from '@/store/useShellStore'
import type { UpdateMyAvatarRequest, UpdateMyCoverRequest, UpdateMyProfileRequest, User } from '../../shared/contracts'

const ProfileActivityPanel = lazy(() => import('@/features/profile/components/ProfileActivityPanel').catch(() => ({
  default: () => (
    <AppState
      compact
      tone="error"
      title="暂时无法打开这里"
      primaryAction={{ label: '重新加载', onClick: () => window.location.reload() }}
    />
  ),
})))

function ProfileActivity({ panel, userId }: { panel: 'bookmarks' | 'liked' | 'replies'; userId: string }) {
  return (
    <Suspense fallback={<PostListSkeleton count={2} />}>
      <ProfileActivityPanel panel={panel} userId={userId} />
    </Suspense>
  )
}

const panels = [
  { id: 'shelf', label: '书架' },
  { id: 'creation', label: '创作' },
  { id: 'favorites', label: '收藏' },
  { id: 'liked', label: '喜欢' },
  { id: 'replies', label: '已回复' },
] as const

type ProfilePanel = (typeof panels)[number]['id']

// 新建默认名已改为「未命名作品」；保留旧名识别，兼容存量引导作品
const BOOTSTRAP_NOVEL_TITLES = new Set(['未命名作品', '我的第一部作品'])
const BOOTSTRAP_NOVEL_SUMMARY = '先创建一部作品，再继续完善简介、章节和封面。'

function isBootstrapNovel(novel: {
  title: string
  displayTitle: string | null
  summary: string
  chapterCount: number
  wordCount: number
}) {
  return (
    BOOTSTRAP_NOVEL_TITLES.has(novel.title) &&
    !novel.displayTitle?.trim() &&
    novel.summary === BOOTSTRAP_NOVEL_SUMMARY &&
    novel.chapterCount === 0 &&
    novel.wordCount === 0
  )
}

export default function ProfilePage() {
  const navigate = useNavigate()
  const toast = useToast()
  const syncSessionUser = useShellStore((state) => state.syncSessionUser)
  const sessionUserId = useShellStore((state) => state.sessionUser?.id)
  const unreadMessageCount = useShellStore((state) => state.unreadMessageCount)
  const unreadNotificationCount = useShellStore((state) => state.unreadNotificationCount)

  const [activePanel, setActivePanel] = useState<ProfilePanel>('shelf')
  // 收藏面板子栏：收藏的作品 / 收藏的帖子
  const [favoritesTab, setFavoritesTab] = useState<'novels' | 'posts'>('novels')
  const [editDialogVisible, setEditDialogVisible] = useState(false)
  const [nicknameDraft, setNicknameDraft] = useState('')
  const [bioDraft, setBioDraft] = useState('')
  const [profileSubmitting, setProfileSubmitting] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [avatarSubmitting, setAvatarSubmitting] = useState(false)
  const [avatarError, setAvatarError] = useState('')
  const [coverDraft, setCoverDraft] = useState<string | null>(null)
  const [coverSubmitting, setCoverSubmitting] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)
  const coverInputRef = useRef<HTMLInputElement | null>(null)
  const panelsSectionRef = useRef<HTMLElement | null>(null)

  const meQuery = useQuery({
    queryKey: ['community', 'me'],
    queryFn: getMe,
  })
  const mePayload = meQuery.data?.user?.id === sessionUserId ? meQuery.data : undefined
  const currentUser = mePayload?.user ?? null

  const postsQuery = useQuery({
    queryKey: ['community', 'posts', 'profile', currentUser?.id],
    queryFn: () => listPosts(40),
    enabled: Boolean(currentUser),
  })

  /** 我收藏的作品：只在切到收藏面板时拉取 */
  const favoriteNovelsQuery = useQuery({
    queryKey: ['profile', 'favorite-novels', currentUser?.id],
    queryFn: listFavoriteNovels,
    enabled: Boolean(currentUser) && activePanel === 'favorites' && favoritesTab === 'novels',
  })
  const favoriteItems = useMemo<ShelfBook[]>(
    () =>
      (favoriteNovelsQuery.data?.items ?? []).map((novel) => ({
        key: novel.id,
        novelId: novel.id,
        title: novel.title,
        coverUrl: getCoverUrl(novel.coverUrl),
        summary: novel.summary ?? '',
      })),
    [favoriteNovelsQuery.data?.items],
  )

  const authoredNovels = useMemo(() => {
    return mePayload?.authoredNovels ?? []
  }, [mePayload?.authoredNovels])

  const visibleAuthoredNovels = useMemo(
    () => authoredNovels.filter((novel) => !isBootstrapNovel(novel)),
    [authoredNovels],
  )

  const hiddenBootstrapNovelIds = useMemo(
    () => new Set(authoredNovels.filter((novel) => isBootstrapNovel(novel)).map((novel) => novel.id)),
    [authoredNovels],
  )

  const draftItems = useMemo(
    () => (mePayload?.drafts ?? []).filter((draft) => !hiddenBootstrapNovelIds.has(draft.novelId)),
    [hiddenBootstrapNovelIds, mePayload?.drafts],
  )

  /** 本地阅读进度与书架（页面渲染时读取，me 数据刷新/书架变更落地后重读） */
  const [shelfVersion, setShelfVersion] = useState(0)
  useEffect(() => subscribeShelfChange(() => setShelfVersion((version) => version + 1)), [])
  const progressMap = useMemo(
    () => getAllReadingProgress(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meQuery.dataUpdatedAt],
  )
  const localShelf = useMemo(
    () => getLocalShelf(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meQuery.dataUpdatedAt, shelfVersion],
  )

  /** 合并服务端书架 + 本地书架 + 仅有阅读进度的作品 */
  const mergedShelf = useMemo<ShelfBook[]>(() => {
    const seen = new Set<string>()
    const items: ShelfBook[] = []

    for (const item of mePayload?.shelf ?? []) {
      const novelId = item.novelId ?? null
      if (novelId) {
        seen.add(novelId)
      }
      items.push({
        key: item.id,
        novelId,
        title: item.title,
        coverUrl: getCoverUrl(item.coverUrl),
        summary: item.summary ?? '',
      })
    }

    for (const entry of localShelf) {
      if (seen.has(entry.novelId)) {
        continue
      }
      seen.add(entry.novelId)
      items.push({
        key: `local-${entry.novelId}`,
        novelId: entry.novelId,
        title: entry.title,
        coverUrl: getCoverUrl(entry.coverUrl),
        summary: '',
      })
    }

    for (const entry of Object.values(progressMap)) {
      if (seen.has(entry.novelId)) {
        continue
      }
      seen.add(entry.novelId)
      items.push({
        key: `progress-${entry.novelId}`,
        novelId: entry.novelId,
        title: entry.novelTitle,
        coverUrl: null,
        summary: '正在阅读中',
      })
    }

    return items
  }, [localShelf, mePayload?.shelf, progressMap])

  /**
   * 书架封面回源同步：既补「当时没封面」的空位，也刷「已换封面」的旧快照；
   * 换封面后本地/云端快照里的旧路径会一直显示旧图（旧域名失效即封面消失），
   * 这里用轻量批量卡片接口对齐全站真实封面，差异即回写本地书架自愈
   */
  const shelfCoverSyncIds = useMemo(
    () => Array.from(new Set(mergedShelf.map((item) => item.novelId).filter((id): id is string => Boolean(id)))),
    [mergedShelf],
  )
  const coverBackfillQuery = useQuery({
    queryKey: ['profile', 'shelf-cover-sync', shelfCoverSyncIds],
    enabled: Boolean(currentUser) && activePanel === 'shelf' && shelfCoverSyncIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const cards = await listNovelCardsByIds(shelfCoverSyncIds)
      const covers = new Map<string, string>()
      for (const card of cards) {
        const cover = getCoverUrl(card.coverUrl)
        if (cover) covers.set(card.id, cover)
      }
      updateShelfCovers(covers)
      return covers
    },
  })
  const shelfItems = useMemo<ShelfBook[]>(() => {
    const covers = coverBackfillQuery.data
    if (!covers?.size) return mergedShelf

    return mergedShelf.map((item) => {
      const synced = item.novelId ? covers.get(item.novelId) : undefined
      // 服务端封面与本地快照不同时以服务端为准（含旧封面刷新），否则保持原样
      return synced && synced !== item.coverUrl ? { ...item, coverUrl: synced } : item
    })
  }, [coverBackfillQuery.data, mergedShelf])

  // 个人封面只使用用户自己设置的封面，不再兜底展示作品封面（避免误显示）
  const recentCoverUrl = currentUser?.profileCoverUrl ?? null

  const readingCount = mergedShelf.length
  const likesCount = useMemo(
    () => postsQuery.data?.items.reduce(
      (total, post) => post.author.id === currentUser?.id ? total + post.favoriteCount + post.likeCount : total,
      0,
    ) ?? null,
    [currentUser?.id, postsQuery.data?.items],
  )

  /** 头部数据行点击：阅读→书架列表，关注/粉丝/获赞→对应列表页面 */
  function handleStatClick(key: 'reading' | 'following' | 'followers' | 'likes') {
    if (key === 'reading') {
      setActivePanel('shelf')
      panelsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    if (key === 'following' || key === 'followers') {
      navigate(`/me/follows?tab=${key}`)
      return
    }

    navigate('/me/likes')
  }

  function openEditDialog() {
    if (!currentUser) {
      return
    }

    setNicknameDraft(currentUser.nickname)
    setBioDraft(currentUser.bio ?? '')
    setProfileError('')
    setEditDialogVisible(true)
  }

  function closeEditDialog() {
    setEditDialogVisible(false)
    setProfileError('')
    setAvatarError('')
  }

  async function uploadAvatar(avatarDataUrl: string | null) {
    const payload = await requestJson<{ user: User }>('/api/users/me/avatar', {
      method: 'PATCH',
      body: JSON.stringify({
        avatarDataUrl,
      } satisfies UpdateMyAvatarRequest),
    })

    syncSessionUser({
      user: payload.user,
      unreadMessageCount,
      unreadNotificationCount,
    })
    await meQuery.refetch()
  }

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setAvatarError('')

    const validationError = getProfileImageUploadError(file, '头像')
    if (validationError) {
      setAvatarError(validationError)
      event.target.value = ''
      return
    }

    setAvatarSubmitting(true)

    try {
      await uploadAvatar(await prepareAvatarImage(file))
    } catch (error) {
      setAvatarError(error instanceof ApiClientError ? error.message : '暂时无法上传头像，请稍后再试。')
    } finally {
      setAvatarSubmitting(false)
      event.target.value = ''
    }
  }

  async function handleResetAvatar() {
    setAvatarError('')
    setAvatarSubmitting(true)

    try {
      await uploadAvatar(null)
    } catch (error) {
      setAvatarError(error instanceof ApiClientError ? error.message : '暂时无法恢复默认头像，请稍后再试。')
    } finally {
      setAvatarSubmitting(false)
    }
  }

  /** 设置封面：选图后先进裁剪弹窗，确认后再上传 */
  async function handleCoverChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    try {
      const validationError = getProfileImageUploadError(file, '封面')
      if (validationError) {
        toast.error(validationError)
        return
      }
      setCoverDraft(await readFileAsDataUrl(file))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '封面文件无效。')
    } finally {
      event.target.value = ''
    }
  }

  async function handleCoverCropConfirm(croppedDataUrl: string) {
    setCoverSubmitting(true)

    try {
      const payload = await requestJson<{ user: User }>('/api/users/me/cover', {
        method: 'PATCH',
        body: JSON.stringify({
          coverDataUrl: croppedDataUrl,
        } satisfies UpdateMyCoverRequest),
      })

      syncSessionUser({
        user: payload.user,
        unreadMessageCount,
        unreadNotificationCount,
      })
      await meQuery.refetch()
      setCoverDraft(null)
      toast.success('封面已更新')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法上传封面，请稍后再试。')
    } finally {
      setCoverSubmitting(false)
    }
  }

  async function handleUpdateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setProfileError('')

    if (!nicknameDraft.trim()) {
      setProfileError('请输入昵称。')
      return
    }

    setProfileSubmitting(true)

    try {
      const payload = await requestJson<{ user: User }>('/api/users/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          nickname: nicknameDraft.trim(),
          bio: bioDraft.trim(),
        } satisfies UpdateMyProfileRequest),
      })

      syncSessionUser({
        user: payload.user,
        unreadMessageCount,
        unreadNotificationCount,
      })
      await meQuery.refetch()
      closeEditDialog()
    } catch (error) {
      setProfileError(error instanceof ApiClientError ? error.message : '暂时无法保存个人信息，请稍后再试。')
    } finally {
      setProfileSubmitting(false)
    }
  }

  if (!currentUser && meQuery.isLoading) {
    return <ProfileRouteSkeleton />
  }

  const meAccessDenied = meQuery.error instanceof ApiClientError && [401, 403, 404].includes(meQuery.error.status)
  if (!currentUser || meAccessDenied) {
    return (
      <AppState
        tone="error"
        title="个人中心暂时没有打开"
        description="请重新加载页面。"
        primaryAction={{ label: '重新加载', onClick: () => meQuery.refetch(), busy: meQuery.isFetching }}
      />
    )
  }

  const favoritesAccessDenied = favoriteNovelsQuery.error instanceof ApiClientError
    && [401, 403, 404].includes(favoriteNovelsQuery.error.status)

  const statsCards = [
    { icon: BookOpen, label: '在读', value: Object.keys(progressMap).length, unit: '本' },
    { icon: Bookmark, label: '书架', value: readingCount, unit: '本' },
    { icon: PenLine, label: '创作', value: visibleAuthoredNovels.length, unit: '部' },
    { icon: FileText, label: '草稿', value: draftItems.length, unit: '篇' },
  ]

  return (
    <>
      <div className="space-y-5 md:space-y-6">
        {meQuery.isRefetchError ? <AppStateRefreshNotice retry={meQuery.refetch} busy={meQuery.isFetching} /> : null}
        <ProfileHeader
          user={currentUser}
          coverUrl={recentCoverUrl}
          readingCount={readingCount}
          likesCount={likesCount}
          onEditProfile={openEditDialog}
          onSetCover={() => coverInputRef.current?.click()}
          onGoSettings={() => navigate('/settings')}
          onStatClick={handleStatClick}
        />

        <input
          ref={coverInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={handleCoverChange}
        />

        {/* 数据总览：去卡片化，一条细线分隔的平铺横条，小屏四项一行摆下不溢出 */}
        <section className="grid grid-cols-4 divide-x divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] py-3">
          {statsCards.map((card) => (
            <div key={card.label} className="min-w-0 px-2 text-center sm:px-4 sm:text-left">
              <p className="truncate text-lg font-semibold tabular-nums text-[var(--text-primary)] sm:text-2xl">
                {card.value}
                <span className="ml-0.5 text-[10px] font-normal text-[var(--text-tertiary)] sm:ml-1 sm:text-xs">
                  {card.unit}
                </span>
              </p>
              <p className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-[var(--text-tertiary)] sm:justify-start sm:text-xs">
                <card.icon className="hidden h-3.5 w-3.5 text-[var(--color-brand)] sm:block" />
                {card.label}
              </p>
            </div>
          ))}
        </section>

        <section ref={panelsSectionRef} className="scroll-mt-20">
          {/* 分页入口：与作者页一致的 X 风格文字 + 活动下划线，无胶囊容器（方案 18 §4） */}
          <div className="flex border-b border-[var(--border-subtle)]">
            {panels.map((panel) => {
              const count =
                panel.id === 'shelf' ? mergedShelf.length : panel.id === 'creation' ? visibleAuthoredNovels.length : null
              const active = activePanel === panel.id

              return (
                <button
                  key={panel.id}
                  type="button"
                  onClick={() => setActivePanel(panel.id)}
                  className="press-feedback relative flex-1 whitespace-nowrap px-1 py-3 text-center transition-colors hover:bg-[var(--surface-muted)] sm:flex-none sm:px-6"
                >
                  <span
                    className={[
                      'inline-flex items-center gap-1.5 text-sm transition-colors sm:text-[15px]',
                      active ? 'font-bold text-[var(--text-primary)]' : 'font-medium text-[var(--text-tertiary)]',
                    ].join(' ')}
                  >
                    {panel.label}
                    {count !== null ? <span className="text-xs font-normal opacity-75">{count}</span> : null}
                  </span>
                  {active ? (
                    <span className="absolute inset-x-0 bottom-0 mx-auto h-1 w-12 rounded-full bg-[var(--color-brand)] sm:w-14" />
                  ) : null}
                </button>
              )
            })}
          </div>

          {activePanel === 'shelf' ? (
            <div className="mt-5">
              <ShelfPanel
                items={shelfItems}
                progressMap={progressMap}
                onOpenNovel={(novelId) => navigate(`/novel/${novelId}`)}
                onDiscover={() => navigate('/discover')}
              />
            </div>
          ) : null}

          {activePanel === 'creation' ? (
            <div className="mt-5">
              <CreationPanel
                drafts={draftItems}
                novels={visibleAuthoredNovels}
                onOpenStudio={() => navigate('/studio')}
                onOpenNovelStudio={(novelId) => navigate(`/studio/novel/${novelId}`)}
                onOpenNovel={(novelId) => navigate(`/novel/${novelId}`)}
              />
            </div>
          ) : null}

          {activePanel === 'favorites' ? (
            <div className="mt-5">
              {/* X 风格文字子栏：作品 / 帖子，不加胶囊容器 */}
              <div className="flex items-center gap-5 border-b border-[var(--border-subtle)] pb-2">
                {([
                  { id: 'novels', label: '作品' },
                  { id: 'posts', label: '帖子' },
                ] as const).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setFavoritesTab(tab.id)}
                    className={[
                      'press-feedback relative pb-1 text-sm transition-colors',
                      favoritesTab === tab.id
                        ? 'font-bold text-[var(--text-primary)]'
                        : 'font-medium text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                    ].join(' ')}
                  >
                    {tab.label}
                    {favoritesTab === tab.id ? (
                      <span className="absolute inset-x-0 -bottom-2 mx-auto h-1 w-8 rounded-full bg-[var(--color-brand)]" />
                    ) : null}
                  </button>
                ))}
              </div>

              {favoritesTab === 'novels' ? (
                <div className="mt-4">
                  {favoriteNovelsQuery.isRefetchError && !favoritesAccessDenied
                    ? <AppStateRefreshNotice retry={favoriteNovelsQuery.refetch} busy={favoriteNovelsQuery.isFetching} />
                    : null}
                  {favoriteNovelsQuery.isLoading ? (
                    <AppState tone="loading" title="正在加载收藏" className="min-h-[280px]" />
                  ) : favoriteNovelsQuery.isError && (!favoriteNovelsQuery.data || favoritesAccessDenied) ? (
                    <AppState
                      compact
                      tone="error"
                      title="收藏作品加载失败"
                      primaryAction={{ label: '重新加载', onClick: () => favoriteNovelsQuery.refetch(), busy: favoriteNovelsQuery.isFetching }}
                    />
                  ) : favoriteItems.length > 0 ? (
                    <ShelfPanel
                      items={favoriteItems}
                      progressMap={progressMap}
                      onOpenNovel={(novelId) => navigate(`/novel/${novelId}`)}
                      onDiscover={() => navigate('/discover')}
                    />
                  ) : (
                    <AppState
                      compact
                      scene="reading"
                      title="还没有收藏作品"
                      primaryAction={{ label: '去发现', href: '/discover' }}
                    />
                  )}
                </div>
              ) : (
                <div className="mt-1">
                  <ProfileActivity panel="bookmarks" userId={currentUser.id} />
                </div>
              )}
            </div>
          ) : null}

          {activePanel === 'liked' ? (
            <div className="mt-5">
              <ProfileActivity panel="liked" userId={currentUser.id} />
            </div>
          ) : null}

          {activePanel === 'replies' ? (
            <div className="mt-5">
              <ProfileActivity panel="replies" userId={currentUser.id} />
            </div>
          ) : null}
        </section>
      </div>

      {editDialogVisible ? (
        <div className="fixed inset-x-0 top-0 bottom-[var(--keyboard-inset,0px)] z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]">
          <div className="max-h-full w-full max-w-[560px] overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-6 shadow-[var(--shadow-modal)]">
            <div className="space-y-2">
              <h3 className="text-xl font-semibold text-[var(--text-primary)]">编辑资料</h3>
              <p className="text-sm leading-7 text-[var(--text-secondary)]">
                在这里修改头像、昵称和简介。封面可以在个人主页直接点击设置。
              </p>
            </div>

            <form className="mt-5 space-y-4" onSubmit={handleUpdateProfile}>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleAvatarChange}
              />

              <div className="rounded-[var(--radius-lg)] bg-[var(--surface-muted)] p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-4">
                    <Avatar
                      name={currentUser.nickname}
                      src={currentUser.avatarUrl}
                      size="lg"
                      className="h-20 w-20"
                    />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-[var(--text-primary)]">头像</p>
                      <p className="text-xs leading-6 text-[var(--text-tertiary)]">
                        支持 PNG、JPG、WebP，大小不超过 {PROFILE_IMAGE_MAX_MB}MB。
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => avatarInputRef.current?.click()}
                      disabled={avatarSubmitting}
                    >
                      {avatarSubmitting ? '上传中…' : '修改头像'}
                    </Button>
                    {currentUser.avatarUrl ? (
                      <Button type="button" variant="ghost" onClick={handleResetAvatar} disabled={avatarSubmitting}>
                        恢复默认
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              {avatarError ? (
                <p className="rounded-[var(--radius-md)] bg-[var(--surface-muted)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                  {avatarError}
                </p>
              ) : null}

              {profileError ? (
                <p className="rounded-[var(--radius-md)] bg-[var(--surface-muted)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                  {profileError}
                </p>
              ) : null}

              <div className="space-y-2">
                <label className="text-sm font-medium text-[var(--text-primary)]" htmlFor="profile-edit-nickname">
                  昵称
                </label>
                <TextInput
                  id="profile-edit-nickname"
                  value={nicknameDraft}
                  onChange={(event) => setNicknameDraft(event.target.value)}
                  placeholder="请输入昵称"
                  autoComplete="nickname"
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-[var(--text-primary)]" htmlFor="profile-edit-bio">
                  个人简介
                </label>
                <textarea
                  id="profile-edit-bio"
                  value={bioDraft}
                  onChange={(event) => setBioDraft(event.target.value)}
                  placeholder="简单介绍一下你自己"
                  rows={4}
                  className="w-full resize-none rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-4 py-3 text-sm leading-7 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--color-brand)]"
                />
              </div>

              <div className="flex flex-wrap gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    closeEditDialog()
                    coverInputRef.current?.click()
                  }}
                >
                  设置封面
                </Button>
                <Button type="button" variant="secondary" onClick={closeEditDialog} disabled={profileSubmitting}>
                  取消
                </Button>
                <Button type="submit" variant="primary" disabled={profileSubmitting || avatarSubmitting}>
                  {profileSubmitting ? '保存中…' : '保存资料'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {coverDraft !== null && (
        <ImageCropperDialog
          open
          imageDataUrl={coverDraft}
          aspect={3}
          submitting={coverSubmitting}
          onCancel={() => setCoverDraft(null)}
          onConfirm={(croppedDataUrl) => void handleCoverCropConfirm(croppedDataUrl)}
        />
      )}
    </>
  )
}
