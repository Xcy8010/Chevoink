import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'
import { useNativeSystemSurface } from '@/lib/useNativeSystemSurface'
import { readInitialEditorColumns } from '@/features/studio/panel-widths'
import { readWorkspaceSidebarOpen, readWorkspaceSidebarWidth } from '@/features/studio/workspace-sidebar-size'
import '@/features/discover/discover-gallery.css'
import '@/features/discover/rankings.css'

/** 骨架需匹配最终布局：从地址栏解析当前作品，读取其工作区视角（work/ide），SSR 无 window 时按 work 处理 */
function resolveStudioPerspective(): 'work' | 'ide' {
  if (typeof window === 'undefined') return 'work'
  const match = window.location.pathname.match(/\/studio\/novel\/([^/]+)/)
  const novelId = match?.[1] ?? window.localStorage.getItem('studio-last-novel-id')
  if (!novelId) return 'work'
  return window.localStorage.getItem(`chevoink:perspective:${novelId}`) === 'ide' ? 'ide' : 'work'
}

type SkeletonProps = {
  className?: string
  style?: CSSProperties
}

/** 基础骨架块 */
export function Skeleton({ className, style }: SkeletonProps) {
  return <div className={cn('skeleton-shimmer rounded-[var(--radius-sm)]', className)} style={style} />
}

/** 文字条骨架 */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className="h-3.5"
          // 最后一行缩短，模拟自然段落
          {...(index === lines - 1 ? { style: { width: '72%' } } : {})}
        />
      ))}
    </div>
  )
}

/** 头像骨架 */
export function SkeletonAvatar({ size = 40 }: { size?: number }) {
  return <Skeleton className="shrink-0 rounded-full" style={{ width: size, height: size }} />
}

/** 封面骨架（3:4 书籍封面比例） */
export function SkeletonCover({ className }: SkeletonProps) {
  return <Skeleton className={cn('aspect-[3/4] w-24 rounded-[var(--radius-md)]', className)} />
}

/** 小说卡片骨架：封面 + 文字条 */
export function SkeletonNovelCard({ className }: SkeletonProps) {
  return (
    <div className={cn('flex gap-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-3', className)}>
      <SkeletonCover />
      <div className="min-w-0 flex-1 space-y-2 py-1">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
        <SkeletonText lines={2} className="pt-1" />
      </div>
    </div>
  )
}

/** 首页骨架屏 */
export function HomeSkeleton() {
  return (
    <div data-route-loading className="grid items-start gap-10 xl:grid-cols-[minmax(0,1fr)_300px]" aria-busy="true" aria-label="内容加载中">
      <div className="min-w-0">
        <Skeleton className="h-[180px] w-full rounded-[var(--radius-xl)] md:h-[240px] xl:h-[280px]" />
        <div className="mt-3 flex gap-2 overflow-hidden md:mt-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-16 shrink-0 rounded-[var(--radius-pill)]" />
          ))}
        </div>
        <div className="mt-7 space-y-4 md:mt-9 xl:mt-10">
          <Skeleton className="h-5 w-24" />
          <div className="grid gap-4 md:grid-cols-4">
            {[0, 1, 2, 3].map(index => <div key={index} className={cn('min-w-0 gap-3 md:block', index === 0 ? 'flex' : 'hidden')}>
              <SkeletonCover className="w-[84px] shrink-0 md:w-full" />
              <div className="min-w-0 flex-1 space-y-2 pt-2"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>
            </div>)}
          </div>
        </div>
      </div>
      <aside className="hidden min-w-0 xl:block">
        <Skeleton className="mb-2 h-5 w-20" />
        {[0, 1, 2, 3, 4].map(index => <div key={index} className="space-y-2 border-b border-[var(--border-subtle)] py-3"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-2.5 w-1/2" /></div>)}
      </aside>
    </div>
  )
}

