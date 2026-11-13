import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserRoundPlus } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'

import { ApiClientError } from '@/app/api-client'
import { useDevice } from '@/components/layout/device-context'
import AppState, { AppStateRefreshNotice } from '@/components/ui/AppState'
import { useToast } from '@/components/ui/toast-context'
import { useKeyboardPushScroll } from '@/hooks/useKeyboardPushScroll'
import {
  CONVERSATION_PAGE_SIZE,
  createDirectConversation,
  getInteractionBadges,
  getMe,
  listConversations,
  listInteractions,
  listMessages,
  listUserFollowers,
  markConversationRead,
  sendMessage,
  setUserFollow,
} from '@/features/community/api'
import Avatar from '@/features/community/components/Avatar'
import ChatComposer from '@/features/messages/components/ChatComposer'
import ConversationList from '@/features/messages/components/ConversationList'
import MessageBubbleList, { type PendingMessage } from '@/features/messages/components/MessageBubbleList'
import {
  ChatInputSkeleton,
  ConversationBackButton,
  ConversationBubblesSkeleton,
  PendingConversationHeader,
  conversationHeaderClass,
  conversationListPaneClass,
  conversationPaneClass,
  messagePanelClass,
} from '@/features/messages/components/MessagesLoading'
import { preloadMessageDetailPages } from '@/features/messages/load-detail-pages'
import type { Conversation, FollowUserItem, Message } from '../../shared/contracts/index.js'

/**
 * 消息中心（TikTok/Messenger 式重设计）：
 * - 手机：会话列表 ↔ 聊天全屏切换
 * - 平板：左会话列表 300px + 右聊天区分栏；电脑：列表加宽到 360px
 * - 列表面板：互关好友横向头像栏 + 「新关注我的」与系统消息固定置顶 + 私聊会话
 */
