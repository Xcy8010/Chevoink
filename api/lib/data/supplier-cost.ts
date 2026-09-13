import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

// Public CNY / million tokens, verified 2026-09-13. Revaluation, NOT historical invoices.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// https://docs.bigmodel.cn/cn/guide/start/pricing.md
export function publicRates(provider: string, model: string, peak: boolean): [number, number, number] | null {
  const name = model.toLowerCase()
  const vendor = provider.toLowerCase()
  if (vendor === 'deepseek') {
    const factor = peak ? 2 : 1
    if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(name)) return [1 * factor, .02 * factor, 4 * factor]
    if (name === 'deepseek-v4-pro') return [4.5 * factor, .15 * factor, 13.5 * factor]
  }
  if (['zhipu ai', 'zhipu', 'zhipu-ai'].includes(vendor)) {
    if (name === 'glm-5.3') return [8, 2, 28]
    if (name === 'glm-5.3-flash') return [.8, .23, 2.8]
  }
  return null
}

export async function supplierCosts(period: 'day' | 'week' | 'month', from: Date, to: Date) {
  const rows = await prisma.$queryRaw<Array<{ date: string; provider: string; model: string; peak: boolean; known: boolean; calls: number; input: number; output: number; hit: number }>>(Prisma.sql`
    SELECT to_char(date_trunc(${period === 'day' ? 'hour' : 'day'}, created_at + interval '8 hours'), ${period === 'day' ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD'}) AS date,
      COALESCE(provider_name, '未知供应商') AS provider, model_name AS model,
      (extract(isodow FROM created_at + interval '8 hours') <= 5 AND
       (extract(hour FROM created_at + interval '8 hours') BETWEEN 9 AND 11 OR extract(hour FROM created_at + interval '8 hours') BETWEEN 14 AND 17)) AS peak,
      (request_tokens IS NOT NULL AND response_tokens IS NOT NULL AND request_tokens >= 0 AND response_tokens >= 0
       AND (request_tokens = 0 OR (prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_hit_tokens BETWEEN 0 AND request_tokens))) AS known,
      count(*)::int AS calls, coalesce(sum(request_tokens),0)::float8 AS input,
      coalesce(sum(response_tokens),0)::float8 AS output, coalesce(sum(prompt_cache_hit_tokens),0)::float8 AS hit
    FROM ai_usage_logs
    WHERE created_at >= ${from} AND created_at < ${to} AND model_tier IS NOT NULL AND model_tier <> 'custom'
      AND (billing_status IS NULL OR billing_status NOT IN ('prepared','not_dispatched'))
    GROUP BY 1,2,3,4,5
  `)
  const models = new Map<string, { provider: string; model: string; estimated: number; knownCalls: number; unknownCalls: number }>()
  const days = new Map<string, number>()
  let total = 0
  let knownCalls = 0
  let unknownCalls = 0
  for (const row of rows) {
    const key = `${row.provider}\0${row.model}`
    const summary = models.get(key) ?? { provider: row.provider, model: row.model, estimated: 0, knownCalls: 0, unknownCalls: 0 }
    const rates = publicRates(row.provider, row.model, row.peak)
    if (rates && row.known) {
      const cost = ((row.input - row.hit) * rates[0] + row.hit * rates[1] + row.output * rates[2]) / 1_000_000
      summary.estimated += cost
      summary.knownCalls += row.calls
      total += cost
      knownCalls += row.calls
      days.set(row.date, (days.get(row.date) ?? 0) + cost)
    } else { summary.unknownCalls += row.calls; unknownCalls += row.calls }
    models.set(key, summary)
  }
  return { total, knownCalls, unknownCalls, models: [...models.values()].sort((a,b) => b.estimated - a.estimated), days }
}
