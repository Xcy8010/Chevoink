import { useState } from 'react'
import { sumWeightedRouteWeights, type WeightedRoutesInput, type WeightedRouteCandidateInput } from '../../../../shared/contracts/model-weighted-routes'
import { IMAGE_QUALITY_OPTIONS } from '../../../../shared/contracts/image-model'
import TextInput from './AdminTextInput'
import Button from '@/components/ui/Button'

export function WeightedRoutesEditor({ value, onChange, defaults, imageGeneration = false }: {
  imageGeneration?: boolean
  value: WeightedRoutesInput; onChange: (value: WeightedRoutesInput) => void
  defaults: { provider: string; modelName: string; baseUrl: string }
}) {
  const [active, setActive] = useState<number | null>(null)
  const update = (index: number, patch: Partial<WeightedRouteCandidateInput>) => onChange({ ...value,
    candidates: value.candidates.map((route, at) => at === index ? { ...route, ...patch } : route) })
  return <section className="mt-5 space-y-3 border-t border-[var(--border-subtle)] pt-4" aria-label="同档位权重供应商线路">
    <h3 className="text-sm font-semibold">同档位权重供应商线路</h3>
    <label className="block text-sm">主配置及原线路的入口概率 (%)<TextInput type="number" min="0" max="100" step="any" value={value.primaryWeight} onChange={event => onChange({ ...value, primaryWeight: Number(event.target.value) })} /></label>
    {value.candidates.map((route, index) => <fieldset key={route.id ?? index} className="space-y-3 border-b border-[var(--border-subtle)] py-4">
      <legend className="px-1 text-sm">权重线路 {index + 1}</legend>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="break-words font-medium">{route.label || `权重线路 ${index + 1}`}</p><p className="break-all text-sm text-[var(--text-secondary)]">{route.provider} · {route.modelName} · {route.weight}%</p></div><Button className="min-h-11" aria-expanded={active === index} onClick={() => setActive(active === index ? null : index)}>{active === index ? '收起权重线路' : `编辑权重线路 ${index + 1}`}</Button></div>
      {active === index ? <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm sm:col-span-2"><input type="checkbox" checked={route.enabled !== false} onChange={event => update(index, { enabled: event.target.checked })} />启用线路</label>
        <label className="text-sm">权重线路名称<TextInput value={route.label} onChange={event => update(index, { label: event.target.value })} /></label>
        <label className="text-sm">线路入口概率 (%)<TextInput type="number" min="0" max="100" step="any" value={route.weight} onChange={event => update(index, { weight: Number(event.target.value) })} /></label>
        <label className="text-sm">权重线路供应商<TextInput value={route.provider} onChange={event => update(index, { provider: event.target.value })} /></label>
        <label className="text-sm">权重线路模型 ID<TextInput value={route.modelName} onChange={event => update(index, { modelName: event.target.value })} /></label>
        <label className="text-sm sm:col-span-2">权重线路 Base URL<TextInput value={route.baseUrl} onChange={event => update(index, { baseUrl: event.target.value })} /></label>
        <label className="text-sm sm:col-span-2">权重线路 API Key<TextInput type="password" autoComplete="new-password" value={route.apiKey ?? ''} placeholder={route.id ? '留空保持已有密钥' : '填写此账号的密钥'} onChange={event => update(index, { apiKey: event.target.value || undefined })} /></label>
        {imageGeneration ? <label className="text-sm">此线路图片质量<select aria-label="此线路图片质量" value={route.imageQuality?.defaultValue ?? ''} onChange={event => update(index, { imageQuality: { supportedValues: event.target.value ? [event.target.value] : [], defaultValue: event.target.value || null } })}><option value="">不传质量参数</option>{IMAGE_QUALITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
      </div> : null}
      <Button size="sm" variant="ghost" onClick={() => { setActive(null); const candidates = value.candidates.filter((_, at) => at !== index); onChange({ primaryWeight: candidates.length ? value.primaryWeight : 100, candidates }) }}>移除权重线路</Button>
    </fieldset>)}
    <div className="flex items-center justify-between"><Button size="sm" onClick={() => { setActive(value.candidates.length); onChange({ ...value, candidates: [...value.candidates,
      { provider: defaults.provider, modelName: defaults.modelName, baseUrl: defaults.baseUrl, label: '权重线路 ' + (value.candidates.length + 1), weight: 0 }] }) }}>添加权重线路</Button>
      <span className="text-sm text-[var(--text-secondary)]">合计 {sumWeightedRouteWeights([value.primaryWeight, ...value.candidates.filter(route => route.enabled !== false).map(route => route.weight)])}%</span></div>
  </section>
}
