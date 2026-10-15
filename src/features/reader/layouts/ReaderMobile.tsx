import {
  ChevronLeft,
  ChevronRight,
  Headphones,
  ListOrdered,
  LogOut,
  MessageSquare,
  Settings2,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'

import BottomSheet from '@/components/layout/BottomSheet'
import AuthPromptDialog from '@/components/ui/AuthPromptDialog'
import { useToast } from '@/components/ui/toast-context'
import { splitReaderParagraphs } from '@/features/discover/api'
import { addToShelf } from '@/features/home/local-shelf'
import { pushShelfAdd } from '@/features/home/reading-sync'
import type { ReaderPayload } from '../../../../shared/contracts/index.js'
import { useNativeReaderImmersive } from '../useNativeReaderImmersive'
import { cn } from '@/lib/utils'
import AddShelfDialog from '../components/AddShelfDialog'
import { markShelfPrompted, shouldPromptShelf } from '../components/shelf-prompt'
import ParagraphActionBar, { type ParagraphActionAnchor } from '../components/ParagraphActionBar'
import ReaderArticle from '../components/ReaderArticle'
import ReaderCommentsPanel from '../components/ReaderCommentsPanel'
import ReaderCoverPage from '../components/ReaderCoverPage'
import ReaderDirectory from '../components/ReaderDirectory'
import ReaderProgressBar from '../components/ReaderProgressBar'
import ReaderSettingsContent from '../components/ReaderSettingsContent'
import ReaderPageChrome from '../pager/ReaderPageChrome'
import { useReaderChromeStatus } from '../pager/useReaderChromeStatus'
import ReaderPagedView, { type BoundaryPageData } from '../pager/ReaderPagedView'
import { PAGE_PARAGRAPH_GAP } from '../pager/page-layout'
import { findPageForParagraphChar, getPaginationCache, paginateChapterAsync, useChapterPaginator } from '../pager/useChapterPaginator'
import { useReaderPager } from '../pager/useReaderPager'
import TtsControlSheet from '../tts/TtsControlSheet'
import TtsMiniBar from '../tts/TtsMiniBar'
import TtsPagedPill from '../tts/TtsPagedPill'
import { useParagraphUnderlines } from '../useParagraphUnderlines'
import { readerQueryKey, type ReaderState } from '../useReaderState'

type ReaderMobileProps = {
  state: ReaderState
}

/** 手动翻页后暂停听书自动跟随的时长（与滚动模式让位用户手动滚动的时长一致） */
const TTS_FOLLOW_HOLD_MS = 5000
/** 听书跟读的轮询间隔：段内朗读位置不进 state，只能定时查 */
const TTS_FOLLOW_POLL_MS = 400

/**
 * 手机端阅读器（方案 20）：全屏沉浸的横向分页阅读。
 * - 代入页（第 -1 页）→ 本章分页正文，左滑下一页 / 右滑上一页，章边界自动换章
 * - 信息层常驻：左下全书页码、右下时间+电量、右上「…」菜单
 * - 长按选段：从本段听 / 发段评 / 复制 / 划线
 * - 退出未在书架时挽留一次；「上下滑动」模式保留原滚动阅读
 */
export default function ReaderMobile({ state }: ReaderMobileProps) {
  const [controlsVisible, setControlsVisible] = useState(false)
  const [ttsSheetOpen, setTtsSheetOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [shelfDialogOpen, setShelfDialogOpen] = useState(false)
  const [authPromptOpen, setAuthPromptOpen] = useState(false)
  const [selection, setSelection] = useState<ParagraphActionAnchor | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  // 章边界翻页的进场动画方向：新章页从翻页方向滑入，避免瞬切内容观感上卡一下。
  // 换章意图先记在 ref（并绑定目标章节），等新章数据就绪由落点 effect 统一起动，
  // 预取未命中时不拿旧章页做动画
  const [chapterEnter, setChapterEnter] = useState<'next' | 'prev' | null>(null)
  const pendingEnterRef = useRef<{ targetId: string; direction: 'next' | 'prev' } | null>(null)
  /** 章边界跟手跨章：边界页已随动画滑到位，落点帧跳过进场动画 */
  const suppressEnterRef = useRef(false)
  const navigate = useNavigate()
  const toast = useToast()
  const tone = state.toneOption
  // 时间/电量只订阅一次，再分发给每页的信息层
  const chromeStatus = useReaderChromeStatus()

  const paged = state.pageTurnMode !== 'scroll'
  const underlines = useParagraphUnderlines(state.novelId ?? '', state.chapterId ?? '')

  // ── 分页 ────────────────────────────────────────────────────────────
  const chapterKey = `${state.chapterId ?? ''}|${state.reader?.currentChapter.wordCount ?? 0}`
  const pagination = useChapterPaginator({
    enabled: paged,
    paragraphs: state.paragraphs,
    chapterKey,
    title: state.chapterTitle,
    layout: {
      width: viewport.width,
      height: viewport.height,
      fontSize: state.fontScaleOption.fontSize,
      lineHeight: state.fontScaleOption.lineHeight,
      paragraphGap: PAGE_PARAGRAPH_GAP,
    },
  })
  const pages = pagination.pages

  // 跨章翻页防卡顿：新章分页要在渲染线程同步跑整章离屏测量（数百次 DOM 测量），
  // 会卡住翻页动画一瞬；章内翻页命中分页缓存所以不卡。这里趁浏览器空闲
  // 把已预取到的相邻章提前分页塞进缓存，真跨章时直接命中，换章和章内翻页一样顺。
  const queryClient = useQueryClient()
  // 预热用最新视口/字号/章节快照：effect 依赖不含它们（避免反复重挂），靠 ref 保证 warm 拿到最新值
  const warmContextRef = useRef({
    paged,
    viewport,
    novelId: state.novelId,
    reader: state.reader,
    chapterList: state.chapterList,
    fontScaleOption: state.fontScaleOption,
    fromStudio: state.fromStudio,
  })
  warmContextRef.current = {
    paged,
    viewport,
    novelId: state.novelId,
    reader: state.reader,
    chapterList: state.chapterList,
    fontScaleOption: state.fontScaleOption,
    fromStudio: state.fromStudio,
  }
  useEffect(() => {
    const warm = () => {
      const context = warmContextRef.current
      if (!context.paged || context.viewport.width <= 0 || context.viewport.height <= 0) return
      if (!context.novelId || !context.reader) return

      const layout = {
        width: context.viewport.width,
        height: context.viewport.height,
        fontSize: context.fontScaleOption.fontSize,
        lineHeight: context.fontScaleOption.lineHeight,
        paragraphGap: PAGE_PARAGRAPH_GAP,
      }
      for (const targetId of [context.reader.nextChapterId, context.reader.previousChapterId]) {
        if (!targetId) continue
        const meta = context.chapterList.find((chapter) => chapter.id === targetId)
        const payload = queryClient.getQueryData<ReaderPayload>(
          readerQueryKey(context.novelId, targetId, context.fromStudio),
        )
        const content = payload?.currentChapter.content
        if (!meta || !content) continue
        // 缓存键与 useChapterPaginator 完全同源（章节身份+标题长+字号+视口），命中才是预热；
        // 分片异步测量，整章离屏测量不再一口气占住主线程卡住触摸与翻页帧
        const title = meta.title?.trim() || '未命名章节'
        const cacheKey = `${targetId}|${meta.wordCount ?? 0}|${title.length}|${layout.fontSize}|${layout.lineHeight}|${Math.round(layout.width)}x${Math.round(layout.height)}|${layout.paragraphGap}`
        void paginateChapterAsync(cacheKey, splitReaderParagraphs(content), layout, title)
      }
    }

    // 空闲执行 + 防抖：已缓存的章 paginateChapter 内部直接命中，重复触发无成本
    let idleId = 0
    let timerId = 0
    const schedule = () => {
      if (timerId) return
      timerId = window.setTimeout(() => {
        timerId = 0
        if (typeof window.requestIdleCallback === 'function') {
          idleId = window.requestIdleCallback(() => warm(), { timeout: 2000 })
        } else {
          warm()
        }
      }, 250)
    }

    schedule()
    // 相邻章数据由 useReaderState 后台预取，落地比本 effect 晚时靠缓存事件补一次预热
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success' && event.query.queryKey[0] === 'reader') {
        schedule()
      }
    })

    return () => {
      unsubscribe()
      if (timerId) window.clearTimeout(timerId)
      if (idleId && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId)
    }
    // 快照走 ref，effect 只挂一次；预取落地/换章都会经缓存事件或 schedule 补预热
     
  }, [queryClient])

  // 代入页：仅公开阅读的第一章带（创作区预览不出）
  const coverEligible = !state.fromStudio && state.currentIndex === 0

  /** 换章落点：从上一章左滑进来落第 1 页，从下一章右滑回来落末页 */
  const pendingLandingRef = useRef<'first' | 'last' | null>(null)
  /** 上次由跟读自己翻到的页码；null = 基准未知（换章/重排后），下次以当前页为准 */
  const followPageRef = useRef<number | null>(null)
  const followHoldUntilRef = useRef(0)

  // 换章落点意图：「新章数据落地」的渲染里确定归属，提交后的 layout effect 里产出写进
  // 与 useReaderPager 共享的 ref，由它在新章分页就绪（页数变化）时消费钉页码。
  // 绝不能在渲染期改 ref / 消费信号 / setState：这里的 setChapterEnter、chapterRef 块的
  // setSelection 都会触发「丢弃本次渲染再重渲染」，被丢弃渲染里的「标记已落定/消费待定信号」
  // 不会回滚，提交的重渲染里 landingKey 变回 null——新旧章页数恰好相同时落点 effect 依赖
  // 整体不变，意图永远不被消费（右滑回上一章落第一页、左翻进下一章落末页，仅部分章节复现）
  const renderedChapterId = state.reader?.currentChapter.id ?? null
  const renderLandedRef = useRef<string | null>(null)
  const landingChapterId =
    paged && renderedChapterId && renderedChapterId === state.chapterId && renderLandedRef.current !== renderedChapterId
      ? renderedChapterId
      : null
  const pagerLandingRef = useRef<import('../pager/useReaderPager').PagerLanding>(null)
  // 必须声明在 useReaderPager 之前：同组件 effect 按声明顺序执行，保证同一提交里
  // 先写入意图、再由 pager 的落点 effect 读取消费（绘制前钉页码，无闪帧）
  useLayoutEffect(() => {
    if (!landingChapterId) return
    renderLandedRef.current = landingChapterId
    // 章边界跟手跨章：边界页已随翻页动画滑到位，落点即当前画面，跳过进场动画
    const pendingEnter = pendingEnterRef.current
    if (suppressEnterRef.current) {
      suppressEnterRef.current = false
      setChapterEnter(null)
    } else if (pendingEnter && pendingEnter.targetId === state.chapterId) {
      // 新章分页就绪：有指向本章的换章意图就此起动进场动画
      setChapterEnter(pendingEnter.direction)
      pendingEnterRef.current = null
    }
    // 优先级：听书自动翻章钉第 1 页 > 左滑换章第 1 页 > 右滑回来末页 > 上次读到的位置 > 代入页。
    // 听书信号绑定目标章，残留信号不会误钉手动换章落点
    if (state.tts.takePendingAutoNext(state.chapterId ?? '')) {
      pagerLandingRef.current = 'first'
    } else {
      const pending = pendingLandingRef.current
      pendingLandingRef.current = null
      if (pending === 'last') pagerLandingRef.current = 'last'
      else if (pending === 'first') pagerLandingRef.current = 'first'
      else if (state.deepLinkComments || state.deepLinkParagraph !== null) {
        // 互动消息深链直达：落本章正文第 1 页，不停在引入页也不恢复旧位置
        // （带 ?paragraph 时段落定位 effect 随后把页码钉到目标段）
        pagerLandingRef.current = 'first'
      } else {
        const savedPercent = state.getSavedScrollPercent()
        pagerLandingRef.current = savedPercent > 0.01 ? { percent: savedPercent } : coverEligible ? 'cover' : 'first'
      }
    }
    // 快照经 landingChapterId 入依赖，闭包里的 state 即落定那一帧的最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landingChapterId])

  const pager = useReaderPager({
    totalPages: pages.length,
    hasCover: coverEligible,
    landingRef: pagerLandingRef,
    landingKey: landingChapterId,
    onOverflowNext: () => {
      if (state.nextHref) {
        pendingLandingRef.current = 'first'
        if (getBoundaryPage(state.reader?.nextChapterId, 'first')) {
          // 下一章首页已预渲染进图层并跟手翻完：落点即当前画面，不再跑进场动画
          suppressEnterRef.current = true
          pendingEnterRef.current = null
        } else if (state.reader?.nextChapterId) {
          pendingEnterRef.current = { targetId: state.reader.nextChapterId, direction: 'next' }
        }
        navigate(state.nextHref)
        return
      }
      toast.info('已经是最新章节了')
    },
    onOverflowPrev: () => {
      if (state.previousHref) {
        pendingLandingRef.current = 'last'
        if (getBoundaryPage(state.reader?.previousChapterId, 'last')) {
          suppressEnterRef.current = true
          pendingEnterRef.current = null
        } else if (state.reader?.previousChapterId) {
          pendingEnterRef.current = { targetId: state.reader.previousChapterId, direction: 'prev' }
        }
        navigate(state.previousHref)
      }
    },
  })

  /**
   * 章边界顺滑翻页：把相邻章的边界页从分页预热缓存里取出来预渲染进前/后图层，
   * 章边界的拖动/翻页就和章内一样跟手连续。只读缓存不触发测量：未命中时返回 null，
   * ReaderPagedView 回落橡皮筋 + 进场动画的兼容行为。缓存键与预热/分页完全同源。
   */
  const neighborParagraphsCacheRef = useRef(new Map<string, string[]>())
  const getBoundaryPage = (
    targetId: string | null | undefined,
    pick: 'first' | 'last',
  ): BoundaryPageData | null => {
    if (!paged || !targetId || viewport.width <= 0 || viewport.height <= 0) return null
    const meta = state.chapterList.find((chapter) => chapter.id === targetId)
    const payload = queryClient.getQueryData<ReaderPayload>(
      readerQueryKey(state.novelId ?? '', targetId, state.fromStudio),
    )
    if (!meta || !payload?.currentChapter.content) return null
    const title = meta.title?.trim() || '未命名章节'
    const cacheKey = `${targetId}|${meta.wordCount ?? 0}|${title.length}|${state.fontScaleOption.fontSize}|${state.fontScaleOption.lineHeight}|${Math.round(viewport.width)}x${Math.round(viewport.height)}|${PAGE_PARAGRAPH_GAP}`
    const result = getPaginationCache(cacheKey)
    if (!result || result.pages.length === 0) return null
    // 段落切分结果按章节缓存：避免每次渲染重切整章
    const cacheId = `${targetId}|${payload.currentChapter.wordCount ?? 0}`
    let neighborParagraphs = neighborParagraphsCacheRef.current.get(cacheId)
    if (!neighborParagraphs) {
      neighborParagraphs = splitReaderParagraphs(payload.currentChapter.content)
      if (neighborParagraphsCacheRef.current.size >= 4) neighborParagraphsCacheRef.current.clear()
      neighborParagraphsCacheRef.current.set(cacheId, neighborParagraphs)
    }
    return {
      page: pick === 'first' ? result.pages[0] : result.pages[result.pages.length - 1],
      paragraphs: neighborParagraphs,
      title,
    }
  }
  // 只在章边界页码上取相邻章页；预热未完成时返回 null，行为回落原有进场动画
  const boundaryPrevPage = pager.pageIndex <= 0 ? getBoundaryPage(state.reader?.previousChapterId, 'last') : null
  const boundaryNextPage =
    pager.pageIndex >= pages.length - 1 ? getBoundaryPage(state.reader?.nextChapterId, 'first') : null

  // 换章后先把页码归零，避免沿用上一章的页号
  const chapterRef = useRef(state.chapterId)
  if (chapterRef.current !== state.chapterId) {
    chapterRef.current = state.chapterId
    setSelection(null)
    // 进场意图只对绑定的目标章有效：目录跳转/听书自动翻章等其他路径换章时清掉残留动画态
    if (pendingEnterRef.current?.targetId !== state.chapterId) {
      pendingEnterRef.current = null
      setChapterEnter(null)
    }
    // 同步作废跟读页码基准：不能只依赖 [pages] 重置（前后两章分页命中同一缓存时 pages 引用不变）
    followPageRef.current = null
    followHoldUntilRef.current = 0
    suppressEnterRef.current = false
  }

  useNativeReaderImmersive(state.activePanel === 'comments', tone.swatch)

  // 翻页写回章内进度（语义：当前页/本章总页），退出时由防抖 Flush；
  // 换章过渡帧（占位数据还属上一章）不写，避免旧章页号污染新章进度
  useEffect(() => {
    if (!paged || pages.length === 0 || pager.pageIndex < 0) return
    if (state.reader?.currentChapter.id !== state.chapterId) return
    const percent = pages.length > 1 ? pager.pageIndex / (pages.length - 1) : 1
    state.commitScrollPercent(percent)
    // 仅页码变化时写回，state 每次渲染都是新对象故不入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, pager.pageIndex, pages.length])

  // 分页模式下由翻页接管"从评论定位段落"
  useEffect(() => {
    if (!paged) {
      state.registerParagraphLocator(null)
      return
    }

    state.registerParagraphLocator((index) => {
      const target = pagination.paragraphPageMap.get(index)
      if (target === undefined) return false
      pager.jumpTo(target)
      return true
    })

    return () => state.registerParagraphLocator(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, pagination.paragraphPageMap, pager.jumpTo])

  // 听书跟读：朗读位置不在当前页时自动翻页（替代滚动模式的自动滚动）。
  // 一段被切到相邻两页时只看段号会卡在上一页（必须整段读完才翻），故按段内字符位置定位；
  // 段内位置在 TTS 里是 ref（不逐帧重渲染），因此播放期间轮询检查。
  const speakingParagraphIndex = state.tts.activeParagraphIndex
  const ttsPlaying = state.tts.status === 'playing'
  const followSpeakingRef = useRef<() => void>(() => {})
  followSpeakingRef.current = () => {
    if (!paged || speakingParagraphIndex === null || pages.length === 0) return
    // 换章过渡期（占位数据仍属上一章）不跟读：旧段落号配新/旧页都会把页码拽到错误位置
    if (state.reader?.currentChapter.id !== state.chapterId) return
    // 基准未知（换章/重排后）：采纳当前页为基准并返回，不拿残留段号定位。
    // 换章时 useTtsPlayer 会清空朗读段落，但那个 effect 在父级、晚于本层 effect 执行，
    // 这一瞬 speakingParagraphIndex 可能还是旧章残留值——直接用它定位会把刚钉好的
    // 换章落点覆盖掉（右滑回上一章被拽到第一页、往后翻被拽到章中某页）
    if (followPageRef.current === null) {
      followPageRef.current = pager.pageIndex
      return
    }
    // 页码不是自己翻的（用户手动滑动/跳转）：让位 5s，别把人拽回朗读页
    if (pager.pageIndex !== followPageRef.current) {
      followPageRef.current = pager.pageIndex
      followHoldUntilRef.current = Date.now() + TTS_FOLLOW_HOLD_MS
      return
    }
    if (Date.now() < followHoldUntilRef.current) return

    const target =
      findPageForParagraphChar(pages, speakingParagraphIndex, state.tts.getActiveCharOffset()) ??
      pagination.paragraphPageMap.get(speakingParagraphIndex)
    if (target === undefined || target === pager.pageIndex) return
    followPageRef.current = target
    pager.jumpTo(target)
  }

  // 换章/重排后页码基准作废（须排在跟读 effect 之前生效）
  useEffect(() => {
    followPageRef.current = null
    followHoldUntilRef.current = 0
  }, [pages])

  // 段落切换立刻跟一次，段内跨页由轮询兜住
  useEffect(() => {
    followSpeakingRef.current()
  }, [speakingParagraphIndex, pages])

  useEffect(() => {
    if (!paged || !ttsPlaying) return
    const timer = window.setInterval(() => followSpeakingRef.current(), TTS_FOLLOW_POLL_MS)
    return () => window.clearInterval(timer)
  }, [paged, ttsPlaying])

  /**
   * 全书页码：当前章精确分页 + 其余章按字数估算（番茄 3/11242 语义）。
   * 信息层每页一份，故这里只算「本章之前的页数 + 全书总页数」，具体页号由各页自己加。
   *
   * 页数账本：每章页数（实测或估算）首次算出即锁定，不再随后续章节的每页均字数变化而漂移；
   * 否则换章后估算基数改变，前面章节的估算页数整体重算，跨章瞬间页码会跳变（109 → 114）。
   * 字号/视口变化时页数整体改变，清空账本重新锁。
   */
  const pageLedgerRef = useRef(new Map<string, number>())
  const pageLedgerLayoutRef = useRef('')
  const bookPaging = useMemo(() => {
    if (!paged || pages.length === 0) return { before: 0, total: 0 }
    const avgChars = pagination.avgCharsPerPage > 0 ? pagination.avgCharsPerPage : 0

    const layoutKey = `${state.fontScaleOption.fontSize}|${state.fontScaleOption.lineHeight}|${viewport.width}x${viewport.height}`
    if (pageLedgerLayoutRef.current !== layoutKey) {
      pageLedgerLayoutRef.current = layoutKey
      pageLedgerRef.current.clear()
    }
    const ledger = pageLedgerRef.current

    // 页码口径跟随「实际渲染中的章节」而非 URL 章节：听书自动翻章/翻页换章后，
    // 新章数据未落地前占位数据仍属上一章，若 before 先切到新章口径，
    // 旧章页号拼新章基数会瞬间漂出一大截（111 闪成 130）再被落点 effect 拉回；
    // 过渡期保持旧口径，数据落地那一帧落点 effect 同提交钉到第 1 页，数字自然衔接
    const renderedChapterId = state.reader?.currentChapter.id
    const renderedIndex = renderedChapterId
      ? state.chapterList.findIndex((chapter) => chapter.id === renderedChapterId)
      : -1
    const baseIndex = renderedIndex >= 0 ? renderedIndex : state.currentIndex
    const baseChapterId = renderedIndex >= 0 ? renderedChapterId : state.chapterId

    // 当前渲染章的实测页数是权威值，直接覆盖（字号变化后也会随清账重新锁）
    if (baseChapterId) ledger.set(baseChapterId, pages.length)

    let before = 0
    let total = 0
    state.chapterList.forEach((chapter, index) => {
      let count: number
      if (index === baseIndex) {
        count = pages.length
      } else {
        const locked = ledger.get(chapter.id)
        if (locked) {
          count = locked
        } else {
          count = Math.max(1, Math.ceil((chapter.wordCount ?? 0) / Math.max(1, avgChars)))
          ledger.set(chapter.id, count)
        }
      }
      if (index < baseIndex) before += count
      total += count
    })
    return { before, total }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderedChapterId 变化已由 chapterList/currentIndex 联动覆盖；补依赖会在听书翻章过渡期提前切换页码口径导致页码漂移（见上方注释）
  }, [
    paged,
    pages.length,
    pagination.avgCharsPerPage,
    state.chapterList,
    state.currentIndex,
    state.chapterId,
    state.fontScaleOption,
    viewport,
  ])

  // ── 交互 ────────────────────────────────────────────────────────────
  const closePanel = () => state.setActivePanel(null)
  const chromeBackground = `color-mix(in srgb, ${tone.swatch} 94%, transparent)`

  const openTts = () => {
    // 正在播/暂停/加载中：直接开面板，续播位置就是原位
    const ttsStatus = state.tts.status
    if (ttsStatus === 'playing' || ttsStatus === 'paused' || ttsStatus === 'loading') {
      setTtsSheetOpen(true)
      return
    }
    // 其余状态（未开始/播完/出错）一律按当前看到的位置重新起播，不复用上次朗读位置
    if (paged) {
      // 分页模式下正文没有滚动容器：从当前页第一个正文块读起；
      // 页首块是跨页段落的续块时带上段内偏移，避免回读上一页已经翻过的内容
      const currentPage = pages[Math.max(0, pager.pageIndex)]
      const firstBlock = currentPage?.blocks[0]
      state.tts.startFromParagraph(firstBlock?.paragraphIndex ?? 0, firstBlock?.startChar ?? 0)
      return
    }
    state.tts.start()
  }

  /** 退出：未在书架先挽留一次 */
  const handleExit = () => {
    if (!state.fromStudio && state.novelId && shouldPromptShelf(state.novelId)) {
      setShelfDialogOpen(true)
      return
    }
    state.exitReader()
  }

  const handleShelfConfirm = () => {
    if (!state.novelId) return
    markShelfPrompted(state.novelId)
    addToShelf({
      novelId: state.novelId,
      title: state.novelTitle,
      coverUrl: state.reader?.novel.coverUrl ?? null,
    })
    pushShelfAdd(state.novelId, state.novelTitle, state.reader?.novel.coverUrl ?? null)
    toast.success('已加入书架')
    setShelfDialogOpen(false)
    window.setTimeout(() => state.exitReader(), 300)
  }

  const handleShelfDismiss = () => {
    if (state.novelId) markShelfPrompted(state.novelId)
    setShelfDialogOpen(false)
    state.exitReader()
  }

  const handleLongPressParagraph = useCallback((paragraphIndex: number, rect: DOMRect) => {
    setSelection({
      paragraphIndex,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    })
  }, [])

  const handleCopyParagraph = async (paragraphIndex: number) => {
    const text = state.paragraphs[paragraphIndex] ?? ''
    setSelection(null)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制本段')
    } catch {
      toast.error('复制失败，请长按文字手动复制')
    }
  }

  const handleToggleUnderline = (paragraphIndex: number) => {
    const next = underlines.toggleUnderline(paragraphIndex)
    setSelection(null)
    if (next === null) {
      setAuthPromptOpen(true)
      return
    }
    toast.success(next ? '已划线' : '已取消划线')
  }

  // 状态栏/挖孔安全区绘制的是 html 画布颜色，fixed 层盖不到那里：
  // 阅读期间把画布与 theme-color 一起染成当前阅读底色，退出时恢复，与其他页面同色融合的原理一致
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    const previousMeta = meta?.getAttribute('content') ?? null
    meta?.setAttribute('content', tone.swatch)

    const rootStyle = document.documentElement.style
    const bodyStyle = document.body.style
    const previousRootBg = rootStyle.background
    const previousBodyBg = bodyStyle.background
    rootStyle.background = tone.background
    bodyStyle.background = tone.background

    return () => {
      if (previousMeta) meta?.setAttribute('content', previousMeta)
      rootStyle.background = previousRootBg
      bodyStyle.background = previousBodyBg
    }
  }, [tone])

  const bottomItem = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    disabled = false,
  ) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-14 flex-col items-center justify-center gap-1 text-[11px] press-feedback',
        disabled ? 'opacity-35' : '',
      )}
      style={{ color: tone.text }}
    >
      {icon}
      {label}
    </button>
  )

  const moreMenuItem = (label: string, icon: ReactNode, onClick: () => void, disabled = false) => (
    <button
      key={label}
      type="button"
      disabled={disabled}
      onClick={() => {
        setMoreMenuOpen(false)
        onClick()
      }}
      className={cn(
        'press-feedback flex flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] py-4 text-xs text-[var(--text-secondary)]',
        disabled ? 'opacity-35' : '',
      )}
    >
      {icon}
      {label}
    </button>
  )

  // 直接挂到 body 渲染：阅读区是覆盖全屏的 fixed 层，留在 AppShell 的滚动容器里时
  // 会被某个祖先当成定位包含块（实测 fixed inset-0 的顶部落在 16px，上方露出 body 的
  // --app-bg 主题色，形成一条不跟随阅读底色的色带）。挂到 body 后 fixed 必然贴视口顶部。
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex flex-col"
      style={{ background: tone.background, color: tone.text }}
    >
      {/* 断网兜底读到的是本地缓存章节：顶部一条轻量徽标说明状态，不阻断阅读 */}
      {state.isOfflineCache ? (
        <div
          className="pointer-events-none absolute left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1 text-[11px]"
          style={{
            top: 'calc(var(--safe-top) + 6px)',
            background: 'color-mix(in srgb, currentColor 12%, transparent)',
            color: tone.text,
            opacity: 0.9,
          }}
        >
          离线模式 · 当前阅读缓存章节
        </div>
      ) : null}
      {paged ? (
        <ReaderPagedView
          pages={pages}
          paragraphs={state.paragraphs}
          chapterTitle={state.chapterTitle}
          pager={pager}
          mode={state.pageTurnMode === 'cover' ? 'cover' : 'simulate'}
          tone={tone}
          fontScaleOption={state.fontScaleOption}
          enterDirection={chapterEnter}
          onEnterAnimationEnd={() => setChapterEnter(null)}
          boundaryPrevPage={boundaryPrevPage}
          boundaryNextPage={boundaryNextPage}
          renderBoundaryChrome={(side) => {
            // 相邻章边界页的全书页码：上一章末页 = 本章之前页数，下一章首页 = 本章之后第一页
            const pageNumber = side === 'prev' ? bookPaging.before : bookPaging.before + pages.length + 1
            if (pageNumber <= 0) return null
            return (
              <ReaderPageChrome
                tone={tone}
                novelTitle={state.novelTitle}
                currentPage={pageNumber}
                totalPages={Math.max(bookPaging.total, pageNumber)}
                showPageNumber={bookPaging.total > 0}
                clock={chromeStatus.clock}
                batteryPercent={chromeStatus.batteryPercent}
                onBack={handleExit}
                onMoreClick={() => setMoreMenuOpen(true)}
              />
            )
          }}
          underlined={underlines.underlined}
          speakingParagraphIndex={speakingParagraphIndex}
          selectedParagraphIndex={selection?.paragraphIndex ?? state.highlightParagraphIndex}
          renderCover={
            coverEligible
              ? () => (
                  <ReaderCoverPage
                    novelId={state.novelId ?? ''}
                    fallbackTitle={state.novelTitle}
                    fallbackCoverUrl={state.reader?.novel.coverUrl ?? null}
                    tone={tone}
                    onExit={handleExit}
                    onOpenTts={openTts}
                    onOpenSettings={() => state.setActivePanel('settings')}
                    ttsAvailable={state.tts.available}
                  />
                )
              : undefined
          }
          renderChrome={(pageIndex) => {
            // 信息层画进每一页（代入页自带功能入口，由 ReaderPagedView 跳过），
            // 这样右滑露出上一页时它跟着页面一起进来，不会先被盖掉再重新出现。
            const pageNumber = bookPaging.before + pageIndex + 1
            return (
              <ReaderPageChrome
                tone={tone}
                novelTitle={state.novelTitle}
                currentPage={pageNumber}
                totalPages={Math.max(bookPaging.total, pageNumber)}
                showPageNumber={bookPaging.total > 0}
                clock={chromeStatus.clock}
                batteryPercent={chromeStatus.batteryPercent}
                bottomCenter={
                  // 听书胶囊排在页码与时间之间：flex 分配宽度，胶囊撑满空隙又绝不越界
                  state.tts.isActive ? (
                    <TtsPagedPill tts={state.tts} tone={tone} onExpand={() => setTtsSheetOpen(true)} />
                  ) : undefined
                }
                onBack={handleExit}
                onMoreClick={() => setMoreMenuOpen(true)}
              />
            )
          }}
          onExitByGesture={handleExit}
          onViewportChange={setViewport}
          onTapCenter={() => setMoreMenuOpen(true)}
          onLongPressParagraph={handleLongPressParagraph}
          onDismissSelection={() => setSelection(null)}
          fallback={
            state.readerQuery.isLoading ? (
              <p className="text-sm opacity-55">正在载入章节…</p>
            ) : state.readerQuery.isError ? (
              // 断网且无本地缓存：番茄式网络异常页（明确原因 + 可重试）
              <div className="flex flex-col items-center gap-4 pt-20 text-center">
                <p className="text-sm opacity-70">网络连接失败，请检查网络后重试</p>
                <button
                  type="button"
                  onClick={() => void state.readerQuery.refetch()}
                  className="press-feedback rounded-full border px-5 py-2 text-sm"
                  style={{ borderColor: 'color-mix(in srgb, currentColor 25%, transparent)', color: tone.text }}
                >
                  重新加载
                </button>
              </div>
            ) : (
              <p className="text-sm opacity-55">本章暂无内容。</p>
            )
          }
        />
      ) : (
        <>
          {/* 上下滑动模式：保留原整章滚动阅读与顶部进度条 */}
          <ReaderProgressBar percent={state.progressPercent} className="absolute inset-x-0 top-0 z-30" />
          <div
            ref={state.contentScrollRef}
            onScroll={state.handleContentScroll}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            onClick={() => setControlsVisible((visible) => !visible)}
          >
            <div className="mx-auto max-w-[680px] pb-32 pl-[calc(var(--safe-left,0px)+20px)] pr-[calc(var(--safe-right,0px)+20px)] pt-[calc(var(--safe-top)+76px)]">
              <ReaderArticle
                state={state}
                header="compact"
                onOpenComments={() => state.setActivePanel('comments')}
              />
            </div>
          </div>
        </>
      )}

      {/* 顶部/底部控制栏只服务上下滑动模式；分页模式的入口由 ReaderPageChrome + 「更多」菜单承载 */}
      {paged ? null : (
        <>
          {/* 顶部控制栏（轻点呼出） */}
          <div
            className={cn(
              'absolute inset-x-0 top-0 z-[50] border-b backdrop-blur-md transition-all [transition-duration:var(--duration-normal)]',
              controlsVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0',
            )}
            style={{
              background: chromeBackground,
              borderColor: 'color-mix(in srgb, currentColor 12%, transparent)',
            }}
          >
            <div
              className="flex items-center gap-2 pb-2 pl-[calc(var(--safe-left,0px)+8px)] pr-[calc(var(--safe-right,0px)+8px)] pt-[calc(var(--safe-top)+8px)]"
              style={{ color: tone.text }}
            >
              <button
                type="button"
                aria-label={state.backLabel}
                onClick={handleExit}
                className="touch-target inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-pill)] press-feedback"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{state.novelTitle}</p>
                <p className="truncate text-xs opacity-60">{state.chapterTitle}</p>
              </div>
              {state.tts.available ? (
                <button
                  type="button"
                  aria-label="听书"
                  onClick={openTts}
                  className="touch-target inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-pill)] press-feedback"
                >
                  <Headphones className="h-5 w-5" />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="阅读设置"
                onClick={() => state.setActivePanel('settings')}
                className="touch-target inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-pill)] press-feedback"
              >
                <Settings2 className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* 底部操作栏（轻点呼出，手势能力的按钮兜底） */}
          <div
            className={cn(
              'absolute inset-x-0 bottom-0 z-[50] border-t backdrop-blur-md transition-all [transition-duration:var(--duration-normal)]',
              controlsVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0',
            )}
            style={{
              background: chromeBackground,
              borderColor: 'color-mix(in srgb, currentColor 12%, transparent)',
            }}
          >
            <div className="grid grid-cols-6 px-2 pb-[var(--safe-bottom)]">
              {bottomItem('退出', <LogOut className="h-5 w-5 rotate-180" />, handleExit)}
              {bottomItem(
                '上一章',
                <ChevronLeft className="h-5 w-5" />,
                () => state.previousHref && navigate(state.previousHref),
                !state.previousHref,
              )}
              {bottomItem('目录', <ListOrdered className="h-5 w-5" />, () => state.setActivePanel('directory'))}
              {bottomItem('评论', <MessageSquare className="h-5 w-5" />, () => state.setActivePanel('comments'))}
              {bottomItem('设置', <Settings2 className="h-5 w-5" />, () => state.setActivePanel('settings'))}
              {bottomItem(
                '下一章',
                <ChevronRight className="h-5 w-5" />,
                () => state.nextHref && navigate(state.nextHref),
                !state.nextHref,
              )}
            </div>
          </div>
        </>
      )}

      {/*
        听书播放器：分页模式的胶囊由每页的信息层自己带（见 renderChrome），
        上下滑动模式正文留了 pb-32，仍用全宽迷你条。
      */}
      {paged ? null : (
        <TtsMiniBar
          tts={state.tts}
          tone={tone}
          onExpand={() => setTtsSheetOpen(true)}
          className={cn(
            'absolute inset-x-0 z-[50] transition-all [transition-duration:var(--duration-normal)]',
            controlsVisible ? 'bottom-[calc(var(--safe-bottom)+56px)]' : 'bottom-0 pb-[var(--safe-bottom)]',
          )}
        />
      )}

      {/* 长按选段操作条 */}
      <ParagraphActionBar
        anchor={selection}
        underlined={selection ? underlines.underlined.has(selection.paragraphIndex) : false}
        ttsAvailable={state.tts.available}
        onPlayFromHere={(index) => {
          setSelection(null)
          state.tts.startFromParagraph(index)
        }}
        onComment={(index) => {
          setSelection(null)
          state.openParagraphComments(index)
        }}
        onCopy={(index) => void handleCopyParagraph(index)}
        onToggleUnderline={handleToggleUnderline}
        onClose={() => setSelection(null)}
      />

      {/* 「…」更多菜单：听书 / 换章 / 目录 / 评论 / 阅读设置（分页模式的功能总入口） */}
      <BottomSheet open={moreMenuOpen} onClose={() => setMoreMenuOpen(false)} title="更多">
        <div className="grid grid-cols-3 gap-3 p-4">
          {state.tts.available
            ? moreMenuItem('听书', <Headphones className="h-5 w-5" />, openTts)
            : null}
          {moreMenuItem(
            '上一章',
            <ChevronLeft className="h-5 w-5" />,
            () => state.previousHref && navigate(state.previousHref),
            !state.previousHref,
          )}
          {moreMenuItem(
            '下一章',
            <ChevronRight className="h-5 w-5" />,
            () => state.nextHref && navigate(state.nextHref),
            !state.nextHref,
          )}
          {moreMenuItem('目录', <ListOrdered className="h-5 w-5" />, () => state.setActivePanel('directory'))}
          {moreMenuItem('评论', <MessageSquare className="h-5 w-5" />, () => state.setActivePanel('comments'))}
          {moreMenuItem('阅读设置', <Settings2 className="h-5 w-5" />, () => state.setActivePanel('settings'))}
        </div>
      </BottomSheet>

      {/* 底部抽屉：目录 / 评论 / 设置 */}
      <BottomSheet open={state.activePanel === 'directory'} onClose={closePanel} title="目录">
        <ReaderDirectory state={state} onNavigate={closePanel} />
      </BottomSheet>
      {/* 章节评论至少占半屏：评论少时也保持足够浏览高度 */}
      <BottomSheet open={state.activePanel === 'comments'} onClose={closePanel} title="章节评论" minHeight="60dvh">
        <ReaderCommentsPanel state={state} />
      </BottomSheet>
      <BottomSheet open={state.activePanel === 'settings'} onClose={closePanel} title="阅读设置">
        <ReaderSettingsContent
          fontScale={state.fontScale}
          tone={state.tone}
          onFontScaleChange={state.setFontScale}
          onToneChange={state.setTone}
          pageTurnMode={state.pageTurnMode}
          onPageTurnModeChange={state.setPageTurnMode}
        />
      </BottomSheet>
      <BottomSheet open={ttsSheetOpen} onClose={() => setTtsSheetOpen(false)} title="听书">
        {/* 分页模式的吸底胶囊只留暂停/退出，上下段等操作由面板顶部的播放器承担 */}
        <TtsControlSheet
          tts={state.tts}
          showPlayer={paged}
          onStopped={() => setTtsSheetOpen(false)}
        />
      </BottomSheet>

      {/* 退出挽留 / 未登录划线引导 */}
      <AddShelfDialog
        open={shelfDialogOpen}
        title={state.novelTitle}
        coverUrl={state.reader?.novel.coverUrl ?? null}
        chapterTitle={state.chapterTitle}
        onConfirm={handleShelfConfirm}
        onDismiss={handleShelfDismiss}
      />
      <AuthPromptDialog
        open={authPromptOpen}
        title="登录后可划线"
        description="登录或注册后，划线会保存到你的账号，换设备继续读也在。"
        onClose={() => setAuthPromptOpen(false)}
      />
    </div>,
    document.body,
  )
}
