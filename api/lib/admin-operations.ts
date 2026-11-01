import { Prisma } from '@prisma/client'
import type { AdminOperationCall, AdminOperationCallsPayload, AdminOperationCallsQuery, AdminOperationRun, AdminOperationRunsPayload, AdminOperationRunsQuery, AdminOperationsContext, AdminOperationsHealthPayload, AdminOperationsHealthQuery } from '../../shared/contracts/admin-operations.js'
import { prisma } from './prisma.js'
import { analyticsWindow } from './data/admin-analytics.js'

function context(query: { period: 'today' | 'week' | 'month'; from?: string; to?: string }, source: string, coverage: string[]): AdminOperationsContext {
  const snapshot = new Date()
  const standard = analyticsWindow(query.period === 'today' ? 'day' : query.period, snapshot)
  return { source, coverage, snapshotAt: snapshot.toISOString(), window: { from: query.from ? new Date(query.from).toISOString() : standard.from.toISOString(), to: query.to ? new Date(query.to).toISOString() : standard.to.toISOString(), timeZone: 'UTC+8', boundary: 'created_at' } }
}
const contains = (column: Prisma.Sql, value: string) => Prisma.sql`strpos(lower(COALESCE(${column}, '')), lower(${value})) > 0`
// All parameters are canonical UTC wall-time strings before ::timestamp;
// never compare stored UTC TIMESTAMP(3) against a session-zone-dependent Date.
const dated = (column: Prisma.Sql, ctx: AdminOperationsContext) => Prisma.sql`${column} >= ${ctx.window.from}::timestamp AND ${column} < ${ctx.window.to}::timestamp`
const page = (query: { page: number; pageSize: number }, total: number) => ({ page: query.page, pageSize: query.pageSize, total, hasMore: query.page * query.pageSize < total })

