import { ChevronLeft, LogOut, Menu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNativeSystemSurface } from '@/lib/useNativeSystemSurface'
import type { MobileView } from '../types'

type Props = {
  view: MobileView
  navigationOpen: boolean
  onOpenNavigation: () => void
  onSelectView: (view: 'assistant' | 'editor' | 'chapters') => void
  onBack: () => void
  onExit: () => void
}

const titles = {
  chapters: '卷章', cover: '封面工坊', meta: '作品设置', memory: '小说关系网', context: '记忆', skills: '作品技能',
} as const

export default function StudioMobileHeader({ view, navigationOpen, onOpenNavigation, onSelectView, onBack, onExit }: Props) {
  const systemSurfaceRef = useNativeSystemSurface<HTMLElement>()
  const primary = view === 'assistant' || view === 'editor'
  const buttonClass = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] active:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-primary)] motion-reduce:transition-none'
  return (
    <header ref={systemSurfaceRef} data-studio-region="mobile-header" className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--app-bg)] pl-[max(8px,var(--safe-left,0px))] pr-[max(8px,var(--safe-right,0px))] pt-[var(--safe-top,0px)]">
      <div className="grid h-14 grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
        {primary ? (
          <button type="button" data-studio-mobile-primary-control aria-label="打开创作区导航" aria-expanded={navigationOpen} aria-controls="studio-mobile-navigation" onClick={onOpenNavigation} className={buttonClass}>
            <Menu className="h-5 w-5" />
          </button>
        ) : (
          <button type="button" data-studio-mobile-primary-control aria-label="返回工作台" onClick={onBack} className={buttonClass}><ChevronLeft className="h-5 w-5" /></button>
        )}
        {primary ? (
          <nav aria-label="创作视图" className="flex h-full min-w-0 items-center justify-center gap-5">
            {([{ key: 'assistant', label: '工作台' }, { key: 'editor', label: '写作' }] as const).map(({ key, label }) => (
              <button key={key} type="button" aria-pressed={view === key} onClick={() => onSelectView(key)} className={cn('studio-mobile-view-tab relative h-full min-w-0 px-1 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] motion-reduce:transition-none', view === key ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]')}>{label}</button>
            ))}
          </nav>
        ) : <h1 className="min-w-0 truncate text-center text-sm font-semibold text-[var(--text-primary)]">{titles[view]}</h1>}
        <button type="button" aria-label="退出创作区" title="退出创作区" onClick={onExit} className={buttonClass}><LogOut className="h-5 w-5" /></button>
      </div>
    </header>
  )
}
