import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { Inbox, Mail, ScanSearch, Shield } from 'lucide-react'
import GovernanceMailStatus from '../GovernanceMailStatus'
import GovernanceReconciliation from '../GovernanceReconciliation'
import { GovernanceInbox } from './GovernanceInbox'
import { GovernanceRestrictionsView } from './GovernanceRestrictionsView'
import { GovernanceSafetyView } from './GovernanceSafetyView'
import GovernanceSummary from './GovernanceSummary'

const sections = [
  { id: 'inbox', path: '/admin/governance', label: '案件处理', icon: Inbox },
  { id: 'risk', path: '/admin/governance/safety', label: '风险核查', icon: ScanSearch },
  { id: 'restrictions', path: '/admin/governance/restrictions', label: '账号限制', icon: Shield },
  { id: 'mail', path: '/admin/governance/mail', label: '通知投递', icon: Mail },
] as const
const groups: Record<string, typeof sections[number]['id']> = {
  inbox: 'inbox', reports: 'inbox', appeals: 'inbox', usage: 'inbox', safety: 'risk', reconciliation: 'risk', restrictions: 'restrictions', mail: 'mail',
}
export default function AdminGovernance() {
  const { section = 'inbox' } = useParams()
  const [params] = useSearchParams()
  const location = useLocation()
  const group = groups[section]
  if (!group) return <Navigate replace to="/admin/governance"/>
  return <div className="space-y-5 text-sm">
    <header><h1 className="text-2xl font-semibold tracking-tight">治理工作台</h1></header>
    <GovernanceSummary/>
    <nav aria-label="治理工作区" className="grid grid-cols-4 border-b border-[var(--border-default)] sm:flex sm:gap-x-2">
      {sections.map(({ id, path, label, icon: Icon }) => <Link key={id} to={path} aria-current={group === id ? 'page' : undefined}
        className={'inline-flex min-h-11 flex-col items-center justify-center gap-1 border-b-2 py-2 text-xs sm:flex-row sm:gap-2 sm:px-4 sm:text-sm ' + (group === id ? 'border-[var(--color-brand)] font-semibold text-[var(--color-brand)]' : 'border-transparent text-[var(--text-secondary)]')}>
        <Icon size={16} aria-hidden="true"/>{label}</Link>)}
    </nav>
    {group === 'inbox' && <GovernanceInbox kind={section === 'reports' ? 'report' : section === 'appeals' ? 'appeal' : section === 'usage' ? 'usage' : undefined}/>}
    {group === 'risk' && <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><nav aria-label="核查类型" className="flex gap-2">
        {([['safety','Agent 安全事件'],['reconciliation','云枢对账']] as const).map(([path,label]) => <Link key={path} to={'/admin/governance/'+path}
          aria-current={section === path ? 'page' : undefined} className={'rounded-full px-3 py-2 ' + (section === path ? 'bg-[var(--surface-muted)] font-semibold' : '')}>{label}</Link>)}</nav>
        <Link className="underline" to="/admin/governance/usage">处理异常使用案件</Link>
      </div>{section === 'safety' ? <GovernanceSafetyView/> : <GovernanceReconciliation/>}</div>}
    {group === 'restrictions' && <GovernanceRestrictionsView key={location.search} userId={params.get('userId') ?? undefined}
      sourceId={params.get('sourceId') ?? undefined} initialReason={location.state?.reason}/>}
    {group === 'mail' && <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5">
      <GovernanceMailStatus/><Link className="mt-4 inline-flex underline" to="/admin/email?tab=library">查看定向邮件模板库</Link></div>}
  </div>
}
