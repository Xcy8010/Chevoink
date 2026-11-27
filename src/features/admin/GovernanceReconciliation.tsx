import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import type { GovernanceReconciliation as Payload } from '../../../shared/contracts/governance-reconciliation'

const labels = { unknown:'待核实',matched:'已匹配',pending:'待结算',provider_error:'供应商异常',refunded:'合法退款',difference:'账本差异' }
export default function GovernanceReconciliation() {
  const [page,setPage] = useState(1)
  const [filter,setFilter] = useState('')
  const query = useQuery({queryKey:['governance-reconciliation',page,filter],queryFn:({signal})=>requestJson<Payload>('/api/admin/governance/reconciliation?page='+page+filter,{signal}),retry:false})
  const data = query.data
  return <section aria-label="异常使用与对账" className="space-y-3">
    <h2 className="font-semibold">云枢三方对账</h2>
    <p className="text-sm">近一个月的平台令牌记录，覆盖范围有限。待核实记录由管理员查证。</p>
    <form className="flex flex-wrap gap-2" onSubmit={e=>{
      e.preventDefault()
      const form = new FormData(e.currentTarget)
      const params = new URLSearchParams()
      for (const key of ['userId','actionId']) { const value=String(form.get(key)??'').trim(); if(value) params.set(key,value) }
      setFilter(params.size?'&'+params.toString():''); setPage(1)
    }}><label>用户 ID <input name="userId" maxLength={64} className="border rounded p-1"/></label><label>业务 ID <input name="actionId" maxLength={64} className="border rounded p-1"/></label><button type="submit">查询</button></form>
    {query.isPending && <p role="status">正在读取…</p>}
    {query.isError && <button onClick={()=>void query.refetch()}>读取失败，重试</button>}
    {data && <><p role="status">{data.message}</p>{!data.rows.length && !data.fixedFees.length && <p>当前页没有可核对的记录。</p>}
    <ul className="divide-y">{data.rows.map((r,i)=><li key={i} className="space-y-1 py-3 text-sm">
      <strong>{labels[r.state]}</strong> · {new Date(r.observedAt).toLocaleString('zh-CN')}<p>{r.reason}</p>
      <p className="break-all">请求 {r.upstreamId ?? '未知'}{r.userId && ' · 用户 '+r.userId}{r.actionId && ' · 业务 '+r.actionId}</p>
      {r.goal && <p>目标 {r.goal.goalId} · 已记 {r.goal.creditsMicros} 微 Credits · 预留 {r.goal.reservedTokens} tokens</p>}
      {r.chargedMilli !== null && <p>实扣 {r.chargedMilli/1000} Credits{r.expectedMilli!==null && ' · 历史应扣 '+r.expectedMilli/1000}{r.refundMilli!==null && ' · 退款 '+r.refundMilli/1000}</p>}
    </li>)}</ul>
    {data.fixedFees.length > 0 && <section aria-label="固定费用"><h3>固定费用</h3><ul className="divide-y">{data.fixedFees.map(fee => <li key={fee.id} className="py-2 text-sm break-all">
      <strong>{{ image_generation: '图片生成', web_search: '联网搜索', web_fetch: '网页读取' }[fee.sourceType] ?? fee.sourceType}</strong> · 账本 {fee.id}
      <p>实扣 {fee.chargedMilli / 1000} Credits · 历史应扣 {fee.expectedMilli === null ? '待核实' : fee.expectedMilli / 1000}</p>
      {fee.refundPending && <p>退款待结算</p>}{fee.refundMilli !== null && <p>已退款 {fee.refundMilli / 1000} Credits</p>}
      {fee.goal && <p>目标 {fee.goal.goalId} · 已记 {fee.goal.creditsMicros} 微 Credits</p>}
    </li>)}</ul></section>}<div className="flex gap-4"><button disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</button><button disabled={!data.hasMore} onClick={()=>setPage(page+1)}>下一页</button></div></>}
  </section>
}
