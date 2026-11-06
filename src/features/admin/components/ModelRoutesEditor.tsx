import { IMAGE_QUALITY_OPTIONS } from '../../../../shared/contracts/image-model'
import { useState } from 'react'
import type { ModelRouteInput } from '../../../../shared/contracts/model-routes'
import TextInput from './AdminTextInput'
import Button from '@/components/ui/Button'

export function ModelRoutesEditor({ routes, onChange, defaults, imageGeneration = false }: {
  imageGeneration?: boolean
  routes: ModelRouteInput[]; onChange: (routes: ModelRouteInput[]) => void
  defaults: { provider: string; modelName: string; baseUrl: string; contextWindowTokens?: string; visionEnabled?: boolean; reasoningEfforts?: ModelRouteInput['reasoningEfforts'] }
}) {
  const [active, setActive] = useState<number | null>(null)
  const update = (index: number, patch: Partial<ModelRouteInput>) => onChange(routes.map((route, i) => i === index ? { ...route, ...patch } : route))
  return <section className="mt-5 space-y-3 border-t border-[var(--border-subtle)] pt-4">
    <h3 className="text-sm font-semibold">{imageGeneration ? '图片生成备用线路' : '同档位供应商线路'}</h3>
    <p className="text-sm text-[var(--text-secondary)]">{imageGeneration ? '优先使用主配置；限流、服务错误或空返回时按顺序尝试启用的备用线路，每条最多一次。超时或断流且结果未知时保留待核。备用模型须支持相同的图片尺寸、张数和质量参数。最多添加 7 条线路。' : '主配置与启用的线路轮流分担请求；限流或服务失败时尝试其他线路。所有线路须支持上方推理强度、上下文窗口及视觉能力；用户仍按本档位费率计费。最多添加 7 条线路。'}</p>
    {routes.map((route, index) => <fieldset key={route.id ?? index} className="space-y-3 border-b border-[var(--border-subtle)] py-4">
      <legend className="px-1 text-sm">线路 {index + 1}</legend>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="break-words font-medium">{route.label || `线路 ${index + 1}`}</p><p className="break-all text-sm text-[var(--text-secondary)]">{route.provider} · {route.modelName} · {route.enabled ? '已启用' : '已停用'}</p></div><Button className="min-h-11" aria-expanded={active === index} onClick={() => setActive(active === index ? null : index)}>{active === index ? '收起线路' : `编辑线路 ${index + 1}`}</Button></div>
      {active === index ? <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">线路名称<TextInput value={route.label} onChange={event => update(index, { label: event.target.value })} /></label>
        <label className="text-sm">供应商<TextInput value={route.provider} onChange={event => update(index, { provider: event.target.value })} /></label>
        <label className="text-sm">模型 ID<TextInput value={route.modelName} onChange={event => update(index, { modelName: event.target.value })} /></label>
        <label className="text-sm">Base URL<TextInput value={route.baseUrl} onChange={event => update(index, { baseUrl: event.target.value })} /></label>
        {!imageGeneration ? <><label className="text-sm">线路上下文窗口<TextInput type="number" min="16000" max="4000000" value={route.contextWindowTokens ?? defaults.contextWindowTokens ?? '128000'} onChange={event => update(index, { contextWindowTokens: Number(event.target.value) })} /></label>
        <div className="text-sm">线路推理强度<div className="mt-2 flex flex-wrap gap-2">{(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(effort => {
          const selected = route.reasoningEfforts ?? defaults.reasoningEfforts ?? []
          return <label key={effort}><input type="checkbox" checked={selected.includes(effort)} onChange={event => update(index, { reasoningEfforts: event.target.checked ? [...selected, effort] : selected.filter(value => value !== effort) })} />{effort}</label>
        })}</div></div>
        <label className="text-sm"><input type="checkbox" checked={route.visionEnabled ?? defaults.visionEnabled ?? false} onChange={event => update(index, { visionEnabled: event.target.checked })} />支持 OpenAI 兼容图片输入</label></> : null}
        {imageGeneration && <label className="text-sm">此线路图片质量<select value={route.imageQuality ? route.imageQuality.defaultValue ?? '' : '__inherit'} onChange={event => update(index, { imageQuality: event.target.value === '__inherit' ? undefined : { supportedValues: event.target.value ? [event.target.value] : [], defaultValue: event.target.value || null } })}><option value="__inherit">沿用主配置</option><option value="">不传质量参数</option>{route.imageQuality?.defaultValue && !IMAGE_QUALITY_OPTIONS.some(option => option.value === route.imageQuality?.defaultValue) ? <option value={route.imageQuality.defaultValue}>{route.imageQuality.defaultValue}</option> : null}{IMAGE_QUALITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
        <label className="text-sm sm:col-span-2">API Key<TextInput type="password" autoComplete="new-password" value={route.apiKey ?? ''} placeholder={route.id ? '留空保持已有密钥' : '填写此账号的密钥'} onChange={event => update(index, { apiKey: event.target.value || undefined })} /></label>
      </div> : null}
      <div className="flex items-center justify-between"><label className="text-sm"><input type="checkbox" checked={route.enabled} onChange={event => update(index, { enabled: event.target.checked })} /> 启用</label><Button size="sm" variant="ghost" onClick={() => { onChange(routes.filter((_, i) => i !== index)); setActive(null) }}>移除线路</Button></div>
    </fieldset>)}
    <Button size="sm" disabled={routes.length >= 7} onClick={() => { setActive(routes.length); onChange([...routes, { provider: defaults.provider, modelName: defaults.modelName, baseUrl: defaults.baseUrl, label: `线路 ${routes.length + 1}`, enabled: true,
      ...(!imageGeneration && defaults.contextWindowTokens ? { contextWindowTokens: Number(defaults.contextWindowTokens) } : {}),
      ...(!imageGeneration && defaults.visionEnabled !== undefined ? { visionEnabled: defaults.visionEnabled } : {}),
      ...(!imageGeneration && defaults.reasoningEfforts ? { reasoningEfforts: [...defaults.reasoningEfforts] } : {}),
    }]) }}>添加供应商线路</Button>
  </section>
}