/** 阅读器骨架屏 */
export function ReaderSkeleton() {
  return (
    <div data-route-loading className="flex min-h-0 flex-1 flex-col overflow-hidden xl:border-b xl:border-[var(--border-subtle)]" aria-busy="true" aria-label="正文加载中">
      <div className="hidden h-14 shrink-0 items-center justify-between gap-3 border-b border-t-[3px] border-[var(--border-subtle)] px-4 xl:flex">
        <Skeleton className="h-3 w-14" /><Skeleton className="h-3.5 w-32" /><Skeleton className="h-3 w-24" />
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-60 shrink-0 space-y-5 border-r border-[var(--border-subtle)] px-4 py-4 xl:block">
          <Skeleton className="h-3.5 w-16" /><SkeletonText lines={6} />
        </aside>
        <div className="mx-auto w-full min-w-0 max-w-[760px] space-y-6 px-4 py-8 md:px-8 xl:px-10 xl:py-10">
          <Skeleton className="h-7 w-48" />
          <div className="space-y-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-4" style={{ width: `${88 + ((index * 7) % 12)}%` }} />
            ))}
          </div>
          <div className="space-y-4 pt-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-4" style={{ width: `${86 + ((index * 11) % 14)}%` }} />
            ))}
          </div>
        </div>
        <aside className="hidden w-[280px] shrink-0 space-y-5 border-l border-[var(--border-subtle)] px-4 py-4 xl:block">
          <Skeleton className="h-3.5 w-20" /><SkeletonText lines={3} />
        </aside>
      </div>
    </div>
  )
}

/** 社区帖子流骨架 */
export function PostListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="帖子加载中">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-4">
          <div className="flex items-center gap-3">
            <SkeletonAvatar />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <SkeletonText lines={3} />
        </div>
      ))}
    </div>
  )
}

/** 帖子详情骨架屏：正文卡 + 评论条 + 右侧延伸区 */
export function PostDetailSkeleton() {
  return (
    <div data-route-loading className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_340px]" aria-busy="true" aria-label="帖子加载中">
      <div className="space-y-4">
        <div className="space-y-3 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <SkeletonAvatar />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <Skeleton className="h-5 w-3/4" />
          <SkeletonText lines={5} />
        </div>
        <div className="space-y-4 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-4 sm:p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-24 w-full rounded-[var(--radius-lg)]" />
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex gap-3">
              <SkeletonAvatar size={32} />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-24" />
                <SkeletonText lines={2} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-4">
        <Skeleton className="h-4 w-24" />
        <SkeletonText lines={3} />
        <SkeletonText lines={3} />
      </div>
    </div>
  )
}

const studioMessageWidths = ['w-11/12', 'w-full', 'w-4/5'] as const

function StudioMessageLines({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn('space-y-3', compact && 'space-y-2.5')}>
      {studioMessageWidths.map((width, index) => (
        <Skeleton key={width} className={cn(compact ? 'h-3' : 'h-3.5', width, index === 2 && 'opacity-80')} />
      ))}
    </div>
  )
}

/** 与真实活动栏一致：桌面并排胶囊，手机融合成一条；不预先展开列表/待审操作。 */
function StudioActivitySkeleton({ region }: { region: string }) {
  return <div data-studio-region={region} aria-hidden="true" className="mb-2 flex min-w-0 shrink-0 justify-center">
    <div data-studio-activity-capsules className="flex max-w-full items-center gap-2 mobile:w-80 mobile:gap-0 mobile:overflow-hidden mobile:rounded-2xl mobile:border mobile:border-[var(--border-subtle)] mobile:bg-[var(--surface-muted)]">
      <div data-studio-activity-capsule="todo" className="flex h-9 w-40 min-w-0 items-center gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 mobile:h-11 mobile:w-1/2 mobile:rounded-none mobile:border-0 mobile:bg-transparent mobile:px-2.5">
        <Skeleton className="h-3.5 w-3.5 shrink-0 mobile:hidden" /><Skeleton className="h-3 w-6 shrink-0" /><Skeleton className="h-3 min-w-0 flex-1" /><Skeleton className="h-2 w-2 shrink-0" />
      </div>
      <div data-studio-activity-capsule="changes" className="flex h-9 w-52 min-w-0 items-center gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 mobile:h-11 mobile:w-1/2 mobile:rounded-none mobile:border-0 mobile:border-l mobile:bg-transparent mobile:px-2.5">
        <Skeleton className="h-3 min-w-0 flex-1" /><Skeleton className="h-3 w-8 shrink-0" /><Skeleton className="h-3 w-4 shrink-0" />
      </div>
    </div>
  </div>
}

