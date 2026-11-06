import { z } from 'zod'

export const ACTIVITY_TIMEZONES = ['Asia/Shanghai', 'UTC'] as const
const dayMs = 86_400_000
const minuteMs = 60_000
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value && value >= '1970-01-01' && value <= '9999-12-30'
}, '请填写有效日期（1970–9999）')
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
export const activityRuleSchema = z.object({
  id: z.string().min(1).max(80), name: z.string().trim().min(1).max(120), enabled: z.boolean(),
  startDate: dateSchema.nullable(), endDate: dateSchema.nullable(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(value => new Set(value).size === value.length),
  allDay: z.boolean(), startTime: timeSchema, endTime: timeSchema,
  multiplierBps: z.number().int().min(0).max(1_000_000),
}).strict().superRefine((value, ctx) => {
  if (value.startDate && value.endDate && value.startDate >= value.endDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: '结束日期（不含）须晚于开始日期' })
  if (!value.allDay && value.startTime === value.endTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: '相同起止时间请使用全天' })
})
export type ModelActivityRule = z.infer<typeof activityRuleSchema>
export type ModelActivities = { revision: number; timezone: typeof ACTIVITY_TIMEZONES[number]; rules: ModelActivityRule[] }
const dateDay = (value: string) => Date.parse(value + 'T00:00:00Z') / dayMs
const hhmm = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
const weekday = (day: number) => ((day + 4) % 7 + 7) % 7
const offset = (timezone: ModelActivities['timezone']) => timezone === 'UTC' ? 0 : 480
function span(rule: ModelActivityRule) {
  const start = rule.allDay ? 0 : hhmm(rule.startTime)
  const end = rule.allDay ? 1440 : hhmm(rule.endTime)
  return { start, end: end <= start ? end + 1440 : end }
}
function bounds(rule: ModelActivityRule) {
  return { low: rule.startDate ? dateDay(rule.startDate) : 0, high: rule.endDate ? dateDay(rule.endDate) : dateDay('9999-12-30') }
}
function interval(rule: ModelActivityRule, day: number) {
  const range = bounds(rule), times = span(rule)
  if (day < range.low || day >= range.high || !rule.weekdays.includes(weekday(day))) return null
  return { start: day * 1440 + times.start, end: Math.min(day * 1440 + times.end, range.high * 1440) }
}
const iso = (minute: number, timezone: ModelActivities['timezone']) => new Date((minute - offset(timezone)) * minuteMs).toISOString()
/** Exact weekly intersection: only neighboring anchor days can overlap. No horizon scan. */
export function findActivityConflict(config: Pick<ModelActivities, 'timezone' | 'rules'>) {
  const rules = config.rules.filter(rule => rule.enabled)
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j], ab = bounds(a), bb = bounds(b)
    for (const shift of [-1, 0, 1]) {
      const low = Math.max(ab.low, bb.low - shift), high = Math.min(ab.high, bb.high - shift)
      for (let delta = 0; delta < 7 && low + delta < high; delta++) {
        const day = low + delta, ai = interval(a, day), bi = interval(b, day + shift)
        if (!ai || !bi) continue
        const start = Math.max(ai.start, bi.start), end = Math.min(ai.end, bi.end)
        if (start < end) return { firstId: a.id, secondId: b.id, start: iso(start, config.timezone), end: iso(end, config.timezone), timezone: config.timezone }
      }
    }
  }
  return null
}
export const modelActivitiesSchema = z.object({ revision: z.number().int().nonnegative(), timezone: z.enum(ACTIVITY_TIMEZONES).default('Asia/Shanghai'),
  rules: z.array(activityRuleSchema).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.rules.map(rule => rule.id)).size !== value.rules.length) ctx.addIssue({ code: 'custom', path: ['rules'], message: '活动编号不能重复' })
  const conflict = findActivityConflict(value)
  if (conflict) ctx.addIssue({ code: 'custom', path: ['rules'], message: '活动时间重叠：' + conflict.firstId + ' / ' + conflict.secondId + ' [' + conflict.start + ', ' + conflict.end + ') ' + conflict.timezone })
})
export function readModelActivities(metadata: unknown): ModelActivities | null {
  if (!metadata || typeof metadata !== 'object' || !('activities' in metadata) || metadata.activities == null) return null
  return modelActivitiesSchema.parse(metadata.activities)
}
export const frozenActivitySchema = z.object({ baseMultiplierBps: z.number().int().min(0), effectiveMultiplierBps: z.number().int().min(0),
  revision: z.number().int().nonnegative(), timezone: z.enum(ACTIVITY_TIMEZONES), admittedAt: z.string().datetime(), activityId: z.string().nullable(), activityName: z.string().nullable(),
}).strict()
export type FrozenModelActivity = z.infer<typeof frozenActivitySchema>
export function evaluateModelActivity(config: ModelActivities, baseMultiplierBps: number, now = Date.now()) {
  const localMinute = (now / minuteMs) + offset(config.timezone), today = Math.floor(localMinute / 1440)
  let active: ModelActivityRule | undefined, next = Infinity
  for (const rule of config.rules.filter(rule => rule.enabled)) {
    for (const day of [today - 1, today]) {
      const occurrence = interval(rule, day)
      if (occurrence && localMinute >= occurrence.start && localMinute < occurrence.end) active = rule
      if (occurrence && occurrence.end > localMinute) next = Math.min(next, occurrence.end)
    }
    const range = bounds(rule), first = Math.max(today, range.low)
    for (let delta = 0; delta <= 7; delta++) {
      const occurrence = interval(rule, first + delta)
      if (occurrence && occurrence.start > localMinute) { next = Math.min(next, occurrence.start); break }
    }
  }
  const frozen: FrozenModelActivity = { baseMultiplierBps, effectiveMultiplierBps: active?.multiplierBps ?? baseMultiplierBps, revision: config.revision,
    timezone: config.timezone, admittedAt: new Date(now).toISOString(), activityId: active?.id ?? null, activityName: active?.name ?? null }
  return { ...frozen, discountRatio: baseMultiplierBps ? frozen.effectiveMultiplierBps / baseMultiplierBps : null, nextSwitchAt: Number.isFinite(next) ? iso(next, config.timezone) : null }
}
