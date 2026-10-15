import { ChevronLeft } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'

import type { FontScaleOption, ToneOption } from '../reader-settings'
import { useParagraphLongPress } from '../useParagraphLongPress'
import { PAGE_INSET, PAGE_PARAGRAPH_GAP } from './page-layout'
import { PAGE_TITLE_STYLE, type ReaderPageContent } from './useChapterPaginator'
import type { ReaderPager } from './useReaderPager'

const FLIP_DURATION = 260
const FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** 判定翻页：位移超过 22% 屏宽，或甩动速度够快 */
const COMMIT_RATIO = 0.22
const COMMIT_VELOCITY = 0.25
const DIRECTION_THRESHOLD = 8
/** 章边界处没有下一页时的橡皮筋阻尼 */
const RUBBER_DAMPING = 0.38
/** 章边界换章的判定（按未阻尼的真实手指位移算，避免要连滑几次才过） */
const CHAPTER_COMMIT_RATIO = 0.12
const CHAPTER_COMMIT_VELOCITY = 0.3
/** 代入页右滑退出：超过 42% 屏宽（或甩出）松手即退出到作品页 */
const EXIT_COMMIT_RATIO = 0.42
/** 右滑退出的视觉最大位移：只让左侧露出一条窄带（番茄同款手感），再往下滑渐近不再跟手 */
const EXIT_MAX_TRAVEL = 100
/** 右滑退出的阻力：位移按 1 - e^(-raw/(MAX×系数)) 渐近，系数越大越"沉" */
const EXIT_DRAG_RESISTANCE = 1.6
/** 提示带够宽才显示文案：窄于此只露一条细竖条，避免竖排文字被裁掉一半 */
const EXIT_HINT_REVEAL = 44

type PageTurnAnimation = 'simulate' | 'cover'

/** 章边界预渲染的相邻章边界页（来自分页预热缓存）：有它时章边界翻页和章内一样跟手 */
export type BoundaryPageData = {
  page: ReaderPageContent
  paragraphs: string[]
  title: string
}

type ReaderPagedViewProps = {
  pages: ReaderPageContent[]
  paragraphs: string[]
  /** 排在本章第 1 页顶部的章节标题 */
  chapterTitle: string
  pager: ReaderPager
  mode: PageTurnAnimation
  tone: ToneOption
  fontScaleOption: FontScaleOption
  /** 已划线的段落序号 */
  underlined: Set<number>
  /** 听书正在朗读的段落 */
  speakingParagraphIndex: number | null
  /** 长按选中的段落 */
  selectedParagraphIndex: number | null
  /** 代入页（第 -1 页）内容 */
  renderCover?: () => ReactNode
  /**
   * 章边界预渲染的相邻章边界页（分页预热缓存命中才有）：
   * 渲染进前/后图层，让章边界拖动跟手、翻页动画连续滑过去不卡；
   * 未命中时维持橡皮筋 + 进场动画的兼容行为
   */
  boundaryPrevPage?: BoundaryPageData | null
  boundaryNextPage?: BoundaryPageData | null
  /** 相邻章边界页各自的信息层（全书页码口径与本章不同，由上层单独给） */
  renderBoundaryChrome?: (side: 'prev' | 'next') => ReactNode
  /**
   * 每页各自的常驻信息层（左上返回/右上菜单/底部页码时间）。
   * 必须画进每一个页面图层而不是单独一层：单层时右滑露出的上一页会先把它盖住、
   * 翻页落定后再重新出现，观感上闪一下（番茄是每页各带一份）。参数为该页页码。
   * 代入页自带功能入口，不调用。
   */
  renderChrome?: (pageIndex: number) => ReactNode
  /** 代入页右滑到位：退出阅读器回作品页（不传则右滑只做橡皮筋） */
  onExitByGesture?: () => void
  /**
   * 章边界换章的进场动画方向：next = 新章页从右侧滑入（往后翻），prev = 从左侧滑入（往前翻）。
   * 没有换章动画诉求时传 null；动画结束回调用于上层清状态。
   */
  enterDirection?: 'next' | 'prev' | null
  onEnterAnimationEnd?: () => void
  /** 正文区尺寸变化（供分页引擎测量） */
  onViewportChange: (size: { width: number; height: number }) => void
  /** 轻点中间区域（左右各 25% 为翻页热区） */
  onTapCenter: () => void
  onLongPressParagraph: (paragraphIndex: number, anchor: DOMRect) => void
  onDismissSelection: () => void
  /** 分页未就绪时的占位内容 */
  fallback?: ReactNode
}