function callsSource(query: AdminOperationsHealthQuery) {
  if (query.source === 'provider_attempts') {
    return {
      from: Prisma.sql`agent_provider_attempts a JOIN agent_operations o ON o.id = a.operation_id LEFT JOIN agent_provider_usage_receipts receipt ON receipt.attempt_id = a.id`,
      date: Prisma.sql`a.created_at`, id: Prisma.sql`a.id`, model: Prisma.sql`a.model`, provider: Prisma.sql`a.provider`, run: Prisma.sql`a.run_id`, task: Prisma.sql`o.task_root_id`, status: Prisma.sql`a.status`,
      outcome: Prisma.sql`CASE a.status WHEN 'succeeded' THEN 'success' WHEN 'failed' THEN 'failure' WHEN 'cancelled' THEN 'cancelled' WHEN 'prepared' THEN 'pending' WHEN 'dispatched' THEN 'pending' ELSE 'unknown' END`,
      error: Prisma.sql`CASE a.status WHEN 'failed' THEN 'known_failure' WHEN 'unknown' THEN 'unknown_result' WHEN 'cancelled' THEN 'cancelled' ELSE NULL END`,
      columns: Prisma.sql`a.id, a.created_at AS "createdAt", a.provider, a.model, o.action, a.run_id AS "runId", o.task_root_id AS "taskId", a.operation_id AS "operationId", a.status,
        receipt.settlement_status AS "billingStatus", receipt.source AS "usageSource", receipt.prompt_tokens AS "requestTokens", receipt.completion_tokens AS "responseTokens", receipt.cache_hit_tokens AS "cacheHitTokens", receipt.cache_miss_tokens AS "cacheMissTokens",
        CASE WHEN a.completed_at >= a.dispatched_at THEN EXTRACT(EPOCH FROM (a.completed_at - a.dispatched_at)) * 1000 ELSE NULL END::float8 AS "durationMs", NULL::int AS "chargedCreditsMilli"`,
      coverage: ['来源：供应商尝试及其独立用量回执；一行对应一次已记录的 attempt，不等于创作任务完成。', '仅读取状态、身份、时间与 Token；不读取 requestSnapshot、result、提示词或正文。', '失败类别仅依据已保存状态；DNS/TLS/HTTP 细分、首字和网关请求 ID 尚无独立字段。', '不与用量日志或工具记录相加，历史未建立 attempt 的调用不在此来源内。'],
    }
  }
  if (query.source === 'usage') {
    return {
      from: Prisma.sql`ai_usage_logs u LEFT JOIN agent_runs r ON r.id = u.agent_run_id`, date: Prisma.sql`u.created_at`, id: Prisma.sql`u.id`, model: Prisma.sql`u.model_name`, provider: Prisma.sql`u.provider_name`, run: Prisma.sql`u.agent_run_id`, task: Prisma.sql`r.task_root_id`, status: Prisma.sql`u.billing_status`,
      outcome: Prisma.sql`'unknown'::text`, error: Prisma.sql`CASE WHEN u.billing_status IN ('prepared','pending_usage','observed','pending_settlement') THEN 'billing_pending' ELSE NULL END`,
      columns: Prisma.sql`u.id, u.created_at AS "createdAt", u.provider_name AS provider, u.model_name AS model, u.action, u.agent_run_id AS "runId", r.task_root_id AS "taskId", NULL::text AS "operationId", u.billing_status AS status,
        u.billing_status AS "billingStatus", u.usage_source AS "usageSource", u.request_tokens AS "requestTokens", u.response_tokens AS "responseTokens", u.prompt_cache_hit_tokens AS "cacheHitTokens", u.prompt_cache_miss_tokens AS "cacheMissTokens", u.duration_ms AS "durationMs",
        CASE WHEN u.billing_status = 'settled' OR u.credit_charge_milli > 0 THEN u.credit_charge_milli ELSE NULL END AS "chargedCreditsMilli"`,
      coverage: ['来源：墨域 AiUsageLog；状态是本地账务状态，不是模型能力成功或作者任务完成。', 'Token 缺失保持 null；已记录本地 Credits 不代表上游现金成本或云枢扣款。', 'taskId 仅通过已存 agentRunId 关联；不按时间、模型名或用户推测归属。', '此来源没有独立能力结果或网络错误分类，健康成功/失败数不从结算状态推断。'],
    }
  }
  return {
    from: Prisma.sql`web_tool_calls w JOIN agent_runs r ON r.id = w.run_id`, date: Prisma.sql`w.created_at`, id: Prisma.sql`w.id`, model: Prisma.sql`NULL::text`, provider: Prisma.sql`NULL::text`, run: Prisma.sql`w.run_id`, task: Prisma.sql`r.task_root_id`, status: Prisma.sql`w.status`,
    outcome: Prisma.sql`CASE w.status WHEN 'failed' THEN 'failure' WHEN 'dispatched' THEN 'pending' ELSE 'unknown' END`, error: Prisma.sql`CASE w.status WHEN 'failed' THEN 'known_failure' ELSE NULL END`,
    columns: Prisma.sql`w.id, w.created_at AS "createdAt", NULL::text AS provider, NULL::text AS model, w.kind AS action, w.run_id AS "runId", r.task_root_id AS "taskId", NULL::text AS "operationId", w.status,
      NULL::text AS "billingStatus", NULL::text AS "usageSource", NULL::int AS "requestTokens", NULL::int AS "responseTokens", NULL::int AS "cacheHitTokens", NULL::int AS "cacheMissTokens", NULL::float8 AS "durationMs", NULL::int AS "chargedCreditsMilli"`,
    coverage: ['来源：固定价 WebToolCall 派发回执，仅覆盖已采用此回执的 Search / Fetch。', 'completed 只表示回执完成；未读取 outcome 正文，不能细分空结果、回退和有效能力结果。', '历史回执没有完整实际模型/渠道、Token 和耗时；这些字段显示未知，不使用主文本档位代替。', 'amountMilli 为冻结准入金额，不在此冒充最终实扣；退款仍以本地账本为准。'],
  }
}
function callQuery(query: AdminOperationsHealthQuery) {
  const source = callsSource(query)
  const ctx = context(query, query.source, source.coverage)
  const conditions = [dated(source.date, ctx)]
  if (query.model) conditions.push(contains(source.model, query.model))
  if (query.provider) conditions.push(contains(source.provider, query.provider))
  if (query.runId) conditions.push(Prisma.sql`${source.run} = ${query.runId}`)
  if (query.taskId) conditions.push(Prisma.sql`${source.task} = ${query.taskId}`)
  if (query.status) conditions.push(Prisma.sql`${source.status} = ${query.status}`)
  if (query.errorCategory) conditions.push(Prisma.sql`(${source.error}) = ${query.errorCategory}`)
  return { source, ctx, where: Prisma.sql`${Prisma.join(conditions, ' AND ')}` }
}
type RawCall = Omit<AdminOperationCall, 'source' | 'createdAt'> & { createdAt: Date }

