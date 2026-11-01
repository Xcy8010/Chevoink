import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { AdminCard, AdminPanelState, StatusPill } from '../AdminLayout'
import type { AdminIntegrationClient, AdminIntegrationExportRequest, AdminIntegrationReadRequest, AdminIntegrationResource, AdminIntegrationStatusPayload } from '../../../../shared/contracts/admin-integrations.js'

const LABELS: Record<AdminIntegrationResource, string> = { model_metadata: '云枢模型资料', usage: '云枢用量观测', gateway_charges: '云枢扣款', gateway_health: '云枢范围性能参考' }
const METRICS: Record<string, string> = { calls: '网关请求样本', prompt_tokens: '已观测输入 Token', completion_tokens: '已观测输出 Token', cache_tokens: '缓存 Token', success: '网关已知成功', failure: '网关已知失败', unknown: '网关未知结果', gateway_deduction: '网关记录扣款', gateway_refund: '网关记录退款' }
const STATES = { blocked: '依赖未就绪', not_loaded: '尚未读取', ready: '已取得只读快照', stale: '快照已过期 / 待读取核对', failed: '读取失败' }
const MAPPING_STATES = { unmapped: '未映射', unverified: '映射未核实', verified: '已核映射', stale: '本地版本已变化', conflict: '映射冲突', not_observed: '当前读取范围未观测' }
const DEFAULT_CLIENT: AdminIntegrationClient = {
  status: () => requestJson<AdminIntegrationStatusPayload>('/api/admin/integrations/status'),
  read: request => requestJson('/api/admin/integrations/read', { method: 'POST', body: JSON.stringify(request) }),
}
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知 / 尚未取得'

