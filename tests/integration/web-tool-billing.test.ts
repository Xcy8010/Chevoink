import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { executeWebToolCall, findWebToolCallOutcome, saveWebToolCacheOutcome, refundCancelledWebToolCall } from '../../api/lib/billing/web-tool-calls.js'
import { getCreditWindow, reconcileCreditRefunds, reserveTokenCredits } from '../../api/lib/credits.js'
import { webSearchTool } from '../../api/lib/agent/tools/search-tools.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { env } from '../../api/config/env.js'
import type { WebSearchOutcome, WebSearchResult } from '../../api/lib/web-search-service.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

// Only supplier transport/configuration is mocked. The tool, request budgets,
// durable receipt, wallet settlement and refund reconciliation use real PG.
const searchTransport = vi.hoisted(() => vi.fn())
const searchConfiguration = vi.hoisted(() => vi.fn())
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: (...args: unknown[]) => searchTransport(...args) }))
vi.mock('../../api/lib/tool-model-config.js', async original => ({ ...await original<typeof import('../../api/lib/tool-model-config.js')>(), getToolModelRuntime: searchConfiguration }))

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
type Result = { provider: string; results: string[] }
const success: Result = { provider: 'bocha', results: ['public source'] }
const classify = (value: Result) => value.results.length ? value.provider === 'bocha' ? 'billable' as const : 'fallback' as const : 'empty' as const
const request = { query: 'public fixture', count: 2 }

