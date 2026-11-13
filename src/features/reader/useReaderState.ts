import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import {
  asArray,
  getDisplayTitle,
  getReaderPayload,
  listCommentsByTarget,
  splitReaderParagraphs,
} from '@/features/discover/api'
import { ApiClientError } from '@/app/api-client'
import { getReadingProgress, saveReadingProgress, updateReadingScrollPercent } from '@/features/home/reading-progress'
import { pushProgress, pushScrollProgress } from '@/features/home/reading-sync'
import { getChapterContent, getStudioPayload } from '@/features/studio/api'
import type { ReaderPayload } from '../../../shared/contracts/index.js'
import { cacheReaderPayload, getCachedReaderPayload } from './reader-offline-cache'
import {
  getFontScaleOption,
  getThemeDefaultTone,
  getToneOption,
  loadReaderSettings,
  saveReaderSettings,
  type ReaderFontScale,
  type ReaderPageTurnMode,
  type ReaderTone,
} from './reader-settings'
import { useTtsPlayer } from './tts/useTtsPlayer'

export type ReaderPanelId = 'directory' | 'comments' | 'settings' | null

const numberFormatter = new Intl.NumberFormat('zh-CN')

// 阅读正文内容基本不变，拉长缓存时间，配合预加载实现秒开翻章
const READER_STALE_TIME = 5 * 60_000
const READER_GC_TIME = 15 * 60_000

export const readerQueryKey = (novelId: string, chapterId: string, fromStudio: boolean) =>
  ['reader', novelId, chapterId, fromStudio ? 'studio-preview' : 'public'] as const

/** 拉取阅读器 payload：公开阅读走 reader 接口，创作区预览用 studio 数据拼装 */
async function fetchReaderPayload(
  novelId: string,
  chapterId: string,
  fromStudio: boolean,
): Promise<ReaderPayload> {
  if (!fromStudio) {
    try {
      const payload = await getReaderPayload(novelId, chapterId)
      // 读成功的章节落一份本地缓存：断网时回落它继续阅读（番茄式离线体验）
      cacheReaderPayload(novelId, chapterId, payload)
      return payload
    } catch (error) {
      if (error instanceof ApiClientError && [401, 403, 404].includes(error.status)) throw error
      // 网络失败/服务异常：回落本地缓存，命中则带离线标记供 UI 提示
      const cached = getCachedReaderPayload(novelId, chapterId)
      if (cached) return { ...cached, fromOfflineCache: true }
      throw error
    }
  }

  const [studio, chapter] = await Promise.all([
    getStudioPayload(novelId),
    getChapterContent(novelId, chapterId),
  ])

  const chapterList = asArray(studio.chapters)
  const currentIndex = chapterList.findIndex((item) => item.id === chapter.id)

  return {
    novel: {
      id: studio.novel.id,
      title: studio.novel.title,
      displayTitle: studio.novel.displayTitle,
      slug: studio.novel.slug,
      coverUrl: studio.novel.coverUrl,
    },
    currentChapter: chapter,
    volumes: studio.volumes,
    chapterList,
    previousChapterId: currentIndex > 0 ? chapterList[currentIndex - 1].id : null,
    nextChapterId:
      currentIndex >= 0 && currentIndex < chapterList.length - 1
        ? chapterList[currentIndex + 1].id
        : null,
  }
}

const formatDateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : '暂未更新'

/**
 * 阅读器共享状态层：数据查询、显示设置、滚动进度、本机阅读进度写回。
 * 三端布局（ReaderMobile / ReaderTablet / ReaderDesktop）共用。
 */
