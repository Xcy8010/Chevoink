import { createHash } from 'node:crypto'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { z } from 'zod'
import { env } from '../../api/config/env.js'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import * as models from '../../api/lib/tool-model-config.js'
import * as search from '../../api/lib/web-search-service.js'
import * as reader from '../../api/lib/web-reader-service.js'
import { extractReaderNavigationHtml } from '../../api/lib/web-reader-quality.js'
import * as sources from '../../api/lib/agent/research-sources.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { webSearchTool, webReadNavigationTool } from '../../api/lib/agent/tools/search-tools.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0]
const args = { query: 'public source fixture', maxResults: 2 }
const request = { query: args.query, count: args.maxResults }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const outcome: search.WebSearchOutcome = { provider: 'bocha', results: [
  { title: 'Author chapter', url: 'https://fiction.example.com/chapter/1', snippet: 'Public text', source: 'fiction.example.com' },
] }
async function start(f: Fixture, tool: Pick<AgentTool, 'name' | 'description' | 'parameters'> = webSearchTool, toolArgs: unknown = args) {
  const lease = await claim(f)
  await initializeExecutionState(lease, { configuration: { version: 1, mode: 'plan', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
    toolAuthority: [{ name: tool.name, permission: 'allow', dangerous: false, alwaysConfirm: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
  snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
    messages: [{ role: 'user', content: 'Search public sources' }, { role: 'assistant', content: null, toolCalls: [{ id: 'original-search', name: tool.name, arguments: JSON.stringify(toolArgs) }] }], successfulToolSignatures: [] } })
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
  const period = getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 20000, periodStartedAt: period.startedAt, periodEndsAt: period.endsAt } })
  return lease
}
async function webFixture(work: (f: Fixture, lease: Awaited<ReturnType<typeof start>>, transport: MockInstance<typeof search.searchWeb>) => Promise<void>) {
  const provider = env.webSearchProvider
  env.webSearchProvider = 'bocha'
  vi.spyOn(models, 'getToolModelRuntime').mockResolvedValue(null)
  const transport = vi.spyOn(search, 'searchWeb').mockResolvedValue(outcome)
  const fetch = vi.fn(() => { throw Error('Unexpected real HTTP') }); vi.stubGlobal('fetch', fetch)
  try { await fixture(async f => { await work(f, await start(f), transport); expect(fetch).not.toHaveBeenCalled() }, undefined, '只读联网搜索公开资料') }
  finally { env.webSearchProvider = provider }
}
const signal = () => new AbortController().signal

