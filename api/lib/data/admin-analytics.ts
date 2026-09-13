import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { supplierCosts } from './supplier-cost.js'
import type { AdminAnalyticsPayload, AdminAnalyticsPeriod } from '../../../shared/contracts/admin-analytics.js'

/** UTC+8 calendar buckets; weeks start Monday. End is the request snapshot. */
export function analyticsWindow(period: AdminAnalyticsPeriod, now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600000)
  const currentLocal = new Date(local)
  local.setUTCHours(0, 0, 0, 0)
  if (period === 'week') local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7)
  if (period === 'month') local.setUTCDate(1)
  const labels: string[] = []
  const from = new Date(local.getTime() - 8 * 3600000)
  const step = period === 'day' ? 3600000 : 86400000
  for (let time = local.getTime(); time <= currentLocal.getTime(); time += step) {
    const iso = new Date(time).toISOString()
    labels.push(period === 'day' ? `${iso.slice(0,10)} ${iso.slice(11,13)}:00` : iso.slice(0,10))
  }
  return { labels, from, to: now }
}

const snapshots = new Map<string, { expires: number; value: Promise<AdminAnalyticsPayload> }>()

/** At most twelve aggregate snapshots; coalesce concurrent admin requests. No user data. */
export function getAdminAnalyticsData(period: AdminAnalyticsPeriod, scope: 'dashboard' | 'creation' | 'credits' | 'cost'): Promise<AdminAnalyticsPayload> {
  const key = `${scope}:${period}`
  const cached = snapshots.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const value = queryAdminAnalytics(period, scope).catch(error => {
    if (snapshots.get(key)?.value === value) snapshots.delete(key)
    throw error
  })
  snapshots.set(key, { expires: Math.min(Date.now() + 60000, (Math.floor(Date.now() / 3600000) + 1) * 3600000), value })
  return value
}