function StudioComposerSkeleton({ region }: { region: string }) {
  return <div data-studio-region={region} aria-hidden="true" className="mb-4 flex min-h-[112px] min-w-0 shrink-0 flex-col rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-2.5 shadow-sm lg:mb-2 lg:min-h-[118px] mobile:mb-0 mobile:min-h-[120px]">
    <div className="min-h-12 flex-1 px-1.5 pt-1"><Skeleton className="h-3.5 w-3/5" /></div>
    <div data-studio-composer-toolbar className="mt-1.5 flex min-w-0 items-center gap-1.5">
      <Skeleton className="h-6 w-6 shrink-0 rounded-lg" />
      <Skeleton className="h-6 w-20 shrink-0 rounded-lg mobile:w-6" />
      <span data-studio-skeleton-model-effort className="ml-auto min-w-0"><Skeleton className="h-6 w-20 max-w-full rounded-lg mobile:w-14" /></span>
      <Skeleton className="h-9 w-9 shrink-0 rounded-full mobile:h-11 mobile:w-11" />
      <Skeleton className="h-8 w-8 shrink-0 rounded-full mobile:h-11 mobile:w-11" />
    </div>
  </div>
}

export function StudioTaskStatusSkeleton() {
  return <div role="status" aria-label="正在载入任务状态" className="rounded-[20px] bg-[var(--surface-muted)] p-3">
    <div aria-hidden="true">
      <div className="flex h-7 items-center px-2"><Skeleton className="h-3.5 w-16" /></div>
      <div className="flex h-9 items-center gap-2 px-2"><Skeleton className="size-3.5" /><Skeleton className="h-3 w-20" /><Skeleton className="h-2.5 w-9" /></div>
      <div data-studio-dock-changes>{['w-5/6', 'w-3/5', 'w-full', 'w-2/3', 'w-4/5'].map(width =>
        <div key={width} className="flex h-9 items-center gap-2 px-2">
          <Skeleton className="size-3.5 shrink-0" />
          <div className="min-w-0 flex-1"><Skeleton className={cn('h-3', width)} /></div>
          <Skeleton className="h-2.5 w-7" /><Skeleton className="h-2.5 w-6" />
        </div>)}</div>
      <div className="flex h-10 items-center gap-4 border-t border-[var(--border-subtle)] px-2">
        <Skeleton className="mr-auto h-2.5 w-12" /><Skeleton className="h-2.5 w-10" /><Skeleton className="h-2.5 w-10" />
      </div>
    </div>
  </div>
}

/** 创作区骨架屏：按真实 Work 工作区分别适配桌面端与手机端 */
const studioSkeletonInspectorTabs = ['work', 'context', 'changes', 'memory', 'skills'] as const

