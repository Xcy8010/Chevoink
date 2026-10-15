import { cn } from '@/lib/utils'
import { useNativeSystemSurface } from '@/lib/useNativeSystemSurface'

/** 骨架需匹配最终布局：从地址栏解析当前作品，读取其工作区视角（work/ide），SSR 无 window 时按 work 处理 */
function resolveStudioPerspective(): 'work' | 'ide' {
  if (typeof window === 'undefined') return 'work'
  const match = window.location.pathname.match(/\/studio\/novel\/([^/]+)/)
  const novelId = match?.[1]
  if (!novelId) return 'work'
  return window.localStorage.getItem(`chevoink:perspective:${novelId}`) === 'ide' ? 'ide' : 'work'
}

type SkeletonProps = {
  className?: string
}

/** 基础骨架块 */
export function Skeleton({ className }: SkeletonProps) {
  return <div className={cn('skeleton-shimmer rounded-[var(--radius-sm)]', className)} />
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
  return <Skeleton className="shrink-0 rounded-full" {...{ style: { width: size, height: size } }} />
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
    <div className="space-y-4 md:space-y-6" aria-busy="true" aria-label="内容加载中">
      <Skeleton className="h-[180px] w-full rounded-[var(--radius-xl)] md:h-[240px]" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-20 shrink-0 rounded-[var(--radius-pill)]" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <SkeletonNovelCard />
        <SkeletonNovelCard />
        <SkeletonNovelCard />
      </div>
    </div>
  )
}

/** 阅读器骨架屏 */
export function ReaderSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[720px] space-y-6 px-4 py-8" aria-busy="true" aria-label="正文加载中">
      <Skeleton className="h-7 w-48" />
      <div className="space-y-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton
            key={index}
            className="h-4"
            {...{ style: { width: `${88 + ((index * 7) % 12)}%` } }}
          />
        ))}
      </div>
      <div className="space-y-4 pt-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton
            key={index}
            className="h-4"
            {...{ style: { width: `${86 + ((index * 11) % 14)}%` } }}
          />
        ))}
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

/** 消息会话列表骨架 */
export function ConversationSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-1" aria-busy="true" aria-label="会话加载中">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-3">
          <SkeletonAvatar />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-4/5" />
          </div>
          <Skeleton className="h-3 w-8" />
        </div>
      ))}
    </div>
  )
}

/** 个人中心骨架屏：封面条 + 头像 + 统计卡 + tab 条 + 卡片栅格 */
export function ProfileSkeleton() {
  return (
    <div className="space-y-4 md:space-y-6" aria-busy="true" aria-label="个人中心加载中">
      <Skeleton className="h-[160px] w-full rounded-[var(--radius-xl)] md:h-[200px]" />
      <div className="flex items-center gap-4 px-2">
        <SkeletonAvatar size={72} />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3.5 w-56" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-20 rounded-[var(--radius-lg)]" />
        ))}
      </div>
      <div className="flex gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-20 rounded-[var(--radius-pill)]" />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <SkeletonNovelCard />
        <SkeletonNovelCard />
        <SkeletonNovelCard />
        <SkeletonNovelCard />
      </div>
    </div>
  )
}

/** 帖子详情骨架屏：正文卡 + 评论条 + 右侧延伸区 */
export function PostDetailSkeleton() {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_340px]" aria-busy="true" aria-label="帖子加载中">
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
  return <div data-studio-region={region} aria-hidden="true" className="mb-4 flex min-h-[112px] min-w-0 shrink-0 flex-col rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-2.5 shadow-sm mobile:mb-0 mobile:min-h-[120px]">
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