async function queryAdminAnalytics(period: AdminAnalyticsPeriod, scope: 'dashboard' | 'creation' | 'credits' | 'cost'): Promise<AdminAnalyticsPayload> {
  const { labels, from, to } = analyticsWindow(period)
  // Fixed identifiers only; every external value is a bound SQL parameter.
  const sources = scope === 'cost' ? [] : scope === 'credits' ? [
    ['invites', '成功邀请人数', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM referral_redemptions`],
  ] as const : scope === 'dashboard' ? [
    ['users', '注册用户', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM users`],
    ['published', '已发布作品', Prisma.sql`SELECT published_at AS date, 1::numeric AS value FROM novels WHERE published_at IS NOT NULL`],
    ['posts', '社区帖子', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM posts`],
    ['comments', '评论', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM comments`],
    ['novels', '已创建作品', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM novels`],
    ['tokens', '已记录 Token', Prisma.sql`SELECT created_at AS date, (COALESCE(request_tokens,0)::numeric + COALESCE(response_tokens,0)) AS value FROM ai_usage_logs`],
    ['credits', '已消耗 Credits（毛额）', Prisma.sql`SELECT created_at AS date, -delta_milli::numeric / 1000 AS value FROM credit_ledger_entries WHERE kind = 'usage' AND delta_milli < 0`],
  ] as const : [
    ['sessions', '新建会话', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM agent_sessions`],
    ['runs', '发起执行', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM agent_runs`],
    ['completed', '已完成执行', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM agent_runs WHERE status = 'completed'`],
    ['failed', '失败执行', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM agent_runs WHERE status = 'failed'`],
    ['tools', '工具返回', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM agent_run_events WHERE type = 'tool.result'`],
    ['toolSuccess', '工具成功', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM agent_run_events WHERE type = 'tool.result' AND payload->>'ok' = 'true'`],
    ['toolFailed', '工具未成功', Prisma.sql`SELECT created_at AS date, 1::numeric AS value FROM agent_run_events WHERE type = 'tool.result' AND payload->>'ok' = 'false'`],
    ['importJobs', '发起作品导入', Prisma.sql`SELECT "createdAt" AS date, 1::numeric AS value FROM novel_import_jobs`],
    ['importCommits', '已提交导入', Prisma.sql`SELECT "createdAt" AS date, 1::numeric AS value FROM novel_import_commits`],
  ] as const
  const metrics: AdminAnalyticsPayload['metrics'] = await Promise.all(sources.map(async ([key, label, source]) => {
    const rows = await prisma.$queryRaw<Array<{ date: string; value: number }>>(Prisma.sql`
      SELECT to_char(date_trunc(${period === 'day' ? 'hour' : 'day'}, date + interval '8 hours'), ${period === 'day' ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD'}) AS date,
             SUM(value)::float8 AS value
      FROM (${source}) source WHERE date >= ${from} AND date < ${to} GROUP BY 1 ORDER BY 1
    `)
    const byDate = new Map(rows.map(row => [row.date, row.value]))
    const values = labels.map(label => byDate.get(label) ?? 0)
    return { key, label, values, total: values.reduce((a, b) => a + b, 0) }
  }))
  const tools = scope === 'creation' ? await prisma.$queryRaw<AdminAnalyticsPayload['tools']>(Prisma.sql`
    SELECT COALESCE(NULLIF(payload->>'toolName',''), '未知工具') AS name,
      COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE payload->>'ok' = 'false')::int AS failed,
      COUNT(*) FILTER (WHERE payload->>'ok' = 'true')::int AS succeeded,
      COUNT(*) FILTER (WHERE payload->>'ok' IS NULL OR payload->>'ok' NOT IN ('true','false'))::int AS unknown
    FROM agent_run_events WHERE type = 'tool.result' AND created_at >= ${from} AND created_at < ${to}
    GROUP BY 1 ORDER BY failed DESC, calls DESC, name ASC LIMIT 30
  `) : []
  const costs = scope === 'dashboard' || scope === 'cost' ? await supplierCosts(period, from, to) : null
  const imports = scope === 'creation' ? await queryImportAnalytics(from, to) : undefined
  if (costs) metrics.push({ key: 'cost', label: '已消耗成本（￥·估算小计）', total: costs.total, values: labels.map(date => costs.days.get(date) ?? 0), unavailable: costs.knownCalls === 0 && costs.unknownCalls > 0 })
  return { period, from: from.toISOString(), to: to.toISOString(), labels, metrics, tools, ...(imports ? { imports } : {}), ...(costs ? { cost: { knownCalls: costs.knownCalls, unknownCalls: costs.unknownCalls, models: costs.models } } : {}) }
}

async function queryImportAnalytics(from: Date, to: Date): Promise<NonNullable<AdminAnalyticsPayload['imports']>> {
  const [rows, failures] = await Promise.all([
    prisma.$queryRaw<Array<{ jobs: number; previewed: number; failedBeforePreview: number; committed: number; cancelled: number; restored: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS jobs,
        COUNT(*) FILTER (WHERE j."manifestRevision" > 0)::int AS previewed,
        COUNT(*) FILTER (WHERE j.status = 'failed' AND j."manifestRevision" = 0)::int AS "failedBeforePreview",
        COUNT(*) FILTER (WHERE c."jobId" IS NOT NULL)::int AS committed,
        COUNT(*) FILTER (WHERE j.status = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE b."restoredAt" IS NOT NULL)::int AS restored
      FROM novel_import_jobs j LEFT JOIN novel_import_commits c ON c."jobId" = j.id
      LEFT JOIN novel_import_backups b ON b."jobId" = j.id
      WHERE j."createdAt" >= ${from} AND j."createdAt" < ${to}
    `),
    prisma.$queryRaw<Array<{ code: string; count: number }>>(Prisma.sql`
      SELECT "errorCode" AS code, COUNT(*)::int AS count FROM novel_import_jobs
      WHERE "createdAt" >= ${from} AND "createdAt" < ${to} AND status = 'failed' AND "errorCode" IS NOT NULL
      GROUP BY "errorCode" ORDER BY count DESC, code LIMIT 20
    `),
  ])
  return { ...(rows[0] ?? { jobs: 0, previewed: 0, failedBeforePreview: 0, committed: 0, cancelled: 0, restored: 0 }), failures }
}