export function StudioSkeleton() {
  const mobileSystemSurfaceRef = useNativeSystemSurface<HTMLDivElement>()
  const perspective = resolveStudioPerspective()
  return (
    <div
      className="studio-workspace flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-bg)]"
      data-route-loading
      aria-busy="true"
      aria-label="创作区加载中"
    >
      {/* 手机端：顶部双视图导航、实际任务控件与底部输入区。 */}
      <div className="studio-pending flex min-h-0 flex-1 flex-col lg:hidden" data-studio-skeleton="mobile">
        <div ref={mobileSystemSurfaceRef} className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--app-bg)] pl-[max(8px,var(--safe-left,0px))] pr-[max(8px,var(--safe-right,0px))] pt-[var(--safe-top,0px)]" data-studio-region="mobile-header">
          <div className="grid h-14 grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
            <div data-studio-nav-key="menu" className="grid size-11 place-items-center"><Skeleton className="size-5" /></div>
            <div className="flex items-center justify-center gap-5" data-studio-region="mobile-view-navigation">
              <div data-studio-nav-key="assistant" className="flex h-14 flex-col items-center justify-center gap-3"><Skeleton className="h-3.5 w-12 rounded-sm" /><Skeleton className="h-0.5 w-5 rounded-sm" /></div>
              <div data-studio-nav-key="editor"><Skeleton className="h-3.5 w-10 rounded-sm" /></div>
            </div>
            <div data-studio-nav-key="exit" className="grid size-11 place-items-center"><Skeleton className="size-5" /></div>
          </div>
        </div>
        <div className="mx-auto flex h-11 w-full max-w-3xl shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-3" data-studio-region="mobile-task-header">
          <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-20" />
          <span className="grid size-11 place-items-center"><Skeleton className="size-4" /></span>
          <span className="ml-auto grid size-11 place-items-center"><Skeleton className="size-4" /></span>
          <span className="grid size-11 place-items-center"><Skeleton className="size-4" /></span>
        </div>

        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden pb-[calc(16px_+_var(--bottom-bar-inset,0px))] pl-[calc(16px_+_var(--safe-left,0px))] pr-[calc(16px_+_var(--safe-right,0px))] pt-4" data-studio-region="mobile-conversation">
          <div className="min-h-0 flex-1 space-y-5 overflow-hidden py-2">
            <StudioMessageLines compact />
            <div className="ml-auto w-2/3 rounded-[22px] bg-[var(--surface-muted)] p-4">
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            <Skeleton className="h-3 w-28" />
            <StudioMessageLines compact />
            <div className="ml-auto w-1/2 rounded-[22px] bg-[var(--surface-muted)] p-4">
              <Skeleton className="h-3.5 w-3/4" />
            </div>
          </div>

          <StudioActivitySkeleton region="mobile-activity" />
          <StudioComposerSkeleton region="mobile-composer" />
        </div>

      </div>

      {/* 桌面端：作品与任务融合侧栏固定在左侧，命令栏保留唯一折叠入口。 */}
      <div className="studio-pending hidden min-h-0 flex-1 flex-col lg:flex" data-studio-skeleton="desktop">
        <div className="studio-skeleton-command flex h-9 shrink-0 items-center gap-[5px] px-2" data-studio-region="desktop-command-bar">
          <div className="grid w-9 place-items-center"><Skeleton className="h-4 w-4 rounded" /></div>
          <div className="flex gap-0.5" data-studio-history>{[0, 1].map(index => <div key={index} className="grid w-8 place-items-center"><Skeleton className="size-4 rounded" /></div>)}</div>
          <div className="h-4 w-px bg-[var(--border-subtle)]" />
          <div className="flex items-center gap-0.5" data-studio-command-menus>{Array.from({ length: 6 }, (_, index) => <div key={index} className="grid w-10 place-items-center"><Skeleton className="h-3 w-6" /></div>)}</div>
          {perspective === 'ide' && <div className="flex min-w-0 gap-2">
            <Skeleton className="h-6 w-24 rounded" />
            <Skeleton className="h-6 w-24 rounded" />
          </div>}
        </div>

        <div className="flex min-h-0 flex-1">
        <div data-studio-region="desktop-activity-rail" className="flex w-[52px] shrink-0 flex-col items-center gap-2 border-r border-[var(--border-subtle)] bg-[var(--studio-rail-bg)] py-3">
          {Array.from({ length: perspective === 'ide' ? 8 : 5 }, (_, index) => <div key={index} className="grid h-9 w-9 place-items-center"><Skeleton className="h-5 w-5 rounded-[6px]" /></div>)}
          <span aria-hidden="true" className="h-px w-6 shrink-0 bg-[var(--studio-rail-rule,var(--border-subtle))]" />
          <div className="grid h-9 w-9 place-items-center"><Skeleton className="h-5 w-5 rounded-[6px]" /></div>
          <div className="grid h-9 w-9 place-items-center"><Skeleton className="h-5 w-5 rounded-[6px]" /></div>
          <div className="mt-auto grid h-9 w-9 place-items-center"><Skeleton className="h-5 w-5 rounded-full" /></div>
          <div className="grid h-9 w-9 place-items-center"><Skeleton className="h-7 w-7 rounded-full" /></div>
        </div>
        {perspective === 'work' && readWorkspaceSidebarOpen() && <aside className="flex shrink-0 flex-col overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--app-bg)]" data-studio-region="desktop-workspace-sidebar" style={{ width: readWorkspaceSidebarWidth() }}>
          <div className="flex h-12 shrink-0 items-center gap-5 px-5"><Skeleton className="h-4 w-16" /><Skeleton className="ml-auto size-4" /><Skeleton className="size-4" /></div>
          <div className="flex h-[34px] shrink-0 items-center gap-2 px-5"><Skeleton className="size-4" /><Skeleton className="h-3 w-14" /></div>
          <div className="px-5 pt-4">
            <Skeleton className="mb-2 h-2.5 w-8" />
            {['w-2/3', 'w-1/2'].map(width => <div key={width} className="mb-2">
              <div className="flex h-[34px] items-center gap-2"><Skeleton className="size-3.5" /><Skeleton className="h-3 w-20" /></div>
              <div className="ml-5 flex h-[34px] items-center"><Skeleton className={cn('h-3', width)} /></div>
              <div className="ml-5 flex h-[34px] items-center"><Skeleton className="h-3 w-3/5" /></div>
            </div>)}
            <Skeleton className="mb-2 mt-5 h-2.5 w-12" />
            {['w-2/3', 'w-3/5', 'w-1/2'].map(width => <div key={width} className="ml-5 flex h-[34px] items-center"><Skeleton className={cn('h-3', width)} /></div>)}
          </div>
        </aside>}
        <div className="flex min-w-0 flex-1 flex-col">
        {perspective === 'ide' ? (
          <div
            className="grid min-h-0 flex-1 overflow-hidden bg-[var(--surface-default)]"
            data-studio-skeleton="ide"
            style={{ gridTemplateColumns: readInitialEditorColumns() }}
          >
            <div className="flex min-h-0 overflow-hidden border-r border-[var(--border-subtle)]">
              <div className="min-w-0 flex-1 space-y-3 overflow-hidden p-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 w-full rounded-[10px]" />
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="flex items-center gap-2.5">
                    <Skeleton className="h-3 w-3 rounded-[4px]" />
                    <Skeleton className={cn('h-3', index === 3 ? 'w-3/5' : 'w-5/6')} />
                  </div>
                ))}
              </div>
            </div>
            <div className="min-h-0 min-w-0 overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--surface-default)]">
              <div className="flex h-12 items-center gap-2 border-b border-[var(--border-subtle)] px-4">
                <Skeleton className="h-3 w-16" /><Skeleton className="ml-auto size-4" /><Skeleton className="size-4" />
              </div>
              <div className="mx-4 space-y-3 pt-5 xl:mx-6">
                <div className="mx-auto w-full max-w-[var(--studio-editor-max-width,880px)] space-y-3">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-11/12" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-10/12" />
                  <Skeleton className="h-4 w-full" />
                </div>
              </div>
            </div>
            <div className="flex min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] px-4">
              <div className="flex h-[3.25rem] shrink-0 items-center gap-2">
                <Skeleton className="h-5 w-5 rounded-full" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="ml-auto h-3 w-8" />
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-hidden py-3">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="ml-auto h-3.5 w-2/5" />
              </div>
              <StudioComposerSkeleton region="ide-composer" />
            </div>
          </div>
        ) : (
        <div className="studio-skeleton-work flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col">
            <header data-studio-region="desktop-task-header" className="flex h-[3.25rem] shrink-0 items-center gap-2.5 pl-[18px] pr-3">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-3.5 w-36" />
              <div className="ml-auto flex gap-1">
                {['new', 'history', 'status', 'more'].map(action => (
                  <span key={action} className="grid h-7 w-7 place-items-center">
                    <Skeleton className="h-4 w-4 rounded" />
                  </span>
                ))}
              </div>
            </header>
            <div className="relative flex min-h-0 flex-1">
              <main className="work-agent-frame ml-[44px] flex min-w-0 flex-1 justify-center overflow-hidden pb-2" data-studio-region="desktop-conversation">
                <div className="agent-conversation-width flex h-full min-h-0 flex-col px-4">
                  <div className="min-h-0 flex-1 space-y-8 overflow-hidden py-8">
                    <StudioMessageLines />
                    <div className="ml-auto w-2/5 rounded-[22px] bg-[var(--surface-muted)] p-5">
                      <Skeleton className="h-3.5 w-4/5" />
                    </div>
                    <Skeleton className="h-3 w-32" />
                    <StudioMessageLines />
                    <StudioMessageLines />
                  </div>
                  <StudioActivitySkeleton region="desktop-activity" />
                  <StudioComposerSkeleton region="desktop-composer" />
                </div>
              </main>
              <aside data-studio-region="desktop-activity-dock" aria-hidden="true" className="studio-skeleton-activity-dock absolute inset-y-0 right-3 hidden w-[296px] overflow-hidden px-3 pt-2"><StudioTaskStatusSkeleton /></aside>
            </div>
          </div>
          <aside className="flex w-[46px] shrink-0 flex-col items-center border-l border-[var(--border-subtle)] py-2" data-studio-region="desktop-inspector-rail">
            <span className="grid h-9 w-9 shrink-0 place-items-center"><Skeleton className="size-4" /></span>
            {studioSkeletonInspectorTabs.map((tab) => (
              <span key={tab} className="mt-2 grid h-9 w-9 shrink-0 place-items-center" data-studio-inspector-tab={tab} data-studio-skeleton-skill-entry={tab === 'skills' || undefined}>
                <Skeleton className="size-4" />
              </span>
            ))}
          </aside>
        </div>
        )}
        </div>
      </div>
    </div>
    </div>
  )
}

