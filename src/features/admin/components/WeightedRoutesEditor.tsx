import { sumWeightedRouteWeights, type WeightedRoutesInput, type WeightedRouteCandidateInput } from '../../../../shared/contracts/model-weighted-routes'
import TextInput from '@/components/ui/TextInput'
import Button from '@/components/ui/Button'

export function WeightedRoutesEditor({ value, onChange, defaults }: {
  value: WeightedRoutesInput; onChange: (value: WeightedRoutesInput) => void
  defaults: { provider: string; modelName: string; baseUrl: string }
}) {
  const update = (index: number, patch: Partial<WeightedRouteCandidateInput>) => onChange({ ...value,
    candidates: value.candidates.map((route, at) => at === index ? { ...route, ...patch } : route) })
  return <section className="mt-5 space-y-3 border-t border-[var(--border-subtle)] pt-4" aria-label="同档位权重供应商线路">
    <h3 className="text-sm font-semibold">同档位权重供应商线路</h3>
    <label className="block text-xs">主配置及原线路的入口概率 (%)<TextInput type="number" min="0" max="100" step="any" value={value.primaryWeight} onChange={event => onChange({ ...value, primaryWeight: Number(event.target.value) })} /></label>
    {value.candidates.map((route, index) => <fieldset key={route.id ?? index} className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-3">
      <legend className="px-1 text-xs">权重线路 {index + 1}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">权重线路名称<TextInput value={route.label} onChange={event => update(index, { label: event.target.value })} /></label>
        <label className="text-xs">线路入口概率 (%)<TextInput type="number" min="0" max="100" step="any" value={route.weight} onChange={event => update(index, { weight: Number(event.target.value) })} /></label>
        <label className="text-xs">权重线路供应商<TextInput value={route.provider} onChange={event => update(index, { provider: event.target.value })} /></label>
        <label className="text-xs">权重线路模型 ID<TextInput value={route.modelName} onChange={event => update(index, { modelName: event.target.value })} /></label>
        <label className="text-xs sm:col-span-2">权重线路 Base URL<TextInput value={route.baseUrl} onChange={event => update(index, { baseUrl: event.target.value })} /></label>
        <label className="text-xs sm:col-span-2">权重线路 API Key<TextInput type="password" autoComplete="new-password" value={route.apiKey ?? ''} placeholder={route.id ? '留空保持已有密钥' : '填写此账号的密钥'} onChange={event => update(index, { apiKey: event.target.value || undefined })} /></label>
      </div>
      <Button size="sm" variant="ghost" onClick={() => { const candidates = value.candidates.filter((_, at) => at !== index); onChange({ primaryWeight: candidates.length ? value.primaryWeight : 100, candidates }) }}>移除权重线路</Button>
    </fieldset>)}
    <div className="flex items-center justify-between"><Button size="sm" onClick={() => onChange({ ...value, candidates: [...value.candidates,
      { provider: defaults.provider, modelName: defaults.modelName, baseUrl: defaults.baseUrl, label: '权重线路 ' + (value.candidates.length + 1), weight: 0 }] })}>添加权重线路</Button>
      <span className="text-xs text-[var(--text-secondary)]">合计 {sumWeightedRouteWeights([value.primaryWeight, ...value.candidates.map(route => route.weight)])}%</span></div>
  </section>
}
