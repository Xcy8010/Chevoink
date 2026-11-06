import { modelActivitiesSchema, type ModelActivities } from '../../../../shared/model-activity'
import { isBuiltInModelTier } from '../../../../shared/contracts/model-tier'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, ChevronLeft } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { rememberAdminModelHistoryDraft, takeAdminModelHistoryDraft, dropAdminModelHistoryDraft } from '../components/AdminModelDraftRecovery'
import { AdminModelLifecycle } from '../components/AdminModelLifecycle'
import AdminModelDiagnostics from '../components/AdminModelDiagnostics'
import type { AdminModelKind } from '../../../../shared/contracts/admin-model-lifecycle'
import { AdminModelEditorSections } from '../components/AdminModelEditorSections'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import type { ModelReasoningEffort } from '../../../../shared/contracts'
import type { WebToolProtocol } from '../../../../shared/contracts/web-tool'
import { IMAGE_QUALITY_OPTIONS, type ImageQualityConfig } from '../../../../shared/contracts/image-model'
import { AdminCard, AdminPageHeader, AdminPanelState, AdminSectionTabs, AdminToolbar } from '../AdminLayout'
import { formatTokens } from '../admin-shared'
import { createAdminModel, reorderAdminModels, getAdminModelManagement, updateAdminModel, startAdminModelDiagnostic, getAdminModelDiagnostic, cancelAdminModelDiagnostic } from '../api'
import type { WeightedRoutesInput } from '../../../../shared/contracts/model-weighted-routes'
import type { ModelRouteInput } from '../../../../shared/contracts/model-routes'
import { webToolChargeMilli } from '../../../../shared/web-tool-pricing'

function toolPrice(multiplier: number): string {
  try { return `${(webToolChargeMilli(Math.round(multiplier * 10000)) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} Credits / 成功请求` }
  catch { return '请输入有效倍率（0–100）' }
}

export type ModelRow = NonNullable<ReturnType<typeof getAdminModelManagement> extends Promise<infer T> ? T : never>['models'][number]
const emptyForm = {
    webToolProtocol: '' as '' | WebToolProtocol,
    publicDescription: '', publicFeatures: [] as string[], activities: { revision: 0, timezone: 'Asia/Shanghai', rules: [] } as ModelActivities,
    provider: '', displayName: '', modelName: '', baseUrl: '', apiKey: '', multiplier: '1',
    imageQuality: undefined as ImageQualityConfig | undefined, imageQualityCustomValues: '',
    enabled: true, selectable: true, isDefault: false,
    reasoningEfforts: ['high'] as ModelReasoningEffort[], defaultReasoningEffort: 'high' as ModelReasoningEffort,
    reasoningParameterMode: '' as '' | 'native' | 'omit',
    outputTokenParameter: '' as '' | 'max_tokens' | 'max_completion_tokens',
    thinkingEnabled: '' as '' | 'enabled' | 'disabled',
    visionEnabled: false, contextWindowTokens: '128000',
    routes: [] as ModelRouteInput[],
    weightedRoutes: { primaryWeight: 100, candidates: [] } as WeightedRoutesInput,
    limitedFree: false, freeUntil: '', afterMultiplier: '1.5',
}
export type AdminModelForm = typeof emptyForm


