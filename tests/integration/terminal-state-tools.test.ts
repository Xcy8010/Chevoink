import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterBridgeCommitTool, chapterBridgeGetTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('terminal facts through the durable provider and commit adapters', () => {
  it.each(['supported', 'missing-verdict-reassessment', 'attributed', 'changed-candidate', 'nested-supported', 'nested-changed'] as const)('%s uses the frozen candidate and existing request boundary', async scenario => fixture(async f => {
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
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
        messages: [{ role: 'user', content: '修订本章' }, { role: 'assistant', content: null, toolCalls: [
          { id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) },
          { id: 'check', name: 'continuity_validate', arguments: JSON.stringify({ compilationId, terminalState: candidate }) },
          { id: 'commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId, ...(scenario === 'changed-candidate' ? changed : scenario === 'nested-changed' ? { terminalState: changed } : scenario === 'nested-supported' ? { terminalState: candidate } : {}) }) },
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
      expect(request.messages[1].content).toContain('待提交终态候选')
      const response = { findings: [], ...(scenario === 'missing-verdict-reassessment' && calls === 1 ? {} : {
        terminalVerdicts: [{ path: 'exitState.body.0', verdict: scenario === 'attributed' ? 'attributed' : 'supported', segmentIds: ['c0'] }],
      }), ...(calls === 2 ? { decisions: [] } : {}) }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(response) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const step = () => executeDurableToolStep(lease, new AbortController().signal)
    await step()
    const check = await step()
    expect(check).toMatchObject({ kind: 'tool' })
    const denied = scenario === 'attributed' || scenario === 'changed-candidate' || scenario === 'nested-changed'
    expect(await step()).toMatchObject({ kind: 'tool', result: denied ? { outcome: 'failed', failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' } : { summary: '提交章节桥与当前故事终态' } })
    expect(calls).toBe(scenario === 'missing-verdict-reassessment' ? 2 : 1)
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId }, include: { bridge: true, sceneTasks: true } })
    expect(saved.validation).toMatchObject({ terminalCandidate: candidate, coverage: { terminalHash: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    if (denied) {
      expect(saved.bridge?.committedAt).toBeNull()
      expect(saved.bridge?.bodyState).toEqual([])
      expect(saved.sceneTasks[0].status).not.toBe('completed')
      expect(await prisma.projectMemoryEntry.count({ where: { sourceChapterId: f.chapterId } })).toBe(0)
    } else expect(saved).toMatchObject({ status: 'completed', bridge: { bodyState: candidate.exitState.body }, preparedContext: { terminalReviewProof: { version: 2 } } })
  }, undefined, '修改本章', { freezeWriting: true }))
})