/** 宽屏停靠区仍用纵向清单，与输入框上方胶囊互斥。 */
function StudioActivityDockSkeleton() {
  return <aside data-studio-region="desktop-activity-dock" aria-hidden="true" className="studio-skeleton-activity-dock hidden w-[296px] shrink-0 px-3 py-4">
    <div className="rounded-[20px] bg-[var(--surface-muted)] p-3">
      <div className="px-2 py-2"><Skeleton className="h-4 w-16" /></div>
      <div className="flex h-9 items-center gap-2 px-2"><Skeleton className="h-3.5 w-3.5" /><Skeleton className="h-3 w-12" /><Skeleton className="h-3 w-16" /></div>
      <div className="space-y-3 px-2 pb-3">{Array.from({ length: 3 }, (_, index) => <div key={index} className="flex items-start gap-2"><Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" /><Skeleton className="h-3 w-4/5 opacity-60" /></div>)}</div>
      <div className="flex h-9 items-center gap-2 px-2"><Skeleton className="h-3.5 w-3.5" /><Skeleton className="h-3 w-24" /></div>
      <div data-studio-dock-changes>{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex h-9 items-center gap-2 px-2"><Skeleton className="h-3.5 w-3.5 shrink-0" /><Skeleton className="h-3 min-w-0 flex-1" /><Skeleton className="ml-3 h-3 w-8" /><Skeleton className="h-3 w-4" /></div>)}</div>
    </div>
  </aside>
}

/** 创作区骨架屏：按真实 Work 工作区分别适配桌面端与手机端 */
const studioSkeletonInspectorTabs = ['work', 'context', 'changes', 'memory', 'skills'] as const

export function StudioSkeleton() {
  const mobileSystemSurfaceRef = useNativeSystemSurface<HTMLDivElement>()
  const perspective = resolveStudioPerspective()
  return (
    <div
      className="studio-workspace flex h-full min-h-[70vh] min-w-0 flex-col overflow-hidden bg-[var(--app-bg)]"
      aria-busy="true"
      aria-label="创作区加载中"
    >
      {/* 手机端：顶部双视图导航、实际任务控件与底部输入区。 */}
      <div className="flex min-h-0 flex-1 flex-col lg:hidden" data-studio-skeleton="mobile">
        <div ref={mobileSystemSurfaceRef} className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--app-bg)] pl-[max(8px,var(--safe-left,0px))] pr-[max(8px,var(--safe-right,0px))] pt-[var(--safe-top,0px)]" data-studio-region="mobile-header">
          <div className="grid h-14 grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
            <div data-studio-nav-key="menu"><Skeleton className="h-11 w-11 rounded-xl" /></div>
            <div className="flex items-center justify-center gap-5" data-studio-region="mobile-view-navigation">
              <div data-studio-nav-key="assistant" className="flex h-14 flex-col items-center justify-center gap-3"><Skeleton className="h-3.5 w-12 rounded-sm" /><Skeleton className="h-0.5 w-5 rounded-sm" /></div>
              <div data-studio-nav-key="editor"><Skeleton className="h-3.5 w-10 rounded-sm" /></div>
            </div>
            <div data-studio-nav-key="exit"><Skeleton className="h-11 w-11 rounded-xl" /></div>
          </div>
        </div>
        <div className="flex h-11 shrink-0 items-center gap-2 px-4" data-studio-region="mobile-task-header">
          <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
          <Skeleton className="h-3.5 min-w-0 flex-1" />
          <Skeleton className="h-11 w-11 shrink-0 rounded-xl" />
          <Skeleton className="h-11 w-11 shrink-0 rounded-xl" />
          <Skeleton className="h-11 w-11 shrink-0 rounded-xl" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[calc(16px_+_var(--safe-bottom,0px))] pl-[calc(16px_+_var(--safe-left,0px))] pr-[calc(16px_+_var(--safe-right,0px))] pt-4" data-studio-region="mobile-conversation">
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
      <div className="hidden min-h-0 flex-1 lg:flex" data-studio-skeleton="desktop">
        <aside className="flex w-[284px] shrink-0 flex-col border-r border-[var(--border-subtle)] p-3" data-studio-region="desktop-workspace-sidebar">
          <div className="flex h-9 items-center gap-2"><Skeleton className="h-5 w-5 rounded-full" /><Skeleton className="h-3.5 w-24" /><Skeleton className="ml-auto h-7 w-7 rounded-[7px]" /></div>
          <Skeleton className="mt-3 h-8 w-full rounded-[4px]" />
          <Skeleton className="mt-3 h-10 w-full rounded-[14px]" />
          <Skeleton className="mt-2 h-9 w-full rounded-[4px]" />
          <Skeleton className="mt-5 h-3 w-12" />
          <div className="mt-2 space-y-2">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-8 w-full rounded-[4px]" />)}</div>
          <div className="mt-4 border-t border-[var(--border-subtle)] pt-4"><Skeleton className="h-3 w-12" /><div className="mt-2 space-y-2">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-10 w-full rounded-[4px]" />)}</div></div>
          <div className="mt-auto"><Skeleton className="h-9 w-full rounded-[10px]" /><Skeleton className="mt-2 h-11 w-full rounded-[4px]" /></div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-3" data-studio-region="desktop-command-bar">
          <Skeleton className="h-8 w-8 rounded-[8px]" />
          <div className="h-6 w-px bg-[var(--border-subtle)]" />
          {perspective === 'work' ? <div className="flex min-w-0 gap-4" data-studio-command-menus>{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-3 w-6" />)}</div> : <div><Skeleton className="h-3.5 w-32" /><Skeleton className="mt-1 h-2.5 w-20" /></div>}
          <div className="ml-auto flex gap-2">
            {perspective === 'ide' ? <>
            <Skeleton className="h-9 w-24 rounded-[4px]" />
            <Skeleton className="h-9 w-20 rounded-[4px]" />
            <Skeleton className="h-9 w-9 rounded-[4px]" />
            </> : null}
            <Skeleton className="h-9 w-24 rounded-[4px]" />
          </div>
        </div>

        {perspective === 'ide' ? (
          <div
            className="grid min-h-0 flex-1 overflow-hidden border-y border-[var(--border-subtle)] bg-[var(--surface-default)]"
            data-studio-skeleton="ide"
            style={{ gridTemplateColumns: 'minmax(0, 280px) minmax(0, 1fr) minmax(0, 320px)' }}
          >
            <div className="flex min-h-0 overflow-hidden border-r border-[var(--border-subtle)]">
              <nav className="flex w-[46px] shrink-0 flex-col items-center border-r border-[var(--border-subtle)] py-2" aria-label="IDE 工作区导航">
                <Skeleton className="mb-3 h-8 w-8 rounded-[8px]" />
                <div className="h-px w-5 bg-[var(--border-subtle)]" />
                <div className="mt-2 flex flex-col gap-1">
                  {studioSkeletonInspectorTabs.map((tab) => (
                    <Skeleton key={tab} className="h-9 w-9 rounded-[8px]" />
                  ))}
                </div>
              </nav>
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
            <div className="min-h-0 overflow-hidden bg-[var(--surface-default)] p-4">
              <div className="space-y-3">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-10/12" />
                <Skeleton className="h-4 w-full" />
              </div>
            </div>
            <div className="min-h-0 overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--surface-default)] p-3">
              <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] pb-3">
                <Skeleton className="h-5 w-5 rounded-full" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="ml-auto h-3 w-8" />
              </div>
              <div className="space-y-3 py-3">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="ml-auto h-3.5 w-2/5" />
              </div>
            </div>
          </div>
        ) : (
        <div className="studio-skeleton-work flex min-h-0 flex-1 overflow-hidden">
          <main className="flex min-w-0 flex-1 justify-center overflow-hidden" data-studio-region="desktop-conversation">
            <div className="agent-conversation-width flex h-full min-h-0 flex-col px-4">
              <div className="flex h-[58px] shrink-0 items-center gap-3 border-b border-[var(--border-subtle)]">
                <Skeleton className="h-6 w-6 rounded-full" />
                <Skeleton className="h-4 w-36" />
                <Skeleton className="ml-auto h-7 w-7 rounded-[8px]" />
                <Skeleton className="h-7 w-7 rounded-[8px]" />
              </div>

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

          <StudioActivityDockSkeleton />
          <aside className="flex w-[46px] shrink-0 flex-col items-center border-l border-[var(--border-subtle)] py-2" data-studio-region="desktop-inspector-rail">
            <Skeleton className="h-8 w-8 rounded-[8px]" />
            <div className="my-3 h-px w-5 shrink-0 bg-[var(--border-subtle)]" />
            {studioSkeletonInspectorTabs.map((tab) => (
              <span key={tab} className="contents" data-studio-inspector-tab={tab} data-studio-skeleton-skill-entry={tab === 'skills' || undefined}>
                <Skeleton className="mb-1 h-5 w-5 rounded-[6px]" />
              </span>
            ))}
          </aside>
        </div>
        )}
        </div>
      </div>
    </div>
  )
}

/** 设置页骨架屏：分区卡片轮廓 */
export function SettingsSkeleton() {
  return (
    <div className="space-y-4 md:space-y-6" aria-busy="true" aria-label="设置加载中">
      <Skeleton className="h-[140px] w-full rounded-[var(--radius-xl)]" />
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="space-y-3 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-5">
          <Skeleton className="h-5 w-28" />
          <SkeletonText lines={2} />
          <Skeleton className="h-10 w-full rounded-[var(--radius-lg)]" />
        </div>
      ))}
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
    <div className="space-y-6" aria-busy="true" aria-label="作者主页加载中">
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

/** 发现页骨架屏：标题区 + 筛选 chips + 精选双卡 + 右侧榜单列 */
export function DiscoverSkeleton() {
  return (
    <div className="space-y-4 md:space-y-6" aria-busy="true" aria-label="分类发现加载中">
      <section className="rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-4 sm:p-5 lg:p-6">
        <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1.08fr)_272px] xl:grid-cols-[minmax(0,1.18fr)_320px]">
          <div className="space-y-5">
            <div className="space-y-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-8 w-4/5 max-w-md" />
              <SkeletonText lines={2} className="max-w-2xl" />
            </div>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-9 w-20 rounded-[var(--radius-pill)]" />
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {Array.from({ length: 2 }).map((_, index) => (
                <div
                  key={index}
                  className="grid gap-4 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-4 sm:grid-cols-[88px_minmax(0,1fr)]"
                >
                  <Skeleton className="aspect-[3/4] w-full rounded-[var(--radius-lg)]" />
                  <div className="space-y-3 py-1">
                    <Skeleton className="h-4 w-3/5" />
                    <SkeletonText lines={3} />
                    <div className="flex gap-2 pt-1">
                      <Skeleton className="h-10 w-24 rounded-[var(--radius-pill)]" />
                      <Skeleton className="h-10 w-16 rounded-[var(--radius-pill)]" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="grid gap-4">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="space-y-3 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] p-4">
                <Skeleton className="h-4 w-20" />
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: 5 }).map((_, chipIndex) => (
                    <Skeleton key={chipIndex} className="h-8 w-16 rounded-[var(--radius-pill)]" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <SkeletonNovelCard key={index} />
        ))}
      </div>
    </div>
  )
}
