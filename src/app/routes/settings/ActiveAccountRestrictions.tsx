import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { requestJson } from '@/app/api-client'
import { restrictionLabels, type RestrictionScope } from '../../../../shared/contracts/governance-restrictions'
import { SectionTitle, SettingsGroup } from './settings-row'

export function ActiveAccountRestrictions({userId}:{userId:string}) {
  const query = useQuery({queryKey:['account-restrictions',userId], queryFn:()=>requestJson<{items:{
    id:string; scope:RestrictionScope; reason:string; clause:string; expiresAt:string|null
  }[]}>('/api/auth/governance-restrictions')})
  if (!query.data?.items.length) return null
  return <section><SectionTitle>当前账号限制</SectionTitle><SettingsGroup>
    {query.data.items.map(row=><div className="space-y-1 p-4 text-sm" key={row.id}>
      <strong>{restrictionLabels[row.scope]}</strong> · {row.expiresAt?'截至 '+new Date(row.expiresAt).toLocaleString():'永久'}
      <p>{row.reason}</p><p className="text-[var(--text-secondary)]">依据 {row.clause}</p>
    </div>)}<Link className="block p-4 text-sm underline" to="/appeal">提交申诉</Link>
  </SettingsGroup></section>
}