/** Query has already passed its shared route schema. All filters remain bound SQL values. */
export async function listAdminOperationCalls(query: AdminOperationCallsQuery): Promise<AdminOperationCallsPayload> {
  const { source, ctx, where } = callQuery(query)
  return prisma.$transaction(async tx => {
    const [counts, rows] = await Promise.all([
      tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT COUNT(*)::int AS total FROM ${source.from} WHERE ${where}`),
      tx.$queryRaw<RawCall[]>(Prisma.sql`SELECT ${source.columns}, (${source.outcome}) AS outcome, (${source.error}) AS "errorCategory" FROM ${source.from} WHERE ${where} ORDER BY ${source.date} DESC, ${source.id} DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`),
    ])
    return { ...ctx, items: rows.map(row => ({ ...row, source: query.source, createdAt: row.createdAt.toISOString() })), pagination: page(query, counts[0].total) }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

export async function getAdminOperationsHealth(query: AdminOperationsHealthQuery): Promise<AdminOperationsHealthPayload> {
  const { source, ctx, where } = callQuery(query)
  const rows = await prisma.$queryRaw<Array<AdminOperationsHealthPayload['counts'] & { lastSampleAt: Date | null }>>(Prisma.sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE (${source.outcome}) = 'success')::int AS success,
      COUNT(*) FILTER (WHERE (${source.outcome}) = 'failure')::int AS failure, COUNT(*) FILTER (WHERE (${source.outcome}) = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE (${source.outcome}) = 'cancelled')::int AS cancelled, COUNT(*) FILTER (WHERE (${source.outcome}) = 'unknown')::int AS unknown,
      MAX(${source.date}) AS "lastSampleAt" FROM ${source.from} WHERE ${where}`)
  const { lastSampleAt, ...counts } = rows[0]
  return { ...ctx, counts, lastSampleAt: lastSampleAt?.toISOString() ?? null, observation: counts.total === 0 ? 'no_samples' : counts.failure > 0 ? 'attention' : counts.success > 0 ? 'observed' : 'unknown', firstTextMs: null, p50Ms: null, p95Ms: null, tokensPerSecond: null }
}

export async function listAdminOperationRuns(query: AdminOperationRunsQuery): Promise<AdminOperationRunsPayload> {
  const ctx = context(query, 'agent_runs', ['来源：墨域 AgentRun 当前执行状态；按执行创建时间筛选，不读取任务正文、输入/输出摘要、错误原文或消息。', '模型档位及自定义配置 ID 为执行记录值；供应商/实际模型请到对应调用来源核对。', '会话标题与作者昵称仅沿用现有管理员记录权限；查看对话需主动进入原详情页。'])
  const conditions = [dated(Prisma.sql`r.created_at`, ctx)]
  if (query.runId) conditions.push(Prisma.sql`r.id = ${query.runId}`)
  if (query.taskId) conditions.push(Prisma.sql`r.task_root_id = ${query.taskId}`)
  if (query.status) conditions.push(Prisma.sql`r.status::text = ${query.status}`)
  if (query.user) conditions.push(Prisma.sql`(u.id = ${query.user} OR ${contains(Prisma.sql`u.nickname`, query.user)})`)
  if (query.model) conditions.push(Prisma.sql`(${contains(Prisma.sql`r.model_tier`, query.model)} OR ${contains(Prisma.sql`r.custom_model_id`, query.model)} OR EXISTS (SELECT 1 FROM agent_provider_attempts a WHERE a.run_id = r.id AND ${contains(Prisma.sql`a.model`, query.model)}))`)
  if (query.provider) conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM agent_provider_attempts a WHERE a.run_id = r.id AND ${contains(Prisma.sql`a.provider`, query.provider)})`)
  const where = Prisma.sql`${Prisma.join(conditions, ' AND ')}`
  const from = Prisma.sql`agent_runs r JOIN users u ON u.id = r.user_id JOIN agent_sessions s ON s.id = r.session_id`
  type RawRun = Omit<AdminOperationRun, 'user' | 'session' | 'createdAt' | 'startedAt' | 'finishedAt'> & { userId: string; nickname: string; sessionId: string; sessionTitle: string; createdAt: Date; startedAt: Date | null; finishedAt: Date | null }
  return prisma.$transaction(async tx => {
    const [counts, rows] = await Promise.all([
      tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT COUNT(*)::int AS total FROM ${from} WHERE ${where}`),
      tx.$queryRaw<RawRun[]>(Prisma.sql`SELECT r.id, r.task_root_id AS "taskId", r.status::text AS status, r.action::text AS action, r.model_tier AS "modelTier", r.custom_model_id AS "customModelId", r.created_at AS "createdAt", r.started_at AS "startedAt", r.finished_at AS "finishedAt", u.id AS "userId", u.nickname, s.id AS "sessionId", s.title AS "sessionTitle" FROM ${from} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`),
    ])
    return { ...ctx, items: rows.map(({ userId, nickname, sessionId, sessionTitle, ...row }) => ({ ...row, createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, user: { id: userId, nickname }, session: { id: sessionId, title: sessionTitle } })), pagination: page(query, counts[0].total) }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}