/** 页内交互元素（代入页的按钮等）不参与翻页/长按手势 */
const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"]'

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_SELECTOR))
}

const insetStyle: CSSProperties = {
  top: `calc(var(--safe-top) + ${PAGE_INSET.top}px)`,
  bottom: `calc(var(--safe-bottom) + ${PAGE_INSET.bottom}px)`,
  left: PAGE_INSET.x,
  right: PAGE_INSET.x,
}

/**
 * 分页正文视图（方案 20 §2.2）：前/当前/后三页常驻 DOM，翻页只做指针平移。
 * - 仿真模式：当前页跟手位移 + 轻微 rotateY + 右缘阴影，下一页在其下方显出；
 * - 覆盖模式：下一页从右侧滑入覆盖；
 * - 轻点分区：左 1/4 上一页、右 1/4 下一页、中间呼出控制栏；长按选段优先。
 */
export default function ReaderPagedView({
  pages,
  paragraphs,
  chapterTitle,
  pager,
  mode,
  tone,
  fontScaleOption,
  underlined,
  speakingParagraphIndex,
  selectedParagraphIndex,
  renderCover,
  boundaryPrevPage = null,
  boundaryNextPage = null,
  renderBoundaryChrome,
  renderChrome,
  onExitByGesture,
  enterDirection = null,
  onEnterAnimationEnd,
  onViewportChange,
  onTapCenter,
  onLongPressParagraph,
  onDismissSelection,
  fallback,
}: ReaderPagedViewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sizerRef = useRef<HTMLDivElement | null>(null)
  const prevLayerRef = useRef<HTMLDivElement | null>(null)
  const currentLayerRef = useRef<HTMLDivElement | null>(null)
  const nextLayerRef = useRef<HTMLDivElement | null>(null)
  const shadeRef = useRef<HTMLDivElement | null>(null)
  const exitHintRef = useRef<HTMLDivElement | null>(null)
  const exitHintContentRef = useRef<HTMLDivElement | null>(null)
  const exitHintTextRef = useRef<HTMLSpanElement | null>(null)
  const exitHintIconRef = useRef<HTMLSpanElement | null>(null)
  const exitHintBarRef = useRef<HTMLSpanElement | null>(null)
  const animatingRef = useRef(false)
  const animationTimerRef = useRef<number | null>(null)
  /** 补间结束后待提交的翻页方向（新手势插进来时用于立即落定） */
  const pendingCommitRef = useRef<'next' | 'prev' | null>(null)

  const reduceMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )
  const duration = reduceMotion ? 0 : FLIP_DURATION

  const dragRef = useRef({
    tracking: false,
    decided: false,
    direction: null as 'next' | 'prev' | null,
    rubber: false,
    /** 章边界且相邻章边界页已预渲染：走章边界阈值但翻页动画连续 */
    boundary: false,
    /** 代入页右滑退出手势 */
    exiting: false,
    startX: 0,
    startY: 0,
    startTime: 0,
    dx: 0,
    /** 未经橡皮筋阻尼的真实位移 */
    rawDx: 0,
    width: 1,
  })

  const exitCallbackRef = useRef(onExitByGesture)
  exitCallbackRef.current = onExitByGesture

  const onEnterEndRef = useRef(onEnterAnimationEnd)
  onEnterEndRef.current = onEnterAnimationEnd
  /** 换章进场动画进行中：期间跳过 resetLayers，避免页码归零的重置把进场起点抹掉 */
  const enterActiveRef = useRef(false)

  const pagerRef = useRef(pager)
  pagerRef.current = pager

  const baseTransform = useCallback(
    (layer: 'prev' | 'current' | 'next') => {
      if (layer === 'prev') return 'translateX(-100%)'
      if (layer === 'current') return 'translateX(0px)'
      return mode === 'cover' ? 'translateX(100%)' : 'translateX(0px)'
    },
    [mode],
  )

  const resetLayers = useCallback(
    (animated: boolean) => {
      const entries: [HTMLDivElement | null, 'prev' | 'current' | 'next'][] = [
        [prevLayerRef.current, 'prev'],
        [currentLayerRef.current, 'current'],
        [nextLayerRef.current, 'next'],
      ]
      for (const [node, layer] of entries) {
        if (!node) continue
        node.style.transition = animated ? `transform ${duration}ms ${FLIP_EASING}` : 'none'
        node.style.transform = baseTransform(layer)
        node.style.boxShadow = 'none'
      }
      if (shadeRef.current) shadeRef.current.style.opacity = '0'
      if (exitHintRef.current) {
        exitHintRef.current.style.transition = animated ? `width ${duration}ms ${FLIP_EASING}` : 'none'
        exitHintRef.current.style.width = '0px'
      }
      if (exitHintIconRef.current) exitHintIconRef.current.style.opacity = '0'
      if (exitHintBarRef.current) exitHintBarRef.current.style.opacity = '0.3'
      if (exitHintContentRef.current) {
        exitHintContentRef.current.style.transition = 'none'
        exitHintContentRef.current.style.opacity = '1'
      }
      if (exitHintTextRef.current) {
        exitHintTextRef.current.textContent = '右滑退出阅读器'
        exitHintTextRef.current.style.display = 'none'
      }
    },
    [baseTransform, duration],
  )

  // 翻页落定/重排/换章后清掉内联动画样式（在绘制前完成，无闪帧）；换章进场期间让位给进场动画。
  // pages 也在依赖里：章边界跟手跨章后落点页码可能恰好不变，只靠页码依赖会漏掉图层归位
  useLayoutEffect(() => {
    if (enterActiveRef.current) return
    resetLayers(false)
  }, [pager.pageIndex, pages, mode, resetLayers])

  // 换章进场：新章首/末页从翻页方向滑入（与章内翻页同一条补间曲线），
  // 避免章边界瞬切内容观感上“卡一下”。起点在绘制前就摆好，不会先闪一帧落点。
  useLayoutEffect(() => {
    if (!enterDirection || pages.length === 0) return
    if (enterActiveRef.current) return
    enterActiveRef.current = true
    animatingRef.current = true

    const node = currentLayerRef.current
    const width = rootRef.current?.getBoundingClientRect().width || window.innerWidth
    if (node) {
      node.style.transition = 'none'
      node.style.transform = `translateX(${enterDirection === 'next' ? width : -width}px)`
      node.style.boxShadow = 'none'
    }
    if (shadeRef.current) shadeRef.current.style.opacity = '0'

    let raf2 = 0
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        const el = currentLayerRef.current
        if (!el) return
        el.style.transition = `transform ${duration}ms ${FLIP_EASING}`
        el.style.transform = baseTransform('current')
        animationTimerRef.current = window.setTimeout(() => {
          animatingRef.current = false
          enterActiveRef.current = false
          resetLayers(false)
          onEnterEndRef.current?.()
        }, duration + 16)
      })
    })
    return () => {
      window.cancelAnimationFrame(raf1)
      if (raf2) window.cancelAnimationFrame(raf2)
    }
  }, [enterDirection, pages, duration, baseTransform, resetLayers])

  useEffect(() => {
    return () => {
      if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current)
    }
  }, [])

  // 正文可用宽高上报（旋屏/字号变化都会触发重新测量）
  const viewportRef = useRef({ width: 0, height: 0 })
  const viewportCallbackRef = useRef(onViewportChange)
  viewportCallbackRef.current = onViewportChange
  useEffect(() => {
    const node = sizerRef.current
    if (!node) return

    const report = () => {
      const rect = node.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.floor(rect.height)
      if (width === viewportRef.current.width && height === viewportRef.current.height) return
      viewportRef.current = { width, height }
      viewportCallbackRef.current({ width, height })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const longPress = useParagraphLongPress({
    enabled: true,
    onLongPress: onLongPressParagraph,
  })

  /** 拖动中把位移写进 DOM（不走 React，保证 60fps） */
  const applyDrag = useCallback(
    (dx: number, direction: 'next' | 'prev', rubber: boolean) => {
      const width = dragRef.current.width
      const progress = Math.min(1, Math.abs(dx) / width)

      if (direction === 'next') {
        if (mode === 'cover' && !rubber) {
          const node = nextLayerRef.current
          if (!node) return
          node.style.transition = 'none'
          node.style.transform = `translateX(${width + dx}px)`
          node.style.boxShadow = `-14px 0 28px rgba(0,0,0,${(0.05 + 0.18 * progress).toFixed(3)})`
          return
        }
        const node = currentLayerRef.current
        if (!node) return
        node.style.transition = 'none'
        node.style.transform = `translateX(${dx}px) rotateY(${(-progress * 7).toFixed(2)}deg)`
        node.style.boxShadow = `14px 0 30px rgba(0,0,0,${(0.05 + 0.22 * progress).toFixed(3)})`
        if (shadeRef.current) shadeRef.current.style.opacity = `${(0.14 * (1 - progress)).toFixed(3)}`
        return
      }

      const node = prevLayerRef.current
      if (!node) return
      node.style.transition = 'none'
      node.style.transform = `translateX(${-width + dx}px)${
        mode === 'simulate' ? ` rotateY(${((1 - progress) * 7).toFixed(2)}deg)` : ''
      }`
      node.style.boxShadow = `14px 0 30px rgba(0,0,0,${(0.05 + 0.2 * progress).toFixed(3)})`
    },
    [mode],
  )

  /** 落定翻页：补间到位后提交页码 */
  const commitFlip = useCallback(
    (direction: 'next' | 'prev') => {
      const width = dragRef.current.width
      animatingRef.current = true

      const finish = () => {
        animatingRef.current = false
        pendingCommitRef.current = null
        if (direction === 'next') pagerRef.current.requestNext()
        else pagerRef.current.requestPrev()
        // 章边界换章时页码不变，兜底把内联样式收回来
        animationTimerRef.current = window.setTimeout(() => resetLayers(false), 80)
      }

      pendingCommitRef.current = direction

      if (direction === 'next') {
        const useCoverLayer = mode === 'cover'
        const node = useCoverLayer ? nextLayerRef.current : currentLayerRef.current
        if (node) {
          node.style.transition = `transform ${duration}ms ${FLIP_EASING}`
          node.style.transform = useCoverLayer ? 'translateX(0px)' : `translateX(${-width}px) rotateY(-7deg)`
        }
        if (shadeRef.current) {
          shadeRef.current.style.transition = `opacity ${duration}ms ${FLIP_EASING}`
          shadeRef.current.style.opacity = '0'
        }
      } else {
        const node = prevLayerRef.current
        if (node) {
          node.style.transition = `transform ${duration}ms ${FLIP_EASING}`
          node.style.transform = 'translateX(0px)'
        }
      }

      if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current)
      animationTimerRef.current = window.setTimeout(finish, duration + 16)
    },
    [duration, mode, resetLayers],
  )

  const cancelFlip = useCallback(() => {
    animatingRef.current = true
    resetLayers(true)
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current)
    animationTimerRef.current = window.setTimeout(() => {
      animatingRef.current = false
      resetLayers(false)
    }, duration + 16)
  }, [duration, resetLayers])

  /** 把还在补间的翻页立即落定：连续快速滑动时不丢手势；换章进场中也一并收掉 */
  const settleFlip = useCallback(() => {
    if (animationTimerRef.current !== null) {
      window.clearTimeout(animationTimerRef.current)
      animationTimerRef.current = null
    }
    animatingRef.current = false
    if (enterActiveRef.current) {
      enterActiveRef.current = false
      onEnterEndRef.current?.()
    }
    const direction = pendingCommitRef.current
    pendingCommitRef.current = null
    if (direction === 'next') pagerRef.current.requestNext()
    else if (direction === 'prev') pagerRef.current.requestPrev()
    resetLayers(false)
  }, [resetLayers])

  /**
   * 代入页右滑：页面右移一条窄带的距离（带阻力，渐近 EXIT_MAX_TRAVEL），左侧同步展开退出提示。
   * 两段提示：带宽够了先显示「右滑退出阅读器」，继续滑过阈值才换成箭头 +「松手退出」。
   * 位移一律取整并用 translate3d，避免亚像素合成在页面左边缘拉出细亮线。
   */
  const applyExitDrag = useCallback((rawDx: number) => {
    const raw = Math.max(0, rawDx)
    const travel = Math.round(
      EXIT_MAX_TRAVEL * (1 - Math.exp(-raw / (EXIT_MAX_TRAVEL * EXIT_DRAG_RESISTANCE))),
    )
    const revealed = travel >= EXIT_HINT_REVEAL
    const passed = raw > dragRef.current.width * EXIT_COMMIT_RATIO
    const node = currentLayerRef.current
    if (node) {
      node.style.transition = 'none'
      node.style.transform = `translate3d(${travel}px, 0, 0)`
    }
    // 下一页图层就铺在代入页底下，提示带不透明并多盖 1px，把接缝与正文一起遮住
    const hint = exitHintRef.current
    if (hint) {
      hint.style.transition = 'none'
      hint.style.width = `${travel > 0 ? travel + 1 : 0}px`
    }
    if (exitHintTextRef.current) {
      const label = passed ? '松手退出' : '右滑退出阅读器'
      if (exitHintTextRef.current.textContent !== label) exitHintTextRef.current.textContent = label
      // 带宽不足时整个摘掉（留着占位会把细竖条挤出居中位置）
      exitHintTextRef.current.style.display = revealed ? 'block' : 'none'
    }
    if (exitHintIconRef.current) exitHintIconRef.current.style.opacity = passed ? '0.7' : '0'
    if (exitHintBarRef.current) exitHintBarRef.current.style.opacity = passed ? '0' : '0.3'
  }, [])

  /** 代入页右滑到位：整页送出屏幕后退出阅读器 */
  const commitExit = useCallback(() => {
    animatingRef.current = true
    const width = dragRef.current.width
    const node = currentLayerRef.current
    if (node) {
      node.style.transition = `transform ${duration}ms ${FLIP_EASING}`
      node.style.transform = `translate3d(${width}px, 0, 0)`
    }
    if (exitHintRef.current) {
      exitHintRef.current.style.transition = `width ${duration}ms ${FLIP_EASING}`
      exitHintRef.current.style.width = `${width}px`
    }
    // 带子这时被拉满整屏、只当背景遮板用；提示内容是按带宽居中的，
    // 留着会跟着漂到屏幕正中定住一帧（看着像凭空出现一个「松手退出」），所以先淡掉
    if (exitHintContentRef.current) {
      const fade = Math.round(duration / 3)
      exitHintContentRef.current.style.transition = `opacity ${fade}ms linear`
      exitHintContentRef.current.style.opacity = '0'
    }
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current)
    animationTimerRef.current = window.setTimeout(() => {
      animatingRef.current = false
      exitCallbackRef.current?.()
      // 退出被挂起（例如先弹加书架挽留）时把页面收回原位
      resetLayers(false)
    }, duration + 16)
  }, [duration, resetLayers])

  /** 按钮/轻点触发的翻页（同样走补间动画） */
  const flip = useCallback(
    (direction: 'next' | 'prev') => {
      if (animatingRef.current) return
      const root = rootRef.current
      dragRef.current.width = root?.getBoundingClientRect().width || window.innerWidth
      const canFlipInChapter = direction === 'next' ? pagerRef.current.hasNextPage : pagerRef.current.hasPrevPage
      // 相邻章边界页已预渲染：轻点也能带补间动画跨章，不再瞬切
      const canFlipAcross = direction === 'next' ? Boolean(boundaryNextPage) : Boolean(boundaryPrevPage)
      if (!canFlipInChapter && !canFlipAcross) {
        // 章边界且无预渲染页：不做动画，直接交给上层换章
        if (direction === 'next') pagerRef.current.requestNext()
        else pagerRef.current.requestPrev()
        return
      }
      commitFlip(direction)
    },
    [commitFlip, boundaryPrevPage, boundaryNextPage],
  )

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) return
    if (isInteractiveTarget(event.target)) {
      dragRef.current.tracking = false
      return
    }
    // 上一次翻页还在补间：直接落定，别把这次滑动吐掉
    if (animatingRef.current) settleFlip()
    const touch = event.touches[0]
    const root = rootRef.current
    dragRef.current = {
      tracking: true,
      decided: false,
      direction: null,
      rubber: false,
      boundary: false,
      exiting: false,
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      dx: 0,
      rawDx: 0,
      width: root?.getBoundingClientRect().width || window.innerWidth,
    }
    longPress.start(touch.clientX, touch.clientY, event.target)
  }

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag.tracking || animatingRef.current) return
    const touch = event.touches[0]
    longPress.move(touch.clientX, touch.clientY)
    if (longPress.firedRef.current) {
      drag.tracking = false
      return
    }

    const dx = touch.clientX - drag.startX
    const dy = touch.clientY - drag.startY

    if (!drag.decided) {
      if (Math.abs(dx) < DIRECTION_THRESHOLD) return
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.tracking = false
        return
      }
      drag.decided = true
      drag.direction = dx < 0 ? 'next' : 'prev'
      // 代入页右滑：不是翻页而是退出阅读器
      drag.exiting =
        drag.direction === 'prev' && Boolean(exitCallbackRef.current) && pagerRef.current.isCoverPage
      // 相邻章边界页已预渲染进图层时不算橡皮筋：拖动跟手、翻页动画连续滑过去
      drag.rubber =
        !drag.exiting &&
        (drag.direction === 'next'
          ? !pagerRef.current.hasNextPage && !boundaryNextPage
          : !pagerRef.current.hasPrevPage && !boundaryPrevPage)
      drag.boundary =
        !drag.exiting &&
        !drag.rubber &&
        (drag.direction === 'next' ? !pagerRef.current.hasNextPage : !pagerRef.current.hasPrevPage)
    }

    const direction = drag.direction
    if (!direction) return

    if (drag.exiting) {
      drag.rawDx = Math.max(0, dx)
      drag.dx = drag.rawDx
      applyExitDrag(drag.dx)
      return
    }

    const offset = drag.rubber ? dx * RUBBER_DAMPING : dx
    drag.rawDx = direction === 'next' ? Math.min(0, dx) : Math.max(0, dx)
    drag.dx = direction === 'next' ? Math.min(0, offset) : Math.max(0, offset)
    applyDrag(drag.dx, direction, drag.rubber)
  }

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    longPress.end()
    if (!drag.tracking) return
    drag.tracking = false

    const elapsed = Math.max(1, Date.now() - drag.startTime)

    // 长按已触发：这次触摸不再产生翻页/轻点
    if (longPress.firedRef.current) return

    if (!drag.decided) {
      // 轻点：先关掉选段浮层，其次按分区翻页/呼出控制栏
      if (selectedParagraphIndex !== null) {
        onDismissSelection()
        return
      }
      const touch = event.changedTouches[0]
      if (!touch || elapsed > 400) return
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const ratio = (touch.clientX - rect.left) / Math.max(1, rect.width)
      if (ratio < 0.25) flip('prev')
      else if (ratio > 0.75) flip('next')
      else onTapCenter()
      return
    }

    const direction = drag.direction
    if (!direction) return

    const velocity = Math.abs(drag.dx) / elapsed

    // 代入页右滑退出：过阈值送出屏幕，否则回弹（甩出也要先滑够一段，避免手抖误退）
    if (drag.exiting) {
      const flungOut = velocity > COMMIT_VELOCITY && drag.rawDx > drag.width * (EXIT_COMMIT_RATIO / 2)
      if (drag.rawDx > drag.width * EXIT_COMMIT_RATIO || flungOut) {
        commitExit()
        return
      }
      cancelFlip()
      return
    }

    const passed =
      !drag.rubber &&
      (Math.abs(drag.dx) > drag.width * (drag.boundary ? CHAPTER_COMMIT_RATIO : COMMIT_RATIO) ||
        velocity > (drag.boundary ? CHAPTER_COMMIT_VELOCITY : COMMIT_VELOCITY))

    if (passed) {
      commitFlip(direction)
      return
    }

    // 章边界：橡皮筋回弹的同时交给上层换章（阈值按真实位移算）
    const rawVelocity = Math.abs(drag.rawDx) / elapsed
    if (
      drag.rubber &&
      (Math.abs(drag.rawDx) > drag.width * CHAPTER_COMMIT_RATIO || rawVelocity > CHAPTER_COMMIT_VELOCITY)
    ) {
      cancelFlip()
      if (direction === 'next') pagerRef.current.requestNext()
      else pagerRef.current.requestPrev()
      return
    }

    cancelFlip()
  }

  /** 页内容主体：本章页与相邻章边界页共用；相邻章页不带本章的选段/听书/划线高亮 */
  const renderPageContent = (
    page: ReaderPageContent,
    sourceParagraphs: string[],
    sourceTitle: string,
    interactive: boolean,
  ): ReactNode => (
    <div
      className="absolute"
      style={{
        ...insetStyle,
        // 长按听书/选段走应用内自定义手势：禁掉系统文本选取与 iOS 气泡菜单，
        // 避免长按时弹出系统「复制/分享/全选/翻译」蓝色选取框
        userSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
    >
      {page.showTitle && sourceTitle.length > 0 ? (
        <div
          style={{
            borderLeft: `${PAGE_TITLE_STYLE.barWidth}px solid ${tone.accent}`,
            paddingLeft: PAGE_TITLE_STYLE.barGap,
            marginBottom: PAGE_TITLE_STYLE.gapBelow,
          }}
        >
          <h2
            style={{
              fontSize: `${Math.round(fontScaleOption.fontSize * PAGE_TITLE_STYLE.scale)}px`,
              lineHeight: PAGE_TITLE_STYLE.lineHeight,
              fontWeight: 700,
              letterSpacing: '0.01em',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: tone.accent,
            }}
          >
            {sourceTitle}
          </h2>
        </div>
      ) : null}
      {page.blocks.map((block, blockIndex) => {
        const source = sourceParagraphs[block.paragraphIndex] ?? ''
        const text = source.slice(block.startChar, block.endChar)
        const isSpeaking = interactive && speakingParagraphIndex === block.paragraphIndex
        const isSelected = interactive && selectedParagraphIndex === block.paragraphIndex
        const isUnderlined = interactive && underlined.has(block.paragraphIndex)
        return (
          <p
            key={`${block.paragraphIndex}-${block.startChar}`}
            data-tts-p={block.paragraphIndex}
            style={{
              fontSize: `${fontScaleOption.fontSize}px`,
              lineHeight: fontScaleOption.lineHeight,
              letterSpacing: '0.01em',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              textIndent: block.startChar > 0 ? 0 : '2em',
              marginTop: blockIndex > 0 ? PAGE_PARAGRAPH_GAP : 0,
              color: tone.text,
              background: isSelected
                ? 'color-mix(in srgb, currentColor 14%, transparent)'
                : isSpeaking
                  ? 'color-mix(in srgb, currentColor 9%, transparent)'
                  : undefined,
              borderRadius: isSelected || isSpeaking ? 8 : undefined,
              textDecoration: isUnderlined ? 'underline' : undefined,
              textDecorationStyle: isUnderlined ? 'dotted' : undefined,
              textDecorationColor: isUnderlined
                ? `color-mix(in srgb, ${tone.accent} 65%, transparent)`
                : undefined,
              textDecorationThickness: isUnderlined ? '2px' : undefined,
              textUnderlineOffset: isUnderlined ? '5px' : undefined,
            }}
          >
            {text}
          </p>
        )
      })}
    </div>
  )

  const renderPageAt = (index: number): ReactNode => {
    if (index < 0) return index === -1 && renderCover ? renderCover() : null
    const page = pages[index]
    if (!page) return null
    return (
      <>
        {renderPageContent(page, paragraphs, chapterTitle, true)}
        {/* 本页自带的信息层：跟着这一页一起进出屏幕，翻页过程中不会消失再重现 */}
        {renderChrome?.(index)}
      </>
    )
  }

  /** 相邻章边界页：预热缓存命中才有；不带本章的高亮态，信息层用单独的全书页码口径 */
  const renderBoundaryAt = (side: 'prev' | 'next'): ReactNode => {
    const neighbor = side === 'prev' ? boundaryPrevPage : boundaryNextPage
    if (!neighbor) return null
    return (
      <>
        {renderPageContent(neighbor.page, neighbor.paragraphs, neighbor.title, false)}
        {renderBoundaryChrome?.(side)}
      </>
    )
  }

  const layerClass = 'absolute inset-0 overflow-hidden'
  const layerStyle: CSSProperties = { background: tone.background, willChange: 'transform', backfaceVisibility: 'hidden' }

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 overflow-hidden"
      style={{ perspective: '1600px', touchAction: 'none', left: 'var(--safe-left, 0px)', right: 'var(--safe-right, 0px)' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {/* 正文可用区尺寸探针：与页面正文区完全同尺寸 */}
      <div ref={sizerRef} aria-hidden className="pointer-events-none absolute opacity-0" style={insetStyle} />

      {/* 代入页右滑退出提示：页面右移时从左侧展开一条窄带（宽度跟手，内容固定在带内居中） */}
      <div
        ref={exitHintRef}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-[15] overflow-hidden"
        style={{
          width: 0,
          background: tone.background,
          boxShadow: 'inset -10px 0 16px -6px rgba(0, 0, 0, 0.35)',
        }}
      >
        {/* 内容随带宽居中：带子跟着页面边缘一起长，图案与文案始终整块落在带内不被裁 */}
        <div
          ref={exitHintContentRef}
          className="absolute inset-0 flex items-center justify-center gap-1"
          style={{ color: tone.text }}
        >
          {/* 图案排在竖排文案左侧；未到阈值是细竖条，过阈值同位置换成返回箭头 */}
          <span className="relative flex h-6 w-4 shrink-0 items-center justify-center">
            <span
              ref={exitHintBarRef}
              className="absolute h-6 w-[2px] rounded-full"
              style={{ background: 'currentColor', opacity: 0.3 }}
            />
            <span ref={exitHintIconRef} className="absolute" style={{ opacity: 0 }}>
              <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
            </span>
          </span>
          <span
            ref={exitHintTextRef}
            className="shrink-0 whitespace-nowrap text-[12px] leading-[1.5] tracking-[0.1em]"
            style={{ opacity: 0.55, writingMode: 'vertical-rl', display: 'none' }}
          >
            右滑退出阅读器
          </span>
        </div>
      </div>

      {pages.length === 0 && !pager.isCoverPage ? (
        <div className="absolute" style={insetStyle}>
          {fallback}
        </div>
      ) : null}

      {/* 下一页（仿真模式在当前页下方显出，覆盖模式从右侧滑入）；
          换章进场期间不渲染相邻页：仿真模式下下一页图层垫在当前页下方，
          滑入过程左侧未覆盖区会提前露出新章第 2 页（闪一下错页） */}
      <div
        ref={nextLayerRef}
        className={layerClass}
        style={{
          ...layerStyle,
          zIndex: mode === 'cover' ? 25 : 10,
          transform: baseTransform('next'),
        }}
      >
        {enterDirection ? null : pager.pageIndex + 1 <= pager.maxIndex
          ? renderPageAt(pager.pageIndex + 1)
          : renderBoundaryAt('next')}
        <div
          ref={shadeRef}
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: '#000', opacity: 0 }}
        />
      </div>

      {/* 当前页 */}
      <div
        ref={currentLayerRef}
        className={layerClass}
        style={{ ...layerStyle, zIndex: 20, transform: baseTransform('current'), transformOrigin: 'left center' }}
      >
        {renderPageAt(pager.pageIndex)}
      </div>

      {/* 上一页：默认停在屏幕左侧外，右滑时滑回来盖住当前页；换章进场期间同样不渲染 */}
      <div
        ref={prevLayerRef}
        className={layerClass}
        style={{ ...layerStyle, zIndex: 30, transform: baseTransform('prev'), transformOrigin: 'right center' }}
      >
        {enterDirection ? null : pager.pageIndex - 1 >= pager.minIndex
          ? renderPageAt(pager.pageIndex - 1)
          : renderBoundaryAt('prev')}
      </div>
    </div>
  )
}