export default function AdminModelsPage() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['admin', 'models'], queryFn: () => getAdminModelManagement('all') })
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<ModelRow | null>(null)
  const savedForm = useRef('')
  const submitLock = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const [newModelKind, setNewModelKind] = useState<AdminModelKind>('text')
  const [sortMode, setSortMode] = useState(false)
  const [checkMessage, setCheckMessage] = useState('')
  const [fieldError, setFieldError] = useState<{ name: string; message: string } | null>(null)
  const sections = [['basic', '基本配置'], ['capability', '能力与参数'], ['routes', '线路'], ['usage', '用量与健康'], ['billing', '计费'], ['changes', '变更与归档']] as const
  const section = sections.some(([id]) => id === params.get('section')) ? params.get('section')! : 'basic'
  const editingKind = editing?.id ? editing.modelKind : newModelKind
  const archivedView = params.get('view') === 'archived'
  const [form, setForm] = useState(emptyForm)
  const actorId = queryClient.getQueryData<{ id: string }>(['admin', 'me'])?.id ?? null
  const liveDraft = useRef({ form, baseline: savedForm.current, editing, actorId })
  liveDraft.current = { form, baseline: savedForm.current, editing, actorId }

  useLayoutEffect(() => {
    if (!editing) return
    const initial = {
      webToolProtocol: editing.webToolProtocol ?? (editing.provider.trim().toLowerCase() === 'deepseek' ? 'deepseek' : editing.provider.trim().toLowerCase() === 'bocha' ? 'bocha' : ''),
      publicDescription: editing.publicDescription ?? '', publicFeatures: editing.publicFeatures ?? [], activities: editing.activities ?? { revision: 0, timezone: 'Asia/Shanghai', rules: [] },
      provider: editing.provider, displayName: editing.displayName, modelName: editing.modelName,
      imageQuality: editing.imageQuality,
      imageQualityCustomValues: editing.imageQuality?.supportedValues.filter(value => !IMAGE_QUALITY_OPTIONS.some(option => option.value === value)).join(', ') ?? '',
      baseUrl: editing.baseUrl ?? '', apiKey: '', multiplier: String(editing.baseMultiplier ?? editing.multiplier),
      enabled: editing.enabled, selectable: editing.selectable, isDefault: editing.isDefault,
      reasoningEfforts: editing.reasoningEfforts, defaultReasoningEffort: editing.defaultReasoningEffort,
      reasoningParameterMode: editing.reasoningParameterMode ?? '',
      outputTokenParameter: editing.outputTokenParameter ?? '',
      thinkingEnabled: editing.thinkingEnabled === undefined ? '' : editing.thinkingEnabled ? 'enabled' : 'disabled',
      visionEnabled: editing.visionEnabled, contextWindowTokens: String(editing.contextWindowTokens ?? 128000),
      routes: (editing.routes ?? []).map(({ apiKeyConfigured: _configured, ...route }) => route),
      weightedRoutes: editing.weightedRoutes ? { primaryWeight: editing.weightedRoutes.primaryWeight,
        candidates: editing.weightedRoutes.candidates.map(({ apiKeyConfigured: _configured, ...route }) => route) } : { primaryWeight: 100, candidates: [] },
      limitedFree: editing.multiplier === 0 && Boolean(editing.freePromotion),
      freeUntil: editing.freePromotion ? new Date(Date.parse(editing.freePromotion.endsAt) - new Date(editing.freePromotion.endsAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '',
      afterMultiplier: String(editing.freePromotion?.afterMultiplier ?? 1.5),
    } satisfies AdminModelForm
    const recovered = takeAdminModelHistoryDraft(queryClient, actorId, editing.id || 'new')
    savedForm.current = recovered?.baseline ?? JSON.stringify(initial)
    setForm(recovered?.form ?? initial)
    if (recovered && recovered.sourceVersion !== editing.updatedAt) setCheckMessage('配置已变化，未保存草稿已保留；保存前请核对当前配置。')
  }, [editing, queryClient, actorId])

  useEffect(() => {
    if (form.provider.trim().toLowerCase() !== 'deepseek') return
    const supported: ModelReasoningEffort[] = form.reasoningEfforts.filter((effort) => effort === 'low' || effort === 'high' || effort === 'max')
    const reasoningEfforts: ModelReasoningEffort[] = supported.length > 0 ? supported : ['high']
    if (reasoningEfforts.length === form.reasoningEfforts.length && reasoningEfforts.every((effort, index) => effort === form.reasoningEfforts[index])) return
    setForm((value) => ({ ...value, reasoningEfforts, defaultReasoningEffort: reasoningEfforts.includes(value.defaultReasoningEffort) ? value.defaultReasoningEffort : reasoningEfforts[0] }))
  }, [form.provider, form.reasoningEfforts])

  const mutation = useMutation({
    mutationFn: async () => {
      if (!editing) return { ok: true as const }
      const missing = !form.displayName.trim() ? { name: `model-display-${editing.id}`, message: '请填写显示名称。' }
        : !form.modelName.trim() ? { name: `model-id-${editing.id}`, message: '请填写模型 ID。' } : null
      if (missing) {
        setFieldError(missing)
        setParams(current => { const next = new URLSearchParams(current); next.set('section', 'basic'); return next }, { replace: true })
        throw new Error(missing.message)
      }
      setFieldError(null)
      if ((editingKind === 'text' || editingKind === 'image_generation') && form.activities.rules.length) modelActivitiesSchema.parse(form.activities)
      const limitedFree = Number(form.multiplier) === 0 && form.limitedFree
      const expires = Date.parse(form.freeUntil)
      if (limitedFree && (!Number.isFinite(expires) || expires <= Date.now())) throw new Error('请选择未来的截止时间')
      const { limitedFree: _limited, freeUntil: _until, afterMultiplier: _after, imageQualityCustomValues: _customQuality, ...fields } = form
      const payload = { ...fields, selectable: editingKind === 'text' ? form.selectable : false, isDefault: editingKind === 'text' ? form.isDefault : false, visionEnabled: editingKind === 'vision' ? true : form.visionEnabled, expectedRevision: editing.id ? editing.revision : undefined, webToolProtocol: (editingKind === 'web_search' || editingKind === 'web_fetch') && form.webToolProtocol ? form.webToolProtocol : undefined, publicFeatures: form.publicFeatures.map(value => value.trim()).filter(Boolean), activities: (editingKind === 'text' || editingKind === 'image_generation') && (editing.activities || form.activities.rules.length) ? form.activities : undefined, weightedRoutes: (editingKind === 'text' || editingKind === 'image_generation') && (editing.weightedRoutes || form.weightedRoutes.candidates.length) ? form.weightedRoutes : undefined, imageQuality: editingKind === 'image_generation' ? form.imageQuality : undefined, baseUrl: form.baseUrl || null, apiKey: form.apiKey || undefined, multiplier: Number(form.multiplier), contextWindowTokens: editingKind === 'text' ? Number(form.contextWindowTokens) : undefined,
        reasoningParameterMode: editingKind === 'text' ? form.reasoningParameterMode || null : undefined,
        outputTokenParameter: editingKind === 'text' ? form.outputTokenParameter || null : undefined,
        thinkingEnabled: editingKind === 'text' ? form.thinkingEnabled === '' ? null : form.thinkingEnabled === 'enabled' : undefined,
        freePromotion: limitedFree ? { endsAt: new Date(expires).toISOString(), afterMultiplier: Number(form.afterMultiplier) } : null }
      if (editing.id) await updateAdminModel(editing.id, payload)
      else await createAdminModel({ ...payload, expectedRevision: undefined, modelKind: newModelKind, expectedOrder: catalog.map(model => model.id) })
      return { ok: true as const }
    },
    onSuccess: async () => {
      dropAdminModelHistoryDraft(queryClient)
      savedForm.current = ''
      setForm(emptyForm)
      setEditing(null)
      setParams(current => { const next = new URLSearchParams(current); next.delete('model'); next.delete('section'); return next }, { replace: true })
      await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
      await queryClient.invalidateQueries({ queryKey: ['credits', 'summary'] })
    },
    onSettled: () => { submitLock.current = false },
  })
  const catalog = (query.data?.models ?? []).filter(model => !model.archivedAt && isBuiltInModelTier(model.tier))
  const reorder = useMutation({ mutationFn: ({ order, expected }: { order: string[]; expected: string[] }) => reorderAdminModels(order, expected),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }); await queryClient.invalidateQueries({ queryKey: ['credits', 'summary'] }) },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }) } })
  function moveModel(id: string, direction: number) {
    const expected = catalog.map(model => model.id)
    const order = [...expected]
    const index = order.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    reorder.mutate({ order, expected })
  }
  function addModel() {
    setNewModelKind('text')
    setParams(current => { const next = new URLSearchParams(current); next.set('model', 'new'); next.set('section', 'basic'); return next })
    mutation.reset()
    setEditing({ id: '', revision: 1, archivedAt: null, archiveReason: null, tier: null, modelKind: 'text', sortOrder: 0, provider: 'openai', displayName: '', modelName: '', baseUrl: null, multiplier: 1,
      enabled: true, selectable: true, isDefault: false, apiKeyConfigured: false, requestCount: 0, requestTokens: 0, responseTokens: 0,
      reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false, contextWindowTokens: 128000, configurationReady: false, updatedAt: '' })
  }
  const dirty = editing !== null && savedForm.current !== '' && savedForm.current !== JSON.stringify(form)
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const leave = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      const target = new URL(anchor.href, window.location.href)
      if (target.href === window.location.href) return
      if (!window.confirm('有未保存的修改。放弃修改并离开模型详情？')) { event.preventDefault(); event.stopPropagation() }
      else dropAdminModelHistoryDraft(queryClient)
    }
    // BrowserRouter stores its existing entry index. On a rejected native Back /
    // Forward, restore that entry before its bubble-phase router listener runs.
    let historyIndex: unknown = window.history.state?.idx
    let restoringHistory = false
    const pop = (event: PopStateEvent) => {
      if (restoringHistory) { restoringHistory = false; event.stopImmediatePropagation(); return }
      const targetIndex: unknown = event.state?.idx
      if (typeof historyIndex !== 'number' || typeof targetIndex !== 'number' || historyIndex === targetIndex) return
      if (window.confirm('有未保存的修改。放弃修改并离开模型详情？')) { dropAdminModelHistoryDraft(queryClient); historyIndex = targetIndex; return }
      const draft = liveDraft.current
      if (draft.editing) rememberAdminModelHistoryDraft(queryClient, { actorId: draft.actorId, modelId: draft.editing.id || 'new', sourceVersion: draft.editing.updatedAt, baseline: draft.baseline, form: draft.form })
      event.stopImmediatePropagation()
      restoringHistory = true
      window.history.go(historyIndex - targetIndex)
    }
    window.addEventListener('popstate', pop, true)
    window.addEventListener('beforeunload', guard)
    document.addEventListener('click', leave, true)
    return () => { window.removeEventListener('beforeunload', guard); document.removeEventListener('click', leave, true); window.removeEventListener('popstate', pop, true) }
  }, [dirty, queryClient])
  useEffect(() => {
    const id = params.get('model')
    if (!id) { if (editing) setEditing(null); return }
    if (id === 'new') { if (!editing) setEditing({ id: '', revision: 1, archivedAt: null, archiveReason: null, tier: null, modelKind: 'text', sortOrder: 0, provider: 'openai', displayName: '', modelName: '', baseUrl: null, multiplier: 1, enabled: true, selectable: true, isDefault: false, apiKeyConfigured: false, requestCount: 0, requestTokens: 0, responseTokens: 0, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false, contextWindowTokens: 128000, configurationReady: false, updatedAt: '' }); return }
    if (editing?.id === id || !query.data) return
    const model = query.data.models.find(row => row.id === id)
    if (model) setEditing(model)
  }, [params, query.data, editing])
  useEffect(() => { if (editing) heading.current?.focus() }, [editing])
  useEffect(() => { if (fieldError && !mutation.isPending) document.getElementsByName(fieldError.name)[0]?.focus() }, [fieldError, section, mutation.isPending])
  function closeEditor() {
    if (mutation.isPending || dirty && !window.confirm('有未保存的修改。放弃修改并返回模型列表？')) return
    dropAdminModelHistoryDraft(queryClient)
    savedForm.current = ''
    setForm(emptyForm)
    setEditing(null)
    mutation.reset()
    setParams(current => { const next = new URLSearchParams(current); next.delete('model'); next.delete('section'); return next })
    requestAnimationFrame(() => { (document.getElementById(`edit-model-${editing?.id}`) ?? document.getElementById('model-list-title'))?.focus({ preventScroll: true }) })
  }
  function editModel(model: ModelRow) {
    mutation.reset(); setCheckMessage(''); setFieldError(null); setEditing(model)
    setParams(current => { const next = new URLSearchParams(current); next.set('model', model.id); next.set('section', 'basic'); return next })
  }
  function filter(key: string, value: string) {
    setParams(current => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); next.delete('page'); return next }, { replace: true })
  }
  const typeLabel = (model: ModelRow) => model.modelKind === 'image_generation' ? '生图' : model.modelKind === 'vision' ? '图片理解' : model.modelKind === 'web_search' ? 'Search' : model.modelKind === 'web_fetch' ? 'Fetch' : model.tier === 'basic' ? '基础服务' : '文本'
  const filtered = (query.data?.models ?? []).filter(model => {
    if (Boolean(model.archivedAt) !== archivedView) return false
    const needle = (params.get('q') ?? '').trim().toLowerCase()
    return (!needle || [model.displayName, model.modelName, model.provider].some(value => value.toLowerCase().includes(needle)))
      && (!params.get('type') || typeLabel(model) === params.get('type'))
      && (!params.get('status') || String(model.enabled) === params.get('status'))
      && (!params.get('visible') || String(model.modelKind === 'text' && model.selectable) === params.get('visible'))
      && (!params.get('config') || String(model.configurationReady) === params.get('config'))
      && (!params.get('channel') || model.provider === params.get('channel'))
  })
  const pageSize = 12
  const page = Math.min(Math.max(1, Number(params.get('page')) || 1), Math.max(1, Math.ceil(filtered.length / pageSize)))
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize)
  function configurationCheck() {
    const model = editing
    if (!model) return
    const errors: string[] = []
    if (!form.displayName.trim()) errors.push('显示名称为空')
    if (!form.modelName.trim() || form.modelName === 'unconfigured') errors.push('模型 ID 未配置')
    if (!form.apiKey.trim() && !model.apiKeyConfigured && model.tier !== 'speed') errors.push('尚未配置密钥')
    try { const url = new URL(form.baseUrl); if (url.protocol !== 'https:' || url.username || url.password) errors.push('地址须为不含凭据的 HTTPS URL') } catch { errors.push('Base URL 无效') }
    if ((model.modelKind === 'web_search' || model.modelKind === 'web_fetch') && (!form.webToolProtocol || model.modelKind === 'web_fetch' && form.webToolProtocol !== 'deepseek')) errors.push('网页工具协议不适用')
    setCheckMessage(errors.length ? `本地配置检查：${errors.join('；')}。未请求上游。` : '本地必要字段检查通过；未请求上游，连通性与能力均未检测。保存时仍执行服务端校验。')
  }
  return <div className="space-y-5 pb-20 text-sm md:pb-0 [&_input:not([type=checkbox])]:min-h-11 [&_select]:min-h-11 [&_button]:min-h-11 [&_label:has(input[type=checkbox])]:min-h-11">
    <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
      {editing ? <>
        <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-default)] px-1 py-3">
          <div className="flex min-w-0 items-center gap-2"><Button variant="ghost" aria-label="返回模型列表" disabled={mutation.isPending} onClick={closeEditor}><ChevronLeft className="h-4 w-4" /></Button><div className="min-w-0"><h1 ref={heading} tabIndex={-1} className="break-words text-xl font-semibold outline-none">{editing.id ? editing.displayName : '添加内置模型'}</h1><p className="text-sm text-[var(--text-secondary)]">{dirty ? '有未保存的修改' : '模型详情'} · {typeLabel(editing)}</p></div></div>
          <div className="flex gap-2"><Button disabled={mutation.isPending || Boolean(editing.archivedAt)} onClick={configurationCheck}>配置检查</Button><Button className="hidden md:inline-flex" variant="primary" disabled={mutation.isPending || Boolean(editing.archivedAt)} onClick={() => { if (submitLock.current) return; submitLock.current = true; mutation.mutate() }}>{mutation.isPending ? '正在保存…' : '保存配置'}</Button></div>
        </div>
        <AdminSectionTabs label="模型详情分区" tabs={sections.map(([id, label]) => ({ id, label }))} value={section} onChange={id => setParams(current => { const next = new URLSearchParams(current); next.set('section', id); return next }, { replace: true })} />
        {checkMessage ? <p role="status" className="rounded-xl bg-[var(--surface-muted)] p-4">{checkMessage}</p> : null}
        {mutation.isError ? <p role="alert" tabIndex={-1} className="rounded-xl border border-rose-300 p-4 text-rose-600">{mutation.error instanceof Error ? mutation.error.message : '保存失败'}，草稿已保留。</p> : null}
        {!editing.id ? <label className="block">服务类型<select aria-label="服务类型" className="ml-3 min-h-11 rounded-md border border-[var(--border-strong)] bg-[var(--surface-default)] px-3" value={newModelKind} onChange={event => setNewModelKind(event.target.value as AdminModelKind)}>{[['text','文本'],['vision','图片理解'],['image_generation','生图'],['web_search','Search'],['web_fetch','Fetch']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
        {editing.archivedAt ? <p role="status">此配置已归档，仅供查阅。恢复后需重新确认配置。</p> : null}
        <AdminCard><h2 className="mb-4 text-base font-semibold">{sections.find(([id]) => id === section)?.[1]}</h2>
          <fieldset disabled={mutation.isPending || Boolean(editing.archivedAt)}><AdminModelEditorSections editing={{ ...editing, modelKind: editingKind }} form={form} setForm={setForm} section={section} fieldError={fieldError} /></fieldset>
          {section === 'usage' ? <div className="space-y-4"><p>最近检测：<strong className="font-medium">未检测</strong>。没有近期健康样本；配置完整不代表可调用。</p><p className="text-[var(--text-secondary)]">以下为档位 {editing.tier ?? '未分配'} 的累计用量，包含该档位过去实际模型的调用，不等于当前模型或渠道的历史。</p><dl className="grid grid-cols-3 gap-4"><div><dt>累计请求</dt><dd className="mt-1 text-xl">{editing.requestCount.toLocaleString('zh-CN')}</dd></div><div><dt>输入 Token</dt><dd className="mt-1 text-xl">{formatTokens(editing.requestTokens)}</dd></div><div><dt>输出 Token</dt><dd className="mt-1 text-xl">{formatTokens(editing.responseTokens)}</dd></div></dl><p className="text-[var(--text-secondary)]">来源：墨域本地用量记录。真实能力检测待接入；此处不会发起模型调用。</p></div> : null}
          {section === 'billing' && (editingKind === 'web_search' || editingKind === 'web_fetch') ? <p className="mt-4 text-[var(--text-secondary)]">保存后费用：{toolPrice(Number(form.multiplier))}（基础 2 Credits × 倍率）；缓存、失败、超时、空搜索和网页直读免费。</p> : null}
          {section === 'changes' ? <div className="space-y-4"><p>配置更新时间：{editing.updatedAt ? new Date(editing.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未保存'}（UTC+8）</p><Link className="inline-flex min-h-11 items-center underline" to="/admin/logs">查看操作审计</Link><p className="text-[var(--text-secondary)]">归档与停用独立管理；恢复不会重新启用服务或自动续跑任务。</p></div> : null}
          {section === 'usage' && editing.id ? <AdminModelDiagnostics key={editing.id} modelConfigId={editing.id} configRevision={String(editing.revision ?? 1)} client={{ start: startAdminModelDiagnostic, get: getAdminModelDiagnostic, cancel: cancelAdminModelDiagnostic }} /> : null}
          {section === 'changes' && editing.id ? <AdminModelLifecycle modelId={editing.id} revision={editing.revision ?? 1} archived={Boolean(editing.archivedAt)} dirty={dirty} onChanged={async () => {
            savedForm.current = ''; setForm(emptyForm); setEditing(null)
            setParams(current => { const next = new URLSearchParams(current); next.delete('model'); next.delete('section'); return next })
            await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
            await queryClient.invalidateQueries({ queryKey: ['credits', 'summary'] })
          }} /> : null}
        </AdminCard>
        <div className="fixed inset-x-0 bottom-[calc(64px+var(--safe-bottom))] z-30 flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--surface-default)] p-3 md:static"><span aria-live="polite" className="text-[var(--text-secondary)]">{dirty ? '未保存' : '配置草稿'}</span><div className="flex gap-2"><Button disabled={mutation.isPending} onClick={closeEditor}>返回列表</Button><Button className="md:hidden" aria-label={mutation.isPending ? '正在保存模型配置…' : '保存模型配置'} variant="primary" disabled={mutation.isPending || Boolean(editing.archivedAt)} onClick={() => { if (submitLock.current) return; submitLock.current = true; mutation.mutate() }}>{mutation.isPending ? '正在保存…' : '保存配置'}</Button></div></div>
      </> : <>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><AdminPageHeader title="模型中心" description="管理写作档位与工具服务。" /><h2 id="model-list-title" tabIndex={-1} className="sr-only">模型列表</h2></div><Button variant="primary" onClick={addModel}><Plus className="h-4 w-4" />添加内置模型</Button></div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[var(--text-secondary)]"><span>共 {query.data?.models.length ?? 0} 项服务</span><span>启用 {query.data?.models.filter(model => model.enabled).length ?? 0}</span><span>待配置 {query.data?.models.filter(model => !model.configurationReady).length ?? 0}</span><span>运行状态：未检测</span></div>
        <AdminSectionTabs label="模型目录" tabs={[{ id: 'active', label: '活动目录' }, { id: 'archived', label: '已归档' }]} value={archivedView ? 'archived' : 'active'} onChange={view => { setSortMode(false); filter('view', view === 'active' ? '' : view) }} />
        <AdminToolbar><label className="min-w-48 flex-1">搜索模型<TextInput className="mt-1" value={params.get('q') ?? ''} placeholder="名称、模型 ID 或渠道" onChange={event => filter('q', event.target.value)} /></label><label>类型<select className="mt-1 block rounded-xl border border-[var(--border-strong)] bg-[var(--surface-default)] px-3" value={params.get('type') ?? ''} onChange={event => filter('type', event.target.value)}><option value="">全部类型</option>{['文本', '图片理解', '生图', 'Search', 'Fetch', '基础服务'].map(type => <option key={type}>{type}</option>)}</select></label><label>状态<select className="mt-1 block rounded-xl border border-[var(--border-strong)] bg-[var(--surface-default)] px-3" value={params.get('status') ?? ''} onChange={event => filter('status', event.target.value)}><option value="">全部状态</option><option value="true">已启用</option><option value="false">已停用</option></select></label></AdminToolbar>
        <details className="rounded-xl border border-[var(--border-subtle)] px-4"><summary className="min-h-11 cursor-pointer py-3">更多筛选{['visible', 'config', 'channel'].filter(key => params.has(key)).length ? `（${['visible', 'config', 'channel'].filter(key => params.has(key)).length}）` : ''}</summary><div className="flex flex-wrap gap-4 pb-4"><label>用户可见性<select className="ml-2 rounded-lg border bg-[var(--surface-default)] px-2" value={params.get('visible') ?? ''} onChange={event => filter('visible', event.target.value)}><option value="">全部</option><option value="true">用户可选</option><option value="false">仅内部使用</option></select></label><label>配置状态<select className="ml-2 rounded-lg border bg-[var(--surface-default)] px-2" value={params.get('config') ?? ''} onChange={event => filter('config', event.target.value)}><option value="">全部</option><option value="true">配置完整</option><option value="false">待配置</option></select></label><label>渠道来源<select className="ml-2 rounded-lg border bg-[var(--surface-default)] px-2" value={params.get('channel') ?? ''} onChange={event => filter('channel', event.target.value)}><option value="">全部渠道</option>{[...new Set(query.data?.models.map(model => model.provider))].map(provider => <option key={provider}>{provider}</option>)}</select></label><Button variant="ghost" onClick={() => setParams({})}>清除筛选</Button></div></details>
        <div className="flex items-center justify-between"><p aria-live="polite">{filtered.length} 项匹配</p><Button disabled={archivedView} aria-pressed={sortMode} onClick={() => setSortMode(value => !value)}>{sortMode ? '完成排序' : '调整目录顺序'}</Button></div>
        {sortMode ? <AdminCard><h2 className="font-semibold">调整内置模型目录顺序</h2><p className="mt-1 text-[var(--text-secondary)]">仅对可排序的内置文本档位生效；每次移动即时保存。</p>{reorder.isError ? <p role="alert" className="my-3 text-rose-600">{reorder.error instanceof Error ? reorder.error.message : '排序失败'}</p> : null}<ol className="mt-3 divide-y divide-[var(--border-subtle)]">{catalog.map((model, index) => <li key={model.id} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0 break-words">{index + 1}. {model.displayName}</span><div className="flex gap-2"><Button aria-label={`上移 ${model.displayName}`} disabled={reorder.isPending || index === 0} onClick={() => moveModel(model.id, -1)}><ArrowUp className="h-4 w-4" /></Button><Button aria-label={`下移 ${model.displayName}`} disabled={reorder.isPending || index === catalog.length - 1} onClick={() => moveModel(model.id, 1)}><ArrowDown className="h-4 w-4" /></Button></div></li>)}</ol></AdminCard> : <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)]"><div className="hidden grid-cols-[1.2fr_0.7fr_1.5fr_0.7fr_0.8fr_0.7fr_0.6fr] gap-4 bg-[var(--surface-muted)] px-4 py-3 font-medium lg:grid"><span>显示名称</span><span>类型</span><span>实际模型 / 渠道</span><span>状态</span><span>用户可见性</span><span>最近检测</span><span>操作</span></div>{visible.map(model => <section key={model.id} aria-label={model.displayName} className="grid gap-3 border-t border-[var(--border-subtle)] bg-[var(--surface-default)] p-4 first:border-t-0 lg:grid-cols-[1.2fr_0.7fr_1.5fr_0.7fr_0.8fr_0.7fr_0.6fr] lg:items-center lg:gap-4"><div className="min-w-0"><h2 className="break-words font-semibold">{model.displayName}</h2><p className="mt-1 text-[var(--text-secondary)]">{model.configurationReady ? '配置完整' : '待配置'}{model.isDefault ? ' · 默认' : ''}</p></div><span>{typeLabel(model)}</span><div className="min-w-0 break-all text-[var(--text-secondary)]"><p>{model.modelName}</p><p>{model.provider}</p></div><span>{model.enabled ? '已启用' : '已停用'}</span><span>{model.modelKind === 'text' && model.selectable ? '用户可选' : '仅内部使用'}</span><span className="text-[var(--text-secondary)]">未检测</span><Button id={`edit-model-${model.id}`} onClick={() => editModel(model)} aria-label={`编辑 ${model.displayName}`}>编辑</Button></section>)}{!visible.length ? <p className="px-4 py-12 text-center text-[var(--text-secondary)]">没有匹配的模型，请调整筛选。</p> : null}</div>}
        {!sortMode ? <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[var(--text-secondary)]">共 {filtered.length} 项 · 每页 {pageSize} 项 · 第 {page} 页</span><div className="flex gap-2"><Button disabled={page <= 1} onClick={() => setParams(current => { const next = new URLSearchParams(current); next.set('page', String(page - 1)); return next }, { replace: true })}>上一页</Button><Button disabled={page * pageSize >= filtered.length} onClick={() => setParams(current => { const next = new URLSearchParams(current); next.set('page', String(page + 1)); return next }, { replace: true })}>下一页</Button></div></div> : null}
        <details className="rounded-xl border border-[var(--border-subtle)] p-4"><summary className="min-h-11 cursor-pointer py-2 font-medium">展开近 14 日全平台用量</summary><p className="my-3 text-[var(--text-secondary)]">来源：墨域本地调用记录，按日汇总（UTC+8）。覆盖全部档位及其历史实际模型，不代表当前模型或云枢渠道的历史。</p>{query.data?.trend.length ? <div className="space-y-2">{query.data.trend.map(item => <div key={item.date} className="flex flex-wrap justify-between gap-2 border-t border-[var(--border-subtle)] py-2"><time>{item.date}</time><span>{item.requests} 次 · {formatTokens(item.totalTokens)} Token</span></div>)}</div> : <p className="py-4 text-[var(--text-secondary)]">近 14 日暂无调用样本</p>}</details>
      </>}
      {!editing && params.get('model') && params.get('model') !== 'new' && query.data ? <p role="alert">该模型不存在或已不可访问。</p> : null}
    </AdminPanelState>
  </div>
}
