import { ModelActivitiesEditor } from './ModelActivitiesEditor'
import { BrainCircuit, Eye } from 'lucide-react'
import { useState, type Dispatch, type SetStateAction } from 'react'
import TextInput from './AdminTextInput'
import { IMAGE_QUALITY_OPTIONS } from '../../../../shared/contracts/image-model'
import type { ModelReasoningEffort } from '../../../../shared/contracts'
import type { WebToolProtocol } from '../../../../shared/contracts/web-tool'
import type { AdminModelForm, ModelRow } from '../pages/AdminModelsPage'
import { ModelRoutesEditor } from './ModelRoutesEditor'
import { WeightedRoutesEditor } from './WeightedRoutesEditor'

const REASONING_OPTIONS: ModelReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export function AdminModelEditorSections({ editing, form, setForm, section, fieldError }: {
  editing: ModelRow; form: AdminModelForm; setForm: Dispatch<SetStateAction<AdminModelForm>>; section: string; fieldError: { name: string; message: string } | null
}) {
  const [routeKind, setRouteKind] = useState<'legacy' | 'weighted'>('legacy')
  const editingTextModel = editing.modelKind === 'text'
  const availableReasoningOptions = form.provider.trim().toLowerCase() === 'deepseek'
    ? REASONING_OPTIONS.filter(effort => effort === 'low' || effort === 'high' || effort === 'max') : REASONING_OPTIONS
  function setImageQualityValues(supportedValues: string[], customValues?: string) {
    setForm(value => ({ ...value, ...(customValues !== undefined ? { imageQualityCustomValues: customValues } : {}),
      imageQuality: { supportedValues: [...new Set(supportedValues)],
        defaultValue: value.imageQuality?.defaultValue && supportedValues.includes(value.imageQuality.defaultValue) ? value.imageQuality.defaultValue : null } }))
  }

  function toggleReasoningEffort(effort: ModelReasoningEffort, checked: boolean) {
    setForm((value) => {
      const next = checked ? [...new Set([...value.reasoningEfforts, effort])] : value.reasoningEfforts.filter((item) => item !== effort)
      const safe = next.length > 0 ? next : [value.defaultReasoningEffort]
      return { ...value, reasoningEfforts: safe, defaultReasoningEffort: safe.includes(value.defaultReasoningEffort) ? value.defaultReasoningEffort : safe[0] }
    })
  }

  if (section === 'basic') return <div className="admin-model-fields space-y-6">
    {fieldError ? <p id="model-field-error" role="alert" className="text-rose-600">{fieldError.message}</p> : null}
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-[var(--text-secondary)]">连接配置</h3>
      <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
        <label className="block space-y-1.5 text-sm"><span>显示名称</span><TextInput name={`model-display-${editing.id}`} aria-invalid={fieldError?.name === `model-display-${editing.id}`} aria-describedby={fieldError?.name === `model-display-${editing.id}` ? 'model-field-error' : undefined} autoComplete="off" value={form.displayName} onChange={event => setForm(value => ({ ...value, displayName: event.target.value }))} /></label>
        <label className="block space-y-1.5 text-sm"><span>供应商</span><TextInput name={`model-provider-${editing.id}`} autoComplete="off" value={form.provider} onChange={event => setForm(value => ({ ...value, provider: event.target.value }))} /></label>
        <label className="block space-y-1.5 text-sm"><span>模型 ID</span><TextInput name={`model-id-${editing.id}`} aria-invalid={fieldError?.name === `model-id-${editing.id}`} aria-describedby={fieldError?.name === `model-id-${editing.id}` ? 'model-field-error' : undefined} autoComplete="off" value={form.modelName} onChange={event => setForm(value => ({ ...value, modelName: event.target.value }))} /></label>
        <label className="block space-y-1.5 text-sm"><span>Base URL</span><TextInput name={`model-endpoint-${editing.id}`} autoComplete="off" inputMode="url" data-lpignore="true" data-1p-ignore="true" value={form.baseUrl} onChange={event => setForm(value => ({ ...value, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label>
        <label className="block space-y-1.5 text-sm md:col-span-2"><span>替换 API Key</span><TextInput name={`model-secret-${editing.id}`} type="password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" value={form.apiKey} onChange={event => setForm(value => ({ ...value, apiKey: event.target.value }))} placeholder={editing.apiKeyConfigured ? '已配置，留空保留原密钥' : '填写服务密钥'} /></label>
        {editing.modelKind === 'web_search' || editing.modelKind === 'web_fetch' ? <label className="block space-y-1.5 text-sm"><span>网页工具协议</span><select aria-label="网页工具协议" value={form.webToolProtocol} onChange={event => setForm(value => ({ ...value, webToolProtocol: event.target.value as '' | WebToolProtocol }))} className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2"><option value="">请选择协议</option><option value="deepseek">deepseek</option>{editing.modelKind === 'web_search' ? <option value="bocha">bocha</option> : null}</select></label> : null}
      </div>
    </section>
    <section className="space-y-3 border-t border-[var(--border-subtle)] pt-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)]">用户展示</h3>
      <div className="grid gap-5 md:grid-cols-2">
        <label className="block space-y-1.5 text-sm"><span>公开模型说明</span><textarea rows={3} className="w-full resize-y rounded-lg border border-[var(--border-strong)] bg-transparent px-3 py-2" value={form.publicDescription} onChange={event => setForm(value => ({ ...value, publicDescription: event.target.value }))} /></label>
        <label className="block space-y-1.5 text-sm"><span>公开特性（每行一项）</span><textarea rows={3} className="w-full resize-y rounded-lg border border-[var(--border-strong)] bg-transparent px-3 py-2" value={form.publicFeatures.join('\n')} onChange={event => setForm(value => ({ ...value, publicFeatures: event.target.value.split('\n') }))} /></label>
      </div>
    </section>
    <section className="space-y-3 border-t border-[var(--border-subtle)] pt-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)]">使用范围</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] px-3 py-2"><input type="checkbox" checked={form.enabled} onChange={event => setForm(value => ({ ...value, enabled: event.target.checked, ...(!event.target.checked ? { testerSelectable: false, isDefault: false } : {}) }))} /><span>启用服务</span></label>
        {editingTextModel ? <>
          <label className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] px-3 py-2"><input type="checkbox" checked={form.selectable} onChange={event => setForm(value => ({ ...value, selectable: event.target.checked, testerSelectable: false, ...(!event.target.checked ? { isDefault: false } : {}) }))} /><span>允许用户选择</span></label>
          {form.enabled && !form.selectable ? <label className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] px-3 py-2"><input type="checkbox" aria-label="允许测试员选择" checked={Boolean(form.testerSelectable)} onChange={event => setForm(value => ({ ...value, testerSelectable: event.target.checked }))} /><span><span className="block">允许测试员选择</span><span className="text-xs text-[var(--text-tertiary)]">仅测试员和超级管理员可选</span></span></label> : null}
          <label className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] px-3 py-2"><input type="checkbox" checked={form.isDefault} disabled={!form.enabled || !form.selectable} onChange={event => setForm(value => ({ ...value, isDefault: event.target.checked }))} /><span>设为默认</span></label>
        </> : null}
      </div>
    </section>
  </div>
  if (section === 'capability') return <div className="admin-model-fields space-y-4">
{editingTextModel ? <label className="text-sm sm:col-span-2">上下文窗口（Tokens）<TextInput className="mt-1.5" name={`model-context-window-${editing.id}`} autoComplete="off" type="number" min="16000" max="4000000" step="1000" value={form.contextWindowTokens} onChange={(e) => setForm((v) => ({ ...v, contextWindowTokens: e.target.value }))} /><span className="mt-1.5 block text-[11px] leading-5 text-[var(--text-secondary)]">按供应商文档填写；Agent 自动压缩与输出预留将采用此值。</span></label> : null}      {editing.modelKind === 'image_generation' ? <fieldset className="mt-5 border-y border-[var(--border-subtle)] py-4">
        <legend className="text-sm font-medium">图片生成质量</legend>
        <div className="mt-2 flex flex-wrap gap-2">{IMAGE_QUALITY_OPTIONS.map(option => <label key={option.value} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm">
          <input type="checkbox" checked={form.imageQuality?.supportedValues.includes(option.value) ?? false} onChange={event => setImageQualityValues(event.target.checked
            ? [...(form.imageQuality?.supportedValues ?? []), option.value]
            : (form.imageQuality?.supportedValues ?? []).filter(value => value !== option.value))} />{option.label} ({option.value})
        </label>)}</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">自定义质量值（逗号分隔）<TextInput className="mt-1.5" value={form.imageQualityCustomValues} onChange={event => setImageQualityValues([
            ...(form.imageQuality?.supportedValues ?? []).filter(value => IMAGE_QUALITY_OPTIONS.some(option => option.value === value)),
            ...event.target.value.split(',').map(value => value.trim()).filter(Boolean),
          ], event.target.value)} /></label>
          <label className="text-sm">默认图片质量<select aria-label="默认图片质量" value={form.imageQuality?.defaultValue ?? ''} onChange={event => setForm(value => ({ ...value,
            imageQuality: { supportedValues: value.imageQuality?.supportedValues ?? [], defaultValue: event.target.value || null } }))} className="mt-1.5 min-h-11 w-full rounded-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-4">
            <option value="">不传此参数</option>{form.imageQuality?.supportedValues.map(value => <option key={value} value={value}>{IMAGE_QUALITY_OPTIONS.find(option => option.value === value)?.label ?? value} ({value})</option>)}
          </select></label>
        </div>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">较高质量通常增加耗时和费用，具体取决于上游。</p>
      </fieldset> : null}
      {editingTextModel ? <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">推理参数协议<select aria-label="推理参数协议" value={form.reasoningParameterMode} onChange={event => setForm(value => ({ ...value, reasoningParameterMode: event.target.value as typeof value.reasoningParameterMode }))} className="mt-1.5 min-h-11 w-full rounded-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-4"><option value="">沿用兼容规则</option><option value="native">reasoning_effort</option><option value="omit">省略推理参数</option></select></label>
        <label className="text-sm">输出上限参数<select aria-label="输出上限参数" value={form.outputTokenParameter} onChange={event => setForm(value => ({ ...value, outputTokenParameter: event.target.value as typeof value.outputTokenParameter }))} className="mt-1.5 min-h-11 w-full rounded-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-4"><option value="">沿用兼容规则</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
        <label className="text-sm">thinking 参数<select aria-label="thinking 参数" value={form.thinkingEnabled} onChange={event => setForm(value => ({ ...value, thinkingEnabled: event.target.value as typeof value.thinkingEnabled }))} className="mt-1.5 min-h-11 w-full rounded-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-4"><option value="">未声明</option><option value="enabled">支持 enabled</option><option value="disabled">不发送</option></select></label>
      </div> : null}
      {editingTextModel ? <div className="mt-5 border-y border-[var(--border-subtle)] py-4"><div className="flex items-center gap-2 text-sm font-medium"><BrainCircuit className="h-4 w-4" />推理强度</div><div className="mt-3 flex flex-wrap gap-2">{availableReasoningOptions.map((effort) => <label key={effort} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm"><input type="checkbox" checked={form.reasoningEfforts.includes(effort)} onChange={(event) => toggleReasoningEffort(effort, event.target.checked)} />{effort}</label>)}</div><label className="mt-4 block text-sm">默认强度<select value={form.defaultReasoningEffort} onChange={(event) => setForm((value) => ({ ...value, defaultReasoningEffort: event.target.value as ModelReasoningEffort }))} className="mt-1.5 min-h-11 w-full rounded-full border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 text-sm">{form.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label><label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.visionEnabled} onChange={(event) => setForm((value) => ({ ...value, visionEnabled: event.target.checked }))} /><Eye className="h-4 w-4" />支持 OpenAI 兼容图片输入</label></div> : null}
{!editingTextModel && editing.modelKind !== 'image_generation' ? <p className="text-sm text-[var(--text-secondary)]">{editing.modelKind === 'vision' ? '图片理解沿用基本配置中的模型、地址与密钥。' : '网页工具使用独立 Search / Fetch 协议，无需配置文本推理与输出参数。'}</p> : null}</div>
  if (section === 'routes') return <div className="admin-model-fields space-y-4">
      {editingTextModel || editing.modelKind === 'image_generation' ? <div className="flex flex-wrap gap-2"><button type="button" aria-pressed={routeKind === 'legacy'} className="rounded-xl border border-[var(--border-subtle)] px-4 py-3" onClick={() => setRouteKind('legacy')}>原有供应商线路（{form.routes.length}）</button><button type="button" aria-pressed={routeKind === 'weighted'} className="rounded-xl border border-[var(--border-subtle)] px-4 py-3" onClick={() => setRouteKind('weighted')}>权重线路（{form.weightedRoutes.candidates.length}）</button></div> : null}
      {editingTextModel && routeKind === 'legacy' && <ModelRoutesEditor routes={form.routes} onChange={routes => setForm(value => ({ ...value, routes }))} defaults={form} />}
      {editing.modelKind === 'image_generation' && routeKind === 'legacy' && <ModelRoutesEditor imageGeneration routes={form.routes} onChange={routes => setForm(value => ({ ...value, routes }))} defaults={form} />}
      {editing.activityStatus && <p className="text-sm">服务端当前：{editing.activityStatus.name ?? '无活动'} · {editing.multiplier}x · {editing.activityStatus.timezone}{editing.activityStatus.nextSwitchAt ? ' · 下次切换 ' + editing.activityStatus.nextSwitchAt : ''}</p>}
    {(editingTextModel || editing.modelKind === 'image_generation') && routeKind === 'weighted' && <WeightedRoutesEditor imageGeneration={editing.modelKind === 'image_generation'} value={form.weightedRoutes} onChange={weightedRoutes => setForm(value => ({ ...value, weightedRoutes }))} defaults={form} />}
{!editingTextModel && editing.modelKind !== 'image_generation' ? <p className="text-sm text-[var(--text-secondary)]">此工具使用基本配置中的独立地址和密钥。</p> : null}</div>
  if (section === 'billing') return <div className="admin-model-fields space-y-4">
    {editing.pricing ? <><h3 className="font-medium">活动前基础分项费率</h3><p className="text-sm text-[var(--text-secondary)]">Credits / 百万 Token · 已包含倍率。修改旧版倍率不会修改已生效费率；历史调用仍使用调用时的价格。</p><dl className="grid gap-3 sm:grid-cols-3"><div><dt>未缓存输入</dt><dd>{editing.pricing.inputPerMillion}</dd></div><div><dt>缓存输入</dt><dd>{editing.pricing.cachePerMillion}</dd></div><div><dt>输出</dt><dd>{editing.pricing.outputPerMillion}</dd></div></dl><p className="break-all text-sm text-[var(--text-secondary)]">费率卡 {editing.pricing.rateCardId}</p></> : null}
    <p className="text-sm text-[var(--text-secondary)]">{editing.pricing ? '以下倍率仅适用于旧版计价。' : '现有倍率与免费期限保持原计价规则。'}</p>
<label className="text-sm">Credits 倍率<TextInput className="mt-1.5" name={`model-multiplier-${editing.id}`} autoComplete="off" type="number" min="0" step="0.0001" value={form.multiplier} onChange={(e) => setForm((v) => ({ ...v, multiplier: e.target.value }))} /></label>      {editingTextModel && Number(form.multiplier) === 0 ? <div className="mt-4 space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.limitedFree} onChange={event => setForm(value => ({ ...value, limitedFree: event.target.checked }))} />限时免费</label>
        {form.limitedFree ? <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">截止时间<TextInput type="datetime-local" required value={form.freeUntil} onChange={event => setForm(value => ({ ...value, freeUntil: event.target.value }))} /></label>
          <label className="text-sm">到期 Credits 倍率<TextInput type="number" min="0.0001" max="100" step="0.1" required value={form.afterMultiplier} onChange={event => setForm(value => ({ ...value, afterMultiplier: event.target.value }))} /></label>
        </div> : null}
      </div> : null}
    {(editingTextModel || editing.modelKind === 'image_generation') && <ModelActivitiesEditor value={form.activities} onChange={activities => setForm(value => ({ ...value, activities }))} />}
</div>
  return null
}