/** 作品下拉选项骨架：列表未就绪时占位 3-5 行 */
export function NovelOptionSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-1" aria-busy="true" aria-label="作品列表加载中">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-[16px] px-3 py-3">
          <Skeleton className="h-9 w-9 rounded-[12px]" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 作者主页骨架屏：资料卡 + 统计卡 + 作品栅格 + 讨论列 */
export function AuthorSkeleton() {
  return (
    <div data-route-loading className="space-y-6" aria-busy="true" aria-label="作者主页加载中">
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_320px]">
        <div className="space-y-5 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-4 sm:p-5">
          <div className="flex items-start gap-4">
            <SkeletonAvatar size={64} />
            <div className="flex-1 space-y-3">
              <Skeleton className="h-6 w-40" />
              <SkeletonText lines={2} />
              <div className="flex gap-2">
                <Skeleton className="h-6 w-28 rounded-[var(--radius-pill)]" />
                <Skeleton className="h-6 w-24 rounded-[var(--radius-pill)]" />
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-20 rounded-[var(--radius-lg)]" />
            ))}
          </div>
        </div>
        <div className="space-y-3 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-4">
          <Skeleton className="h-4 w-24" />
          <SkeletonText lines={3} />
        </div>
      </section>
      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_360px]">
        <div className="space-y-4">
          <Skeleton className="h-4 w-24" />
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="aspect-[4/5] w-full rounded-[var(--radius-xl)]" />
            <Skeleton className="aspect-[4/5] w-full rounded-[var(--radius-xl)]" />
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-4 w-24" />
          <PostListSkeleton count={2} />
        </div>
      </section>
    </div>
  )
}

