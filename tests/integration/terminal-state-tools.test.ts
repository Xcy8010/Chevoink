import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { inspectTerminalReview, terminalReviewFailure, terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterBridgeCommitTool, chapterBridgeGetTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('frozen candidate judgments and current reports through the durable provider and commit adapters', () => {
  it.each(['supported', 'missing-verdict-reassessment', 'attributed', 'changed-candidate', 'nested-supported', 'nested-changed'] as const)('%s preserves frozen candidate history and uses the current report request boundary', async scenario => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const lease = await claim(f)
    const content = scenario === 'attributed' ? '“林舟右掌骨裂。”敌人散布着这条未经证实的传言。' : '医师确认林舟右掌骨裂，尚未愈合。'
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 4 } })
    const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '修订本章' })
    const compilationId = prepared.compilation.id
    const candidate = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌骨裂'] } })
    const unknown = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '确认伤情', entryState: unknown, goal: '验伤', obstacle: '痛楚', choice: '求医', cost: '时间', turn: '确认伤情', exitState: unknown,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await persistHumanityQualityReport({ ...f, compilationId, chapterId: f.chapterId, chapterRevision: 4, mode: 'balanced', criticComplete: true,
      criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const tools = [chapterBridgeGetTool, continuityValidateTool, chapterBridgeCommitTool]
    const changed = terminalCandidateSchema.parse({ exitState: { body: ['林舟双掌骨裂'] } })
    const historicalRaw = JSON.stringify({ findings: [], terminalVerdicts: [{ path: 'exitState.body.0',
      verdict: scenario === 'attributed' ? 'attributed' : 'supported', segmentIds: ['c0'] }] })
    const historicalReview = inspectTerminalReview(candidate, content, historicalRaw, true)!
    expect(historicalReview.supported).toBe(scenario !== 'attributed')
    if (scenario === 'attributed') expect(terminalReviewFailure({ terminalCandidate: candidate }, content)).toMatchObject({ outcome: 'failed', failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' })
    if (scenario === 'missing-verdict-reassessment') expect(inspectTerminalReview(candidate, content, '{"findings":[]}', true)).toBeNull()
    const historical = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Frozen candidate judgment',
      content: historicalRaw, metadata: runtimeJson({ version: 1, candidate, rawResponse: historicalRaw, verdicts: historicalReview.verdicts }).value } })
    const retired = scenario === 'attributed' || scenario === 'changed-candidate' || scenario === 'nested-changed'

    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
        messages: [{ role: 'user', content: '修订本章' }, { role: 'assistant', content: null, toolCalls: [
          { id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) },
          { id: 'check', name: 'continuity_validate', arguments: JSON.stringify({ compilationId }) },
          { id: 'commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId, ...(scenario === 'changed-candidate' ? changed : scenario === 'nested-changed' ? { terminalState: changed } : scenario === 'attributed' ? { terminalState: candidate } : {}) }) },
          ...(retired ? [{ id: 'current-commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId }) }] : []),
        ] }] } })
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
      baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
      reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null })
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
      rateCardId: 'terminal-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
    let calls = 0
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      calls++
      const request = JSON.parse(String(init.body))
      expect(request.messages[1].content).toContain(content)
      expect(request.messages[1].content).not.toContain('待提交终态候选')
      const response = scenario === 'missing-verdict-reassessment' && calls === 1 ? '{"findings":' : '{"findings":[]}'
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: response }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const step = () => executeDurableToolStep(lease, new AbortController().signal)
    await step()
    const check = await step()
    expect(check).toMatchObject({ kind: 'tool' })
    expect(check).toMatchObject({ result: { reviewCompleted: true } })
    expect(await step()).toMatchObject({ kind: 'tool', result: retired ? { outcome: 'failed', failureCode: 'TOOL_CONTRACT_RETIRED' } : { summary: '章节已提交' } })
    expect(calls).toBe(scenario === 'missing-verdict-reassessment' ? 2 : 1)
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { bridge: true, sceneTasks: true } })
    expect(saved.validation).toMatchObject({ continuityReport: { chapterId: f.chapterId, revision: 4, complete: true, findings: [] } })
    expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
    if (retired) {
      expect(saved.bridge?.committedAt).toBeNull()
      expect(saved.bridge?.bodyState).toEqual([])
      expect(saved.sceneTasks[0].status).not.toBe('completed')
      expect(await prisma.projectMemoryEntry.count({ where: { sourceChapterId: f.chapterId } })).toBe(0)
      expect(await step()).toMatchObject({ kind: 'tool', result: { summary: '章节已提交' } })
    }
    const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { bridge: true } })
    expect(committed).toMatchObject({ status: 'completed', bridge: { committedAt: expect.any(Date), bodyState: [] } })
    expect(committed.preparedContext).not.toHaveProperty('terminalReviewProof')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 4, content })
    expect(fetchMock).toHaveBeenCalledTimes(scenario === 'missing-verdict-reassessment' ? 2 : 1)
    expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
  }, undefined, '修改本章', { freezeWriting: true }))
})
