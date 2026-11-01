import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import Button from '@/components/ui/Button'
import { archiveAdminModel, getAdminModelLifecyclePreview, restoreAdminModel } from '../api'

export function AdminModelLifecycle({ modelId, revision, archived, dirty = false, onChanged }: {
  modelId: string; revision: number; archived: boolean; dirty?: boolean; onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [reason, setReason] = useState('')
  const preview = useQuery({ queryKey: ['admin', 'model-lifecycle', modelId, revision], queryFn: () => getAdminModelLifecyclePreview(modelId), enabled: open, retry: false })
  const action = useMutation({ mutationFn: async () => {
    if (!reason.trim()) throw new Error('请填写操作原因。')
    if (archived) return restoreAdminModel(modelId, { expectedRevision: revision, reason })
    if (!preview.data) throw new Error('请先读取影响预览。')
    const candidate = preview.data.candidates.find(row => row.id === replacement)
    return archiveAdminModel(modelId, { expectedRevision: revision, previewHash: preview.data.previewHash, reason,
      ...(candidate ? { replacementId: candidate.id, replacementRevision: candidate.revision } : {}) })
  }, onSuccess: onChanged })
  const requiresReplacement = !archived && Boolean(preview.data?.isDefault || preview.data?.systemRoles.length)
  return <section className="mt-5 border-t border-[var(--border-subtle)] pt-5" aria-label="模型生命周期">
    <h3 className="font-semibold">{archived ? '恢复配置' : '从活动目录移除'}</h3>
    <p className="my-3 text-[var(--text-secondary)]">{archived ? '恢复原身份后保持停用、不可选、非默认。请重新核对配置；不会恢复旧任务或重算旧账。' : '归档保留模型身份、历史调用与账务。在途任务保留原配置和价格；排队、暂停或待恢复任务需要明确重新选择。'}</p>
    {dirty ? <p role="status">请先保存或丢弃当前配置草稿，再预览归档。</p> : null}
    {!open ? <Button disabled={dirty} onClick={() => setOpen(true)}>{archived ? '查看恢复影响' : '预览归档影响'}</Button> : <div className="space-y-4">
      {preview.isPending ? <p role="status">正在读取引用影响…</p> : preview.isError ? <p role="alert">影响预览不可用，请刷新后重试。</p> : preview.data ? <>
        <p>{preview.data.isDefault ? '当前默认模型 · ' : ''}{preview.data.systemRoles.length ? `系统用途：${preview.data.systemRoles.join('、')}` : '无必要系统用途绑定'}</p>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{Object.entries(preview.data.impact).map(([key, count]) => <div key={key}><dt className="text-[var(--text-secondary)]">{({ queued: '排队任务', running: '执行中/等待审批', paused: '暂停任务', historicalCalls: '档位历史调用', assignments: '模型分配', queuedRequests: '待发请求', goals: '未结束目标', schedules: '定时任务', imports: '导入任务' } as Record<string, string>)[key]}</dt><dd>{count}</dd></div>)}</dl>
        <p className="text-[var(--text-secondary)]">历史调用按原档位累计，仅作范围参考，不重新归属到当前供应商。</p>
        {requiresReplacement ? <label className="block">必要用途的替代配置<select aria-label="必要用途的替代配置" className="mt-2 min-h-11 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-default)] px-3" value={replacement} onChange={event => setReplacement(event.target.value)}><option value="">请选择同类型、同生效费率的配置</option>{preview.data.candidates.map(candidate => <option key={candidate.id} value={candidate.id} disabled={!candidate.eligible}>{candidate.displayName}{candidate.reasons.length ? ` · ${candidate.reasons.join('；')}` : ''}</option>)}</select></label> : null}
        {requiresReplacement && !preview.data.candidates.some(row => row.eligible) ? <p role="alert">当前没有同类型、同生效费率的有效替代配置，归档已阻止。</p> : null}
      </> : null}
      <label className="block">操作原因<textarea aria-label="操作原因" className="mt-2 min-h-24 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-default)] p-3" value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></label>
      {action.isError ? <p role="alert" className="text-rose-600">{action.error instanceof Error ? action.error.message : '操作未完成'}；输入已保留。</p> : null}
      <div className="flex flex-wrap gap-3"><Button disabled={action.isPending} onClick={() => setOpen(false)}>收起影响</Button><Button disabled={dirty || action.isPending || !reason.trim() || preview.isError || preview.isPending || requiresReplacement && !replacement} onClick={() => action.mutate()}>{action.isPending ? '正在处理…' : archived ? '确认恢复为停用配置' : '确认归档'}</Button></div>
    </div>}
  </section>
}