/** 与榜单的排名、封面和文字行对齐。 */
export function RankingsSkeleton() {
  return <div data-route-loading className="rankings-page" aria-busy="true" aria-label="榜单加载中">
    <div className="rankings-controls"><div className="rankings-boards">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-10 w-16 shrink-0 rounded-md" />)}</div><Skeleton className="h-9 w-32 shrink-0" /></div>
    <div className="rankings-list">{Array.from({ length: 5 }, (_, index) => <div className="rankings-row" key={index}>
      <Skeleton className="h-8 w-6 self-start" /><Skeleton className="rankings-cover aspect-[3/4] rounded-md" />
      <div className="rankings-copy space-y-3"><Skeleton className="h-5 w-2/3 max-w-xs" /><Skeleton className="h-3 w-24" /><SkeletonText lines={2} className="max-w-lg" /></div>
      <Skeleton className="h-9 w-24 max-[640px]:hidden" />
    </div>)}</div>
  </div>
}

/** 与发现页封面画廊保持相同尺寸和错落节奏。 */
export function DiscoverSkeleton() {
  return <div data-route-loading className="discover-gallery-page" aria-busy="true" aria-label="书库加载中">
    <div className="discover-controls"><div className="discover-categories">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-9 w-16 shrink-0 rounded-full" />)}</div><Skeleton className="h-8 w-24 shrink-0" /></div>
    <div className="discover-gallery"><div className="discover-gallery-books">{Array.from({ length: 6 }, (_, index) => <div className="discover-gallery-book" key={index}>
      <Skeleton className="aspect-[3/4] w-full rounded-md" /><div className="discover-book-caption"><Skeleton className="h-5 w-4/5" /><Skeleton className="mt-2 h-3 w-1/2" /></div><div className="h-[76px] max-[1100px]:h-10" />
    </div>)}</div></div>
    <div className="discover-section"><div className="discover-section-heading"><Skeleton className="h-6 w-24" /></div><div className="discover-recommendations">{Array.from({ length: 2 }, (_, index) => <div className="discover-recommendation" key={index}><Skeleton className="discover-recommendation-cover aspect-[3/4] rounded-md" /><div className="flex-1 space-y-3"><Skeleton className="h-5 w-3/4" /><SkeletonText lines={3} /></div></div>)}</div></div>
  </div>
}
