import { DURABLE_FULL_CHAIN_TEST_TIMEOUT_MS } from '../support/durable-test-lifecycle.js'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture, claim } from '../support/agent-durable-runtime-fixture.js'
import { initializeExecutionState, saveExecutionState } from '../support/native-tool-test-state.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { toOpenAIToolPresentation } from '../../api/lib/agent/tool-schema.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { prisma } from '../../api/lib/prisma.js'

describe.runIf(available)('new ordinary quality calls after a settled standalone failure', () => {
  it('retries through a new call while retaining the failed report, old claims and settled fees', async () => fixture(async f => {
    const lease = await claim(f), signal = new AbortController().signal
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 0, provider: 'fixture', modelName: 'fixture',
      baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-not-a-key', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
      reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null })
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 0 })
    let valid = false
    const transport = vi.fn(async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: valid ? '{"findings":[]}' : '{"findings":[' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', transport)
    const args = { chapterId: f.chapterId }
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [chapterReadTool, qualityAnalyzeTool].map(tool => ({ type: 'function', function: { name: tool.name, ...toOpenAIToolPresentation(tool, f.spec.scope) } })),
      toolAuthority: [chapterReadTool, qualityAnalyzeTool].map(tool => ({ name: tool.name, permission: 'allow', dangerous: false, alwaysConfirm: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
        messages: [{ role: 'user', content: '检查当前章质量' }, { role: 'assistant', content: null, toolCalls: [{ id: 'actual-read', name: 'chapter_read', arguments: JSON.stringify(args) }, { id: 'first-check', name: 'quality_analyze', arguments: JSON.stringify(args) }] }] } })
    expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool' })
    expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' } })
    const old = await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId }, orderBy: { createdAt: 'desc' } })
    expect(old).toMatchObject({ status: 'failed', compilationId: null })
    const before = transport.mock.calls.length
    valid = true
    const source = await loadExecutionState(f.userId, f.runId)
    await saveExecutionState(lease, { expectedRevision: source.frame.revision, expectedHash: source.frame.snapshotHash,
      snapshot: { ...source.frame.state, messages: [...source.frame.state.messages, { role: 'assistant', content: null,
        toolCalls: [{ id: 'new-check', name: 'quality_analyze', arguments: JSON.stringify(args) }] }] } })
    const result = await executeDurableToolStep(lease, signal)
    expect(result).toMatchObject({ kind: 'tool' })
    if (result.kind !== 'tool') throw Error('expected a completed new quality call')
    expect(result.result.outcome).not.toBe('failed')
    expect(transport.mock.calls.length).toBeGreaterThan(before)
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old)
    expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(2)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { action: { not: 'fixture_model_turn' }, taskRootId: f.rootId }, status: { in: ['dispatching', 'unknown'] } } })).toBe(0)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '原文', revision: 1 })
  }, undefined, '检查当前章质量'), DURABLE_FULL_CHAIN_TEST_TIMEOUT_MS)
})
