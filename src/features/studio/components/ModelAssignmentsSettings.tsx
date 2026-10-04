import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError, requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { fetchCreditSummary, fetchCustomModels } from '@/features/account/credits-api'
import { cn } from '@/lib/utils'
import { MODEL_ASSIGNMENT_TASKS, type AgentModelSelection, type ModelAssignmentTask, type ModelAssignmentsPayload, type PatchModelAssignments } from '../../../../shared/contracts/agent-model-assignments.js'
import type { ModelReasoningEffort } from '../../../../shared/contracts/credits.js'

type ModelOption = { id: string; label: string; price?: string; selection: AgentModelSelection; efforts: ModelReasoningEffort[]; vision: boolean }
type Draft = { revision: number; changes: PatchModelAssignments['assignments'] }
const effortLabels: Record<ModelReasoningEffort, string> = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }
const fieldClass = 'min-w-0 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50'
function modelKey(selection: AgentModelSelection | null | undefined) { return selection ? selection.modelTier === 'custom' ? `custom:${selection.customModelId}` : selection.modelTier : '' }

export default function ModelAssignmentsSettings({ novelId }: { novelId?: string }) {
  const [scope, setScope] = useState<'global' | 'novel'>(novelId ? 'novel' : 'global')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const queryClient = useQueryClient()
  const targetNovelId = scope === 'novel' ? novelId : undefined
  const owner = targetNovelId ? `novel:${targetNovelId}` : 'global'
  const queryKey = ['agent', 'model-assignments', owner]
  const assignments = useQuery({ queryKey, queryFn: () => requestJson<ModelAssignmentsPayload>(`/api/agent/model-assignments${targetNovelId ? `?novelId=${encodeURIComponent(targetNovelId)}` : ''}`), enabled: scope !== 'novel' || Boolean(novelId) })
  const models = useQuery({ queryKey: ['credits', 'summary'], queryFn: fetchCreditSummary, staleTime: 20_000 })
  const customModels = useQuery({ queryKey: ['credits', 'custom-models'], queryFn: fetchCustomModels, staleTime: 30_000 })
  const options: ModelOption[] = [
    ...(models.data?.models ?? []).filter(model => model.available && model.tier !== 'basic').map(model => ({ id: model.tier, label: model.label,
      price: typeof model.multiplier === 'number' ? model.multiplier === 0 ? model.freePromotion ? '限时免费' : '免费' : `${model.multiplier.toFixed(1)}x` : undefined,
      selection: { modelTier: model.tier as AgentModelSelection['modelTier'] }, efforts: model.reasoningEfforts, vision: model.visionEnabled })),
    ...(customModels.data?.models ?? []).filter(model => model.enabled).map(model => ({ id: `custom:${model.id}`, label: model.displayName || model.modelName, price: 'BYOK', selection: { modelTier: 'custom' as const, customModelId: model.id }, efforts: model.reasoningEfforts, vision: model.visionEnabled })),
  ]
  const record = scope === 'global' ? assignments.data?.global : assignments.data?.novel
  const draft = drafts[owner]
  const busy = saving !== null
  const ready = Boolean(record && models.data && customModels.data)
  const change = (task: ModelAssignmentTask, selection: AgentModelSelection | null) => {
    if (!record) return
    setErrors(current => ({ ...current, [owner]: '' }))
    setDrafts(current => ({ ...current, [owner]: { revision: current[owner]?.revision ?? record.revision, changes: { ...current[owner]?.changes, [task]: selection } } }))
  }
  const save = async () => {
    if (!draft || busy) return
    const savedOwner = owner
    const savedKey = queryKey
    setSaving(savedOwner)
    setErrors(current => ({ ...current, [savedOwner]: '' }))
    try {
      const result = await requestJson<ModelAssignmentsPayload>('/api/agent/model-assignments', { method: 'PATCH', body: JSON.stringify({ scope, ...(targetNovelId ? { novelId: targetNovelId } : {}), expectedRevision: draft.revision, assignments: draft.changes } satisfies PatchModelAssignments) })
      queryClient.setQueryData(savedKey, result)
      setDrafts(current => { const next = { ...current }; delete next[savedOwner]; return next })
      void queryClient.invalidateQueries({ queryKey: ['agent', 'model-assignments'] })
    } catch (error) {
      const message = error instanceof Error ? error.message : '模型设置保存失败。'
      setErrors(current => ({ ...current, [savedOwner]: message }))
      if (error instanceof ApiClientError && error.status === 409) {
        const refreshed = await queryClient.fetchQuery<ModelAssignmentsPayload>({ queryKey: savedKey, queryFn: () => requestJson<ModelAssignmentsPayload>(`/api/agent/model-assignments${targetNovelId ? `?novelId=${encodeURIComponent(targetNovelId)}` : ''}`), staleTime: 0 }).catch(() => null)
        const latest = scope === 'global' ? refreshed?.global : refreshed?.novel
        if (latest) setDrafts(current => current[savedOwner] ? { ...current, [savedOwner]: { ...current[savedOwner], revision: latest.revision } } : current)
      }
    } finally { setSaving(null) }
  }
  const error = errors[owner] || (assignments.error instanceof Error ? assignments.error.message : '') || (models.error instanceof Error ? models.error.message : '') || (customModels.error instanceof Error ? customModels.error.message : '')
  const row = (task: typeof MODEL_ASSIGNMENT_TASKS[number]) => {
    const selection = draft && Object.prototype.hasOwnProperty.call(draft.changes, task.key) ? draft.changes[task.key] : record?.assignments[task.key]
    const value = modelKey(selection)
    const choices = task.kind === 'vision' ? options.filter(option => option.vision) : options
    const selected = choices.find(option => option.id === value)
    const inherited = scope === 'novel' ? assignments.data?.global.assignments[task.key] : undefined
    const inheritedLabel = inherited ? options.find(option => option.id === modelKey(inherited))?.label : undefined
    return <div key={task.key} className="grid grid-cols-[minmax(0,1fr)_96px] gap-2 border-b border-[var(--border-subtle)] py-3 sm:grid-cols-[140px_minmax(0,1fr)_112px] sm:items-center">
      <span className="col-span-2 text-sm font-medium sm:col-span-1">{task.label}</span>
      <select aria-label={`${task.label}模型`} className={fieldClass} value={value} disabled={!ready || busy} onChange={event => { const chosen = choices.find(option => option.id === event.target.value); change(task.key, chosen ? { ...chosen.selection } : null) }}>
        <option value="">{inheritedLabel ? `跟随全局 · ${inheritedLabel}` : '跟随默认模型'}</option>
        {value && !selected ? <option value={value} disabled>模型不可用</option> : null}
        {choices.map(option => <option key={option.id} value={option.id}>{option.label}{option.price ? ` · ${option.price}` : ''}</option>)}
      </select>
      <select aria-label={`${task.label}推理强度`} className={fieldClass} value={selection?.reasoningEffort ?? ''} disabled={!ready || busy || !selected} onChange={event => { if (selection) change(task.key, { ...selection, ...(event.target.value ? { reasoningEffort: event.target.value as ModelReasoningEffort } : { reasoningEffort: undefined }) }) }}>
        <option value="">默认</option>
        {(selected?.efforts ?? []).map(effort => <option key={effort} value={effort}>{effortLabels[effort]}</option>)}
      </select>
    </div>
  }
  return <div className="space-y-5">
    <div className="inline-flex gap-1 rounded-lg bg-[var(--surface-muted)] p-1" role="group" aria-label="模型设置作用域">
      {(['global', 'novel'] as const).filter(item => item !== 'novel' || Boolean(novelId)).map(item => <button key={item} type="button" disabled={busy} aria-pressed={scope === item} onClick={() => setScope(item)} className={cn('rounded-md px-4 py-2 text-sm', scope === item ? 'bg-[var(--surface-default)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>{item === 'global' ? '全局' : '当前作品'}</button>)}
    </div>
    {error ? <p role="alert" className="text-sm text-rose-500">{error}</p> : null}
    {assignments.isPending ? <p role="status" className="text-sm text-[var(--text-secondary)]">加载中…</p> : null}
    <div>{MODEL_ASSIGNMENT_TASKS.slice(0, 6).map(row)}</div>
    <details><summary className="cursor-pointer py-2 text-sm text-[var(--text-secondary)]">其它工具</summary><div>{MODEL_ASSIGNMENT_TASKS.slice(6).map(row)}</div></details>
    <Button disabled={!ready || !draft || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Button>
  </div>
}