async function fixture(work: (ctx: ToolContext) => Promise<void>, balance = 10000) {
  const user = await prisma.user.create({ data: { nickname: 'web-tool-billing-fixture', passwordHash: 'test-only' } })
  try {
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: 'Billing fixture', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: 'Fixture' } })
    const run = await prisma.agentRun.create({ data: { id: randomUUID(), userId: user.id, novelId: novel.id, sessionId: session.id,
      mode: 'act', engine: 'loop', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running' } })
    const window = getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: user.id, dailyAllowanceMilli: balance, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    await work({ userId: user.id, novelId: novel.id, sessionId: session.id, runId: run.id, callId: randomUUID(), chapterId: null,
      mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {} })
  } finally {
    await prisma.aiUsageLog.deleteMany({ where: { userId: user.id } })
    await prisma.agentRun.deleteMany({ where: { userId: user.id } })
    await prisma.agentSession.deleteMany({ where: { userId: user.id } })
    await prisma.novel.deleteMany({ where: { authorId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
  }
}
const ledger = (ctx: ToolContext) => prisma.creditLedgerEntry.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: 'asc' } })

describe.skipIf(!available)('Search / Fetch billing with isolated PostgreSQL (simulated supplier)', () => {
  it.each(['eligible-free-fallback', 'all-ineligible'] as const)('settles actual constrained search tool %s without repricing or replaying a supplier', async branch => {
    const originalProvider = env.webSearchProvider
    env.webSearchProvider = 'auto'
    const target = { title: '河谷纪事', author: '林青', sourceHosts: ['fiction.example.com'], textAnalysisRequired: true }
    const query = 'site:fiction.example.com 河谷纪事 林青'
    const official: WebSearchResult = { title: '河谷纪事最新章节在线阅读_林青', url: 'https://fiction.example.com/page/123', snippet: '作者：林青，作品目录。', source: 'fiction.example.com' }
    const secondary: WebSearchResult = { title: '林青《河谷纪事》创作访谈', url: 'https://news.example.com/article/1', snippet: '访谈文章，不是目标原作章节。', source: 'news.example.com' }
    const irrelevant: WebSearchResult = { title: '河（汉字）', url: 'https://dictionary.example.com/item/he', snippet: '汉字释义。', source: 'dictionary.example.com' }
    const freeResult = branch === 'eligible-free-fallback' ? official : irrelevant
    searchConfiguration.mockReset().mockResolvedValue({ provider: 'deepseek', modelName: 'deepseek-search', baseUrl: 'https://api.deepseek.com', apiKey: 'offline-supplier-fixture' })
    searchTransport.mockReset().mockResolvedValueOnce(Response.json({ results: [{ ...secondary, summary: secondary.snippet, content: '', site_name: secondary.source }] }))
      .mockResolvedValueOnce(new Response(`<div class="vrwrap" data-url="${freeResult.url}"><h3 class="vr-title"><a href="${freeResult.url}">${freeResult.title}</a></h3><p>${freeResult.snippet}</p></div>`))
    if (branch === 'all-ineligible') searchTransport.mockResolvedValueOnce(new Response(`<li class="b_algo"><h2><a href="${irrelevant.url}">${irrelevant.title}</a></h2><p>${irrelevant.snippet}</p></li>`))
    vi.stubGlobal('fetch', searchTransport)
    try {
      await fixture(async ctx => {
        const spec = { ...buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt: '只读联网研究《河谷纪事》并分析公开样本', researchAdmission: 1 }),
          researchTarget: target, researchDiscoveryProtocol: 1 }
        await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: JSON.parse(JSON.stringify(spec)) } })
        const first = await webSearchTool.execute(ctx, { query, maxResults: 6 })
        expect(first.outcome).toBeUndefined()
        expect(first.display).toMatchObject({ kind: 'webSearch', provider: branch === 'eligible-free-fallback' ? 'sogou' : 'deepseek' })
        const receipt = await prisma.webToolCall.findFirstOrThrow({ where: { runId: ctx.runId, kind: 'search' } })
        expect(receipt).toMatchObject({ status: 'completed' })
        expect(receipt.amountMilli).toBeGreaterThan(0)
        const saved = receipt.outcome as unknown as WebSearchOutcome
        expect(saved).toMatchObject({ provider: branch === 'eligible-free-fallback' ? 'sogou' : 'deepseek',
          quality: { eligibleCount: branch === 'eligible-free-fallback' ? 1 : 0 } })
        expect(saved.attempts?.[0]).toMatchObject({ provider: 'deepseek', outcome: 'results', resultCount: 1, eligibleCount: 0 })
        expect(saved.results[0].url).toBe(branch === 'eligible-free-fallback' ? official.url : secondary.url)
        expect(saved.attempts).toHaveLength(branch === 'eligible-free-fallback' ? 2 : 3)
        const again = await webSearchTool.execute(ctx, { query, maxResults: 6 })
        expect(again.output).toBe(first.output)
        await Promise.all([reconcileCreditRefunds({ userId: ctx.userId }), reconcileCreditRefunds({ userId: ctx.userId })])
        const entries = await ledger(ctx)
        expect(entries.filter(entry => entry.kind === 'usage')).toHaveLength(1)
        expect(entries.filter(entry => entry.kind === 'refund')).toHaveLength(branch === 'eligible-free-fallback' ? 1 : 0)
        expect(entries.reduce((sum, entry) => sum + entry.deltaMilli, 0)).toBe(branch === 'eligible-free-fallback' ? 0 : -receipt.amountMilli)
        expect(await prisma.creditRefundIntent.count({ where: { originalEntry: { userId: ctx.userId } } })).toBe(branch === 'eligible-free-fallback' ? 1 : 0)
        expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: ctx.userId } })).dailyUsedMilli).toBe(branch === 'eligible-free-fallback' ? 0 : receipt.amountMilli)
        expect(await prisma.webToolCall.count({ where: { runId: ctx.runId } })).toBe(1)
        expect(await prisma.agentResearchRequest.count({ where: { ownerRunId: ctx.runId, kind: 'search', status: 'consumed' } })).toBe(1)
        expect(searchTransport).toHaveBeenCalledTimes(branch === 'eligible-free-fallback' ? 2 : 3)
        expect(searchTransport.mock.calls.filter(([url]) => String(url).includes('/v1/tools/search'))).toHaveLength(1)
        expect(JSON.stringify(receipt.outcome)).not.toContain('offline-supplier-fixture')
      })
    } finally {
      env.webSearchProvider = originalProvider
      searchConfiguration.mockReset()
      searchTransport.mockReset()
      vi.unstubAllGlobals()
    }
  })
  it('refunds an observed incomplete Fetch once and replays its evidence without another supplier request', async () => {
    await fixture(async ctx => {
      const failure = { provider: 'deepseek', status: 'unreadable', code: 'WEB_READ_INCOMPLETE', text: '',
        evidence: { version: 1, integrity: { status: 'damaged', code: 'SOURCE_TEXT_DELETION', extractedHash: 'a'.repeat(64), referenceHash: 'b'.repeat(64) } } }
      const dispatch = vi.fn(async () => failure)
      const fetchRequest = { url: 'https://example.com/chapter/1', sourceId: null, refresh: false }
      expect(await executeWebToolCall(ctx, 'fetch', fetchRequest, true, dispatch, () => 'failed')).toEqual(failure)
      expect(await findWebToolCallOutcome(ctx, 'fetch', fetchRequest)).toEqual(failure)
      await Promise.all([reconcileCreditRefunds({ userId: ctx.userId }), reconcileCreditRefunds({ userId: ctx.userId })])
      expect(dispatch).toHaveBeenCalledOnce()
      const entries = await ledger(ctx)
      expect(entries).toHaveLength(2)
      expect(entries.reduce((sum, entry) => sum + entry.deltaMilli, 0)).toBe(0)
      expect(await prisma.creditRefundIntent.count({ where: { originalEntry: { userId: ctx.userId } } })).toBe(1)
      await expect(executeWebToolCall(ctx, 'fetch', fetchRequest, true, dispatch, () => 'failed')).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_PENDING' })
      expect(dispatch).toHaveBeenCalledOnce()
    })
  })
  it('migrates exactly two multipliers, retains configuration and audit, and fences rollback after later admin edits', async () => {
    const schema = `billing_migration_${randomUUID().replaceAll('-', '')}`
    const sql = readFileSync(new URL('../../prisma/migrations/20261020120000_web_tool_billing/migration.sql', import.meta.url), 'utf8')
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
      try {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
        await tx.$executeRawUnsafe('CREATE TABLE agent_runs (id VARCHAR(64) PRIMARY KEY)')
        await tx.$executeRawUnsafe(`CREATE TABLE ai_model_configs (key VARCHAR(64) PRIMARY KEY, owner_user_id VARCHAR(64),
          multiplier_bps INTEGER, updated_at TIMESTAMP(3), provider TEXT, base_url TEXT, api_key_ciphertext TEXT, enabled BOOLEAN, metadata JSONB)`)
        await tx.$executeRawUnsafe(`INSERT INTO ai_model_configs VALUES
          ('tool:web-search', NULL, 20000, '2026-01-01', 'bocha', 'https://search.example', 'fixture-not-real', true, '{"keep":true}'),
          ('tool:web-fetch', NULL, 30000, '2026-01-01', 'unconfigured', NULL, NULL, false, '{"keep":true}'),
          ('other', NULL, 48000, '2026-01-01', 'other', 'https://other.example', 'fixture-not-real', true, '{}')`)
        const before = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM ai_model_configs ORDER BY key')
        for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(value => value && !['BEGIN', 'COMMIT'].includes(value))) {
          await tx.$executeRawUnsafe(statement)
        }
        const after = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM ai_model_configs ORDER BY key')
        for (const row of after) {
          const original = before.find(item => item.key === row.key)!
          expect({ ...row, multiplier_bps: original.multiplier_bps, updated_at: original.updated_at }).toEqual(original)
          expect(row.multiplier_bps).toBe(row.key === 'other' ? 48000 : 10000)
        }
        const audit = await tx.$queryRawUnsafe<Array<{ key: string; previous_multiplier: number }>>('SELECT key, previous_multiplier FROM web_tool_price_migration_20261020 ORDER BY key')
        expect(audit).toEqual([{ key: 'tool:web-fetch', previous_multiplier: 30000 }, { key: 'tool:web-search', previous_multiplier: 20000 }])
        await tx.$executeRawUnsafe(`UPDATE ai_model_configs SET multiplier_bps=15000, updated_at='2026-12-01' WHERE key='tool:web-search'`)
        const rolledBack = await tx.$executeRawUnsafe(`UPDATE ai_model_configs c SET multiplier_bps=b.previous_multiplier, updated_at=CURRENT_TIMESTAMP
          FROM web_tool_price_migration_20261020 b WHERE c.key=b.key AND c.owner_user_id IS NULL AND c.multiplier_bps=10000 AND c.updated_at=b.applied_at`)
        expect(rolledBack).toBe(1)
        const prices = await tx.$queryRawUnsafe<Array<{ key: string; multiplier_bps: number }>>('SELECT key, multiplier_bps FROM ai_model_configs ORDER BY key')
        expect(prices.map(row => row.multiplier_bps)).toEqual([48000, 30000, 15000])
      } finally {
        await tx.$executeRawUnsafe('SET LOCAL search_path TO public')
        await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
      }
    })
  })
  it.each(['search', 'fetch'] as const)('freezes %s price, replays without repricing and charges a genuinely new call', async kind => {
    const config = await prisma.aiModelConfig.findUniqueOrThrow({ where: { key: `tool:web-${kind}` } })
    try {
      await prisma.aiModelConfig.update({ where: { id: config.id }, data: { multiplierBps: 12500 } })
      await fixture(async ctx => {
        const dispatch = vi.fn(async () => success)
        expect(await executeWebToolCall(ctx, kind, request, true, dispatch, classify)).toEqual(success)
        await prisma.aiModelConfig.update({ where: { id: config.id }, data: { multiplierBps: 20000 } })
        expect(await findWebToolCallOutcome(ctx, kind, request)).toEqual(success)
        expect(dispatch).toHaveBeenCalledOnce()
        expect((await ledger(ctx)).map(row => [row.sourceType, row.deltaMilli, row.multiplierBps, row.modelTier, row.requestTokens])).toEqual([[`web_${kind}`, -2500, 12500, null, null]])
        await executeWebToolCall({ ...ctx, callId: randomUUID() }, kind, request, true, dispatch, classify)
        expect((await ledger(ctx)).map(row => row.deltaMilli)).toEqual([-2500, -4000])
        await expect(findWebToolCallOutcome(ctx, kind, { ...request, count: 8 })).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
      })
    } finally { await prisma.aiModelConfig.update({ where: { id: config.id }, data: { multiplierBps: config.multiplierBps } }) }
  })

  it.each(['empty', 'fallback', 'failed', 'aborted'] as const)('refunds %s exactly once and persists the outcome before cancellation propagates', async outcome => {
    await fixture(async ctx => {
      const controller = new AbortController()
      const scoped = { ...ctx, signal: controller.signal }
      const run = executeWebToolCall(scoped, 'search', request, true, async () => {
        if (outcome === 'failed') throw new Error('supplier unavailable')
        if (outcome === 'aborted') { controller.abort(new Error('author stopped')); throw controller.signal.reason }
        return { ...success, provider: outcome === 'fallback' ? 'sogou' : 'bocha', results: outcome === 'empty' ? [] : success.results }
      }, classify)
      if (outcome === 'failed' || outcome === 'aborted') await expect(run).rejects.toThrow(outcome === 'failed' ? 'supplier unavailable' : 'author stopped')
      else await run
      await Promise.all([reconcileCreditRefunds({ userId: ctx.userId }), reconcileCreditRefunds({ userId: ctx.userId })])
      const entries = await ledger(ctx)
      expect(entries).toHaveLength(2)
      expect(entries.reduce((total, row) => total + row.deltaMilli, 0)).toBe(0)
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: ctx.userId } })).dailyUsedMilli).toBe(0)
      const intent = await prisma.creditRefundIntent.findFirstOrThrow({ where: { originalEntry: { userId: ctx.userId } } })
      expect(intent.settledAt).not.toBeNull()
      if (outcome === 'failed' || outcome === 'aborted') await expect(findWebToolCallOutcome(ctx, 'search', request)).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_FAILED' })
    })
  })

  it('allows only one supplier dispatch for concurrent duplicate deliveries and fences an unknown outcome', async () => {
    await fixture(async ctx => {
      let finish!: (result: Result) => void
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const dispatch = vi.fn(() => { entered(); return new Promise<Result>(resolve => { finish = resolve }) })
      const first = executeWebToolCall(ctx, 'search', request, true, dispatch, classify)
      await started
      await expect(findWebToolCallOutcome(ctx, 'search', request)).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_PENDING' })
      await expect(executeWebToolCall(ctx, 'search', request, true, dispatch, classify)).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_PENDING' })
      expect(dispatch).toHaveBeenCalledOnce()
      finish(success)
      await first
      expect(await findWebToolCallOutcome(ctx, 'search', request)).toEqual(success)
      expect(await ledger(ctx)).toHaveLength(1)
    })
  })

  it('keeps a durable refund obligation through a recoverable wallet failure and rejects a mismatched receipt', async () => {
    await fixture(async ctx => {
      await executeWebToolCall(ctx, 'fetch', request, true, async () => success, classify)
      const debit = (await ledger(ctx))[0]
      const receipt = await prisma.webToolCall.findFirstOrThrow({ where: { runId: ctx.runId } })
      // Simulate a known cancellation discovered after completion; no supplier redispatch.
      await prisma.creditRefundIntent.create({ data: { originalEntryId: debit.id, reason: 'web_tool_no_billable_result', evidence: { callId: receipt.id, outcome: 'aborted' } } })
      // Cross-window refunds restore to bonus. Exhaust its integer capacity in
      // this fixture only, exercising a real rolled-back wallet settlement.
      await prisma.creditLedgerEntry.update({ where: { id: debit.id }, data: { createdAt: new Date(Date.now() - 2 * 86400000) } })
      await prisma.creditAccount.update({ where: { userId: ctx.userId }, data: { dailyUsedMilli: 0, bonusBalanceMilli: 2147483647 } })
      expect(await reconcileCreditRefunds({ userId: ctx.userId })).toEqual({ examined: 1, settled: 0 })
      expect((await prisma.creditRefundIntent.findUniqueOrThrow({ where: { originalEntryId: debit.id } })).settledAt).toBeNull()
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: ctx.userId } })).bonusBalanceMilli).toBe(2147483647)
      expect(await ledger(ctx)).toHaveLength(1)
      await prisma.creditAccount.update({ where: { userId: ctx.userId }, data: { bonusBalanceMilli: 0 } })
      await prisma.creditRefundIntent.update({ where: { originalEntryId: debit.id }, data: { nextAttemptAt: new Date(), evidence: { callId: 'a'.repeat(64), outcome: 'aborted' } } })
      expect(await reconcileCreditRefunds({ userId: ctx.userId })).toEqual({ examined: 1, settled: 0 })
      expect(await ledger(ctx)).toHaveLength(1)
      await prisma.creditRefundIntent.update({ where: { originalEntryId: debit.id }, data: { nextAttemptAt: new Date(), evidence: { callId: receipt.id, outcome: 'aborted' } } })
      expect(await reconcileCreditRefunds({ userId: ctx.userId })).toEqual({ examined: 1, settled: 1 })
      expect((await ledger(ctx)).reduce((sum, row) => sum + row.deltaMilli, 0)).toBe(0)
    })
  })

  it('atomically admits only one of two simultaneous first deliveries', async () => {
    await fixture(async ctx => {
      let release!: (result: Result) => void
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const dispatch = vi.fn(() => { entered(); return new Promise<Result>(resolve => { release = resolve }) })
      const results = Promise.allSettled([
        executeWebToolCall(ctx, 'search', request, true, dispatch, classify),
        executeWebToolCall(ctx, 'search', request, true, dispatch, classify),
      ])
      await started
      release(success)
      const settled = await results
      expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      expect(settled.filter(item => item.status === 'rejected')).toEqual([{ status: 'rejected', reason: expect.objectContaining({ code: 'CREDIT_WEB_TOOL_PENDING' }) }])
      expect(dispatch).toHaveBeenCalledOnce()
      expect(await ledger(ctx)).toHaveLength(1)
    })
  })

  it('permits a configured zero multiplier on an empty wallet and never manufactures a refund for zero debit', async () => {
    const config = await prisma.aiModelConfig.findUniqueOrThrow({ where: { key: 'tool:web-fetch' } })
    try {
      await prisma.aiModelConfig.update({ where: { id: config.id }, data: { multiplierBps: 0 } })
      await fixture(async ctx => {
        await executeWebToolCall(ctx, 'fetch', request, true, async () => ({ ...success, results: [] }), classify)
        expect((await ledger(ctx)).map(row => row.deltaMilli)).toEqual([0])
        expect(await prisma.creditRefundIntent.count({ where: { originalEntry: { userId: ctx.userId } } })).toBe(0)
      }, 0)
    } finally { await prisma.aiModelConfig.update({ where: { id: config.id }, data: { multiplierBps: config.multiplierBps } }) }
  })
  it.each(['search', 'fetch'] as const)('refunds %s cancellation after supplier completion during delivery exactly once', async kind => {
    await fixture(async ctx => {
      const controller = new AbortController()
      const scoped = { ...ctx, signal: controller.signal }
      await executeWebToolCall(scoped, kind, request, true, async () => success, classify)
      controller.abort(new Error('cancel while saving research'))
      await refundCancelledWebToolCall(scoped, kind, request)
      await refundCancelledWebToolCall(scoped, kind, request)
      expect((await ledger(ctx)).map(row => row.kind).sort()).toEqual(['refund', 'usage'])
      expect((await ledger(ctx)).reduce((sum, row) => sum + row.deltaMilli, 0)).toBe(0)
      expect(await findWebToolCallOutcome(ctx, kind, request)).toEqual(success)
    })
  })
  it('settles an already-durable refund after its author deletes the owning task and dispatch receipt', async () => {
    await fixture(async ctx => {
      await executeWebToolCall(ctx, 'search', request, true, async () => success, classify)
      const debit = (await ledger(ctx))[0]
      const receipt = await prisma.webToolCall.findFirstOrThrow({ where: { runId: ctx.runId } })
      await prisma.creditRefundIntent.create({ data: { originalEntryId: debit.id, reason: 'web_tool_no_billable_result', evidence: { callId: receipt.id, outcome: 'aborted' } } })
      await prisma.agentRun.delete({ where: { id: ctx.runId } })
      expect(await prisma.webToolCall.count({ where: { id: receipt.id } })).toBe(0)
      expect(await reconcileCreditRefunds({ userId: ctx.userId })).toEqual({ examined: 1, settled: 1 })
      await reconcileCreditRefunds({ userId: ctx.userId })
      expect((await ledger(ctx)).map(row => row.kind).sort()).toEqual(['refund', 'usage'])
      expect((await ledger(ctx)).reduce((sum, row) => sum + row.deltaMilli, 0)).toBe(0)
    })
  })

  it('preserves free cache receipt across process cache loss, and direct fallback cannot become a paid Fetch', async () => {
    await fixture(async ctx => {
      await saveWebToolCacheOutcome(ctx, 'search', request, success)
      expect(await findWebToolCallOutcome(ctx, 'search', request)).toEqual(success)
      expect(await ledger(ctx)).toHaveLength(0)
      await expect(findWebToolCallOutcome(ctx, 'search', { query: 'other' })).rejects.toMatchObject({ code: 'CREDIT_IDEMPOTENCY_CONFLICT' })
      const direct = { ...ctx, callId: randomUUID() }
      await executeWebToolCall(direct, 'fetch', { url: 'https://example.com' }, false, async () => ({ ...success, provider: 'direct' }), classify)
      expect((await ledger(ctx)).reduce((sum, row) => sum + row.deltaMilli, 0)).toBe(0)
      expect(await findWebToolCallOutcome(direct, 'fetch', { url: 'https://example.com' })).toMatchObject({ provider: 'direct' })
    })
  })

  it('does not dispatch or leave receipts on insufficient balance, token reservation or inactive/cross-user runs', async () => {
    await fixture(async ctx => {
      const dispatch = vi.fn(async () => success)
      await expect(executeWebToolCall(ctx, 'search', request, true, dispatch, classify)).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
      expect(dispatch).not.toHaveBeenCalled()
      expect(await prisma.webToolCall.count({ where: { runId: ctx.runId } })).toBe(0)
      await prisma.creditAccount.update({ where: { userId: ctx.userId }, data: { dailyAllowanceMilli: 2500 } })
      const usage = await prisma.aiUsageLog.create({ data: { userId: ctx.userId, providerType: 'text', providerMode: 'fixture', modelName: 'fixture',
        action: 'fixture', targetType: 'text', modelTier: 'speed', durationMs: 0, billingStatus: 'prepared',
        billingSnapshot: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 } } })
      await reserveTokenCredits(ctx.userId, usage.id, 20000, 10000)
      await expect(executeWebToolCall(ctx, 'fetch', request, true, dispatch, classify)).rejects.toMatchObject({ code: 'CREDITS_RESERVED' })
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'cancelled' } })
      await expect(executeWebToolCall(ctx, 'fetch', request, true, dispatch, classify)).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_INACTIVE' })
      await expect(findWebToolCallOutcome({ ...ctx, userId: 'different-user' }, 'search', request)).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_SCOPE' })
      expect(dispatch).not.toHaveBeenCalled()
      expect(await ledger(ctx)).toHaveLength(0)
    }, 1000)
  })
})
