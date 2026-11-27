import { useState } from 'react'
import { useLocation, useParams, useSearchParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import CaseProgressForm from './CaseProgressForm'
import {
  caseStatuses,
  reportReasons,
  type CaseRow,
  type CaseDetails,
  type CaseStatus,
  type ReportReason,
} from '../../../../shared/contracts/governance-cases'
import { control, action, post, errorText } from '@/features/governance/common'
import GovernanceReconciliation from '../GovernanceReconciliation'
import GovernanceMailStatus from '../GovernanceMailStatus'
import ManualUsageCase from './ManualUsageCase'
import { usageCategories } from '../../../../shared/contracts/governance-cases'
import { GovernanceRestrictionsView } from './GovernanceRestrictionsView'
import { GovernanceSafetyView } from './GovernanceSafetyView'

import GovernanceSummary from './GovernanceSummary'
const labels: Record<string, string> = {
  post: '帖子',
  novel: '作品',
  profile: '个人主页',
  comment: '评论',
  message: '私信',
  platform: '平台',
  restriction: '账号限制',
  warning: '安全提醒',
  observe: '观察',
  review: '需要复核',
  urgent: '紧急复核',
}
function CaseDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useQueryClient(),
    q = useQuery({
      queryKey: ['governance', 'case', id],
      queryFn: () => requestJson<CaseDetails>('/api/admin/governance/cases/' + encodeURIComponent(id)),
      refetchOnWindowFocus: false,
    })
  const [next, setNext] = useState<CaseStatus>('investigating'),
    [reason, setReason] = useState(''),
    [related, setRelated] = useState(''),
    [events, setEvents] = useState<string[]>([]),
    [expires, setExpires] = useState(''),
    [retention, setRetention] = useState('')
  const c = q.data,
    appeal = c?.kind === 'appeal'
  const m = useMutation({
    mutationFn: () =>
      post('/api/admin/governance/' + (appeal ? 'appeals' : 'reports') + '/' + encodeURIComponent(id), {
        status: next,
        reason,
        relatedId: next === 'linked' ? related : undefined,
        invalidEventIds: ['corrected', 'adjusted', 'lifted'].includes(next) ? events : undefined,
        expiresAt: next === 'adjusted' && expires ? new Date(expires).toISOString() : undefined,
        retainUntil: retention ? new Date(retention).toISOString() : undefined,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['governance'] })
      setReason('')
    },
  })
  const choices: CaseStatus[] = appeal
    ? [
        'investigating',
        'maintained',
        ...(c?.safetyEvents?.length ? ['corrected' as const] : []),
        ...(c?.targetKind === 'restriction' ? ['adjusted' as const, 'lifted' as const] : []),
      ]
    : ['investigating', 'upheld', 'dismissed', 'linked']
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-[var(--border-subtle)] p-4"
      aria-label="案件详情"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">案件详情</h2>
        <button type="button" className={action} onClick={onClose}>
          关闭
        </button>
      </div>
      {q.isLoading ? (
        '加载中…'
      ) : q.isError ? (
        <p role="alert">{errorText(q.error)}</p>
      ) : (
        c && (
          <>
            <p className="break-all">
              {c.id} · {caseStatuses[c.status]}
            </p>
            <p>
              {labels[c.targetKind]} · {c.targetId}
            </p>
            <p>
              受理截止 {new Date(c.acknowledgeBy).toLocaleString()} ·{' '}
              {c.feedbackBy ? '反馈截止 ' + new Date(c.feedbackBy).toLocaleString() : '等待补充材料'}
            </p>
            {c.publicProgress && <p>{c.publicProgress}</p>}
            {['investigating', 'pending'].includes(c.status) && (
              <CaseProgressForm
                item={c}
                onSaved={() => {
                  void client.invalidateQueries({ queryKey: ['governance'] })
                }}
              />
            )}
            <p>
              {reportReasons[c.category as ReportReason] ??
                usageCategories[c.category as keyof typeof usageCategories] ??
                labels[c.category]}
            </p>
            {c.snapshot && (
              <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3">
                {c.snapshot}
              </blockquote>
            )}
            {c.statement && <p className="whitespace-pre-wrap break-words">{c.statement}</p>}
            {c.subjectId && (
              <Link
                className="underline"
                to={
                  '/admin/governance/restrictions?' +
                  new URLSearchParams({ userId: c.subjectId, sourceId: c.id }).toString()
                }
                state={{ reason: c.statement ?? reportReasons[c.category as ReportReason] ?? '' }}
              >
                查看或处理账号限制
              </Link>
            )}
            {c.targetKind === 'novel' && (
              <Link className="ml-2 underline" to={'/admin/novels/' + encodeURIComponent(c.targetId)}>
                作品管理
              </Link>
            )}
            {['pending', 'investigating'].includes(c.status) && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  m.mutate()
                }}
              >
                <label>
                  处理结果
                  <select
                    className={control}
                    value={next}
                    onChange={(e) => setNext(e.target.value as CaseStatus)}
                  >
                    {choices.map((k) => (
                      <option key={k} value={k} disabled={k === c.status}>
                        {caseStatuses[k]}
                      </option>
                    ))}
                  </select>
                </label>
                {next === 'linked' && (
                  <label>
                    同一目标的主案件编号
                    <input
                      required
                      className={control}
                      value={related}
                      onChange={(e) => setRelated(e.target.value)}
                    />
                  </label>
                )}
                {next === 'adjusted' && (
                  <label>
                    调整后的限制截止时间
                    <input
                      required
                      type="datetime-local"
                      className={control}
                      value={expires}
                      onChange={(e) => setExpires(e.target.value)}
                    />
                  </label>
                )}
                {['corrected', 'adjusted', 'lifted'].includes(next) && Boolean(c.safetyEvents?.length) && (
                  <fieldset className="space-y-1">
                    <legend>经独立复核认定有误的关联事件</legend>
                    {c.safetyEvents.map((event) => (
                      <label key={event.id} className="block break-all">
                        <input
                          type="checkbox"
                          checked={events.includes(event.id)}
                          onChange={(e) =>
                            setEvents((current) =>
                              e.target.checked
                                ? [...current, event.id]
                                : current.filter((id) => id !== event.id),
                            )
                          }
                        />{' '}
                        {event.category} · {event.id}
                      </label>
                    ))}
                  </fieldset>
                )}
                <label>
                  {appeal ? '告知申诉人的结论及依据' : '内部处理依据'}
                  <textarea
                    className={control}
                    rows={3}
                    maxLength={4000}
                    required
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                {['upheld', 'dismissed', 'maintained', 'corrected', 'adjusted', 'lifted'].includes(next) && (
                  <label>
                    需依法继续保留证据时填写截止日期，否则结案后清理
                    <input
                      className={control}
                      type="datetime-local"
                      value={retention}
                      onChange={(e) => setRetention(e.target.value)}
                    />
                  </label>
                )}
                <button
                  className={action}
                  disabled={m.isPending || next === c.status || (next === 'corrected' && !events.length)}
                >
                  {m.isPending ? '处理中…' : '确认处理'}
                </button>
              </form>
            )}
            {m.isError && <p role="alert">{errorText(m.error)}</p>}
            {m.isSuccess && <p role="status">已记录处理结果。</p>}
            <details>
              <summary>处理历史</summary>
              {c.events.map((e) => (
                <p key={e.id}>
                  {new Date(e.createdAt).toLocaleString()} ·{' '}
                  {e.result ? caseStatuses[e.result as CaseStatus] : e.action} {e.reason}
                </p>
              ))}
            </details>
          </>
        )
      )}
    </section>
  )
}
function Cases({ kind }: { kind: 'appeal' | 'report' | 'usage' }) {
  const [status, setStatus] = useState(''),
    [target, setTarget] = useState(''),
    [category, setCategory] = useState(''),
    [user, setUser] = useState(''),
    [after, setAfter] = useState(''),
    [cursor, setCursor] = useState(''),
    [id, setId] = useState('')
  const params = new URLSearchParams({ kind })
  for (const [key, v] of Object.entries({
    status,
    target,
    category,
    userId: user,
    cursor,
    after: after ? new Date(after).toISOString() : '',
  }))
    if (v) params.set(key, v)
  const q = useQuery({
    queryKey: ['governance', 'list', params.toString()],
    queryFn: () =>
      requestJson<{ items: CaseRow[]; next: string | null }>('/api/admin/governance/cases?' + params),
  })
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-3" onChange={() => setCursor('')}>
        <label>
          状态
          <select className={control} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(caseStatuses).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          对象
          <select className={control} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(labels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          主要理由
          <select className={control} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(kind === 'usage' ? usageCategories : reportReasons).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          被调查账号
          <input className={control} value={user} onChange={(e) => setUser(e.target.value)} />
        </label>
        <label>
          提交日期起
          <input type="date" className={control} value={after} onChange={(e) => setAfter(e.target.value)} />
        </label>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="min-w-0 space-y-1">
          {q.isLoading ? (
            <p>加载中…</p>
          ) : q.isError ? (
            <p role="alert">{errorText(q.error)}</p>
          ) : q.data?.items.length ? (
            q.data.items.map((c) => (
              <button
                key={c.id}
                className="block w-full rounded-lg border border-[var(--border-subtle)] p-3 text-left hover:bg-[var(--surface-muted)]"
                onClick={() => setId(c.id)}
              >
                <strong>
                  {labels[c.targetKind]} · {caseStatuses[c.status]}
                </strong>
                <span className="block break-all text-xs">
                  {c.id} · {new Date(c.createdAt).toLocaleString()}
                </span>
              </button>
            ))
          ) : (
            <p>暂无符合条件的案件。</p>
          )}
          {q.data?.next && (
            <button className={action} onClick={() => setCursor(q.data!.next!)}>
              下一页
            </button>
          )}
          {cursor && (
            <button className={action} onClick={() => setCursor('')}>
              返回首页
            </button>
          )}
        </section>
        {id && <CaseDetail key={id} id={id} onClose={() => setId('')} />}
      </div>
    </>
  )
}
export default function AdminGovernance() {
  const { section = 'reports' } = useParams(),
    [params] = useSearchParams(),
    location = useLocation(),
    client = useQueryClient()
  return (
    <div className="space-y-5 text-sm">
      <h1 className="text-2xl font-semibold">内容治理</h1>
      <GovernanceSummary />
      {section === 'reports' && <GovernanceMailStatus />}
      {section === 'safety' ? (
        <GovernanceSafetyView />
      ) : section === 'restrictions' ? (
        <GovernanceRestrictionsView
          userId={params.get('userId') ?? undefined}
          sourceId={params.get('sourceId') ?? undefined}
          initialReason={location.state?.reason}
        />
      ) : section === 'reconciliation' ? (
        <>
          <GovernanceReconciliation />
          <ManualUsageCase
            onCreated={() => {
              void client.invalidateQueries({ queryKey: ['governance', 'list'] })
            }}
          />
          <Cases kind="usage" />
        </>
      ) : (
        <Cases key={section} kind={section === 'appeals' ? 'appeal' : 'report'} />
      )}
    </div>
  )
}
