import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { prepareAuxiliaryModelOperation } from '../../api/lib/agent/runtime-auxiliary-model.js'
import type { DurableTokenPrice } from '../../api/lib/agent/runtime-settlement.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { chapterBridgeGetTool, continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'

describe.runIf(available)('native body report and first terminal review share the original task', () => {
  it.each(['complete-and-reenter', 'unknown-history'] as const)('%s preserves native receipts and unique settlement', scenario => fixture(async f => {
    const lease = await claim(f)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
    const content = 'The sealed packet remains with the guard.'
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 4, wordCount: content.length } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Review this saved chapter.' })
    const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Inspect the packet', entryState: state,
      goal: 'Inspect it', obstacle: 'A seal', choice: 'Leave it sealed', cost: 'Time', turn: 'Keep the packet', exitState: state,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const candidate = { exitState: { objects: [content] } }, tools = [chapterBridgeGetTool, continuityValidateTool, qualityAnalyzeTool, chapterBridgeCommitTool]
    const args = { compilationId: compilation.id }
    const calls = [
      { id: 'bridge-body', name: 'chapter_bridge_get', arguments: JSON.stringify(args) },
      { id: 'body-only', name: 'continuity_validate', arguments: JSON.stringify(args) },
      { id: 'bridge-terminal', name: 'chapter_bridge_get', arguments: JSON.stringify(args) },
      { id: 'first-terminal', name: 'continuity_validate', arguments: JSON.stringify({ ...args, terminalState: candidate }) },
      { id: 'same-terminal', name: 'continuity_validate', arguments: JSON.stringify({ ...args, terminalState: candidate }) },
      { id: 'quality', name: 'quality_analyze', arguments: JSON.stringify({ chapterId: chapter.id, compilationId: compilation.id }) },
      { id: 'bridge-commit', name: 'chapter_bridge_get', arguments: JSON.stringify(args) },
      { id: 'commit', name: 'chapter_bridge_commit', arguments: JSON.stringify(args) },
      { id: 'committed-bridge', name: 'chapter_bridge_get', arguments: JSON.stringify(args) },
      { id: 'committed-review', name: 'continuity_validate', arguments: JSON.stringify({ ...args, terminalState: candidate }) },
    ]
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改第一章' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 15000, provider: 'fixture', modelName: 'fixture',
      baseUrl: 'https://provider.invalid/v1', apiKey: 'isolated-placeholder', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
      reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 })
    const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'body-native-fixture',
      rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue(price)
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    let requests = 0, reentered = false
    const fetcher = vi.fn(async () => {
      requests++
      if (requests === 2) {
        const child = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, kind: 'provider', action: 'continuity_critic' },
          orderBy: { createdAt: 'desc' } })
        const frozen = child.inputSnapshot as { input: { request: Prisma.InputJsonValue; billing: DurableTokenPrice } }
        const attempts = await prisma.agentProviderAttempt.findMany({ where: { operationId: child.id }, orderBy: { id: 'asc' } })
        const again = await prepareAuxiliaryModelOperation(lease, { key: child.operationKey, action: child.action, step: 'continuity_critic',
          parentOperationId: child.parentOperationId!, request: frozen.input.request, price: frozen.input.billing })
        expect(again.id).toBe(child.id)
        expect(await prisma.agentProviderAttempt.findMany({ where: { operationId: child.id }, orderBy: { id: 'asc' } })).toEqual(attempts)
        reentered = true
      }
      const report = requests === 1 ? { findings: [],
        semanticChecks: { action_direction: { result: 'clear', reason: 'Saved body checked.', findingIndexes: [] },
          state_progression: { result: 'clear', reason: 'Saved body checked.', findingIndexes: [] } },
        terminalVerdicts: [], terminalProofVerdicts: [], terminalDispositions: [] }
        : requests === 2 ? { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear',
          reasonCode: 'consistent', explanation: 'The saved body is consistent.', findingIds: [] })),
          terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', reasonCode: 'consistent', explanation: 'The packet is still sealed.',
            manuscriptEvidence: [{ segmentId: 'c0' }] }], terminalProofVerdicts: [], terminalDispositions: [], issueDispositions: [] }
        : { findings: [] }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(report) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const step = () => executeDurableToolStep(lease, new AbortController().signal)
    await step()
    expect(await step()).toMatchObject({ kind: 'tool' })
    const bodyParent = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'continuity_validate' }, include: { effectReceipt: true } })
    expect(bodyParent.inputSnapshot).toMatchObject({ input: { work: { version: 18, reassessmentProtocol: 2 } } })
    expect(bodyParent.inputSnapshot).not.toHaveProperty('input.work.terminalCandidate')
    const bodyChildren = await prisma.agentOperation.findMany({ where: { parentOperationId: bodyParent.id }, orderBy: { id: 'asc' } })
    const bodyAttempts = await prisma.agentProviderAttempt.findMany({ where: { operationId: { in: bodyChildren.map(row => row.id) } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })
    await step()
    if (scenario === 'unknown-history') {
      await prisma.agentProviderUsageReceipt.update({ where: { attemptId: bodyAttempts[0].id }, data: { settlementStatus: 'pending' } })
      const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed', failureCode: 'RUNTIME_RECONCILIATION_REQUIRED' } })
      expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
      expect(fetcher).toHaveBeenCalledOnce()
      expect(await prisma.agentProviderUsageReceipt.findUniqueOrThrow({ where: { attemptId: bodyAttempts[0].id } })).toMatchObject({ settlementStatus: 'pending' })
      expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toMatchObject({ committedAt: null })
      return
    }
    for (let index = 3; index < 8; index++) expect(await step()).toMatchObject({ kind: 'tool' })
    const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    expect(await step()).toMatchObject({ kind: 'tool' })
    expect(await step()).toMatchObject({ kind: 'tool', result: { reviewCompleted: true } })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })).toEqual(committed)
    expect(reentered).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: bodyParent.id }, include: { effectReceipt: true } })).toEqual(bodyParent)
    expect(await prisma.agentProviderAttempt.findMany({ where: { operationId: { in: bodyChildren.map(row => row.id) } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })).toEqual(bodyAttempts)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(3)
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toMatchObject({ targetRevision: 4, committedAt: expect.any(Date) })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
  }, undefined, '修改第一章', { freezeWriting: true, continuityEvidenceProtocol: 1, continuityReportProtocol: 5,
    terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
