import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, ArrowUpRight, Bell, BookOpen, Bot, CircleHelp, CircleUserRound, Crosshair, Ellipsis, Gift, Settings, UserRound } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { AnnouncementInboxControl } from '@/features/site-content/AnnouncementBell'
import { DesktopDestinationLinks } from '@/components/layout/DesktopNavigation'
import { formatCreditAmount } from '@/features/account/credit-format'
import Avatar from '@/features/community/components/Avatar'
import { useShellStore } from '@/store/useShellStore'
import { useStudioCredits } from '../hooks/useStudioCredits'
import { useAgentStore } from '../agent/agentStore'
import IdeNavigationRail, { type IdeRailProps } from './IdeNavigationRail'
import type { StudioSettingsSection } from './StudioSettingsDialog'
import { studioInert, useStudioPresence } from './use-studio-presence'
import './studio-desktop-shell.css'

type Props = {
  ide?: IdeRailProps
  onOpenSettings: (section: StudioSettingsSection, trigger: HTMLButtonElement | null) => void
  onInvite: () => void
  onReturnToWorkspace?: () => void
}

function RailCard({ open, alignTop = false, id, label, className, children }: {
  open: boolean; alignTop?: boolean; id: string; label: string; className: string; children: ReactNode
}) {
  const { rendered, phase } = useStudioPresence(open ? true : null)
  const card = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const popup = card.current
    const button = popup?.previousElementSibling
    if (!rendered || !popup || !button) return
    const position = () => {
      const anchor = button.getBoundingClientRect()
      const rail = button.closest('aside')!.getBoundingClientRect()
      const preferredTop = alignTop ? anchor.top : anchor.bottom - popup.offsetHeight
      const top = Math.max(rail.top + 4, Math.min(preferredTop, window.innerHeight - popup.offsetHeight - 8))
      popup.style.left = Math.min(rail.right + 3, window.innerWidth - popup.offsetWidth - 8) + 'px'
      popup.style.top = top + 'px'
      popup.style.setProperty('--studio-motion-origin', 'left ' + Math.max(0, Math.min(anchor.top + anchor.height / 2 - top, popup.offsetHeight)) + 'px')
    }
    position()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position)
    observer?.observe(popup)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [alignTop, rendered])

  return rendered ? <section ref={card} id={id} aria-label={label} className={'studio-rail-card ' + className}
    {...studioInert(!open)} data-studio-surface="menu" data-phase={phase}>{children}</section> : null
}

