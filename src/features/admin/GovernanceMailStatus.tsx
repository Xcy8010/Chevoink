import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'

const labels:Record<string,string>={pending:'待发送',delivered:'已投递',accepted:'供应商已接受',deferred:'延迟投递',unknown:'结果待核',rejected:'发送失败',bounced:'退信',unconfigured:'发送未启用',unavailable:'无已验证邮箱',suppressed:'已抑制'}
export default function GovernanceMailStatus(){
  const status=useQuery({queryKey:['governance','mail-status'],queryFn:({signal})=>requestJson<{items:{state:string;mode:string|null;count:number}[];expiring:number}>('/api/admin/governance/mail-status',{signal}),retry:false})
  return <section className="space-y-2" aria-label="事务通知"><h2 className="font-semibold">事务通知</h2>
    {status.data ? <><p>24 小时内到期的限制 {status.data.expiring} 项</p>{status.data.items.length?<ul className="flex flex-wrap gap-x-4">{status.data.items.map(r=><li key={r.state+'-'+r.mode}>{r.mode==='mock'?'模拟 · ':''}{labels[r.state]??r.state} {r.count}</li>)}</ul>:<p>暂无治理邮件记录。</p>}</>:status.isError?<button onClick={()=>void status.refetch()}>读取失败，重试</button>:<p>正在读取…</p>}
  </section>
}