export default function MessagesPage() {
  const { isMobile } = useDevice()
  const isSplitLayout = !isMobile
  const queryClient = useQueryClient()
  const toast = useToast()
  const { key: locationKey } = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  // 选中会话直接从 URL 派生，URL 是唯一数据源：
  // 之前用本地 state + effect 与路由参数双向同步，但 react-router v7 的 setSearchParams
  // 走 startTransition 延迟提交，本地 state 先行提交会产生「列表↔聊天」来回翻转的中间帧，
  // 手机端表现为进入/退出聊天时各闪一下；派生后页面切换与壳层底栏隐藏在同一次提交内完成
  const routeConversationId = searchParams.get('conversationId') ?? ''
  const [friendOpen, setFriendOpen] = useState<{ person: FollowUserItem; locationKey: string } | null>(null)
  const friendOpenRequest = useRef<symbol | null>(null)
  const openingConversations = useRef(new Map<string, Promise<Conversation>>())
  const pendingFriend = friendOpen?.locationKey === locationKey ? friendOpen.person : undefined
  const [openedConversation, setOpenedConversation] = useState<Conversation | null>(null)
  const [draftByConversationId, setDraftByConversationId] = useState<Record<string, string>>({})
  const [pendingByConversation, setPendingByConversation] = useState<Record<string, PendingMessage[]>>({})
  const [followBackSubmitting, setFollowBackSubmitting] = useState(false)
  const messageScrollRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => () => { friendOpenRequest.current = null }, [locationKey])
  useEffect(() => {
    setFriendOpen(current => current?.locationKey === locationKey ? current : null)
  }, [locationKey])

  useEffect(() => {
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(preloadMessageDetailPages, { timeout: 3000 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = window.setTimeout(preloadMessageDetailPages, 1000)
    return () => window.clearTimeout(timer)
  }, [])

  // 会话列表分页：15s 轮询只刷第 1 页（query 缓存），翻出来的更早页放独立 state 渲染时去重合并，
  // 避免轮询把用户已加载的分页冲掉
  const [conversationPages, setConversationPages] = useState<Record<number, Conversation[]>>({})
  const [conversationHasMore, setConversationHasMore] = useState(false)
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false)
  const conversationLoadingRef = useRef(false)

  const meQuery = useQuery({
    queryKey: ['community', 'me'],
    queryFn: getMe,
  })

  const conversationsQuery = useQuery({
    queryKey: ['community', 'conversations'],
    queryFn: () => listConversations(),
    // 方案 6.1：15s 轻轮询，保持会话列表/未读数新鲜
    refetchInterval: 15_000,
  })

  // 首页加载后同步分页元信息（第 2 页从这里的 hasMore/total 推导）
  useEffect(() => {
    const pagination = conversationsQuery.data?.pagination
    if (pagination) setConversationHasMore(pagination.hasMore)
  }, [conversationsQuery.data])

  const loadMoreConversations = () => {
    if (conversationLoadingRef.current || !conversationHasMore) return
    conversationLoadingRef.current = true
    setLoadingMoreConversations(true)
    const nextPage = Object.keys(conversationPages).length + 2
    listConversations(CONVERSATION_PAGE_SIZE, nextPage)
      .then((data) => {
        setConversationPages((current) => ({ ...current, [nextPage]: data.items }))
        setConversationHasMore(data.pagination?.hasMore ?? false)
      })
      .catch(() => {
        // 加载失败不打断列表，下次触底重试
      })
      .finally(() => {
        conversationLoadingRef.current = false
        setLoadingMoreConversations(false)
      })
  }

  // 第 1 页（轮询保鲜）+ 更早页去重合并，合并后仍按最近消息时间倒序
  const allConversations = useMemo(() => {
    const firstPage = conversationsQuery.data?.items ?? []
    const olderPages = Object.keys(conversationPages)
      .map(Number)
      .sort((a, b) => a - b)
      .flatMap((page) => conversationPages[page])
    const seen = new Set(firstPage.map((item) => item.id))
    return [...firstPage, ...olderPages.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)))]
  }, [conversationsQuery.data, conversationPages])

  // 互关好友与最新粉丝：登录后拉取自己的粉丝列表（含 followedByViewer/followsViewer 标记）
  const followersQuery = useQuery({
    queryKey: ['community', 'followers', 'me'],
    queryFn: () => listUserFollowers('me'),
    enabled: Boolean(meQuery.data?.user?.id),
  })
  const followerItems = useMemo(() => followersQuery.data?.items ?? [], [followersQuery.data])
  const mutualFriends = useMemo(
    () => followerItems.filter((item) => item.followedByViewer && item.followsViewer),
    [followerItems],
  )
  const latestFollower = followerItems[0] ?? null

  // 最新互动（赞/收藏/评论）：给「互动消息」固定入口提供副标题
  const interactionsQuery = useQuery({
    queryKey: ['community', 'interactions'],
    queryFn: listInteractions,
    enabled: Boolean(meQuery.data?.user?.id),
  })
  const latestInteraction = interactionsQuery.data?.items?.[0] ?? null

  // 互动/新关注未读红点：15s 轻轮询保持新鲜
  const badgesQuery = useQuery({
    queryKey: ['community', 'interaction-badges'],
    queryFn: getInteractionBadges,
    enabled: Boolean(meQuery.data?.user?.id),
    refetchInterval: 15_000,
  })
  const interactionsUnseen = badgesQuery.data?.interactionsUnseen ?? 0
  const followersUnseen = badgesQuery.data?.followersUnseen ?? 0

  // 直接信任路由参数：新建会话可能还不在缓存列表里（staleTime 内不会重拉），
  // 聊天区已有 messagesQuery.data.conversation 兑底，选中不依赖列表包含该会话；
  // 平板/桌面分栏无参数时兜底选中第一条会话，手机端无参数即回到列表
  const selectedConversationId = pendingFriend
    ? ''
    : routeConversationId || (isSplitLayout ? (allConversations[0]?.id ?? '') : '')

  const messagesQuery = useQuery({
    queryKey: ['community', 'messages', selectedConversationId],
    queryFn: () => listMessages(selectedConversationId, 20, 1),
    enabled: Boolean(selectedConversationId),
    refetchInterval: 15_000,
  })

  // 消息分页：第 1 页 = 最新 20 条（后端倒序分页，轮询只刷这页），更早的历史页放独立 state 往前拼接
  const [olderMessagesByConversation, setOlderMessagesByConversation] = useState<
    Record<string, { items: Message[]; page: number; hasMore: boolean }>
  >({})
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const olderMessagesLoadingRef = useRef(false)
  // 加载更早消息后跳过一次「滚到底部」，避免覆盖刚恢复的滚动位置
  const skipScrollToBottomRef = useRef(false)

  // 是否还有更早的历史消息：已翻过页时以更早页的 hasMore 为准，否则看第 1 页的分页信息
  const hasMoreMessages = selectedConversationId
    ? (olderMessagesByConversation[selectedConversationId]?.hasMore ?? messagesQuery.data?.pagination?.hasMore ?? false)
    : false

  const loadEarlierMessages = () => {
    const conversationId = selectedConversationId
    if (!conversationId || !hasMoreMessages) return
    if (olderMessagesLoadingRef.current) return
    olderMessagesLoadingRef.current = true
    setLoadingOlderMessages(true)
    const state = olderMessagesByConversation[conversationId]
    const nextPage = (state?.page ?? 1) + 1
    listMessages(conversationId, 20, nextPage)
      .then((data) => {
        // 加载前记录内容高度，渲染后按高度差恢复滚动位置，视口停留在原消息上
        const element = messageScrollRef.current
        const previousScrollHeight = element?.scrollHeight ?? 0
        setOlderMessagesByConversation((current) => {
          const existing = current[conversationId]?.items ?? []
          const existingIds = new Set(existing.map((item) => item.id))
          return {
            ...current,
            [conversationId]: {
              items: [...data.items.filter((item) => !existingIds.has(item.id)), ...existing],
              page: nextPage,
              hasMore: data.pagination?.hasMore ?? false,
            },
          }
        })
        requestAnimationFrame(() => {
          const node = messageScrollRef.current
          if (node && previousScrollHeight > 0) {
            skipScrollToBottomRef.current = true
            node.scrollTop = node.scrollHeight - previousScrollHeight
          }
        })
      })
      .catch(() => {
        // 历史消息加载失败不打断聊天，下次触顶重试
      })
      .finally(() => {
        olderMessagesLoadingRef.current = false
        setLoadingOlderMessages(false)
      })
  }

  // 进入会话即标记已读：本地未读数归零 + 刷新全局未读统计；
  // 依赖最新消息 id，停留在聊天中收到新消息时也持续上报已读，对方的「已读」状态才能半实时刷新
  const latestMessageId = messagesQuery.data?.items?.at(-1)?.id ?? ''
  useEffect(() => {
    if (!selectedConversationId) return

    void markConversationRead(selectedConversationId)
      .then(() => {
        queryClient.setQueryData<{ items: Conversation[] } | undefined>(
          ['community', 'conversations'],
          (current) => {
            if (!current) return current
            return {
              ...current,
              items: current.items.map((conversation) =>
                conversation.id === selectedConversationId
                  ? { ...conversation, unreadCount: 0 }
                  : conversation,
              ),
            }
          },
        )
        void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
      })
      .catch(() => {
        // 已读标记失败不阻断聊天，下次轮询会重新对齐
      })
  }, [queryClient, selectedConversationId, latestMessageId])

  const removePending = (conversationId: string, tempId: string) => {
    setPendingByConversation((current) => ({
      ...current,
      [conversationId]: (current[conversationId] ?? []).filter((item) => item.tempId !== tempId),
    }))
  }

  const sendMessageMutation = useMutation({
    mutationFn: ({
      conversationId,
      content,
      type,
    }: {
      conversationId: string
      content: string
      type: 'text' | 'image'
      tempId: string
    }) => sendMessage(conversationId, { type, content }),
    onSuccess: async (message, variables) => {
      removePending(variables.conversationId, variables.tempId)
      queryClient.setQueryData<{ conversation: Conversation | null; items: Message[] } | undefined>(
        ['community', 'messages', variables.conversationId],
        (current) => {
          if (!current) return current
          return { ...current, items: [...current.items, message] }
        },
      )
      queryClient.setQueryData<{ items: Conversation[] } | undefined>(
        ['community', 'conversations'],
        (current) => {
          if (!current) return current
          return {
            ...current,
            items: current.items.map((conversation) =>
              conversation.id === variables.conversationId
                ? {
                    ...conversation,
                    lastMessagePreview: message.type === 'image' ? '[图片]' : message.content,
                    lastMessageAt: message.createdAt,
                    unreadCount: 0,
                  }
                : conversation,
            ),
          }
        },
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['community', 'messages', variables.conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['community', 'conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['community', 'me'] }),
      ])
    },
    onError: (error, variables) => {
      setPendingByConversation((current) => ({
        ...current,
        [variables.conversationId]: (current[variables.conversationId] ?? []).map((item) =>
          item.tempId === variables.tempId ? { ...item, status: 'failed' } : item,
        ),
      }))
      toast.error(error instanceof Error ? error.message : '这条消息暂时没有发出，请稍后再试。')
    },
  })

  const selectedConversation =
    allConversations.find((item) => item.id === selectedConversationId) ??
    messagesQuery.data?.conversation ??
    (openedConversation?.id === selectedConversationId ? openedConversation : null) ??
    null
  // 更早历史页（时间正序）拼在第 1 页前面，按 id 去重
  const activeMessages = useMemo(() => {
    const firstPage = messagesQuery.data?.items ?? []
    const older = selectedConversationId ? (olderMessagesByConversation[selectedConversationId]?.items ?? []) : []
    if (older.length === 0) return firstPage
    const firstPageIds = new Set(firstPage.map((item) => item.id))
    return [...older.filter((item) => !firstPageIds.has(item.id)), ...firstPage]
  }, [messagesQuery.data, olderMessagesByConversation, selectedConversationId])
  const activePending = selectedConversationId ? (pendingByConversation[selectedConversationId] ?? []) : []
  const activeDraft = selectedConversation ? (draftByConversationId[selectedConversation.id] ?? '') : ''
  const currentUserId = meQuery.data?.user?.id ?? ''
  // 对方最近读到会话的时间：从消息接口返回的会话成员里取（用于「已读」状态）
  const counterpartLastReadAt = useMemo(() => {
    const members = messagesQuery.data?.conversation?.members ?? []
    return members.find((member) => member.id && String(member.id) !== currentUserId)?.lastReadAt ?? null
  }, [messagesQuery.data, currentUserId])
  const totalUnread = allConversations.reduce((sum, item) => sum + item.unreadCount, 0)
  const showMobileChat = Boolean(routeConversationId || pendingFriend)
  const shouldShowListPane = isSplitLayout || !showMobileChat
  const shouldShowConversationPane = isSplitLayout || showMobileChat

  // 回关横幅：对方关注了我而我还没回关时展示
  const showFollowBackBanner =
    selectedConversation?.type === 'direct' &&
    selectedConversation.counterpartFollowsViewer === true &&
    selectedConversation.viewerFollowsCounterpart === false
  // 陌生消息限额：未互关的直聊单方最多发 3 条（含发送中的乐观消息，失败的不占额度）
  const isStrangerConversation =
    selectedConversation?.type === 'direct' && selectedConversation.isMutualFollow === false
  const sentByMeCount =
    activeMessages.filter((message) => message.senderId === currentUserId).length +
    activePending.filter((item) => item.status !== 'failed').length
  const strangerQuotaLeft = isStrangerConversation ? Math.max(0, 3 - sentByMeCount) : Infinity

  // 新消息到达后滚动到底部（加载更早消息触发的长度变化除外，保持视口停留在原消息上）
  useEffect(() => {
    if (skipScrollToBottomRef.current) {
      skipScrollToBottomRef.current = false
      return
    }
    const element = messageScrollRef.current
    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }, [selectedConversationId, activeMessages.length, activePending.length])

  // 消息区滚动接近顶部时自动加载更早的历史消息
  const handleMessageScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!hasMoreMessages || loadingOlderMessages) return
    if (event.currentTarget.scrollTop <= 80) loadEarlierMessages()
  }

  // 键盘弹起时微信/QQ 式把聊天对话顶上去（消息区加载完成后才挂载，ready 翻真重绑）
  useKeyboardPushScroll(messageScrollRef, !messagesQuery.isLoading && !messagesQuery.isError)

  const dispatchMessage = (
    conversationId: string,
    content: string,
    type: 'text' | 'image' = 'text',
    tempId?: string,
  ) => {
    const finalTempId = tempId ?? `pending-${Date.now()}-${Math.round(Math.random() * 1000)}`
    if (!tempId) {
      setPendingByConversation((current) => ({
        ...current,
        [conversationId]: [
          ...(current[conversationId] ?? []),
          { tempId: finalTempId, content, createdAt: new Date().toISOString(), status: 'sending', type },
        ],
      }))
    } else {
      setPendingByConversation((current) => ({
        ...current,
        [conversationId]: (current[conversationId] ?? []).map((item) =>
          item.tempId === tempId ? { ...item, status: 'sending' } : item,
        ),
      }))
    }
    sendMessageMutation.mutate({ conversationId, content, type, tempId: finalTempId })
  }

  const handleSend = () => {
    const content = activeDraft.trim()
    if (!selectedConversationId || !content) return
    if (isStrangerConversation && strangerQuotaLeft <= 0) {
      toast.info('你们还没有互相关注，最多只能发送 3 条陌生消息。')
      return
    }
    setDraftByConversationId((current) => ({ ...current, [selectedConversationId]: '' }))
    dispatchMessage(selectedConversationId, content)
  }

  const handleRetryPending = (tempId: string) => {
    const pending = activePending.find((item) => item.tempId === tempId)
    if (!pending || !selectedConversationId) return
    dispatchMessage(selectedConversationId, pending.content, pending.type ?? 'text', tempId)
  }

  // 加号发图片：校验格式与大小后转 dataURL 走同一发送链路（后端落盘并替换为图片地址）
  const handlePickImage = (file: File) => {
    if (!selectedConversationId) return
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      toast.error('仅支持 PNG、JPG 或 WebP 图片。')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('图片不能超过 5MB。')
      return
    }
    if (isStrangerConversation && strangerQuotaLeft <= 0) {
      toast.info('你们还没有互相关注，最多只能发送 3 条陌生消息。')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) {
        toast.error('图片读取失败，请重试。')
        return
      }
      dispatchMessage(selectedConversationId, dataUrl, 'image')
    }
    reader.onerror = () => toast.error('图片读取失败，请重试。')
    reader.readAsDataURL(file)
  }

  const handleSelectConversation = (conversationId: string) => {
    friendOpenRequest.current = null
    setFriendOpen(null)
    setSearchParams({ conversationId })
  }

  const handleBackToList = () => {
    friendOpenRequest.current = null
    setFriendOpen(null)
    if (routeConversationId) setSearchParams({})
  }

  // 回关对方：成功后刷新会话/消息/粉丝数据，横幅与陌生限额随之解除
  const handleFollowBack = async () => {
    const counterpartId = selectedConversation?.counterpart?.id
    if (!counterpartId || followBackSubmitting) return

    setFollowBackSubmitting(true)
    try {
      await setUserFollow(String(counterpartId), true)
      toast.success('已回关，现在可以不限次数畅聊了。')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['community', 'conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['community', 'messages', selectedConversationId] }),
        queryClient.invalidateQueries({ queryKey: ['community', 'followers', 'me'] }),
      ])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '回关暂时没有成功，请稍后再试。')
    } finally {
      setFollowBackSubmitting(false)
    }
  }

  // 点互关好友头像：复用已有直聊会话，否则创建后选中
  const handleOpenFriend = async (userId: string) => {
    if (pendingFriend?.id === userId) return

    const existing = allConversations.find(
      (item) => item.type === 'direct' && item.counterpart?.id === userId,
    )
    if (existing) {
      handleSelectConversation(existing.id)
      return
    }

    const person = mutualFriends.find((item) => item.id === userId)
    if (!person) return
    const request = Symbol()
    friendOpenRequest.current = request
    setFriendOpen({ person, locationKey })
    try {
      const pending = openingConversations.current
      let opening = pending.get(userId)
      if (!opening) {
        opening = createDirectConversation(userId).finally(() => { pending.delete(userId) })
        pending.set(userId, opening)
      }
      const conversation = await opening
      if (friendOpenRequest.current !== request) return
      setOpenedConversation(conversation)
      setSearchParams({ conversationId: conversation.id })
      void queryClient.invalidateQueries({ queryKey: ['community', 'conversations'] })
    } catch (error) {
      if (friendOpenRequest.current !== request) return
      friendOpenRequest.current = null
      setFriendOpen(null)
      toast.error(error instanceof Error ? error.message : '暂时无法打开会话，请稍后再试。')
    }
  }

  const conversationError = conversationsQuery.isError && !conversationsQuery.data ? (
    <AppState
      compact
      tone="error"
      title="会话列表暂时没有打开"
      primaryAction={{ label: '重新加载', onClick: () => conversationsQuery.refetch(), busy: conversationsQuery.isFetching }}
    />
  ) : null
  const messagesError = (
    <AppState
      compact
      tone="error"
      title="消息暂时没有加载"
      primaryAction={{ label: '重试', onClick: () => messagesQuery.refetch(), busy: messagesQuery.isFetching }}
      className="min-h-0 flex-1"
    />
  )
  const messageError = messagesQuery.error
  const messagesUnavailable = messagesQuery.isError && (!messagesQuery.data
    || (messageError instanceof ApiClientError && [401, 403, 404].includes(messageError.status)))

  return (
    // 单一分栏面：桌面/平板用一张卡片包住两栏中间分隔线，手机端全出血去掉卡片壳；壳层已改 overflow-hidden 固定布局，直接 flex-1 铺满剩余高度，不再估算 dvh 减值
    <div className={messagePanelClass}>
      {shouldShowListPane ? (
        <aside className={conversationListPaneClass}>
          <ConversationList
            conversations={allConversations}
            selectedId={selectedConversationId || null}
            onSelect={handleSelectConversation}
            totalUnread={totalUnread}
            mutualFriends={mutualFriends}
            latestFollower={latestFollower}
            latestInteraction={latestInteraction}
            interactionsUnseen={interactionsUnseen}
            followersUnseen={followersUnseen}
            onOpenFriend={(userId) => void handleOpenFriend(userId)}
            openingFriendId={pendingFriend?.id ?? null}
            hasMoreConversations={conversationHasMore}
            loadingMoreConversations={loadingMoreConversations}
            onLoadMoreConversations={loadMoreConversations}
            loadingConversations={conversationsQuery.isLoading}
            loadingFriends={followersQuery.isLoading}
            conversationError={conversationError}
            refreshNotice={conversationsQuery.isRefetchError
              ? <AppStateRefreshNotice retry={conversationsQuery.refetch} busy={conversationsQuery.isFetching} />
              : null}
          />
        </aside>
      ) : null}

      {shouldShowConversationPane ? (
        <section className={conversationPaneClass} data-message-pending-chat={pendingFriend ? '' : undefined}>
          {selectedConversation ? (
            <>
              {/* 聊天头部：手机端收紧左边距与间距，让返回键+头像+昵称整体靠左 */}
              <div className={conversationHeaderClass}>
                {!isSplitLayout && <ConversationBackButton onBack={handleBackToList} />}
                {/* 直聊会话：头像与昵称可点进入对方主页 */}
                {selectedConversation.type === 'direct' && selectedConversation.counterpart ? (
                  <Link
                    to={`/author/${selectedConversation.counterpart.id}`}
                    aria-label={`查看 ${selectedConversation.title ?? selectedConversation.counterpart.nickname} 的主页`}
                    className="shrink-0"
                  >
                    <Avatar
                      name={selectedConversation.title ?? selectedConversation.counterpart.nickname}
                      src={selectedConversation.avatarUrl ?? selectedConversation.counterpart.avatarUrl}
                      size="sm"
                    />
                  </Link>
                ) : (
                  <Avatar name={selectedConversation.title ?? '系统'} src={selectedConversation.avatarUrl} size="sm" />
                )}
                <div className="min-w-0 flex-1">
                  {selectedConversation.type === 'direct' && selectedConversation.counterpart ? (
                    <Link
                      to={`/author/${selectedConversation.counterpart.id}`}
                      className="block truncate text-sm font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--color-brand)]"
                    >
                      {selectedConversation.title ?? selectedConversation.counterpart.nickname}
                    </Link>
                  ) : (
                    <h3 className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {selectedConversation.title ?? '系统通知'}
                    </h3>
                  )}
                  {selectedConversation.type === 'system' ? (
                    <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">系统会把重要提醒收在这里</p>
                  ) : selectedConversation.presence === 'online' ? (
                    <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">在线</p>
                  ) : selectedConversation.presence === 'typing' ? (
                    <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">正在输入...</p>
                  ) : selectedConversation.unreadCount > 0 ? (
                    <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">{selectedConversation.unreadCount} 条未读</p>
                  ) : null}
                </div>
              </div>

              {/* 回关横幅：对方关注了你而你未回关，实心红色长方形白字按钮一键回关 */}
              {showFollowBackBanner ? (
                <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-2.5">
                  <p className="min-w-0 truncate text-xs text-[var(--text-secondary)]">
                    对方关注了你，回关后可以不限次数畅聊
                  </p>
                  <button
                    type="button"
                    disabled={followBackSubmitting}
                    onClick={() => void handleFollowBack()}
                    className="press-feedback shrink-0 rounded-[6px] bg-rose-500 px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {followBackSubmitting ? '关注中...' : '关注'}
                  </button>
                </div>
              ) : null}

              {/* 消息区 */}
              {messagesQuery.isLoading ? (
                <ConversationBubblesSkeleton />
              ) : messagesUnavailable ? (
                messagesError
              ) : (
                <div ref={messageScrollRef} className="min-h-0 flex-1 overflow-y-auto" onScroll={handleMessageScroll}>
                  {messagesQuery.isRefetchError ? <AppStateRefreshNotice retry={messagesQuery.refetch} busy={messagesQuery.isFetching} /> : null}
                  {/* 历史消息分页：触顶自动加载，也保留手动按钮兑底 */}
                  {hasMoreMessages ? (
                    <div className="flex justify-center pt-3">
                      <button
                        type="button"
                        onClick={loadEarlierMessages}
                        disabled={loadingOlderMessages}
                        className="press-feedback rounded-[var(--radius-pill)] bg-[var(--surface-muted)] px-3 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-60"
                      >
                        {loadingOlderMessages ? '正在加载更早的消息...' : '加载更早的消息'}
                      </button>
                    </div>
                  ) : null}
                  {activeMessages.length === 0 && activePending.length === 0 ? (
                    <AppState compact scene="message" title="还没有消息" />
                  ) : (
                    <MessageBubbleList
                      messages={activeMessages}
                      pendingMessages={activePending}
                      currentUserId={currentUserId}
                      counterpartLastReadAt={counterpartLastReadAt}
                      onRetryPending={handleRetryPending}
                    />
                  )}
                </div>
              )}

              {/* 输入区 / 系统会话提示 / 陌生消息限额 */}
              {selectedConversation.type === 'system' ? (
                <div className="border-t border-[var(--border-subtle)] px-4 py-3 text-center text-xs text-[var(--text-tertiary)]">
                  系统通知不支持回复
                </div>
              ) : isStrangerConversation && strangerQuotaLeft <= 0 ? (
                <div className="border-t border-[var(--border-subtle)] px-4 py-3 text-center text-xs text-[var(--text-tertiary)]">
                  你们还没有互相关注，最多发送 3 条陌生消息，等对方回关后再继续聊吧。
                </div>
              ) : (
                <>
                  {isStrangerConversation ? (
                    <div className="flex justify-center border-t border-[var(--border-subtle)] px-4 pt-2.5">
                      <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--surface-muted)] px-3 py-1 text-[11px] text-[var(--text-tertiary)]">
                        <UserRoundPlus className="h-3 w-3" />
                        互相关注前还可以发送
                        <span className="font-semibold tabular-nums text-[var(--text-primary)]">{strangerQuotaLeft}</span>
                        条消息
                      </span>
                    </div>
                  ) : null}
                  <ChatComposer
                    value={activeDraft}
                    onChange={(value) =>
                      setDraftByConversationId((current) => ({
                        ...current,
                        [selectedConversation.id]: value,
                      }))
                    }
                    onSend={handleSend}
                    onPickImage={handlePickImage}
                    isSending={sendMessageMutation.isPending}
                  />
                </>
              )}
            </>
          ) : pendingFriend || selectedConversationId || conversationsQuery.isLoading ? (
            <>
              <PendingConversationHeader onBack={isSplitLayout ? undefined : handleBackToList} person={pendingFriend} />
              {!pendingFriend && messagesQuery.isError ? (
                messagesError
              ) : (
                <>
                  <ConversationBubblesSkeleton />
                  <ChatInputSkeleton />
                </>
              )}
            </>
          ) : conversationError ? (
            conversationError
          ) : (
            <AppState
              scene="message"
              title="选一个会话开始聊天"
              className="min-h-0 flex-1"
            />
          )}
        </section>
      ) : null}
    </div>
  )
}
