import type { ModelActivities, ModelActivityRule } from '../../../../shared/model-activity'
import { ACTIVITY_TIMEZONES, findActivityConflict } from '../../../../shared/model-activity'
import Button from '@/components/ui/Button'
import TextInput from './AdminTextInput'

const dayNames = ['日', '一', '二', '三', '四', '五', '六']
export function ModelActivitiesEditor({ value, onChange }: { value: ModelActivities; onChange: (value: ModelActivities) => void }) {
  const update = (index: number, patch: Partial<ModelActivityRule>) => onChange({ ...value, rules: value.rules.map((rule, at) => at === index ? { ...rule, ...patch } : rule) })
  const conflict = findActivityConflict(value)
  return <section aria-label="时段活动" className="space-y-4 border-t border-[var(--border-subtle)] pt-4">
    <h3 className="font-medium">时段活动</h3>
    <label className="block text-sm">活动时区<select aria-label="活动时区" value={value.timezone} onChange={event => onChange({ ...value, timezone: event.target.value as ModelActivities['timezone'] })}>{ACTIVITY_TIMEZONES.map(zone => <option key={zone}>{zone}</option>)}</select></label>
    {value.rules.map((rule, index) => <fieldset key={rule.id} className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-3">
      <legend>{rule.name || '活动 ' + (index + 1)}</legend>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rule.enabled} onChange={event => update(index, { enabled: event.target.checked })} />启用活动</label>
      <label className="block text-sm">活动名称<TextInput value={rule.name} onChange={event => update(index, { name: event.target.value })} /></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">开始日期（含，留空不限）<TextInput type="date" value={rule.startDate ?? ''} onChange={event => update(index, { startDate: event.target.value || null })} /></label><label className="text-sm">结束日期（不含，留空不限）<TextInput type="date" value={rule.endDate ?? ''} onChange={event => update(index, { endDate: event.target.value || null })} /></label></div>
      <div className="flex flex-wrap gap-3">{dayNames.map((label, day) => <label key={day} className="text-sm"><input type="checkbox" checked={rule.weekdays.includes(day)} onChange={event => update(index, { weekdays: event.target.checked ? [...rule.weekdays, day] : rule.weekdays.filter(value => value !== day) })} />周{label}</label>)}</div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rule.allDay} onChange={event => update(index, { allDay: event.target.checked })} />全天</label>
      {!rule.allDay && <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">开始时间（含）<TextInput type="time" value={rule.startTime} onChange={event => update(index, { startTime: event.target.value })} /></label><label className="text-sm">结束时间（不含，早于开始则跨夜）<TextInput type="time" value={rule.endTime} onChange={event => update(index, { endTime: event.target.value })} /></label></div>}
      <label className="block text-sm">活动有效倍率<TextInput type="number" min="0" max="100" step="0.0001" value={rule.multiplierBps / 10000} onChange={event => update(index, { multiplierBps: Math.round(Number(event.target.value) * 10000) })} /></label>
      <Button variant="ghost" onClick={() => onChange({ ...value, rules: value.rules.filter((_, at) => at !== index) })}>移除活动</Button>
    </fieldset>)}
    {conflict && <p role="alert" className="text-sm text-rose-600">活动时间重叠：{conflict.start} 至 {conflict.end}（{conflict.timezone}）</p>}
    <Button onClick={() => onChange({ ...value, rules: [...value.rules, { id: crypto.randomUUID(), name: '', enabled: false, startDate: null, endDate: null, weekdays: [0, 1, 2, 3, 4, 5, 6], allDay: true, startTime: '00:00', endTime: '00:00', multiplierBps: 10000 }] })}>添加活动</Button>
  </section>
}
