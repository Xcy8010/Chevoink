import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit, Eye, Globe2, ImagePlus, KeyRound, Pencil, ScanSearch, X } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import type { ModelReasoningEffort } from '../../../../shared/contracts'
import { AdminCard, AdminPageHeader, AdminPanelState } from '../AdminLayout'
import { formatTokens } from '../admin-shared'
import { getAdminModelManagement, updateAdminModel } from '../api'
import { ModelRoutesEditor } from '../components/ModelRoutesEditor'
import type { ModelRouteInput } from '../../../../shared/contracts/model-routes'

type ModelRow = NonNullable<ReturnType<typeof getAdminModelManagement> extends Promise<infer T> ? T : never>['models'][number]
const REASONING_OPTIONS: ModelReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export default function AdminModelsPage() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['admin', 'models'], queryFn: getAdminModelManagement })
  const [editing, setEditing] = useState<ModelRow | null>(null)
  const [form, setForm] = useState({
    provider: '', displayName: '', modelName: '', baseUrl: '', apiKey: '', multiplier: '1',
    enabled: true, selectable: true, isDefault: false,
    reasoningEfforts: ['high'] as ModelReasoningEffort[], defaultReasoningEffort: 'high' as ModelReasoningEffort,
    visionEnabled: false, contextWindowTokens: '128000',
    routes: [] as ModelRouteInput[],
    limitedFree: false, freeUntil: '', afterMultiplier: '1.5',
  })

  useEffect(() => {
    if (!editing) return
    setForm({
      provider: editing.provider, displayName: editing.displayName, modelName: editing.modelName,
      baseUrl: editing.baseUrl ?? '', apiKey: '', multiplier: String(editing.multiplier),
      enabled: editing.enabled, selectable: editing.selectable, isDefault: editing.isDefault,
      reasoningEfforts: editing.reasoningEfforts, defaultReasoningEffort: editing.defaultReasoningEffort,
      visionEnabled: editing.visionEnabled, contextWindowTokens: String(editing.contextWindowTokens ?? 128000),
      routes: (editing.routes ?? []).map(({ apiKeyConfigured: _configured, ...route }) => route),
      limitedFree: editing.multiplier === 0 && Boolean(editing.freePromotion),
      freeUntil: editing.freePromotion ? new Date(Date.parse(editing.freePromotion.endsAt) - new Date(editing.freePromotion.endsAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '',
      afterMultiplier: String(editing.freePromotion?.afterMultiplier ?? 1.5),
    })
  }, [editing])

  useEffect(() => {
    if (form.provider.trim().toLowerCase() !== 'deepseek') return
    const supported: ModelReasoningEffort[] = form.reasoningEfforts.filter((effort) => effort === 'low' || effort === 'high' || effort === 'max')
    const reasoningEfforts: ModelReasoningEffort[] = supported.length > 0 ? supported : ['high']
    if (reasoningEfforts.length === form.reasoningEfforts.length && reasoningEfforts.every((effort, index) => effort === form.reasoningEfforts[index])) return
    setForm((value) => ({ ...value, reasoningEfforts, defaultReasoningEffort: reasoningEfforts.includes(value.defaultReasoningEffort) ? value.defaultReasoningEffort : reasoningEfforts[0] }))
  }, [form.provider, form.reasoningEfforts])

  const mutation = useMutation({
    mutationFn: () => {
      if (!editing) return Promise.resolve({ ok: true as const })
      const limitedFree = Number(form.multiplier) === 0 && form.limitedFree
      const expires = Date.parse(form.freeUntil)
      if (limitedFree && (!Number.isFinite(expires) || expires <= Date.now())) throw new Error('请选择未来的截止时间')
      return updateAdminModel(editing.id, { ...form, baseUrl: form.baseUrl || null, apiKey: form.apiKey || undefined, multiplier: Number(form.multiplier), contextWindowTokens: editing.modelKind === 'text' ? Number(form.contextWindowTokens) : undefined,
        freePromotion: limitedFree ? { endsAt: new Date(expires).toISOString(), afterMultiplier: Number(form.afterMultiplier) } : null })
    },
    onSuccess: async () => {
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
      await queryClient.invalidateQueries({ queryKey: ['credits', 'summary'] })
    },
  })
  const maxTrend = useMemo(() => Math.max(1, ...(query.data?.trend.map((item) => item.totalTokens) ?? [1])), [query.data?.trend])
  const trendPoints = useMemo(() => {
    const items = query.data?.trend ?? []
    return items.map((item, index) => ({
      ...item,
      x: items.length <= 1 ? 350 : 20 + index * (660 / (items.length - 1)),
      y: 140 - (item.totalTokens / maxTrend) * 120,
    }))
  }, [maxTrend, query.data?.trend])
  const availableReasoningOptions = form.provider.trim().toLowerCase() === 'deepseek'
    ? REASONING_OPTIONS.filter((effort) => effort === 'low' || effort === 'high' || effort === 'max')
    : REASONING_OPTIONS
  const editingTextModel = editing?.modelKind === 'text'
  const kindPresentation = (model: ModelRow) => model.modelKind === 'image_generation'
    ? { label: '图片生成', icon: ImagePlus }
    : model.modelKind === 'vision'
      ? { label: '图片理解', icon: ScanSearch }
      : model.modelKind === 'web_search'
        ? { label: '联网搜索', icon: Globe2 }
        : { label: '文本模型', icon: BrainCircuit }

  function toggleReasoningEffort(effort: ModelReasoningEffort, checked: boolean) {
    setForm((value) => {
      const next = checked ? [...new Set([...value.reasoningEfforts, effort])] : value.reasoningEfforts.filter((item) => item !== effort)
      const safe = next.length > 0 ? next : [value.defaultReasoningEffort]
      return { ...value, reasoningEfforts: safe, defaultReasoningEffort: safe.includes(value.defaultReasoningEffort) ? value.defaultReasoningEffort : safe[0] }
    })
  }

  return <div>
    <AdminPageHeader title="模型管理" description="配置内置模型、推理能力、视觉能力和 Credits 倍率；API Key 加密存储，只能替换，不能查看。" />
    <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}>
      {query.data ? <div className="space-y-4">
        <AdminCard>
          <div className="flex items-baseline justify-between gap-4"><h2 className="text-sm font-semibold">近 14 日模型用量</h2><span className="text-[10px] text-[var(--text-tertiary)]">Token</span></div>
          {trendPoints.length > 0 ? <div className="mt-4 overflow-hidden"><svg viewBox="0 0 700 164" className="h-40 w-full" role="img" aria-label="近 14 日模型 Token 用量折线图">
            {[20, 60, 100, 140].map((y) => <line key={y} x1="20" x2="680" y1={y} y2={y} stroke="var(--border-subtle)" strokeWidth="1" />)}
            <polyline fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={trendPoints.map((point) => `${point.x},${point.y}`).join(' ')} />
            {trendPoints.map((point) => <g key={point.date}><circle cx={point.x} cy={point.y} r="3.5" fill="var(--surface-default)" stroke="var(--text-primary)" strokeWidth="2"><title>{point.date} · {formatTokens(point.totalTokens)} Token · {point.requests} 次请求</title></circle><text x={point.x} y="160" textAnchor="middle" fill="var(--text-tertiary)" fontSize="9">{point.date.slice(5)}</text></g>)}
          </svg></div> : <p className="py-10 text-center text-xs text-[var(--text-tertiary)]">近 14 日暂无模型调用</p>}
        </AdminCard>

        <div className="grid gap-3 lg:grid-cols-2">{query.data.models.map((model) => { const kind = kindPresentation(model); const KindIcon = kind.icon; return <AdminCard key={model.id}>
          <div className="flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{model.displayName}</h2><span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]"><KindIcon className="h-3 w-3" />{kind.label}</span><span className="text-xs text-[var(--text-tertiary)]">{model.multiplier.toFixed(1)}x</span>{model.isDefault ? <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]">默认</span> : null}<span className={`rounded-full px-2 py-0.5 text-[10px] ${model.configurationReady ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{model.configurationReady ? '配置完整' : '待配置'}</span></div><p className="mt-1 text-xs text-[var(--text-secondary)]">{model.provider} · {model.modelName}</p></div><Button size="sm" onClick={() => setEditing(model)}><Pencil className="h-3.5 w-3.5" />编辑</Button></div>
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-[var(--border-subtle)] pt-4 text-xs"><div><p className="text-[var(--text-tertiary)]">请求</p><p className="mt-1 font-medium">{model.requestCount.toLocaleString('zh-CN')}</p></div><div><p className="text-[var(--text-tertiary)]">输入</p><p className="mt-1 font-medium">{formatTokens(model.requestTokens)}</p></div><div><p className="text-[var(--text-tertiary)]">输出</p><p className="mt-1 font-medium">{formatTokens(model.responseTokens)}</p></div></div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]"><span>{model.enabled ? '服务已启用' : '服务已停用'}</span>{model.modelKind === 'text' ? <><span>{model.selectable ? '用户可选择' : '用户不可选'}</span><span className="inline-flex items-center gap-1"><BrainCircuit className="h-3.5 w-3.5" />{model.reasoningEfforts.join(' / ')}</span><span>{model.contextWindowTokens ? `${Math.round(model.contextWindowTokens / 1000)}K 上下文` : '默认上下文'}</span></> : <span>由 Agent 工具调用</span>}{model.visionEnabled ? <span className="inline-flex items-center gap-1"><Eye className="h-3.5 w-3.5" />图片输入</span> : null}<span className="ml-auto inline-flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" />{model.apiKeyConfigured ? '密钥已配置' : model.tier === 'speed' ? '沿用环境密钥' : '未配置密钥'}</span></div>
        </AdminCard> })}</div>
      </div> : null}
    </AdminPanelState>

    {query.data?.models.some(model => model.pricing) ? <AdminCard className="mt-4">
      <h2 className="text-sm font-semibold">当前生效的分项费率</h2>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">以下模型按费率卡结算，单位为 Credits / 百万 Token。已包含倍率，不再额外相乘；上方倍率仅适用于旧版计价，修改倍率不会修改这些已生效费率。历史调用仍按调用时的价格结算。</p>
      <div className="mt-3 space-y-3">{query.data.models.filter(model => model.pricing).map(model => <div key={model.id} className="rounded-xl border border-[var(--border-subtle)] p-3 text-xs">
        <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{model.displayName}</span><span className="break-all text-[var(--text-tertiary)]">{model.pricing!.rateCardId}</span></div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1"><span>未缓存输入 {model.pricing!.inputPerMillion}</span><span>缓存输入 {model.pricing!.cachePerMillion}</span><span>输出 {model.pricing!.outputPerMillion}</span></div>
      </div>)}</div>
    </AdminCard> : null}

    {editing ? <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/35 px-4 backdrop-blur-[2px]"><section className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-[18px] border border-[var(--border-strong)] bg-[var(--surface-default)] p-5 shadow-[0_24px_70px_rgba(15,23,42,0.2)]">
      <div className="flex items-center justify-between"><div><h2 className="font-semibold">编辑 {editing.displayName}</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">真实模型 ID 仅在管理端显示；未完成服务配置的高阶档位无法开放。</p></div><button type="button" onClick={() => setEditing(null)} className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--surface-muted)]"><X className="h-4 w-4" /></button></div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-xs">显示名称<TextInput className="mt-1.5" name={`model-display-${editing.id}`} autoComplete="off" value={form.displayName} onChange={(e) => setForm((v) => ({ ...v, displayName: e.target.value }))} /></label><label className="text-xs">供应商<TextInput className="mt-1.5" name={`model-provider-${editing.id}`} autoComplete="off" value={form.provider} onChange={(e) => setForm((v) => ({ ...v, provider: e.target.value }))} /></label><label className="text-xs">模型 ID<TextInput className="mt-1.5" name={`model-id-${editing.id}`} autoComplete="off" value={form.modelName} onChange={(e) => setForm((v) => ({ ...v, modelName: e.target.value }))} /></label><label className="text-xs">Credits 倍率<TextInput className="mt-1.5" name={`model-multiplier-${editing.id}`} autoComplete="off" type="number" min="0" step="0.1" value={form.multiplier} onChange={(e) => setForm((v) => ({ ...v, multiplier: e.target.value }))} /></label>{editingTextModel ? <label className="text-xs sm:col-span-2">上下文窗口（Tokens）<TextInput className="mt-1.5" name={`model-context-window-${editing.id}`} autoComplete="off" type="number" min="16000" max="4000000" step="1000" value={form.contextWindowTokens} onChange={(e) => setForm((v) => ({ ...v, contextWindowTokens: e.target.value }))} /><span className="mt-1.5 block text-[11px] leading-5 text-[var(--text-secondary)]">按供应商文档填写；Agent 自动压缩与输出预留将采用此值。</span></label> : null}<label className="text-xs sm:col-span-2">Base URL<TextInput className="mt-1.5" name={`model-endpoint-${editing.id}`} autoComplete="off" inputMode="url" data-lpignore="true" data-1p-ignore="true" value={form.baseUrl} onChange={(e) => setForm((v) => ({ ...v, baseUrl: e.target.value }))} placeholder="https://api.example.com/v1" /></label><label className="text-xs sm:col-span-2">替换 API Key<TextInput className="mt-1.5" name={`model-secret-${editing.id}`} type="password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" value={form.apiKey} onChange={(e) => setForm((v) => ({ ...v, apiKey: e.target.value }))} placeholder={editing.apiKeyConfigured ? '已配置；留空保持不变，输入新值即替换' : '必须填写后才能开放该档位'} /></label></div>
      {editingTextModel ? <div className="mt-5 border-y border-[var(--border-subtle)] py-4"><div className="flex items-center gap-2 text-sm font-medium"><BrainCircuit className="h-4 w-4" />推理强度</div><div className="mt-3 flex flex-wrap gap-2">{availableReasoningOptions.map((effort) => <label key={effort} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2.5 py-1.5 text-xs"><input type="checkbox" checked={form.reasoningEfforts.includes(effort)} onChange={(event) => toggleReasoningEffort(effort, event.target.checked)} />{effort}</label>)}</div><label className="mt-4 block text-xs">默认强度<select value={form.defaultReasoningEffort} onChange={(event) => setForm((value) => ({ ...value, defaultReasoningEffort: event.target.value as ModelReasoningEffort }))} className="mt-1.5 h-10 w-full rounded-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 text-sm">{form.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label><label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.visionEnabled} onChange={(event) => setForm((value) => ({ ...value, visionEnabled: event.target.checked }))} /><Eye className="h-4 w-4" />支持 OpenAI 兼容图片输入</label></div> : null}
      <div className="mt-5 flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm((v) => ({ ...v, enabled: e.target.checked }))} />启用服务</label>{editingTextModel ? <><label className="flex items-center gap-2"><input type="checkbox" checked={form.selectable} onChange={(e) => setForm((v) => ({ ...v, selectable: e.target.checked }))} />允许用户选择</label><label className="flex items-center gap-2"><input type="checkbox" checked={form.isDefault} onChange={(e) => setForm((v) => ({ ...v, isDefault: e.target.checked }))} />设为默认</label></> : null}</div>
      {editingTextModel && <ModelRoutesEditor routes={form.routes} onChange={routes => setForm(value => ({ ...value, routes }))} defaults={form} />}
      {editingTextModel && Number(form.multiplier) === 0 ? <div className="mt-4 space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.limitedFree} onChange={event => setForm(value => ({ ...value, limitedFree: event.target.checked }))} />限时免费</label>
        {form.limitedFree ? <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs">截止时间<TextInput type="datetime-local" required value={form.freeUntil} onChange={event => setForm(value => ({ ...value, freeUntil: event.target.value }))} /></label>
          <label className="text-xs">到期 Credits 倍率<TextInput type="number" min="0.0001" max="100" step="0.1" required value={form.afterMultiplier} onChange={event => setForm(value => ({ ...value, afterMultiplier: event.target.value }))} /></label>
        </div> : null}
      </div> : null}
      {mutation.isError ? <p className="mt-3 text-xs text-rose-600">{mutation.error instanceof Error ? mutation.error.message : '保存失败'}</p> : null}
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={() => setEditing(null)}>取消</Button><Button variant="primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>保存配置</Button></div>
    </section></div> : null}
  </div>
}
