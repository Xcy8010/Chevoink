import {
  ChevronLeft,
  Headphones,
  ListOrdered,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import BottomSheet from '@/components/layout/BottomSheet'
import { useDevice } from '@/components/layout/device-context'
import { isNativeApp } from '@/lib/native-app'
import { setNativeReaderSafeArea } from '@/lib/safe-area'
import { cn } from '@/lib/utils'
import ReaderArticle from '../components/ReaderArticle'
import ReaderCommentsPanel from '../components/ReaderCommentsPanel'
import ReaderDirectory from '../components/ReaderDirectory'
import ReaderProgressBar from '../components/ReaderProgressBar'
import ReaderSettingsContent from '../components/ReaderSettingsContent'
import ReaderSettingsPopover from '../components/ReaderSettingsPopover'
import TtsControlSheet from '../tts/TtsControlSheet'
import TtsMiniBar from '../tts/TtsMiniBar'
import { useChapterGestures } from '../useChapterGestures'
import type { ReaderState } from '../useReaderState'

type ReaderTabletProps = {
  state: ReaderState
}

/**
 * 平板端阅读器（方案 2.5.2）：
 * - 横屏：左侧目录/评论双栏（可折叠）+ 右侧正文，设置用弹出面板
 * - 竖屏：单栏正文 + 顶部工具栏，目录/评论/设置用底部抽屉
 * - 支持触控滑动翻章
 * - 折叠屏（双折叠/三折叠/阔折叠内屏均落在平板断点）：支持一键沉浸阅读，
 *   开启后阅读器全屏覆盖应用壳层，隐藏顶栏与底部导航
 */
export default function ReaderTablet({ state }: ReaderTabletProps) {
  const { orientation } = useDevice()
  const navigate = useNavigate()
  const [sideTab, setSideTab] = useState<'directory' | 'comments'>('directory')
  const [sideOpen, setSideOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sheetPanel, setSheetPanel] = useState<'directory' | 'comments' | 'settings' | null>(null)
  const [immersive, setImmersive] = useState(false)
  const [ttsSheetOpen, setTtsSheetOpen] = useState(false)

  const tone = state.toneOption
  const { activePanel, activeParagraphIndex } = state

  useEffect(() => {
    if (!isNativeApp()) return
    setNativeReaderSafeArea(true)
    return () => setNativeReaderSafeArea(false)
  }, [])

  // 段评气泡打开评论时同步打开对应方向的评论面板
  useEffect(() => {
    if (activePanel !== 'comments') return
    if (orientation === 'landscape') {
      setSideTab('comments')
      setSideOpen(true)
    } else {
      setSheetPanel('comments')
    }
  }, [activePanel, activeParagraphIndex, orientation])

  const gestures = useChapterGestures({
    onSwipeLeft: () => {
      if (state.nextHref) navigate(state.nextHref)
    },
    onSwipeRight: () => {
      if (state.previousHref) navigate(state.previousHref)
    },
  })

  const settingsButton = (onClick: () => void, active: boolean) => (
    <button
      type="button"
      aria-label="阅读设置"
      onClick={onClick}
      className={cn(
        'touch-target inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-pill)] transition-colors press-feedback',
        active ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]' : 'hover:bg-black/5',
      )}
    >
      <Settings2 className="h-5 w-5" />
    </button>
  )

  const ttsButton = state.tts.available ? (
    <button
      type="button"
      aria-label="听书"
      onClick={() => {
        if (state.tts.isActive) {
          setTtsSheetOpen(true)
        } else {
          state.tts.start()
        }
      }}
      className="touch-target inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-pill)] transition-colors hover:bg-black/5 press-feedback"
    >
      <Headphones className="h-5 w-5" />
    </button>
  ) : null

  const ttsSheet = (
    <BottomSheet open={ttsSheetOpen} onClose={() => setTtsSheetOpen(false)} title="听书设置">
      <TtsControlSheet tts={state.tts} />
    </BottomSheet>
  )

  const immersiveButton = (
    <button
      type="button"
      aria-label={immersive ? '退出沉浸阅读' : '沉浸阅读'}
      onClick={() => setImmersive((value) => !value)}
      className={cn(
        'touch-target inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-pill)] transition-colors press-feedback',
        immersive ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]' : 'hover:bg-black/5',
      )}
    >
      {immersive ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
    </button>
  )

  if (orientation === 'landscape') {
    return (
      <div
        className={
          immersive
            ? 'fixed inset-0 z-[70] flex overflow-hidden'
            : '-mt-4 flex min-h-0 flex-1 overflow-hidden md:-mt-6'
        }
        style={{ background: tone.background, color: tone.text }}
      >
        {/* 左侧目录/评论面板 */}
        {sideOpen ? (
          <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-default)]">
            <div className="grid grid-cols-2 gap-1 border-b border-[var(--border-subtle)] p-2">
              {(
                [
                  { id: 'directory', label: '目录', icon: <ListOrdered className="h-4 w-4" /> },
                  { id: 'comments', label: '评论', icon: <MessageSquare className="h-4 w-4" /> },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    // 切回目录时重置段评筛选
                    if (tab.id === 'directory') state.setActivePanel(null)
                    setSideTab(tab.id)
                  }}
                  className={cn(
                    'inline-flex h-9 items-center justify-center gap-1.5 rounded-[var(--radius-md)] text-sm transition-colors press-feedback',
                    sideTab === tab.id
                      ? 'bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]',
                  )}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {sideTab === 'directory' ? (
                <ReaderDirectory state={state} />
              ) : (
                <ReaderCommentsPanel state={state} />
              )}
            </div>
          </aside>
        ) : null}

        {/* 右侧正文 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <ReaderProgressBar percent={state.progressPercent} />
          <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2">
            <button
              type="button"
              onClick={state.exitReader}
              className="touch-target inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] press-feedback"
              aria-label={state.backLabel}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1 text-[var(--text-primary)]">
              <p className="truncate text-sm font-medium">{state.novelTitle}</p>
              <p className="truncate text-xs text-[var(--text-tertiary)]">{state.chapterTitle}</p>
            </div>
            <button
              type="button"
              aria-label={sideOpen ? '收起侧栏' : '展开侧栏'}
              onClick={() => setSideOpen((open) => !open)}
              className="touch-target inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] press-feedback"
            >
              {sideOpen ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
            </button>
            {ttsButton}
            {immersiveButton}
            <div className="relative">
              {settingsButton(() => setSettingsOpen((open) => !open), settingsOpen)}
              <ReaderSettingsPopover
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                fontScale={state.fontScale}
                tone={state.tone}
                onFontScaleChange={state.setFontScale}
                onToneChange={state.setTone}
              />
            </div>
          </header>

          <div
            ref={state.contentScrollRef}
            onScroll={state.handleContentScroll}
            {...gestures}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <div className="mx-auto max-w-[680px] px-8 py-8">
              <ReaderArticle
                state={state}
                header="full"
                onOpenComments={() => {
                  setSideTab('comments')
                  setSideOpen(true)
                }}
              />
            </div>
          </div>

          {/* 听书迷你条：正文列底部常驻 */}
          <TtsMiniBar
            tts={state.tts}
            tone={tone}
            onExpand={() => setTtsSheetOpen(true)}
            className="shrink-0"
          />
        </div>

        {ttsSheet}
      </div>
    )
  }

  // 竖屏：单栏正文 + 顶部工具栏 + 底部抽屉
  return (
    <div
      className={
        immersive
          ? 'fixed inset-0 z-[70] flex flex-col overflow-hidden'
          : '-mt-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-mt-6'
      }
      style={{ background: tone.background, color: tone.text }}
    >
      <ReaderProgressBar percent={state.progressPercent} />
      <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2">
        <button
          type="button"
          onClick={state.exitReader}
          className="touch-target inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] press-feedback"
          aria-label={state.backLabel}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 text-[var(--text-primary)]">
          <p className="truncate text-sm font-medium">{state.novelTitle}</p>
          <p className="truncate text-xs text-[var(--text-tertiary)]">{state.chapterTitle}</p>
        </div>
        <button
          type="button"
          aria-label="目录"
          onClick={() => setSheetPanel('directory')}
          className="touch-target inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] press-feedback"
        >
          <ListOrdered className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="评论"
          onClick={() => setSheetPanel('comments')}
          className="touch-target inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] press-feedback"
        >
          <MessageSquare className="h-5 w-5" />
        </button>
        {settingsButton(() => setSheetPanel('settings'), sheetPanel === 'settings')}
        {ttsButton}
        {immersiveButton}
      </header>

      <div
        ref={state.contentScrollRef}
        onScroll={state.handleContentScroll}
        {...gestures}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto max-w-[680px] px-6 py-6">
          <ReaderArticle state={state} header="full" onOpenComments={() => setSheetPanel('comments')} />
        </div>
      </div>

      {/* 听书迷你条：吸底常驻 */}
      <TtsMiniBar
        tts={state.tts}
        tone={tone}
        onExpand={() => setTtsSheetOpen(true)}
        className="shrink-0 pb-[var(--safe-bottom)]"
      />

      <BottomSheet open={sheetPanel === 'directory'} onClose={() => setSheetPanel(null)} title="目录">
        <ReaderDirectory state={state} onNavigate={() => setSheetPanel(null)} />
      </BottomSheet>
      <BottomSheet
        open={sheetPanel === 'comments'}
        onClose={() => {
          // 关闭评论抽屉时重置段评筛选
          state.setActivePanel(null)
          setSheetPanel(null)
        }}
        title="章节评论"
      >
        <ReaderCommentsPanel state={state} />
      </BottomSheet>
      <BottomSheet open={sheetPanel === 'settings'} onClose={() => setSheetPanel(null)} title="阅读设置">
        <ReaderSettingsContent
          fontScale={state.fontScale}
          tone={state.tone}
          onFontScaleChange={state.setFontScale}
          onToneChange={state.setTone}
        />
      </BottomSheet>
      {ttsSheet}
    </div>
  )
}
