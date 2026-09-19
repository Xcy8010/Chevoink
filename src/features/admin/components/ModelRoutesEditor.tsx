import type { ModelRouteInput } from '../../../../shared/contracts/model-routes'
import TextInput from '@/components/ui/TextInput'
import Button from '@/components/ui/Button'

export function ModelRoutesEditor({ routes, onChange, defaults }: {
  routes: ModelRouteInput[]; onChange: (routes: ModelRouteInput[]) => void
  defaults: { provider: string; modelName: string; baseUrl: string; contextWindowTokens?: string; visionEnabled?: boolean; reasoningEfforts?: ModelRouteInput['reasoningEfforts'] }
}) {
  const update = (index: number, patch: Partial<ModelRouteInput>) => onChange(routes.map((route, i) => i === index ? { ...route, ...patch } : route))
  return <section className="mt-5 space-y-3 border-t border-[var(--border-subtle)] pt-4">
    <h3 className="text-sm font-semibold">同档位供应商线路</h3>
    <p className="text-xs text-[var(--text-secondary)]">主配置与启用的线路轮流分担请求；限流或服务失败时尝试其他线路。所有线路须支持上方推理强度、上下文窗口及视觉能力；用户仍按本档位费率计费。最多添加 7 条线路。</p>
    {routes.map((route, index) => <fieldset key={route.id ?? index} className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-3">
      <legend className="px-1 text-xs">线路 {index + 1}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">线路名称<TextInput value={route.label} onChange={event => update(index, { label: event.target.value })} /></label>
        <label className="text-xs">供应商<TextInput value={route.provider} onChange={event => update(index, { provider: event.target.value })} /></label>
        <label className="text-xs">模型 ID<TextInput value={route.modelName} onChange={event => update(index, { modelName: event.target.value })} /></label>
        <label className="text-xs">Base URL<TextInput value={route.baseUrl} onChange={event => update(index, { baseUrl: event.target.value })} /></label>
        <label className="text-xs">线路上下文窗口<TextInput type="number" min="16000" max="4000000" value={route.contextWindowTokens ?? defaults.contextWindowTokens ?? '128000'} onChange={event => update(index, { contextWindowTokens: Number(event.target.value) })} /></label>
        <div className="text-xs">线路推理强度<div className="mt-2 flex flex-wrap gap-2">{(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(effort => {
          const selected = route.reasoningEfforts ?? defaults.reasoningEfforts ?? []
          return <label key={effort}><input type="checkbox" checked={selected.includes(effort)} onChange={event => update(index, { reasoningEfforts: event.target.checked ? [...selected, effort] : selected.filter(value => value !== effort) })} />{effort}</label>
        })}</div></div>
        <label className="text-xs"><input type="checkbox" checked={route.visionEnabled ?? defaults.visionEnabled ?? false} onChange={event => update(index, { visionEnabled: event.target.checked })} />线路支持图片输入</label>
        <label className="text-xs sm:col-span-2">API Key<TextInput type="password" autoComplete="new-password" value={route.apiKey ?? ''} placeholder={route.id ? '留空保持已有密钥' : '填写此账号的密钥'} onChange={event => update(index, { apiKey: event.target.value || undefined })} /></label>
      </div>
      <div className="flex items-center justify-between"><label className="text-xs"><input type="checkbox" checked={route.enabled} onChange={event => update(index, { enabled: event.target.checked })} /> 启用</label><Button size="sm" variant="ghost" onClick={() => onChange(routes.filter((_, i) => i !== index))}>移除线路</Button></div>
    </fieldset>)}
    <Button size="sm" disabled={routes.length >= 7} onClick={() => onChange([...routes, { provider: defaults.provider, modelName: defaults.modelName, baseUrl: defaults.baseUrl, label: `线路 ${routes.length + 1}`, enabled: true,
      ...(defaults.contextWindowTokens ? { contextWindowTokens: Number(defaults.contextWindowTokens) } : {}),
      ...(defaults.visionEnabled !== undefined ? { visionEnabled: defaults.visionEnabled } : {}),
      ...(defaults.reasoningEfforts ? { reasoningEfforts: [...defaults.reasoningEfforts] } : {}),
    }])}>添加供应商线路</Button>
  </section>
}
