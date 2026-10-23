import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as tools from '../../api/lib/tool-model-config.js'
import * as search from '../../api/lib/web-search-service.js'
import * as contract from '../../api/lib/agent/runtime-dossier-contract.js'
import * as dossier from '../../api/lib/agent/research-dossier.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { researchDossierBuildTool as tool } from '../../api/lib/agent/tools/research-dossier-tools.js'
import { researchDossierBuildSchema } from '../../shared/contracts/index.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'isolated-fixture-key', reasoningEffort: 'high', reasoningEfforts: ['high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'dossier-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
const originalArgs = { topic: '雪原救援', genre: '探险', triggerReason: 'new_book' as const, triggerSignals: ['核对职业细节'], targetAudience: '成年读者', queries: ['雪原 救援一', '雪原 救援二', '雪原 救援三'] }
const synthesis = { readerPromise: '具体人物选择', abandonmentRisks: ['说明过多'], marketPatterns: [], differentiation: ['明确代价'], factCards: [], languageRisks: [], recommendations: ['用行动呈现'], rejectedIdeas: [] }
const wire = (content: string, finish = 'stop') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })

describe.runIf(available)('research dossier owns its original queries, synthesis and effect', () => {
  it.each(['three-build', 'one-plan', 'two-build', 'review-deny', 'cache', 'cooldown', 'force-no-proof', 'force-human', 'query-recovery', 'model-recovery',
    'receipt-recovery', 'resume', 'search-unknown', 'search-rejected', 'search-empty', 'cancel-after-query', 'model-unknown', 'model-length', 'invalid-complete', 'current-deny', 'predecessor-conflict', 'synthesis-preflight-conflict'] as const)('%s', scenario => fixture(async f => {
    const args = researchDossierBuildSchema.parse({ ...originalArgs, queries: originalArgs.queries.slice(0, scenario === 'one-plan' ? 1 : scenario === 'two-build' ? 2 : 3),
      ...(scenario.startsWith('force-') ? { forceRefresh: true, triggerReason: 'author_request' } : {}) })
    const prior = ['cache', 'cooldown', 'force-no-proof', 'force-human'].includes(scenario)
      ? await prisma.researchDossier.create({ data: { ...synthesis, id: crypto.randomUUID(), userId: f.userId, novelId: f.novelId, runId: f.runId,
        version: 1, status: 'ready', triggerReason: 'new_book', triggerSignals: [], topic: args.topic, genre: args.genre, targetAudience: args.targetAudience, targetPlatform: args.targetPlatform,
        queryPlan: [], sources: [], sourceHash: 'a'.repeat(64), cacheKey: scenario === 'cooldown' ? 'b'.repeat(64) : dossier.dossierCacheKey(args), expiresAt: new Date(Date.now() + 86400000) } }) : null
    let lease = await claim(f)
    const mode = scenario === 'one-plan' ? 'plan' : scenario === 'review-deny' ? 'review' : 'build'
    await initializeExecutionState(lease, { configuration: { version: 1, mode, agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
      toolAuthority: [{ name: tool.name, permission: 'allow', dangerous: false, alwaysConfirm: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
        messages: [{ role: 'user', content: '建立创作研究档案' }, { role: 'assistant', content: null, toolCalls: [{ id: 'dossier-call', name: tool.name, arguments: JSON.stringify(args) }] }] } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
    const period = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: period.startedAt, periodEndsAt: period.endsAt } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue()
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue(price)
    const config = vi.spyOn(tools, 'getToolModelRuntime').mockResolvedValue({ provider: 'bocha', modelName: 'bocha', baseUrl: 'https://search.example.org/v1', apiKey: 'isolated-search-key' })
    const createConcurrentDossier = () => prisma.researchDossier.create({ data: { ...synthesis, userId: f.userId, novelId: f.novelId, runId: f.runId,
      version: 1, status: 'ready', triggerReason: 'new_book', triggerSignals: [], topic: '其他合法入口的研究', genre: args.genre, targetAudience: args.targetAudience,
      queryPlan: [], sources: [], sourceHash: 'a'.repeat(64), cacheKey: 'b'.repeat(64), expiresAt: new Date(Date.now() + 86400000) } })
    if (scenario === 'synthesis-preflight-conflict') {
      const mark = operations.markProviderDispatched
      vi.spyOn(operations, 'markProviderDispatched').mockImplementationOnce(async (...input) => { await createConcurrentDossier(); return mark(...input) })
    }
    const controller = new AbortController()
    const searches = vi.spyOn(search, 'searchWeb').mockImplementation(async query => {
      if (scenario === 'search-unknown') throw new search.WebSearchUnknownError([{ provider: 'bocha', outcome: 'unknown', durationMs: 1 }])
      if (scenario === 'search-rejected') throw new search.WebSearchError('known rejection', [{ provider: 'bocha', outcome: 'failed', httpStatus: 429, durationMs: 1 }])
      if (scenario === 'current-deny') await prisma.agentSession.update({ where: { id: f.sessionId }, data: { toolPolicy: { network: 'deny', contentWrite: 'allow' } } })
      if (scenario === 'predecessor-conflict') await createConcurrentDossier()
      if (scenario === 'cancel-after-query') controller.abort(Error('cancel after query'))
      return { provider: 'bocha', results: scenario === 'search-empty' ? [] : [{ title: query, url: `https://example.org/${encodeURIComponent(query)}`, source: 'example.org', snippet: '原始公开摘要' }] }
    })
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.messages).toHaveLength(2)
      expect(body.messages[1].content).toContain('原始公开摘要')
      expect(body.tools).toBeUndefined()
      expect(body.response_format).toBeUndefined()
      if (scenario === 'model-unknown') throw Error('supplier result unknown')
      return wire(scenario === 'invalid-complete' ? 'complete invalid JSON' : JSON.stringify(synthesis), scenario === 'model-length' ? 'length' : 'stop')
    }); vi.stubGlobal('fetch', fetch)
    const step = () => executeDurableToolStep(lease, controller.signal)
    if (scenario === 'cancel-after-query') {
      await expect(step()).rejects.toThrow('cancel after query')
      expect(searches).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled()
      expect(await prisma.researchDossier.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.webToolCall.count({ where: { runId: f.runId, status: 'completed' } })).toBe(1)
      expect((await loadExecutionState(f.userId, lease.runId)).frame.state.phase).toBe('awaiting_operation')
      return
    }
    if (scenario === 'review-deny') {
      await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
      expect(searches).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
      return
    }
    if (scenario === 'query-recovery' || scenario === 'resume') vi.spyOn(contract, 'dossierSynthesisInput').mockRejectedValueOnce(Error('interrupted after queries'))
    if (scenario === 'model-recovery') vi.spyOn(dossier, 'parseResearchSynthesis').mockImplementationOnce(() => { throw Error('interrupted after model') })
    if (scenario === 'receipt-recovery') vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after receipt'))
    if (scenario === 'search-unknown' || scenario === 'model-unknown') {
      await expect(step()).rejects.toThrow()
      await expect(step()).rejects.toMatchObject({ code: scenario === 'search-unknown' ? 'CREDIT_WEB_TOOL_PENDING' : 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(searches).toHaveBeenCalledTimes(scenario === 'search-unknown' ? 1 : args.queries.length)
      expect(fetch).toHaveBeenCalledTimes(scenario === 'search-unknown' ? 0 : 1)
      expect(await prisma.researchDossier.count({ where: { novelId: f.novelId } })).toBe(0)
      expect((await loadExecutionState(f.userId, lease.runId)).frame.state.phase).toBe('awaiting_operation')
      return
    }
    if (scenario === 'current-deny') {
      await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
      expect(searches).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled()
      expect(await prisma.researchDossier.count({ where: { novelId: f.novelId } })).toBe(0)
      return
    }
    if (scenario.endsWith('recovery') || scenario === 'resume') {
      await expect(step()).rejects.toThrow('interrupted')
      config.mockRejectedValue(Error('must replay before current config'))
      if (scenario === 'resume') {
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, runId: lease.runId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id })
      }
    }
    const result = await step()
    const refused = ['review-deny', 'cooldown', 'force-no-proof', 'search-rejected', 'search-empty', 'model-length', 'predecessor-conflict', 'synthesis-preflight-conflict'].includes(scenario)
    if (scenario !== 'receipt-recovery') expect(result).toMatchObject({ kind: 'tool', result: refused ? { outcome: 'failed' } : { summary: expect.stringContaining('研究档案') } })
    else expect(result).toMatchObject({ kind: 'recovered' })
    const noIO = ['cache', 'cooldown', 'force-no-proof', 'review-deny'].includes(scenario)
    expect(searches).toHaveBeenCalledTimes(noIO ? 0 : ['search-rejected', 'predecessor-conflict'].includes(scenario) ? 1 : args.queries.length)
    expect(fetch).toHaveBeenCalledTimes(noIO || scenario === 'search-rejected' || scenario === 'search-empty' || scenario === 'predecessor-conflict' || scenario === 'synthesis-preflight-conflict' ? 0 : 1)
    const rows = await prisma.researchDossier.findMany({ where: { novelId: f.novelId }, orderBy: { version: 'desc' } })
    expect(rows).toHaveLength(scenario === 'force-human' ? 2 : prior || !refused || scenario === 'predecessor-conflict' || scenario === 'synthesis-preflight-conflict' ? 1 : 0)
    if (scenario === 'cache') { expect(rows[0].id).toBe(prior!.id); expect(rows[0].reusedCount).toBe(1); expect(config).not.toHaveBeenCalled() }
    if (!refused && !noIO) { expect(rows[0].searchCount).toBe(args.queries.length); expect(rows[0].runId).toBe(f.runId) }
    if (scenario === 'invalid-complete') { expect(rows[0].factCards).toEqual([]); expect(rows[0].marketPatterns).toEqual([]) }
    const webCalls = await prisma.webToolCall.findMany({ where: { runId: f.runId } })
    expect(webCalls.every(call => call.amountMilli === 0 && call.multiplierBps === 0)).toBe(true)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, sourceType: 'web_search', deltaMilli: { not: 0 } } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, sourceType: 'model_tokens' } })).toBe(fetch.mock.calls.length)
    expect(JSON.stringify(await prisma.agentOperation.findMany({ where: { taskRootId: f.rootId } }))).not.toContain('isolated-search-key')
  }, undefined, scenario === 'force-human' ? '请重新建立研究档案。' : '请建立创作研究档案。'))
})