describe.runIf(available)('durable web identity, research budget and dispatch fence', () => {
  it.each(['receipt', 'raw-projection'] as const)('recovers %s without redispatch or repricing, including a new run', scenario => webFixture(async (f, initialLease, transport) => {
    let lease = initialLease
    if (scenario === 'receipt') vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after receipt'))
    else vi.spyOn(sources, 'saveResearchSearchOutcome').mockRejectedValueOnce(Error('interrupted before projection'))
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('interrupted')
    expect(await prisma.webToolCall.count({ where: { runId: f.runId, status: 'completed' } })).toBe(1)
    expect(await prisma.agentResearchRequest.count({ where: { ownerRunId: f.runId, status: 'consumed', kind: 'search' } })).toBe(1)
    if (scenario === 'raw-projection') {
      await pauseDurableTask(f.userId, f.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
      lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'worker-b')
      await prisma.agentRun.update({ where: { id: lease.runId }, data: { status: 'running' } })
    }
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: scenario === 'receipt' ? 'recovered' : 'tool' })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(1)
    const row = await prisma.webToolCall.findFirstOrThrow({ where: { runId: f.runId } })
    expect(row.amountMilli).toBe(2000)
    expect(await prisma.webToolCall.count({ where: { runId: lease.runId } })).toBe(lease.runId === f.runId ? 1 : 0)
    const state = await loadExecutionState(f.userId, lease.runId)
    expect(state.frame.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'original-search' })
    expect(await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'web_search' } })).toMatchObject({ originRunId: f.runId })
    expect(state.frame.state.messages.at(-1)?.content).toContain('Author chapter')
  }))

  it.each(['revoked', 'cancelled', 'exhausted'] as const)('rolls back %s admission before network, debit and reservation', scenario => webFixture(async (f, lease, transport) => {
    const controller = new AbortController()
    if (scenario === 'exhausted') await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyAllowanceMilli: 0 } })
    else vi.mocked(models.getToolModelRuntime).mockImplementationOnce(async () => {
      if (scenario === 'revoked') await prisma.agentSession.update({ where: { id: f.sessionId }, data: { toolPolicy: { network: 'deny' } } })
      else controller.abort(Error('cancelled before dispatch'))
      return null
    })
    if (scenario === 'exhausted') expect(await executeDurableToolStep(lease, controller.signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed', failureCode: 'CREDITS_EXHAUSTED' } })
    else await expect(executeDurableToolStep(lease, controller.signal)).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.webToolCall.count({ where: { runId: f.runId } })).toBe(0)
    expect(await prisma.agentResearchRequest.count({ where: { ownerRunId: f.runId } })).toBe(0)
  }))

  it('preserves an unknown original dispatch and its consumed budget', () => webFixture(async (f, lease, transport) => {
    const ctx = { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: f.runId, callId: 'original-search' }
    await sources.reserveResearchRequest(ctx, 'search', digest(request))
    await sources.settleResearchRequest(ctx, 'consumed')
    await prisma.webToolCall.create({ data: { id: digest([f.userId, f.runId, ctx.callId, 'search']), runId: f.runId,
      kind: 'search', requestHash: digest(request), amountMilli: 2000, multiplierBps: 10000 } })
    await expect(executeDurableToolStep(lease, signal())).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_PENDING' })
    expect(transport).not.toHaveBeenCalled()
    expect(await prisma.agentResearchRequest.count({ where: { ownerRunId: f.runId, status: 'consumed' } })).toBe(1)
    expect(await prisma.webToolCall.count({ where: { runId: f.runId, status: 'dispatched' } })).toBe(1)
    expect((await loadExecutionState(f.userId, f.runId)).frame.state.phase).toBe('awaiting_operation')
  }))

  it('keeps a real dispatched transport timeout pending across resume, independently of the user refund', () => webFixture(async (f, lease, transport) => {
    transport.mockRejectedValueOnce(Error('synthetic supplier connection lost after sending request'))
    await expect(executeDurableToolStep(lease, signal())).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_PENDING' })
    const first = await prisma.webToolCall.findFirstOrThrow({ where: { runId: f.runId } })
    expect(first.status).toBe('dispatched')
    expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
    await pauseDurableTask(f.userId, f.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
    const nextLease = await claim({ userId: f.userId, runId: resumed.run.id }, 'worker-b')
    await prisma.agentRun.update({ where: { id: nextLease.runId }, data: { status: 'running' } })
    await expect(executeDurableToolStep(nextLease, signal())).rejects.toMatchObject({ code: 'CREDIT_WEB_TOOL_PENDING' })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(await prisma.webToolCall.count({ where: { runId: f.runId } })).toBe(1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(1)
    expect(await prisma.agentResearchRequest.count({ where: { ownerRunId: f.runId, status: 'consumed' } })).toBe(1)
  }))

  it.each([429, 503])('records an observed HTTP %s rejection without inventing transport uncertainty', status => webFixture(async (f, lease, transport) => {
    transport.mockRejectedValueOnce(new search.WebSearchError('HTTP rejection fixture', [{ provider: 'bocha', outcome: 'failed', durationMs: 1, httpStatus: status }]))
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
    expect((await prisma.webToolCall.findFirstOrThrow({ where: { runId: f.runId } })).status).toBe('failed')
    expect((await loadExecutionState(f.userId, f.runId)).frame.state.phase).toBe('idle')
    expect(transport).toHaveBeenCalledTimes(1)
  }))

  it.each(['interrupted', 'known-rejection'] as const)('atomically closes navigation projection %s without a paid body reader', scenario => fixture(async f => {
    expect(f.spec.researchNavigation?.version).toBe(1)
    expect(f.spec.researchNavigation?.sourceHosts).toContain('fiction.example.com')
    const url = 'https://fiction.example.com/page/book-1'
    const html = `<html><head><title>河谷纪事</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Book', name: '河谷纪事', author: '林青' })}</script></head><body><nav><a href="/chapter/1">第一章 河流</a></nav></body></html>`
    const page: reader.WebReadResult = { ...extractReaderNavigationHtml(html, url), finalUrl: url, provider: 'direct', retryable: false, contentKind: 'metadata', purpose: 'navigation' }
    expect(page.evidence?.identity.status).toBe('unknown')
    const navigation = vi.spyOn(reader, 'readPublicWebNavigation').mockResolvedValue(page)
    const body = vi.spyOn(reader, 'readPublicWebPage').mockRejectedValue(Error('Must not use a body reader'))
    const configuration = vi.spyOn(models, 'getToolModelRuntime').mockRejectedValue(Error('Must not resolve a paid reader'))
    const lease = await start(f, webReadNavigationTool, { url, purpose: 'navigation' })
    const seed = { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: f.runId, callId: 'seed-search' }
    await sources.reserveResearchRequest(seed, 'search', 'seed')
    await sources.settleResearchRequest(seed, 'consumed')
    await sources.saveResearchSearchOutcome(seed, { provider: 'sogou', results: [{ title: '河谷纪事_林青', url, source: 'fiction.example.com', snippet: '作者林青的作品目录' }] }, '小说 公开章节')
    // Real Search projects both the saved transport outcome and owned sources.
    // The outcome alone is not a URL-provenance grant for a later Fetch.
    await sources.registerResearchSources(seed, [{ title: '河谷纪事_林青', url, source: 'fiction.example.com', snippet: '作者林青的作品目录' }])
    if (scenario === 'interrupted') {
      vi.spyOn(sources, 'readResearchContent').mockRejectedValueOnce(Error('interrupted after content save'))
      await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('interrupted after content save')
    } else {
      vi.spyOn(sources, 'saveResearchContent').mockRejectedValueOnce(new DataAccessError(403, 'RESEARCH_SOURCE_SCOPE_MISMATCH', 'synthetic final source outside frozen scope'))
      expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed', failureCode: 'RESEARCH_SOURCE_SCOPE_MISMATCH' } })
      const failed = await prisma.agentResearchRequest.findFirstOrThrow({ where: { ownerRunId: f.runId, kind: 'read', status: 'consumed' } })
      expect(failed.savedOutcome).toMatchObject({ purpose: 'navigation', ok: false })
    }
    expect(await prisma.agentResearchContent.count({ where: { source: { ownerRunId: f.runId } } })).toBe(0)
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'contextCheckpoint' } })).toBe(0)
    if (scenario === 'known-rejection') {
      const { frame } = await loadExecutionState(f.userId, f.runId)
      await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...frame.state,
        messages: [...frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'second-navigation', name: 'web_read', arguments: JSON.stringify({ url, purpose: 'navigation' }) }] }] } })
    }
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool' })
    expect(navigation).toHaveBeenCalledTimes(scenario === 'interrupted' ? 1 : 2)
    expect(body).not.toHaveBeenCalled(); expect(configuration).not.toHaveBeenCalled()
    expect(await prisma.agentResearchContent.count({ where: { source: { ownerRunId: f.runId } } })).toBe(1)
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'contextCheckpoint' } })).toBe(1)
    expect(await prisma.webToolCall.count({ where: { runId: f.runId, amountMilli: { not: 0 } } })).toBe(0)
    expect(await prisma.agentResearchRequest.count({ where: { ownerRunId: f.runId, kind: 'read', status: 'consumed' } })).toBe(scenario === 'interrupted' ? 1 : 2)
  }, undefined, '仅在https://fiction.example.com 联网选一本有公开章节的小说，核对书名作者，深度研究写作手法', { researchNavigationAdmission: 1 }))
})
