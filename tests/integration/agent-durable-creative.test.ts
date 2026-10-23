import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import * as creative from '../../api/lib/agent/tools/creative-review.js'
import { creativeCritiqueTool, creativeRevisionDraftTool } from '../../api/lib/agent/tools/skill-tools.js'
import { skillCatalog } from '../../api/lib/agent/skills/index.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'isolated-fake-key', reasoningEffort: 'high', reasoningEfforts: ['high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'creative-isolated-fixture',
  rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
const response = () => Response.json({ choices: [{ message: { role: 'assistant', content: '1. “原文”：这一处应澄清人物的实际行动。' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })

describe.runIf(available)('durable independent creative artifacts', () => {
  it.each(['critique-build', 'critique-review', 'revision', 'result-recovery', 'receipt-recovery', 'stale-body', 'archived-before-dispatch', 'changed-free-route', 'wrong-critique', 'unknown'] as const)('%s preserves the original request, bill and source', scenario => fixture(async f => {
    const revision = scenario === 'revision' || scenario === 'wrong-critique'
    const tool = revision ? creativeRevisionDraftTool : creativeCritiqueTool
    const mode = scenario === 'critique-review' ? 'review' : 'build'
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const critique = revision ? await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Original critique', content: 'Selected critique',
      metadata: { chapterId: scenario === 'wrong-critique' ? 'another-chapter' : f.chapterId, revision: chapter.revision, phase: 'critique' } } }) : null
    const args = { chapterId: f.chapterId, skillIds: [skillCatalog.find(skill => skill.phases.includes(revision ? 'revision' : 'critique'))!.id], creativeFreedom: 'balanced',
      ...(critique ? { critiqueArtifactId: critique.id, selectedFindings: ['澄清人物的实际行动'] } : {}) }
    const lease = await claim(f)
    await initializeExecutionState(lease, { configuration: { version: 1, mode, agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
      toolAuthority: [{ name: tool.name, permission: 'allow', dangerous: false, alwaysConfirm: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
    snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
      messages: [{ role: 'user', content: '独立批评并只生成选中意见的修订草稿' }, { role: 'assistant', content: null, toolCalls: [{ id: 'creative-call', name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
    const period = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: period.startedAt, periodEndsAt: period.endsAt } })
    vi.spyOn(credits, 'getModelTierRuntime').mockImplementation(async () => {
      if (scenario === 'archived-before-dispatch') await prisma.chapter.update({ where: { id: f.chapterId }, data: { archivedAt: new Date() } })
      return scenario === 'changed-free-route' ? { ...runtime, multiplierBps: 0, provider: 'changed-provider' } : runtime
    })
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue(price)
    const fetch = vi.fn(async () => {
      if (scenario === 'unknown') throw Error('Supplier response lost')
      if (scenario === 'stale-body') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者新的正文', revision: { increment: 1 } } })
      return response()
    }); vi.stubGlobal('fetch', fetch)
    if (scenario === 'result-recovery') vi.spyOn(creative, 'saveCreativeReview').mockRejectedValueOnce(Error('interrupted before artifact'))
    if (scenario === 'receipt-recovery') vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after artifact'))
    if (scenario === 'unknown') {
      await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow()
      await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect((await loadExecutionState(f.userId, f.runId)).frame.state.phase).toBe('awaiting_operation')
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId } })).toBe(0)
      return
    }
    if (scenario === 'changed-free-route') {
      await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      expect(fetch).not.toHaveBeenCalled()
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      return
    }
    if (scenario === 'result-recovery' || scenario === 'receipt-recovery') {
      await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('interrupted')
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: scenario === 'receipt-recovery' ? 'recovered' : 'tool' })
    } else expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result:
      scenario === 'wrong-critique' || scenario === 'stale-body' || scenario === 'archived-before-dispatch' ? { outcome: 'failed' } : { summary: expect.stringContaining(revision ? '选择性修订稿' : '独立批评') } })
    expect(fetch).toHaveBeenCalledTimes(scenario === 'wrong-critique' || scenario === 'archived-before-dispatch' ? 0 : 1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(scenario === 'wrong-critique' || scenario === 'archived-before-dispatch' ? 0 : 1)
    const generated = await prisma.agentArtifact.findMany({ where: { runId: f.runId, ...(critique ? { id: { not: critique.id } } : {}) } })
    expect(generated).toHaveLength(scenario === 'wrong-critique' || scenario === 'stale-body' || scenario === 'archived-before-dispatch' ? 0 : 1)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(scenario === 'stale-body' ? '作者新的正文' : '原文')
    if (fetch.mock.calls.length) {
      const provider = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } } })
      expect(JSON.stringify(provider.requestSnapshot)).not.toContain('isolated-fake-key')
      expect(provider.status).toBe('succeeded')
    }
  }))
})