export function useReaderState() {
  const { novelId, chapterId } = useParams()
  const [searchParams] = useSearchParams()
  const fromStudio = searchParams.get('from') === 'studio'
  const returnTo = searchParams.get('returnTo')

  const initialSettings = useMemo(() => loadReaderSettings(), [])
  const [fontScale, setFontScaleState] = useState<ReaderFontScale>(initialSettings.fontScale)
  const [pageTurnMode, setPageTurnModeState] = useState<ReaderPageTurnMode>(initialSettings.pageTurnMode)
  // 全局主题模式：监听 html.dark 变化，阅读中切主题也能实时响应
  const [isDarkTheme, setIsDarkTheme] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkTheme(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  // 底色：显式选择只在选择时的主题模式下生效；切主题后跟随默认（深色→夜读，浅色→纸感）
  const [toneOverride, setToneOverride] = useState<{
    tone: ReaderTone
    theme: 'light' | 'dark'
  } | null>(() =>
    initialSettings.tone && initialSettings.toneTheme
      ? { tone: initialSettings.tone, theme: initialSettings.toneTheme }
      : null,
  )
  const currentTheme: 'light' | 'dark' = isDarkTheme ? 'dark' : 'light'
  const tone: ReaderTone =
    toneOverride && toneOverride.theme === currentTheme
      ? toneOverride.tone
      : getThemeDefaultTone(isDarkTheme)
  // 深链（互动消息直达）：?panel=comments 展开评论面板；?paragraph=N 直达对应段落并高亮。
  // 段评带段落时优先定位正文段落（不弹面板，面板会盖住高亮位置）
  const deepLinkParagraph = useMemo(() => {
    const raw = searchParams.get('paragraph')
    if (raw === null) return null
    const value = Number.parseInt(raw, 10)
    return Number.isInteger(value) && value >= 0 ? value : null
  }, [searchParams])
  const deepLinkComments = searchParams.get('panel') === 'comments'
  const [activePanel, setActivePanelState] = useState<ReaderPanelId>(() =>
    deepLinkComments && deepLinkParagraph === null ? 'comments' : null,
  )
  // 段评：当前查看的段落序号（null = 章评总合视图）与定位高亮闪烁的段落
  const [activeParagraphIndex, setActiveParagraphIndex] = useState<number | null>(null)
  const [highlightParagraphIndex, setHighlightParagraphIndex] = useState<number | null>(null)
  const highlightTimerRef = useRef<number | null>(null)
  const [scrollPercent, setScrollPercent] = useState(0)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  // 分页阅读布局注册的段落定位器：返回 true 表示已接管定位（翻页）
  const paragraphLocatorRef = useRef<((index: number) => boolean) | null>(null)
  const queryClient = useQueryClient()

  const readerQuery = useQuery({
    queryKey: readerQueryKey(novelId ?? '', chapterId ?? '', fromStudio),
    queryFn: async (): Promise<ReaderPayload> => {
      if (!novelId || !chapterId) {
        throw new Error('未找到章节内容。')
      }

      return fetchReaderPayload(novelId, chapterId, fromStudio)
    },
    enabled: Boolean(novelId && chapterId),
    // 断网时 fetch 直接失败：不空转重试，立刻落错误态（缓存兜底已在 queryFn 内做）；
    // 创作预览的结构化错误才少量重试
    retry: (failureCount, error) => fromStudio && error instanceof ApiClientError && failureCount < 2,
    // 预取未命中时旧章数据作占位：换章等待期间不闪骨架屏、不重挂阅读器，
    // 布局层以 reader.currentChapter.id === chapterId 判断数据新鲜度后再动页码
    placeholderData: keepPreviousData,
    staleTime: READER_STALE_TIME,
    gcTime: READER_GC_TIME,
  })

  const commentsQuery = useQuery({
    queryKey: ['chapter-comments', chapterId],
    // 段评需要全量统计各段评论数，pageSize 放大到 200
    queryFn: () => listCommentsByTarget('chapter', chapterId ?? '', { page: 1, pageSize: 200 }),
    enabled: Boolean(chapterId && readerQuery.isSuccess),
  })

  const reader = readerQuery.data ?? null

  // 后台静默预加载相邻章节：点击上一章/下一章时直接命中缓存，无任何 UI 表现
  useEffect(() => {
    if (!reader || !novelId) return

    for (const targetChapterId of [reader.nextChapterId, reader.previousChapterId]) {
      if (!targetChapterId) continue
      void queryClient.prefetchQuery({
        queryKey: readerQueryKey(novelId, targetChapterId, fromStudio),
        queryFn: () => fetchReaderPayload(novelId, targetChapterId, fromStudio),
        staleTime: READER_STALE_TIME,
        gcTime: READER_GC_TIME,
      })
    }
  }, [queryClient, reader, novelId, fromStudio])

  const paragraphs = useMemo(
    () => splitReaderParagraphs(reader?.currentChapter.content ?? ''),
    [reader?.currentChapter.content],
  )
  const chapterComments = asArray(commentsQuery.data?.items)

  // 各段落的根评论数（气泡角标）
  const paragraphCommentCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const comment of chapterComments) {
      if (typeof comment.paragraphIndex === 'number' && comment.paragraphIndex >= 0) {
        counts.set(comment.paragraphIndex, (counts.get(comment.paragraphIndex) ?? 0) + 1)
      }
    }
    return counts
  }, [chapterComments])
  const chapterList = asArray(reader?.chapterList)
  const volumes = asArray(reader?.volumes)
  const chapterTitle = reader?.currentChapter.title?.trim() || '未命名章节'
  const novelTitle = reader ? getDisplayTitle(reader.novel) : '未命名作品'
  const currentIndex = reader
    ? chapterList.findIndex((chapter) => chapter.id === reader.currentChapter.id)
    : -1
  const totalChapters = chapterList.length

  /** 章节级进度 + 章内滚动进度（方案 5.3.1） */
  const progressPercent =
    totalChapters > 0 && currentIndex >= 0
      ? Math.min(100, ((currentIndex + scrollPercent) / totalChapters) * 100)
      : 0

  const fontScaleOption = getFontScaleOption(fontScale)
  const toneOption = getToneOption(tone)

  const setFontScale = (next: ReaderFontScale) => {
    setFontScaleState(next)
    saveReaderSettings({ fontScale: next })
  }
  const setTone = (next: ReaderTone) => {
    setToneOverride({ tone: next, theme: currentTheme })
    saveReaderSettings({ tone: next, toneTheme: currentTheme })
  }
  const setPageTurnMode = (next: ReaderPageTurnMode) => {
    setPageTurnModeState(next)
    saveReaderSettings({ pageTurnMode: next })
  }

  const backHref = reader ? (fromStudio && returnTo ? returnTo : `/novel/${reader.novel.id}`) : '/discover'
  const backLabel = fromStudio ? '返回创作区' : '返回详情'

  // 退出阅读器：
  // - 从作品页进入（入口携带作品页历史 idx 标记）：回退「阅读器自身+器内翻章」步数，精确落回该作品页条目；
  // - 直达入口（首页继续阅读/深链/创作区）：把阅读器条目 replace 成目标页，
  //   作品页即当前页，其左上角返回回进入前页面，不会跌回阅读器。
  const navigate = useNavigate()
  const location = useLocation()
  const entryDetailIdxRef = useRef<number | null>(
    (location.state as { fromDetailIdx?: number } | null)?.fromDetailIdx ?? null,
  )
  const exitReader = () => {
    const currentIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    const detailIdx = entryDetailIdxRef.current
    if (detailIdx !== null && currentIdx > detailIdx) {
      navigate(-(currentIdx - detailIdx))
    } else {
      navigate(backHref, { replace: true })
    }
  }

  /** 打开/关闭面板；离开评论面板时重置段评筛选，下次从底栏进入默认看章评总合 */
  const setActivePanel = (panel: ReaderPanelId) => {
    if (panel !== 'comments') {
      setActiveParagraphIndex(null)
    }
    setActivePanelState(panel)
  }

  /** 段评入口：打开评论面板并定位到指定段落（null = 章评总合） */
  const openParagraphComments = (index: number | null) => {
    setActiveParagraphIndex(index)
    setActivePanelState('comments')
  }

  /** 段落高亮闪一下（1.6s 后自动消退） */
  const flashHighlight = (index: number) => {
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current)
    setHighlightParagraphIndex(index)
    highlightTimerRef.current = window.setTimeout(() => setHighlightParagraphIndex(null), 1600)
  }

  /** 从评论定位到正文段落：关面板 → 滑到段落 → 高亮闪一下 */
  const locateParagraph = (index: number) => {
    setActiveParagraphIndex(null)
    setActivePanelState(null)

    // 分页模式由布局层注册定位器（翻到该段所在页），滚动模式走原滚动定位
    if (paragraphLocatorRef.current?.(index)) {
      flashHighlight(index)
      return
    }

    requestAnimationFrame(() => {
      const element = contentScrollRef.current?.querySelector<HTMLElement>(`[data-tts-p="${index}"]`)
      if (!element) return
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      flashHighlight(index)
    })
  }

  /** 段评深链定位：翻到/滚到对应段落并高亮闪一下，返回是否定位成功（分页未就绪时返回 false 供重试） */
  const locateDeepLinkParagraph = (index: number): boolean => {
    if (paragraphLocatorRef.current?.(index)) {
      flashHighlight(index)
      return true
    }
    const element = contentScrollRef.current?.querySelector<HTMLElement>(`[data-tts-p="${index}"]`)
    if (!element) return false
    element.scrollIntoView({ block: 'center' })
    flashHighlight(index)
    return true
  }
  /** 分页阅读布局注册段落定位器（传 null 注销，回到滚动定位） */
  const registerParagraphLocator = (locator: ((index: number) => boolean) | null) => {
    paragraphLocatorRef.current = locator
  }

  const previewSearch = fromStudio
    ? `?from=studio${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ''}`
    : ''
  const buildReadHref = (targetChapterId: string) =>
    reader ? `/novel/${reader.novel.id}/read/${targetChapterId}${previewSearch}` : '#'
  const previousHref = reader?.previousChapterId ? buildReadHref(reader.previousChapterId) : null
  const nextHref = reader?.nextChapterId ? buildReadHref(reader.nextChapterId) : null

  const currentVolume = reader ? volumes.find((volume) => volume.id === reader.currentChapter.volumeId) ?? null : null
  const metaLine = reader
    ? `${currentVolume ? `第 ${currentVolume.orderIndex} 卷《${currentVolume.title}》 · ` : ''}第 ${reader.currentChapter.orderInVolume} 章 · ${numberFormatter.format(reader.currentChapter.wordCount)} 字 · ${formatDateTime(reader.currentChapter.publishedAt)}`
    : ''

  // 听书播放引擎（方案 17）：三端共用，创作区预览（fromStudio）不启用
  const tts = useTtsPlayer({
    novelId,
    chapterId,
    fromStudio,
    paragraphs,
    nextHref,
    nextChapterId: reader?.nextChapterId ?? null,
    novelTitle,
    chapterTitle,
    coverUrl: reader?.novel.coverUrl ?? null,
    contentScrollRef,
    initialVoice: initialSettings.ttsVoice,
    initialRate: initialSettings.ttsRate,
    initialAutoNext: initialSettings.ttsAutoNext,
  })

  /** 章内进度写回（防抖）：滚动模式 = 滚动百分比，分页模式 = 当前页/本章总页 */
  const scrollSaveTimerRef = useRef<number | null>(null)
  /** 待写进度归属的章节：真换章时据此清掉上一章残留的防抖写入 */
  const scrollSaveChapterRef = useRef<string | null>(null)
  const commitScrollPercent = (percent: number, delayMs = 800) => {
    setScrollPercent(percent)

    if (fromStudio || !novelId || !chapterId) return
    if (scrollSaveTimerRef.current) window.clearTimeout(scrollSaveTimerRef.current)
    scrollSaveTimerRef.current = window.setTimeout(() => {
      updateReadingScrollPercent(novelId, chapterId, percent)
      // 章内位置写穿服务端，供跨设备恢复到上次读到的位置
      pushScrollProgress(novelId, novelTitle, chapterId, percent)
    }, delayMs)
    scrollSaveChapterRef.current = chapterId
  }

  /** 绑定到各布局的正文滚动容器 */
  const handleContentScroll = () => {
    const element = contentScrollRef.current
    if (!element) return
    const max = element.scrollHeight - element.clientHeight
    const percent = max > 0 ? Math.min(1, element.scrollTop / max) : 1
    commitScrollPercent(percent, 400)
  }

  // 章节切换后回到顶部并重置章内进度与段评状态
  useEffect(() => {
    // 真换章（非首次挂载）：清掉上一章尚未落盘的进度写入，避免旧章页号写进新章进度
    if (scrollSaveChapterRef.current !== null && scrollSaveChapterRef.current !== chapterId) {
      if (scrollSaveTimerRef.current) window.clearTimeout(scrollSaveTimerRef.current)
      scrollSaveTimerRef.current = null
    }
    scrollSaveChapterRef.current = chapterId ?? null

    contentScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
    setScrollPercent(0)
    setActiveParagraphIndex(null)
    setHighlightParagraphIndex(null)
  }, [chapterId])

  // 段评深链（?paragraph=N）：章节数据新鲜后定位到对应段落并高亮闪一下。
  // 分页模式要等视口测量+分页完成，首次可能未就绪，按 150ms 间隔重试至成功或超时。
  // 声明在换章重置 effect 之后：同组件 effect 按声明顺序执行，保证重置不会清掉本次高亮
  useEffect(() => {
    if (deepLinkParagraph === null || fromStudio) return
    // 占位数据（上一章残留）不是本章：等真数据落地再定位
    if (!reader || reader.currentChapter.id !== chapterId) return

    let cancelled = false
    let timer: number | null = null
    let attempts = 0
    const attempt = () => {
      if (cancelled || locateDeepLinkParagraph(deepLinkParagraph)) return
      attempts += 1
      if (attempts < 20) timer = window.setTimeout(attempt, 150)
    }
    attempt()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
    // locateDeepLinkParagraph 只依赖稳定的 ref，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, chapterId, deepLinkParagraph, fromStudio])

  // 首次进入时恢复上次阅读位置（仅同一章节且本次会话尚未定位过）
  const restoredScrollRef = useRef(false)
  useEffect(() => {
    if (restoredScrollRef.current || !reader || !novelId || !chapterId || fromStudio) return
    restoredScrollRef.current = true
    // 互动消息深链直达：按深链意图定位（段落/章首），不恢复上次阅读位置
    if (deepLinkComments || deepLinkParagraph !== null) return

    const entry = getReadingProgress(novelId)
    if (!entry || entry.chapterId !== chapterId) return
    const target = entry.scrollPercent ?? 0
    if (target <= 0.01) return

    // 等正文渲染完成后再定位，避免 scrollHeight 未就绪
    requestAnimationFrame(() => {
      const element = contentScrollRef.current
      if (!element) return
      const max = element.scrollHeight - element.clientHeight
      if (max <= 0) return
      element.scrollTo({ top: max * Math.min(1, target), behavior: 'auto' })
      setScrollPercent(Math.min(1, target))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 深链定位只在进入章节时执行一次，deepLink 参数变化不应重复触发滚动
  }, [reader, novelId, chapterId, fromStudio])

  // 写回本机阅读进度（首页"继续阅读"数据源），创作区预览不记录
  useEffect(() => {
    if (!reader || !novelId || !chapterId || fromStudio) return
    saveReadingProgress({
      novelId,
      novelTitle,
      chapterId,
      chapterTitle,
      chapterOrder: Math.max(0, currentIndex),
      totalChapters,
    })
    // 写穿服务端：书架成员身份 + 当前章节，跨设备点击阅读跳到一致章节
    pushProgress({
      novelId,
      novelTitle,
      coverUrl: reader.novel.coverUrl ?? null,
      chapterId,
      chapterTitle,
      chapterOrder: Math.max(0, currentIndex),
      totalChapters,
    })
  }, [reader, novelId, chapterId, fromStudio, currentIndex, totalChapters, novelTitle, chapterTitle])

  return {
    novelId,
    chapterId,
    fromStudio,
    readerQuery,
    commentsQuery,
    reader,
    /** 当前章节来自离线缓存（断网兜底读到的旧内容），UI 据此提示离线状态 */
    isOfflineCache: Boolean(reader && reader.fromOfflineCache),
    paragraphs,
    chapterComments,
    chapterList,
    volumes,
    currentVolume,
    chapterTitle,
    novelTitle,
    currentIndex,
    totalChapters,
    progressPercent,
    metaLine,
    fontScale,
    fontScaleOption,
    setFontScale,
    pageTurnMode,
    setPageTurnMode,
    tone,
    toneOption,
    setTone,
    activePanel,
    setActivePanel,
    activeParagraphIndex,
    highlightParagraphIndex,
    /** 互动消息深链：直达评论面板 / 直达段落（见 URL ?panel / ?paragraph） */
    deepLinkComments,
    deepLinkParagraph,
    paragraphCommentCounts,
    openParagraphComments,
    locateParagraph,
    registerParagraphLocator,
    contentScrollRef,
    handleContentScroll,
    commitScrollPercent,
    scrollPercent,
    getSavedScrollPercent: () => {
      if (fromStudio || !novelId || !chapterId) return 0
      const entry = getReadingProgress(novelId)
      if (!entry || entry.chapterId !== chapterId) return 0
      return Math.min(1, Math.max(0, entry.scrollPercent ?? 0))
    },
    backHref,
    backLabel,
    exitReader,
    buildReadHref,
    previousHref,
    nextHref,
    tts,
  }
}

export type ReaderState = ReturnType<typeof useReaderState>
