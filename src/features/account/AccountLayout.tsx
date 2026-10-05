import { useQuery } from '@tanstack/react-query'
import { ChevronDown, CircleGauge, LogOut, Newspaper, PanelLeftClose, PanelLeftOpen, PenLine, ReceiptText, Settings2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { requestJson } from '@/app/api-client'
import AppImage from '@/components/ui/AppImage'
import Avatar from '@/features/community/components/Avatar'
import { useToast } from '@/components/ui/toast-context'
import FeedbackDialog from '@/features/feedback/components/FeedbackDialog'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import { FEEDBACK_QQ_GROUP_URL, type FeedbackKind } from '../../../shared/contracts'
import { fetchReferral, fetchPublicCreditPolicy } from './credits-api'
import InviteCreditsDialog from './InviteCreditsDialog'

export type AccountNavId = 'profile' | 'usage' | 'posts' | 'billing'

type Props = {
  active?: AccountNavId
  /** 价格/文档等独立页面不挂账户侧栏 */
  withSidebar?: boolean
  children: ReactNode
}

/** 悬停卡片条目：站内路由 / 外链 / 邀请弹窗 / 反馈弹窗四种落点 */
type NavCardItem = { title: string; desc: string } & (
  | { to: string }
  | { external: string }
  | { action: 'invite' }
  | { action: 'feedback'; kind: FeedbackKind }
)

/** 顶栏悬停卡片：对照参考站导航，把站内入口按意图分组 */
const NAV_CARDS: { id: string; label: string; items: NavCardItem[] }[] = [
  {
    id: 'product',
    label: '产品',
    items: [
      { title: '创作中心', desc: '从灵感整理到章节成稿与 AI 封面', to: '/studio' },
      { title: '阅读与发现', desc: '分类、书单与编辑推荐，找到下一本', to: '/discover' },
      { title: '社区', desc: '创作动态、读后讨论与作品话题', to: '/community' },
      { title: '榜单', desc: '看看大家都在读什么', to: '/rankings' },
    ],
  },
  {
    id: 'partner',
    label: '合作',
    items: [
      { title: '邀请计划', desc: '邀请好友注册，获得长期有效的 Credits', action: 'invite' },
      { title: '商业合作', desc: '内容授权、品牌联动等商务洽谈入口', external: FEEDBACK_QQ_GROUP_URL },
      { title: '反馈与建议', desc: '把使用感受与产品建议直接告诉我们', action: 'feedback', kind: 'suggestion' },
    ],
  },
  {
    id: 'pricing',
    label: '价格',
    items: [
      { title: '公测版 · ¥0 / 月', desc: '注册即开通，含每日额度与完整 Agent 能力', to: '/account/plan' },
      { title: '查看价格页', desc: '当前套餐权益与后续套餐规划说明', to: '/account/plan' },
    ],
  },
  {
    id: 'help',
    label: '帮助',
    items: [
      { title: '文档', desc: '了解如何使用启创墨域', to: '/account/docs' },
      { title: '常见问题', desc: '获取常见问题的清晰解答', to: '/account/docs?doc=faq' },
      { title: '更新日志', desc: '了解最新功能发布与改进', to: '/account/docs?doc=changelog' },
      { title: '问题反馈', desc: '遇到异常？带上截图直接提交', action: 'feedback', kind: 'bug' },
    ],
  },
]

const SIDEBAR_NAV: { id: AccountNavId; label: string; href: string; icon: typeof UserRound }[] = [
  { id: 'profile', label: '个人信息', href: '/account/profile', icon: UserRound },
  { id: 'usage', label: '用量明细', href: '/account/usage', icon: CircleGauge },
  { id: 'posts', label: '我的发布', href: '/account/posts', icon: Newspaper },
  { id: 'billing', label: '我的账单', href: '/account/billing', icon: ReceiptText },
]

const SIDEBAR_COLLAPSE_KEY = 'chevoink:account-sidebar-collapsed'

const menuItemClass =
  'flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[#f4f4f2] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]'

export default function AccountLayout({ active, withSidebar = true, children }: Props) {
  const toast = useToast()
  const policy = useQuery({ queryKey: ['credits', 'public-policy'], queryFn: fetchPublicCreditPolicy, staleTime: 20_000, refetchInterval: 60_000 })
  const planLabel = policy.data?.planLabel ?? '—'
  const navCards = NAV_CARDS.map(card => card.id === 'pricing' ? { ...card, items: card.items.map((item, index) => index === 0 ? { ...item, title: `${planLabel} · ¥0 / 月`, desc: policy.data?.publicBetaEnabled ? '注册即开通，含每日额度与完整 Agent 能力' : '完整 Agent 能力' } : item) } : card)
  const user = useShellStore((state) => state.sessionUser)
  const setGuest = useShellStore((state) => state.setGuest)
  const navigate = useNavigate()

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind | null>(null)
  const referralQuery = useQuery({ queryKey: ['credits', 'referral'], queryFn: fetchReferral, staleTime: 60_000 })

  useEffect(() => { if (!inviteOpen) setCopied(false) }, [inviteOpen])
  const copyInviteLink = useCallback(async () => {
    const url = referralQuery.data?.inviteUrl
    if (!url || !navigator.clipboard) return
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }, [referralQuery.data?.inviteUrl])
  const openInvite = useCallback(() => {
    setInviteOpen(true)
    if (referralQuery.data?.inviteUrl && navigator.clipboard) void navigator.clipboard.writeText(referralQuery.data.inviteUrl).then(() => setCopied(true)).catch(() => undefined)
  }, [referralQuery.data?.inviteUrl])

  function toggleCollapsed() {
    setCollapsed((current) => {
      localStorage.setItem(SIDEBAR_COLLAPSE_KEY, current ? '0' : '1')
      return !current
    })
  }

  async function handleLogout() {
    try {
      await requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
    } catch {
      toast.error('暂时无法确认退出登录，请稍后重试。')
      return
    }
    setGuest()
    navigate('/login', { replace: true })
  }

  function renderCardItem(item: NavCardItem) {
    const body = (
      <>
        <span className="block text-sm font-medium">{item.title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-[var(--text-tertiary)]">{item.desc}</span>
      </>
    )
    const itemClass = 'block w-full rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-[#f4f4f2] dark:hover:bg-[var(--surface-muted)]'
    if ('to' in item) return <Link key={item.title} to={item.to} className={itemClass}>{body}</Link>
    if ('external' in item) {
      return (
        <a key={item.title} href={item.external} target="_blank" rel="noopener,noreferrer" className={itemClass}>
          {body}
        </a>
      )
    }
    if (item.action === 'invite') {
      return <button key={item.title} type="button" onClick={() => openInvite()} className={itemClass}>{body}</button>
    }
    return <button key={item.title} type="button" onClick={() => setFeedbackKind(item.kind)} className={itemClass}>{body}</button>
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain bg-[#f6f6f4] text-[var(--text-primary)] [scrollbar-gutter:stable] dark:bg-[var(--app-bg)]">
      {/* 注意：Tailwind v3 不支持 var() 颜色加 alpha 修饰符（类不生成），深色顶栏必须用实底变量 */}
      <header className="sticky top-0 z-40 border-b border-[#e8e8e5] bg-[#f6f6f4]/95 backdrop-blur-xl dark:border-[var(--border-subtle)] dark:bg-[var(--app-bg)]">
        <div className="flex h-16 items-center gap-1 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 pr-3">
            <AppImage src="/chevoink-agent.png" alt="" className="h-8 w-8 rounded-[9px]" />
            <span className="text-base font-semibold tracking-tight">Chevoink</span>
          </Link>
          <nav className="hidden items-center md:flex">
            {navCards.map((card) => (
              <div key={card.id} className="group relative">
                <button
                  type="button"
                  className="flex h-16 items-center gap-1 px-3 text-[15px] text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]"
                >
                  {card.label}
                  <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-hover:rotate-180" />
                </button>
                <div className="pointer-events-none absolute left-0 top-full z-50 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
                  <div className="w-[300px] rounded-[14px] border border-[#e7e7e4] bg-white p-1.5 shadow-[0_16px_40px_rgba(23,27,36,0.12)] dark:border-[var(--border-strong)] dark:bg-[var(--surface-elevated)] dark:shadow-[0_16px_40px_rgba(0,0,0,0.55)]">
                    {card.items.map((item) => renderCardItem(item))}
                  </div>
                </div>
              </div>
            ))}
          </nav>
          <div className="group relative ml-auto">
            <button type="button" className="flex h-16 items-center px-1" aria-label="账户菜单">
              <Avatar name={user?.nickname ?? '创作者'} src={user?.avatarUrl} size="sm" className="h-8 w-8" />
            </button>
            <div className="pointer-events-none absolute right-0 top-full z-50 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
              <div className="w-[252px] rounded-[14px] border border-[#e7e7e4] bg-white p-1.5 shadow-[0_16px_40px_rgba(23,27,36,0.12)] dark:border-[var(--border-strong)] dark:bg-[var(--surface-elevated)] dark:shadow-[0_16px_40px_rgba(0,0,0,0.55)]">
                <div className="rounded-[10px] bg-[#f4f4f2] px-3 py-2.5 dark:bg-[var(--surface-muted)]">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <span className="truncate">{user?.nickname ?? '创作者'}</span>
                    <span className="shrink-0 rounded-full bg-emerald-600/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">{planLabel}</span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">{user?.email ?? user?.phone ?? '启创墨域账户'}</p>
                </div>
                <div className="my-1 h-px bg-[#ececea] dark:bg-[var(--border-subtle)]" />
                <Link to="/" className={menuItemClass}>
                  Chevoink 网页版
                  <PenLine className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                </Link>
                <Link to="/account/profile" className={menuItemClass}>
                  个人设置
                  <Settings2 className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                </Link>
                <div className="my-1 h-px bg-[#ececea] dark:bg-[var(--border-subtle)]" />
                <button type="button" onClick={() => void handleLogout()} className={cn(menuItemClass, 'w-full hover:text-[var(--color-error)]')}>
                  退出
                  <LogOut className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>
      <div className="flex min-h-[calc(100%-4rem)] items-stretch">
        {withSidebar ? (
          <aside className={cn('hidden shrink-0 border-r border-[#e8e8e5] transition-[width] duration-200 lg:block dark:border-[var(--border-subtle)]', collapsed ? 'w-[64px]' : 'w-[264px]')}>
            <div className={cn('sticky top-16 py-6', collapsed ? 'px-2' : 'px-4')}>
              {collapsed ? (
                <>
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={toggleCollapsed}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--text-tertiary)] transition-colors hover:bg-[#f1f1ef] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]"
                      aria-label="展开侧栏"
                      title="展开侧栏"
                    >
                      <PanelLeftOpen className="h-4 w-4" />
                    </button>
                  </div>
                  <nav className="mt-5 space-y-1">
                  {SIDEBAR_NAV.map(({ id, label, href, icon: Icon }) => (
                    <Link
                      key={id}
                      to={href}
                      title={label}
                      className={cn(
                        'flex h-10 items-center justify-center rounded-[10px] transition-colors',
                        active === id
                          ? 'bg-[#ececea] text-[var(--text-primary)] dark:bg-[var(--surface-muted)]'
                          : 'text-[var(--text-secondary)] hover:bg-[#f1f1ef] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </Link>
                  ))}
                  </nav>
                </>
              ) : (
                <>
                  {/* 用户信息置顶：头像 + 昵称 + 套餐徽标 + 邮箱，对照参考站侧栏头部 */}
                  <div className="flex items-start justify-between gap-2 px-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={user?.nickname ?? '创作者'} src={user?.avatarUrl} size="sm" className="h-10 w-10 shrink-0" />
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-[15px] font-semibold">
                          <span className="truncate">{user?.nickname ?? '创作者'}</span>
                          <span className="shrink-0 rounded-full bg-emerald-600/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">{planLabel}</span>
                        </p>
                        <p className="mt-0.5 truncate text-[13px] text-[var(--text-tertiary)]">{user?.email ?? user?.phone ?? '启创墨域账户'}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={toggleCollapsed}
                      className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--text-tertiary)] transition-colors hover:bg-[#f1f1ef] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]"
                      aria-label="折叠侧栏"
                      title="折叠侧栏"
                    >
                      <PanelLeftClose className="h-4 w-4" />
                    </button>
                  </div>
                  <nav className="mt-7 space-y-1">
                    {SIDEBAR_NAV.map(({ id, label, href, icon: Icon }) => (
                      <Link
                        key={id}
                        to={href}
                        className={cn(
                          'flex h-10 items-center gap-2.5 rounded-[10px] px-3 text-sm transition-colors',
                          active === id
                            ? 'bg-[#ececea] font-medium text-[var(--text-primary)] dark:bg-[var(--surface-muted)]'
                            : 'text-[var(--text-secondary)] hover:bg-[#f1f1ef] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        {label}
                      </Link>
                    ))}
                  </nav>
                </>
              )}
            </div>
          </aside>
        ) : null}
        <main className="min-w-0 flex-1">
          {withSidebar ? (
            <div className="flex gap-1 overflow-x-auto border-b border-[#e8e8e5] px-4 py-2 lg:hidden dark:border-[var(--border-subtle)]">
              {SIDEBAR_NAV.map(({ id, label, href }) => (
                <Link
                  key={id}
                  to={href}
                  className={cn(
                    'shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors',
                    active === id
                      ? 'bg-[#ececea] font-medium text-[var(--text-primary)] dark:bg-[var(--surface-muted)]'
                      : 'text-[var(--text-secondary)] hover:bg-[#f1f1ef] dark:hover:bg-[var(--surface-muted)]',
                  )}
                >
                  {label}
                </Link>
              ))}
            </div>
          ) : null}
          {children}
        </main>
      </div>
      <InviteCreditsDialog
        open={inviteOpen}
        referral={referralQuery.data ?? null}
        copied={copied}
        onCopy={() => void copyInviteLink()}
        onClose={() => setInviteOpen(false)}
      />
      <FeedbackDialog open={feedbackKind !== null} kind={feedbackKind ?? 'suggestion'} source="account" onClose={() => setFeedbackKind(null)} />
    </div>
  )
}