/** Embedded in cost/balance content; mounting reads local status only, never the gateway. */
export default function AdminIntegrationStatus({ client = DEFAULT_CLIENT, window: selectedWindow, onExport }: {
  client?: AdminIntegrationClient
  window?: AdminIntegrationReadRequest['window']
  onExport?: (request: AdminIntegrationExportRequest) => Promise<void>
}) {
  const [resource, setResource] = useState<AdminIntegrationResource>('gateway_charges')
  const [columns, setColumns] = useState<AdminIntegrationExportRequest['columns']>([])
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(false)
  const query = useQuery({ queryKey: ['admin','integrations','status'], queryFn: client.status, retry: false })
  const mutation = useMutation({ mutationFn: (request: AdminIntegrationReadRequest) => client.read(request), retry: false, onSuccess: async () => { await query.refetch() } })
  const data = query.data
  const current = data?.resources.find(item => item.resource === resource)
  const snapshot = current?.snapshot
  const exportable = resource !== 'model_metadata' && Boolean(snapshot?.aggregates.length)
  const exportSelected = async () => {
    if (!onExport || !columns.length || resource === 'model_metadata' || exporting) return
    setExporting(true); setExportError(false)
    try { await onExport({ resource, columns }) } catch { setExportError(true) } finally { setExporting(false) }
  }
  return <AdminCard className="mb-4 min-w-0"><section aria-label="云枢只读集成状态">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">云枢只读观测与对账</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">墨域本地业务账为主；外部记录不与本地用量相加，不覆盖 Credits、费率或历史快照。</p></div><Button disabled={query.isFetching} onClick={() => void query.refetch()}>刷新集成状态</Button></div>
    <AdminPanelState state={query.isPending ? 'loading' : query.isError ? 'error' : 'ready'}>{data && current ? <div className="mt-4 space-y-4">
      <label className="block text-sm">观测来源<select aria-label="观测来源" className="mt-1 block min-h-11 max-w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3" value={resource} onChange={event => setResource(event.target.value as AdminIntegrationResource)}>{Object.entries(LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div className="flex flex-wrap items-center gap-3"><StatusPill tone={current.state === 'failed' ? 'danger' : 'neutral'}>{STATES[current.state]}</StatusPill><Button disabled={!current.canRead || !selectedWindow || mutation.isPending} aria-describedby="integration-blockers" onClick={() => { if (selectedWindow) mutation.mutate({ resource, window: selectedWindow }) }}>读取只读快照</Button></div>
      <div id="integration-blockers" className="text-sm text-[var(--text-secondary)]">{current.blockingReasons.length ? <ul className="list-inside list-disc space-y-2">{current.blockingReasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : !selectedWindow ? <p>尚未提供可核的统计期间，读取暂不可用。</p> : <p>仅读取已授权来源；不会修改模型、执行作者任务或覆盖本地账务。</p>}</div>
      {mutation.isError ? <p role="alert">读取结果尚未确认，请刷新集成状态核对；系统不会自动重试。</p> : null}
      {current.failureReason ? <p role="status">{current.failureReason}</p> : null}
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2"><div><dt className="text-[var(--text-secondary)]">最近成功读取（UTC+8）</dt><dd>{time(current.lastSuccessAt)}</dd></div><div><dt className="text-[var(--text-secondary)]">来源采样时间（UTC+8）</dt><dd>{time(snapshot?.observedAt ?? null)}</dd></div><div><dt className="text-[var(--text-secondary)]">来源范围</dt><dd>{snapshot?.scope.kind === 'chevoink_exclusive' ? '已核墨域专属来源' : snapshot?.scope.kind === 'gateway_wide' ? '全网关参考，可能包含其他应用' : '专属范围未知'}</dd></div><div><dt className="text-[var(--text-secondary)]">覆盖</dt><dd>{snapshot?.coverage === 'complete' ? '该读取范围完整' : snapshot?.coverage === 'partial' ? '部分覆盖' : '覆盖未知'}</dd></div></dl>
      {snapshot ? <><p className="text-sm text-[var(--text-secondary)]">期间 {time(snapshot.window.from)} — {time(snapshot.window.to)} · 分组 {snapshot.scope.group ?? '未知 / 未分组'} · 计价版本 {snapshot.pricingVersion ?? '未核定'} · 快照暂存于当前服务进程，重启后需重新读取。</p>{resource === 'model_metadata' ? <p className="text-sm">当前读取 {snapshot.models.length} 项模型资料，仅提供预览建议，不保证包含完整能力元数据。</p> : <ul className="divide-y divide-[var(--border-default)]">{snapshot.aggregates.map((item,index) => <li key={`${item.metric}:${item.unit}:${index}`} className="flex flex-wrap justify-between gap-3 py-3 text-sm"><span>{METRICS[item.metric]}</span><span>{item.value ?? '未核定'} {item.unit}</span></li>)}</ul>}</> : <p className="text-sm">尚无可信外部快照。云枢扣款、退款与供应商余额均未核定，不补零、不推断免费。</p>}
      <details><summary className="min-h-11 cursor-pointer py-3 text-sm">映射与对账边界</summary><p className="text-sm text-[var(--text-secondary)]">仅接受本地配置 ID 与版本的显式映射；同名模型可以对应多个写作档位，不能据此分配作者、任务或账务。网关成功不代表创作完成。</p>{data.mappings.length ? <ul className="mt-3 divide-y divide-[var(--border-default)]">{data.mappings.slice(0,20).map(item => <li key={item.localModelConfigId} className="py-3 text-sm"><p>{item.localDisplayName} · {MAPPING_STATES[item.state]}</p><p className="mt-1 break-all text-[var(--text-secondary)]">{item.localModelConfigId} / v{item.localRevision} → {item.gatewayModelId ?? '未指定'}</p>{item.suggestedLabel ? <p>来源建议名称：{item.suggestedLabel}（未应用）</p> : null}</li>)}</ul> : <p className="mt-3 text-sm">尚未取得可核本地映射。</p>}{data.mappings.length > 20 ? <p className="text-sm">这里只预览前 20 项；未批量应用任何建议。</p> : null}</details>
      {onExport && exportable ? <details><summary className="min-h-11 cursor-pointer py-3 text-sm">导出所选安全聚合列</summary><fieldset className="flex flex-wrap gap-3">{(['source','scope','from','to','observedAt','metric','value','unit'] as const).map(column => <label key={column} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={columns.includes(column)} onChange={event => setColumns(values => event.target.checked ? [...values,column] : values.filter(value => value !== column))} />{column}</label>)}</fieldset><p className="my-3 text-sm text-[var(--text-secondary)]">仅导出当前快照聚合，不包含正文、用户资料、密钥或原始调用日志。</p><Button disabled={!columns.length || exporting} onClick={() => void exportSelected()}>{exporting ? '导出中…' : '导出已选聚合列'}</Button>{exportError ? <p role="alert">导出失败，所选列已保留。</p> : null}</details> : null}
      <details><summary className="min-h-11 cursor-pointer py-3 text-sm">独立能力与待接入项</summary><p className="text-sm">{data.system.applicationName} · 公开运行版本：{data.system.releaseVersion ?? '未取得'}</p><ul className="mt-3 list-inside list-disc space-y-2 text-sm text-[var(--text-secondary)]">{data.deferred.map(item => <li key={item.area}>{item.reason}</li>)}</ul></details>
    </div> : null}</AdminPanelState>
  </section></AdminCard>
}