export default function StudioDesktopRail({ ide, onOpenSettings, onInvite, onReturnToWorkspace }: Props) {
  const user = useShellStore(state => state.sessionUser)
  const credits = useStudioCredits(60_000)
  const autoFollow = useAgentStore(state => state.autoFollow)
  const setAutoFollow = useAgentStore(state => state.setAutoFollow)
  const summary = credits.data
  const fraction = summary && summary.dailyAllowance > 0
    ? Math.min(1, Math.max(0, summary.dailyRemaining / summary.dailyAllowance)) : null
  const percent = fraction === null ? null : fraction === 1 ? 100 : Math.min(99, Math.round(fraction * 100))
  const balance = summary ? '可用 ' + formatCreditAmount(summary.totalRemaining) + ' Credits'
    : credits.isError ? '额度暂时无法读取' : '正在读取额度'
  const [panel, setPanel] = useState<'usage' | 'profile' | 'more' | 'settings' | null>(null)
  const [hint, setHint] = useState<HTMLElement | null>(null)
  const activeTrigger = useRef<HTMLButtonElement | null>(null)
  const cardId = useId()
  const hintId = useId()
  const name = user?.nickname ?? '创作者'

  useEffect(() => {
    if (!panel) return
    const card = document.getElementById(cardId + '-' + panel)
    const outside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !card?.contains(event.target) && !activeTrigger.current?.contains(event.target)) setPanel(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPanel(null)
      activeTrigger.current?.focus()
      setHint(null)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [panel, cardId])

  useEffect(() => {
    if (!hint || panel) return
    hint.setAttribute('aria-describedby', hintId)
    return () => hint.removeAttribute('aria-describedby')
  }, [hint, panel, hintId])

  function showHint(target: EventTarget | null) {
    const button = target instanceof Element ? target.closest<HTMLElement>('.studio-rail-button') : null
    setHint(button)
  }

  function toggle(next: NonNullable<typeof panel>, button: HTMLButtonElement) {
    activeTrigger.current = button
    setHint(null)
    setPanel(panel === next ? null : next)
  }

  function openSettings(section: StudioSettingsSection, trigger = activeTrigger.current) {
    setPanel(null)
    setHint(null)
    onOpenSettings(section, trigger)
  }

  const navigateFromRail = () => {
    setPanel(null)
    onReturnToWorkspace?.()
  }

  const hintBox = hint?.getBoundingClientRect()
  const creditHint = hint?.classList.contains('studio-credit-button')
  return <AnnouncementInboxControl placement="studio-rail">{inbox => <aside className="studio-desktop-rail" aria-label="创作区活动栏"
    onMouseOver={event => showHint(event.target)}
    onMouseOut={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setHint(null) }}
    onFocus={event => showHint(event.target)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHint(null) }}
    onKeyDown={event => {
      if (event.key === 'Escape' && hint && !panel) { event.preventDefault(); setHint(null) }
    }}>
    {hint && hintBox && !panel && <div id={hintId} role="tooltip" className="studio-rail-tip"
      style={{ left: hint.closest('aside')!.getBoundingClientRect().right + 3, top: hintBox.top + hintBox.height / 2 }}>
      {creditHint ? <>{percent !== null && <span>{summary?.publicBetaEnabled ? '每日' : '基础额度'}剩余 {percent}%</span>}<span>{balance}</span></> : hint.getAttribute('aria-label')}
    </div>}
    <nav className="studio-rail-navigation studio-rail-links" aria-label={ide ? 'Editor 工作区导航' : '桌面工作区导航'}>
      <DesktopDestinationLinks compact onSelect={navigateFromRail} />
      {ide && <IdeNavigationRail {...ide} onSelect={tab => { navigateFromRail(); ide.onSelect(tab) }}
        onToggle={() => { navigateFromRail(); ide.onToggle() }} />}
      <button type="button" className="studio-rail-button" aria-label="更多入口"
        aria-description={inbox.hasUnread ? '有未读站内通知' : undefined}
        aria-expanded={panel === 'more'} aria-controls={panel === 'more' ? cardId + '-more' : undefined}
        onClick={event => toggle('more', event.currentTarget)}><Ellipsis />
        {inbox.hasUnread && <span aria-hidden="true" className="studio-more-unread" />}
      </button>
      <RailCard open={panel === 'more'} alignTop id={cardId + '-more'} label="更多入口" className="studio-rail-menu">
        <button type="button" aria-haspopup="dialog" aria-description={inbox.hasUnread ? '有未读通知' : undefined}
          onClick={() => {
            if (!activeTrigger.current) return
            inbox.open(activeTrigger.current)
            setPanel(null)
            setHint(null)
          }}><Bell />站内通知{inbox.hasUnread && <span aria-hidden="true" className="studio-inbox-item-dot" />}</button>
        <button type="button" role="switch" aria-label="正文追踪" aria-checked={autoFollow}
          onClick={() => setAutoFollow(!autoFollow)}><Crosshair />正文追踪
          <span aria-hidden="true" className="ml-auto text-xs text-[var(--text-tertiary)]">{autoFollow ? '已开启' : '已关闭'}</span>
        </button>
        <NavLink to="/me" onClick={navigateFromRail}><BookOpen />个人书架</NavLink>
        <button type="button" onClick={() => openSettings('archives')}><Archive />归档内容</button>
        {ide && <><div className="studio-card-divider" /><IdeNavigationRail {...ide} more onSelect={tab => { navigateFromRail(); ide.onSelect(tab) }} /></>}
      </RailCard>
      <span aria-hidden="true" className="studio-rail-divider" />
      <button type="button" className="studio-rail-button" aria-label="Agent 与定时"
        onClick={event => openSettings('operations', event.currentTarget)}><Bot /></button>
      <button type="button" className="studio-rail-button" aria-label="设置"
        aria-expanded={panel === 'settings'} aria-controls={panel === 'settings' ? cardId + '-settings' : undefined}
        onClick={event => toggle('settings', event.currentTarget)}><Settings /></button>
      <RailCard open={panel === 'settings'} id={cardId + '-settings'} label="设置入口" className="studio-rail-menu">
        <button type="button" onClick={() => openSettings('general')}><Settings />创作区设置</button>
        <NavLink to="/settings" onClick={navigateFromRail}><UserRound />账号设置</NavLink>
      </RailCard>
    </nav>
    <div className="studio-rail-account">
      <button type="button" className="studio-rail-button studio-credit-button"
        aria-label="查看剩余额度" aria-expanded={panel === 'usage'} aria-controls={panel === 'usage' ? cardId + '-usage' : undefined}
        onClick={event => toggle('usage', event.currentTarget)}>
        <svg className="studio-credit-ring" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <path d="m14 10.5 3.5 3.5-3.5 3.5-3.5-3.5z" fill="currentColor" />
          <circle className="studio-ring-track" cx="14" cy="14" r="9.5" />
          {fraction !== null && fraction > 0 ? <circle className="studio-ring-value" cx="14" cy="14" r="9.5" pathLength="100" strokeDasharray={fraction < 1 ? String(fraction * 100) + ' 100' : undefined} transform="rotate(-90 14 14)" /> : null}
        </svg>
      </button>
      <RailCard open={panel === 'usage'} id={cardId + '-usage'} className="studio-credit-card" label="额度概览">
        <h2>额度来源{summary && ' · ' + summary.planLabel}</h2>
        {summary ? <dl className="studio-credit-details">
          <div><dt>每日额度</dt><dd>{percent === null ? '未开通' : '剩余 ' + percent + '%'}</dd></div>
          <div><dt>奖励额度</dt><dd>{formatCreditAmount(summary.bonusRemaining)} credits</dd></div>
        </dl> : <div className="studio-credit-details" role="status">{balance}
          {credits.isError && <button type="button" onClick={() => void credits.refetch()}>重试</button>}
        </div>}
        <button type="button" className="studio-card-action" onClick={() => openSettings('usage')}>管理用量</button>
      </RailCard>
      <button type="button" className="studio-rail-button studio-avatar-button"
        aria-label={'个人菜单，' + name} aria-expanded={panel === 'profile'} aria-controls={panel === 'profile' ? cardId + '-profile' : undefined}
        onClick={event => toggle('profile', event.currentTarget)}>
        <Avatar name={name} src={user?.avatarUrl} size="sm" className="h-7 w-7" />
      </button>
      <RailCard open={panel === 'profile'} id={cardId + '-profile'} className="studio-profile-card" label="个人菜单">
        <div className="studio-profile-identity"><Avatar name={name} src={user?.avatarUrl} size="sm" />
          <div><strong>{name}</strong>{user?.emailAuthEnabled && user.email && <span title={user.email}>{user.email}</span>}{summary && <small>{summary.planLabel}</small>}</div>
        </div>
        <button type="button" onClick={() => openSettings('personalization')}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9.5" /><path d="m11 7.5-2.5 5h3M12.5 16a5 5 0 0 0 4-3" />
          </svg>个性化
        </button>
        <button type="button" onClick={() => openSettings('profile')}><CircleUserRound />个人资料</button>
        <button type="button" onClick={() => openSettings('general')}><Settings />创作区设置</button>
        <div className="studio-card-divider" />
        <button type="button" onClick={() => { setPanel(null); onInvite() }}><Gift />邀请好友</button>
        <a href="/account/docs" target="_blank" rel="noopener noreferrer" onClick={() => setPanel(null)}><CircleHelp />帮助文档<ArrowUpRight /></a>
      </RailCard>
    </div>
  </aside>}</AnnouncementInboxControl>
}
