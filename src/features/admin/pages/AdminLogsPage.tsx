import { useQuery } from '@tanstack/react-query'
import TextInput from '../components/AdminTextInput'
import { listAdminAuditLogs } from '../api'
import { AdminCard, AdminPageHeader, AdminPager, AdminPanelState } from '../AdminLayout'
import { describeAdminAction, formatDateTime } from '../admin-shared'
import { useAdminQueryState } from '../admin-query-state'
import { useAdminNumberQuery } from './admin-page-query'

const TARGET_TYPE_LABELS: Record<string, string> = { aiModelConfig:'模型配置', creditSystem:'全局权益', creditAccount:'额度账户', user: '用户', novel: '作品', chapter: '章节', post: '帖子', comment: '评论', model: '模型', credits: 'Credits', corpusSource: '语料来源' }
const DETAIL_LABELS: Record<string, string> = { webToolProtocol:'网页工具协议',imageQuality:'生图质量',supportedValues:'支持值',defaultValue:'默认值',routes:'备用线路',weightedRoutes:'权重线路',contextWindowTokens:'上下文窗口',reasoningEfforts:'推理强度',visionEnabled:'图片理解',keyConfigured:'已配置密钥', reason: '原因', status: '状态', modelId: '模型 ID', modelTier: '档位', enabled: '启用', userIds: '用户 ID', count: '数量', stoppedRuns: '停止任务数', revision: '版本', provider: '渠道', previousRole: '原角色', role: '角色', field: '字段', before: '变更前', after: '变更后', changes: '差异', fromRevision: '原版本', toRevision: '新版本', keyReplaced: '密钥已替换', routeKeysReplaced: '替换密钥的线路', endpoint: '服务地址', origin: '地址来源', pathFingerprint: '路径指纹' }
function Detail({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>—</span>
  if (typeof value === 'object') return <dl className="space-y-2">{Object.entries(value).filter(([key]) => key !== 'previousVisibility' && (['requestTokens','responseTokens','totalTokens','contextWindowTokens','outputTokenParameter','apiKeyConfigured'].includes(key) || !/password|secret|token|credential|apiKey|content|body|prompt|message/i.test(key))).map(([key, item]) => <div key={key} className="grid min-w-0 grid-cols-[minmax(5rem,1fr)_minmax(0,2fr)] gap-3"><dt className="break-words text-[var(--text-secondary)]">{DETAIL_LABELS[key] ?? key}</dt><dd className="min-w-0 break-all">{key === 'field' && typeof item === 'string' ? DETAIL_LABELS[item] ?? item : <Detail value={item} />}</dd></div>)}</dl>
  return <span>{typeof value === 'boolean' ? value ? '是' : '否' : String(value)}</span>
}
export default function AdminLogsPage() {
  const [targetType, setTargetType] = useAdminQueryState('targetType', '')
  const [action, setAction] = useAdminQueryState('action', '')
  const [operator, setOperator] = useAdminQueryState('operator', '')
  const [object, setObject] = useAdminQueryState('object', '')
  const [from, setFrom] = useAdminQueryState('from', '')
  const [to, setTo] = useAdminQueryState('to', '')
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const [pageSize, setPageSize] = useAdminNumberQuery('pageSize', 10)
  const query = useQuery({ queryKey: ['admin', 'logs', targetType, action, operator, object, from, to, page, pageSize], queryFn: () => listAdminAuditLogs({ targetType: targetType || undefined, action: action || undefined, operator: operator || undefined, objectId: object || undefined, from: from || undefined, to: to || undefined, page, pageSize }) })
  const data = query.data
  const rows = data?.items ?? []
  return <div>
    <AdminPageHeader title="操作审计" description="管理操作只增不删；详情按字段展示，敏感内容保持隐藏。" />
    <AdminCard className="mb-4"><div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">对象类型<select aria-label="对象类型" value={targetType} onChange={event => { setTargetType(event.target.value); setPage(1) }} className="mt-1 block min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3"><option value="">全部对象</option>{Object.entries(TARGET_TYPE_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-sm">动作代码<TextInput aria-label="动作代码" value={action} onChange={event => { setAction(event.target.value); setPage(1) }} placeholder="完整动作代码" /></label>
      <details className="w-full"><summary className="min-h-11 cursor-pointer py-3 text-sm">更多筛选</summary><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><label className="text-sm">操作者<TextInput value={operator} onChange={event => { setOperator(event.target.value); setPage(1) }} placeholder="管理员昵称 / ID" /></label><label className="text-sm">对象 ID<TextInput value={object} onChange={event => { setObject(event.target.value); setPage(1) }} placeholder="对象 ID" /></label><label className="text-sm">开始日期<TextInput type="date" value={from} onChange={event => { setFrom(event.target.value); setPage(1) }} /></label><label className="text-sm">结束日期<TextInput type="date" value={to} onChange={event => { setTo(event.target.value); setPage(1) }} /></label></div><p className="mt-3 text-xs text-[var(--text-secondary)]">全部筛选由服务端执行，按 UTC+8 日期范围检索；历史审计记录保持只增不删。</p></details>
    </div></AdminCard>
    <AdminCard><AdminPanelState state={query.isPending ? 'loading' : query.isError ? 'error' : rows.length === 0 ? 'empty' : 'ready'}>
      <div className="space-y-3">{rows.map(log => <article key={log.id} className="rounded-xl border border-[var(--border-default)] p-4"><div className="flex flex-wrap items-start justify-between gap-2"><h2 className="text-sm font-semibold">{describeAdminAction(log.action)}</h2><time className="text-sm text-[var(--text-secondary)]" dateTime={log.createdAt}>{formatDateTime(log.createdAt)}</time></div><dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-[var(--text-secondary)]">操作者</dt><dd className="break-all">{log.adminNickname ?? log.adminId}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">对象</dt><dd className="break-all">{TARGET_TYPE_LABELS[log.targetType ?? ''] ?? log.targetType ?? '—'} · {log.targetId ?? '—'}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">动作代码</dt><dd className="break-all">{log.action}</dd></div></dl><details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-sm">查看审计详情</summary><div className="space-y-3 text-sm"><p>来源 IP：{log.ip ?? '—'}</p><Detail value={log.detail} /></div></details></article>)}</div>
    </AdminPanelState>{data ? <AdminPager pagination={data.pagination} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} /> : null}</AdminCard>
  </div>
}
