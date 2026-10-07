import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { env } from '../../api/config/env.js'
import { countActiveRunsByUser,deregisterActiveRun,getActiveRun,registerActiveRun } from '../../api/lib/agent/active-runs.js'
import * as agentDefinitions from '../../api/lib/agent/agents.js'
import * as contextAssembler from '../../api/lib/agent/context.js'
import { executePersistedLoopRun,initializePersistedLoopRun,recoverDurableLoopRuns,stopLoopRun } from '../../api/lib/agent/run-service.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { advanceDurableContext } from '../../api/lib/agent/runtime-checkpoint-step.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import * as runtimeExecutor from '../../api/lib/agent/runtime-executor.js'
import { executeDurableStep,waitForDurableDecision } from '../../api/lib/agent/runtime-executor.js'
import * as runtimeLease from '../../api/lib/agent/runtime-lease.js'
import { releaseRunLease,withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { readObservedBaseline } from '../../api/lib/agent/runtime-observed-baseline.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { resolveDurableQuestion } from '../../api/lib/agent/runtime-question.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { initializeExecutionState,loadExecutionState,saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { entityResolveTool,impactAnalyzeTool,projectSearchTool,structureValidateTool } from '../../api/lib/agent/tools/changeset-tools.js'
import { chapterCreateTool,chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'
import { retrievalTraceReadTool,styleProfileGetTool } from '../../api/lib/agent/tools/craft-library-tools.js'
import { directiveListTool } from '../../api/lib/agent/tools/directive-tools.js'
import { characterVoiceGetTool,experienceAnchorGetTool,qualityReportGetTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import { memoryReviewListTool } from '../../api/lib/agent/tools/memory-tools.js'
import { coverPromptSetTool,novelRenameTool,novelUpdateMetaTool } from '../../api/lib/agent/tools/novel-tools.js'
import { chapterReadTool,novelGetContextTool,planReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { firstThreePrototypeGetTool,researchDossierGetTool } from '../../api/lib/agent/tools/research-dossier-tools.js'
import { storyCharterGetTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { executionContextReadTool } from '../../api/lib/agent/tools/task-context-tools.js'
import * as credits from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('durable domain reads', () => {
  it.each(['research_dossier_get', 'first_three_prototype_get', 'style_profile_get', 'retrieval_trace_read', 'trace-missing', 'memory_review_list', 'character_voice_get', 'experience_anchor_get', 'directive_list', 'project_search', 'search-rollback', 'search-repeat', 'entity_resolve', 'impact_analyze', 'structure_validate', 'story_charter_get', 'quality_report_get'] as const)('%s records an observation or explicit missing-target failure', async scenario => {
    await fixture(async f => {
      const action = scenario === 'search-rollback' || scenario === 'search-repeat' ? 'project_search' : scenario === 'trace-missing' ? 'retrieval_trace_read' : scenario
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '原文。'.repeat(25) } })
      const tools = [researchDossierGetTool, firstThreePrototypeGetTool, styleProfileGetTool, retrievalTraceReadTool, memoryReviewListTool, characterVoiceGetTool, experienceAnchorGetTool, directiveListTool, projectSearchTool, entityResolveTool, impactAnalyzeTool, structureValidateTool, storyCharterGetTool, qualityReportGetTool]
      if (scenario === 'research_dossier_get') await prisma.researchDossier.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
        version: 1, status: 'ready', triggerReason: 'new_book', triggerSignals: [], topic: '题材研究', genre: '历史', targetAudience: '历史读者',
        readerPromise: '人物抉择', abandonmentRisks: ['风险1', '风险2', '风险3', '风险4', '不能遗漏的第五项'], marketPatterns: [], differentiation: [], factCards: [],
        languageRisks: [], recommendations: [], rejectedIdeas: [], queryPlan: [], sources: [], sourceHash: 'a'.repeat(64), cacheKey: randomUUID(), expiresAt: new Date(Date.now() + 86400000) } })
      const tool = tools.find(candidate => candidate.name === action)!
      const traceId = randomUUID()
      if (scenario === 'retrieval_trace_read') await prisma.retrievalTrace.create({ data: { id: traceId, userId: f.userId, novelId: f.novelId,
        runId: f.runId, query: { scene: '本次查询' }, candidateIds: [], selected: [] } })
      const args = action === 'entity_resolve' ? { name: '原文' }
        : action === 'project_search' || action === 'impact_analyze' ? { query: '原文' }
        : action === 'quality_report_get' ? { reportId: randomUUID() } : action === 'experience_anchor_get' ? { characterName: '陈砚' }
        : action === 'retrieval_trace_read' ? { traceId } : {}
      const lease = await claim(f)
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '读取当前作品' }, { role: 'assistant', content: null,
            toolCalls: [{ id: 'domain-read', name: action, arguments: JSON.stringify(args) },
              ...(scenario === 'search-repeat' ? [{ id: 'repeat-read', name: action, arguments: JSON.stringify(args) }] : [])] }], successfulToolSignatures: [] } })
      if (scenario === 'search-rollback') {
        const originalExecute = projectSearchTool.execute
        vi.spyOn(projectSearchTool, 'execute').mockImplementationOnce(async (ctx, input) => {
          await originalExecute(ctx, input)
          throw new Error('fixture failure after artifact creation')
        })
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('fixture failure after artifact creation')
        expect(await prisma.agentArtifact.count({ where: { runId: f.runId } })).toBe(0)
        const pending = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action }, include: { effectReceipt: true } })
        expect(pending.effectReceipt).toBeNull()
      }
      const outcome = await executeDurableToolStep(lease, new AbortController().signal)
      expect(outcome.kind).toBe('tool')
      if (outcome.kind !== 'tool') throw new Error('Expected a completed tool observation')
      const missing = action === 'quality_report_get' || scenario === 'trace-missing'
      expect(outcome.result.outcome).toBe(missing ? 'failed' : undefined)
      if (scenario === 'retrieval_trace_read') expect(outcome.result.output).toContain('本次查询')
      const state = await loadExecutionState(f.userId, f.runId)
      expect(state.frame.state.phase).toBe('idle')
      expect(state.frame.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'domain-read' })
      if (scenario === 'research_dossier_get') {
        expect(state.frame.state.messages.at(-1)?.content).toContain('不能遗漏的第五项')
        expect(state.frame.state.messages.at(-1)?.content).not.toContain('reusedCount')
        expect((await prisma.researchDossier.findFirstOrThrow({ where: { novelId: f.novelId } })).reusedCount).toBe(1)
      }
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action } })).toBe(1)
      if (action === 'project_search') {
        expect(outcome.result.output.match(/\[content@/g)).toHaveLength(25)
        expect(await prisma.agentArtifact.count({ where: { runId: f.runId } })).toBe(1)
      }
      const evidence = await withRunLease(lease, tx => collectDurableToolEvidence(tx, f.rootId, state.frame.revision))
      const substantive = ['research_dossier_get', 'project_search', 'entity_resolve', 'impact_analyze', 'structure_validate'].includes(action)
      expect(evidence.progressSequence === '0').toBe(!substantive)
      if (scenario === 'search-repeat') {
        expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool' })
        const repeatedState = await loadExecutionState(f.userId, f.runId)
        const repeated = await withRunLease(lease, tx => collectDurableToolEvidence(tx, f.rootId, repeatedState.frame.revision))
        expect(repeated.effects).toHaveLength(2)
        expect(repeated.progressSequence).toBe(evidence.progressSequence)
      }
      // Dispatching again after reduction must not repeat the read or create another artifact.
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'idle' })
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action } })).toBe(scenario === 'search-repeat' ? 2 : 1)
      if (action === 'project_search') expect(await prisma.agentArtifact.count({ where: { runId: f.runId } })).toBe(scenario === 'search-repeat' ? 2 : 1)
    })
  })
})

describe.runIf(available)('durable service dispatch', () => {
  it('freezes a fresh global chapter schema at service admission and executes it without rebuilding stored identity', async () => {
    await fixture(async f => {
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1/', apiKey: 'not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(agentDefinitions, 'getToolsForAgent').mockReturnValue([
        { ...chapterCreateTool, execute: (ctx, args) => chapterCreateTool.execute(ctx, chapterCreateTool.parameters.parse(args)) },
      ])
      const prompt = '写下一章', runId = randomUUID()
      const input = { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, mode: 'build' as const, prompt }
      vi.spyOn(contextAssembler, 'assembleContext').mockResolvedValue({ messages: [{ role: 'user', content: prompt }], skillRoute: null })
      await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId,
        status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', startRequest: input } })
      await prisma.agentMessage.create({ data: { runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
      const originalRoot = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
      const first = await initializePersistedLoopRun(f.userId, runId, input)
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: run.taskRootId! } })
      const spec = taskSpecSchema.parse(root.specSnapshot)
      expect(spec.scope.writing?.targets).toEqual([{ orderIndex: 2, chapterId: null }])
      expect(first.configuration.tools.find(tool => tool.function.name === chapterCreateTool.name)).toEqual(toOpenAITools([chapterCreateTool], spec.scope)[0])
      expect(await initializePersistedLoopRun(f.userId, runId, input)).toEqual(first)
      const lease = await claim({ userId: f.userId, runId })
      await prepareStoryCompilation({ userId: f.userId, novelId: f.novelId, runId, targetOrderIndex: 2, mode: 'balanced', intentSummary: prompt, volumeDecision: { kind: 'continue', reason: '当前卷主困局尚未收束，本章继续推进' } })
      await saveExecutionState(lease, { expectedRevision: first.frame.revision, expectedHash: first.frame.snapshotHash,
        snapshot: { ...first.frame.state, messages: [...first.frame.state.messages, { role: 'assistant', content: null, toolCalls: [
          { id: 'server-positioned-create', name: chapterCreateTool.name, arguments: JSON.stringify({ title: '合成下一章' }) },
        ] }] } })
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { display: { kind: 'chapterRef' } } })
      expect(await prisma.chapter.findMany({ where: { novelId: f.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual([
        expect.objectContaining({ id: f.chapterId, orderIndex: 1 }), expect.objectContaining({ title: '合成下一章', orderIndex: 2 }),
      ])
      expect((await loadExecutionState(f.userId, runId)).configuration).toEqual(first.configuration)
      expect(await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: root.id } })).toEqual(root)
      expect(await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: originalRoot.id } })).toEqual(originalRoot)
    })
  })
  it.each(['initialize', 'replay', 'wrong-input', 'read-only', 'saved-input', 'changed-selection'] as const)('%s bootstraps from admitted input without rebuilding an existing frame', async scenario => {
    await fixture(async f => {
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1/', apiKey: 'not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(agentDefinitions, 'getToolsForAgent').mockReturnValue([
        { ...chapterReadTool, execute: (ctx, args) => chapterReadTool.execute(ctx, chapterReadTool.parameters.parse(args)) },
        { ...chapterWriteTool, execute: (ctx, args) => chapterWriteTool.execute(ctx, chapterWriteTool.parameters.parse(args)) },
      ])
      const assemble = vi.spyOn(contextAssembler, 'assembleContext').mockResolvedValue({ messages: [{ role: 'system', content: '保留任务范围' }, { role: 'user', content: '修改本章' }], skillRoute: null })
      if (scenario === 'read-only') await prisma.agentSession.update({ where: { id: f.sessionId }, data: { sandboxMode: 'read_only' } })
      const input = { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, mode: 'build' as const, prompt: scenario === 'wrong-input' ? '改写旧任务' : '修改本章' }
      if (scenario === 'saved-input' || scenario === 'changed-selection') {
        await prisma.agentRun.update({ where: { id: f.runId }, data: { startRequest: input } })
      }
      if (scenario === 'changed-selection') {
        await expect(initializePersistedLoopRun(f.userId, f.runId, { ...input, selection: { text: '不同选区' } })).rejects.toMatchObject({ code: 'RUN_INPUT_MISMATCH' })
        expect(assemble).not.toHaveBeenCalled()
        return
      }
      if (scenario === 'wrong-input') {
        await expect(initializePersistedLoopRun(f.userId, f.runId, input)).rejects.toMatchObject({ code: 'RUN_INPUT_MISMATCH' })
        expect(assemble).not.toHaveBeenCalled()
        expect(await prisma.agentExecutionState.count({ where: { taskRootId: f.rootId } })).toBe(0)
        return
      }
      const first = await initializePersistedLoopRun(f.userId, f.runId, scenario === 'saved-input' ? undefined : input)
      expect(first.configuration.model).toMatchObject({ maxOutputTokens: env.aiTextMaxOutputTokens, contextWindowTokens: env.agentContextWindowTokens })
      expect(first.frame.state.messages.at(-1)).toEqual({ role: 'user', content: input.prompt })
      expect(first.configuration.tools.map(tool => tool.function.name)).toEqual(scenario === 'read-only'
        ? ['chapter_read', 'execution_context_read'] : ['chapter_read', 'chapter_write', 'execution_context_read'])
      expect(JSON.stringify(first.head.configuration)).not.toContain('not-real')
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })).ownerId).toBeNull()
      if (scenario === 'replay') {
        const maxOutputTokens = env.aiTextMaxOutputTokens, contextWindowTokens = env.agentContextWindowTokens
        try {
          env.aiTextMaxOutputTokens += 1024
          env.agentContextWindowTokens += 16000
          assemble.mockResolvedValue({ messages: [{ role: 'user', content: '后来变化的历史，不应采用' }], skillRoute: null })
          const replay = await initializePersistedLoopRun(f.userId, f.runId, input)
          expect(replay.frame.snapshotHash).toBe(first.frame.snapshotHash)
          expect(replay.head.configurationHash).toBe(first.head.configurationHash)
          expect(replay.configuration.model.maxOutputTokens).toBe(first.configuration.model.maxOutputTokens)
          expect(replay.configuration.model.contextWindowTokens).toBe(first.configuration.model.contextWindowTokens)
          expect(assemble).toHaveBeenCalledTimes(1)
        } finally {
          env.aiTextMaxOutputTokens = maxOutputTokens
          env.agentContextWindowTokens = contextWindowTokens
        }
      }
    })
  })
  it('yielding a lease does not stop the task or allow a stale release of its successor', async () => {
    await fixture(async f => {
      const first = await claim(f)
      expect(await releaseRunLease(first)).toBe(true)
      expect(await releaseRunLease(first)).toBe(false)
      await expect(withRunLease(first, async () => {})).rejects.toThrow()
      const second = await claim(f, 'worker-b')
      expect(second.epoch).toBeGreaterThan(first.epoch)
      expect(await releaseRunLease(first)).toBe(false)
      await withRunLease(second, async () => {})
      await pauseDurableTask(f.userId, f.runId)
      expect(await releaseRunLease(second)).toBe(false)
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })).enabled).toBe(false)
    })
  })

  it.each(['waiting', 'error', 'error-release', 'release', 'stop', 'duplicate', 'wrong-input', 'lease-lost', 'recovery', 'expired-recovery', 'capacity'] as const)('%s shares stop and local registration without legacy execution', async scenario => {
    await fixture(async f => {
      const initialLease = await claim(f)
      const initial = await initializeExecutionState(initialLease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: scenario === 'wrong-input' ? '写旧任务第13章' : '修改本章' }], successfulToolSignatures: [] } })
      if (scenario === 'recovery' || scenario === 'expired-recovery') {
        expect(await recoverDurableLoopRuns()).not.toEqual(expect.arrayContaining([expect.objectContaining({ runId: f.runId })]))
      }
      if (scenario === 'expired-recovery') {
        await prisma.agentRunLease.update({ where: { runId: f.runId }, data: { expiresAt: new Date('2000-01-01T00:00:00Z') } })
      } else await releaseRunLease(initialLease)
      if (scenario === 'capacity') {
        const occupied = Array.from({ length: env.agentUserMaxConcurrent }, (_, index) => `${f.runId}-occupied-${index}`)
        const before = await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })
        try {
          for (const id of occupied) registerActiveRun(id, { controller: new AbortController(), userId: f.userId, sessionId: id })
          const execute = vi.spyOn(runtimeExecutor, 'runReviewedDurableExecution')
          await expect(executePersistedLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUN_LIMIT' })
          expect(await recoverDurableLoopRuns()).toContainEqual({ runId: f.runId, status: 'not_dispatched', code: 'RUN_LIMIT' })
          expect(execute).not.toHaveBeenCalled()
          expect(getActiveRun(f.runId)).toBeUndefined()
          expect(await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })).toEqual(before)
          expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(initial.frame.snapshotHash)
        } finally { for (const id of occupied) deregisterActiveRun(id) }
        return
      }
      vi.spyOn(runtimeExecutor, 'runReviewedDurableExecution').mockImplementationOnce(async (lease, signal) => {
        expect(lease.taskRootId).toBe(f.rootId)
        expect(getActiveRun(f.runId)?.controller.signal).toBe(signal)
        expect(countActiveRunsByUser(f.userId)).toBe(1)
        expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(initial.frame.snapshotHash)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('running')
        if (scenario === 'duplicate') await expect(executePersistedLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
        if (scenario === 'error') throw new Error('fixture dispatch failure')
        if (scenario === 'release') vi.spyOn(runtimeLease, 'releaseRunLease').mockRejectedValueOnce(new Error('fixture cleanup failure'))
        if (scenario === 'error-release') {
          vi.spyOn(runtimeLease, 'releaseRunLease').mockRejectedValueOnce(new Error('fixture cleanup failure'))
          throw new Error('fixture original execution failure')
        }
        if (scenario === 'lease-lost') {
          await releaseRunLease(lease)
          await claim(f, 'replacement-worker')
          throw new Error('fixture old owner failure')
        }
        if (scenario === 'stop') { await stopLoopRun(f.userId, f.runId); signal.throwIfAborted() }
        return { kind: 'needs_attention', reason: 'fixture handoff', frame: initial.frame }
      })
      if (scenario === 'error-release') await expect(executePersistedLoopRun(f.userId, f.runId)).rejects.toThrow('fixture original execution failure')
      else if (scenario === 'release') await expect(executePersistedLoopRun(f.userId, f.runId)).rejects.toThrow('fixture cleanup failure')
      else if (scenario === 'error' || scenario === 'stop' || scenario === 'wrong-input' || scenario === 'lease-lost') await expect(executePersistedLoopRun(f.userId, f.runId)).rejects.toThrow()
      else if (scenario === 'recovery' || scenario === 'expired-recovery') {
        expect(await recoverDurableLoopRuns()).toContainEqual({ runId: f.runId, status: 'dispatched' })
        expect(runtimeExecutor.runReviewedDurableExecution).toHaveBeenCalledTimes(1)
      } else expect(await executePersistedLoopRun(f.userId, f.runId)).toMatchObject({ kind: 'needs_attention' })
      if (scenario === 'wrong-input') expect(runtimeExecutor.runReviewedDurableExecution).not.toHaveBeenCalled()
      expect(getActiveRun(f.runId)).toBeUndefined()
      expect(countActiveRunsByUser(f.userId)).toBe(0)
      const lease = await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })
      if (scenario === 'release') expect(lease.ownerId).not.toBeNull()
      else expect(lease.ownerId).toBe(scenario === 'lease-lost' ? 'replacement-worker' : null)
      expect(lease.enabled).toBe(!['stop', 'error', 'error-release', 'wrong-input'].includes(scenario))
      if (scenario === 'error' || scenario === 'error-release' || scenario === 'wrong-input') {
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
        const event = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        expect(event.payload).toMatchObject({ reason: 'needs_input', sourceRevision: initial.frame.revision, sourceHash: initial.frame.snapshotHash })
      }
      if (scenario === 'lease-lost') {
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'run.paused' } })).toBe(0)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('running')
      }
      expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(initial.frame.snapshotHash)
    })
  })
})

describe.runIf(available)('durable context archive', () => {
  it('rejects an oversized original request before creating a paid attempt and preserves its text', async () => {
    await fixture(async f => {
      const lease = await claim(f)
      const content = '不可丢弃的作者要求。'.repeat(2000)
      const state = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content }], successfulToolSignatures: [] } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 16000 })
      const fetchMock = vi.fn(() => { throw new Error('must not dispatch') })
      vi.stubGlobal('fetch', fetchMock)
      await expect(executeDurableStep(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_CONTEXT_LIMIT' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(0)
      expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(state.frame.snapshotHash)
    })
  })

  it.each(['complete', 'hole', 'duplicate'] as const)('%s pages cannot manufacture a full read baseline', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const plan = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '长计划',
        content: '必须完整读取的计划正文。'.repeat(2300), metadata: { savedAsPlan: true } } })
      const tools = [planReadTool, executionContextReadTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '核对完整计划' }, { role: 'assistant', content: null,
            toolCalls: [{ id: 'large-plan', name: 'plan_read', arguments: JSON.stringify({ planId: plan.id }) }] }], successfulToolSignatures: [] } })
      await executeDurableToolStep(lease, new AbortController().signal)
      const source = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'plan_read' }, include: { effectReceipt: true } })
      const raw = z.object({ toolResult: z.object({ output: z.string() }) }).parse(source.effectReceipt!.result).toolResult.output
      const baseline = async () => {
        const { frame } = await loadExecutionState(f.userId, f.runId)
        return withRunLease(lease, tx => readObservedBaseline(tx, f.rootId, frame.revision, { kind: 'plan', id: plan.id }))
      }
      expect((await loadExecutionState(f.userId, f.runId)).frame.state.messages.at(-1)?.content).toContain('archivedToolOutput')
      expect(raw).toContain(plan.content)
      expect(await baseline()).toBeNull()
      const offsets = scenario === 'duplicate' ? [0, 0] : Array.from({ length: Math.ceil(raw.length / 16000) }, (_, index) => index * 16000 + (scenario === 'hole' ? 1 : 0))
      for (const [index, offset] of offsets.entries()) {
        const { frame } = await loadExecutionState(f.userId, f.runId)
        await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...frame.state,
          messages: [...frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: `page-${index}`, name: 'execution_context_read',
            arguments: JSON.stringify({ operationId: source.id, resultHash: source.effectReceipt!.resultHash, offset, limit: 16000 }) }] }] } })
        const result = await executeDurableToolStep(lease, new AbortController().signal)
        expect(result.kind).toBe('tool')
        if (scenario === 'complete' && index < offsets.length - 1) expect(await baseline()).toBeNull()
      }
      if (scenario === 'complete') expect(await baseline()).toMatchObject({ kind: 'plan', id: plan.id })
      else expect(await baseline()).toBeNull()
    })
  })
  it.each(['read', 'wrong-hash', 'future', 'no-reader', 'stopped', 'model-window'] as const)('%s preserves source frames and task budget', async scenario => {
    await fixture(async f => {
      const lease = await claim(f), tool = executionContextReadTool
      const messages = [{ role: 'user', content: '只写第19章，不能继续旧任务。' }, ...Array.from({ length: 12 }, (_, index) => [
        { role: 'assistant', content: `第${index}次说明必须保留`, toolCalls: [{ id: `archive-${index}`, name: 'chapter_read', arguments: '{}' }] },
        { role: 'tool', toolCallId: `archive-${index}`, content: '历史原文，必须可以完整回读。'.repeat(scenario === 'model-window' ? 100 : 1600) },
      ]).flat()]
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: scenario === 'no-reader' ? [] : [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: scenario === 'no-reader' ? [] : [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages, successfulToolSignatures: [] } })
      const budget = await readTaskBudget(lease)
      if (scenario === 'stopped') await pauseDurableTask(f.userId, f.runId)
      if (scenario === 'stopped' || scenario === 'no-reader') {
        await expect(advanceDurableContext(lease)).rejects.toThrow()
        expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(initial.frame.snapshotHash)
        return
      }
      if (scenario === 'model-window') expect(await advanceDurableContext(lease)).toBeNull()
      const archived = await advanceDurableContext(lease, scenario === 'model-window' ? 8000 : undefined)
      expect(archived?.state.messages[0]).toEqual(messages[0])
      expect(archived?.state.messages.length).toBeLessThan(messages.length)
      expect(await readTaskBudget(lease)).toEqual(budget)
      expect(await advanceDurableContext(lease)).toBeNull()
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.context.archived' } })).toBe(1)
      const source = await prisma.agentExecutionFrame.findUniqueOrThrow({ where: { taskRootId_revision: { taskRootId: f.rootId, revision: 0 } } })
      expect(source.snapshot).toEqual(initial.frame.snapshot)
      if (scenario === 'model-window') {
        expect(archived?.state.messages.at(-1)).toEqual(messages.at(-1))
        expect(archived?.state.messages.filter(message => message.role === 'tool')).toHaveLength(1)
        return
      }
      if (!archived) throw new Error('Expected archived frame')
      const args = { revision: scenario === 'future' ? 999999 : 0, hash: scenario === 'wrong-hash' ? 'b'.repeat(64) : initial.frame.snapshotHash,
        messageIndex: 2, offset: 7, limit: 3000 }
      await saveExecutionState(lease, { expectedRevision: archived.revision, expectedHash: archived.snapshotHash,
        snapshot: { ...archived.state, messages: [...archived.state.messages, { role: 'assistant', content: null,
          toolCalls: [{ id: 'read-archive', name: tool.name, arguments: JSON.stringify(args) }] }] } })
      {
        const result = await executeDurableToolStep(lease, new AbortController().signal)
        if (result.kind !== 'tool') throw new Error('Expected archive read observation')
        if (scenario === 'future' || scenario === 'wrong-hash') expect(result.result.outcome).toBe('failed')
        else expect(JSON.parse(result.result.output)).toMatchObject({ offset: 7, nextOffset: 3007,
          content: JSON.stringify(messages[2]).slice(7, 3007), totalChars: JSON.stringify(messages[2]).length })
      }
    })
  }, 15_000)
})

describe.runIf(available)('durable question lifecycle', () => {
  it.each(['answer', 'replay', 'different-answer', 'wrong-request', 'stopped', 'resume', 'changed-question', 'changed-answer-type', 'expired', 'receipt-rollback'] as const)('%s binds answers to the displayed request', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const tool = askUserTool
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '讨论剧情方向' }, { role: 'assistant', content: null, toolCalls: [{ id: 'question-call', name: 'ask_user',
            arguments: JSON.stringify({ question: '选择哪个方向？', options: [{ label: '方向一' }, { label: '方向二' }] }) }] }], successfulToolSignatures: [] } })
      const waiting = await executeDurableToolStep(lease, new AbortController().signal)
      if (waiting.kind !== 'waiting_question' || !waiting.requestId) throw new Error('Expected durable question')
      const decisionWait = { kind: 'waiting_question' as const, requestId: waiting.requestId }
      if (scenario === 'answer') {
        const controller = new AbortController()
        const pending = waitForDurableDecision(lease, controller.signal, decisionWait)
        const assertion = expect(pending).rejects.toThrow()
        controller.abort(new Error('fixture wait cancelled'))
        await assertion
        expect(await prisma.agentExecutionOutbox.count({ where: { eventKey: `question-answer:${waiting.requestId}` } })).toBe(0)
      }
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'waiting_question', requestId: waiting.requestId })
      const events = await publishDurableEvents(f.userId, lease.runId)
      expect(events.filter(item => item.type === 'tool.call')).toHaveLength(1)
      expect(events.find(item => item.type === 'tool.call')).toMatchObject({ args: { requestId: waiting.requestId } })
      if (scenario === 'stopped' || scenario === 'resume') await pauseDurableTask(f.userId, lease.runId)
      if (scenario === 'resume') {
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id })
        expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ requestId: waiting.requestId })
      }
      const answer = { userId: f.userId, runId: lease.runId, callId: 'question-call', requestId: scenario === 'wrong-request' ? randomUUID() : waiting.requestId, answer: '方向一' }
      if (scenario === 'changed-question' || scenario === 'expired') {
        const request = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: waiting.requestId } })
        await prisma.agentExecutionOutbox.update({ where: { id: request.id }, data: { payload: {
          ...(request.payload as Record<string, Prisma.InputJsonValue>),
          ...(scenario === 'changed-question' ? { question: '已被替换的问题' } : { expiresAt: '2000-01-01T00:00:00.000Z' }),
        } } })
      }
      if (scenario === 'stopped' || scenario === 'wrong-request' || scenario === 'changed-question' || scenario === 'expired') {
        await expect(resolveDurableQuestion(answer)).rejects.toThrow()
        expect(await prisma.agentExecutionOutbox.count({ where: { eventKey: `question-answer:${waiting.requestId}` } })).toBe(0)
        if (scenario === 'expired') {
          await waitForDurableDecision(lease, new AbortController().signal, decisionWait)
          expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({
          kind: 'tool', result: { summary: '提问未获回答', display: { unanswered: true } },
          })
        }
      }
      else {
        const pendingDecision = scenario === 'replay' ? waitForDurableDecision(lease, new AbortController().signal, decisionWait) : undefined
        expect(await resolveDurableQuestion(answer)).toEqual({ resolved: true })
        await pendingDecision
        await waitForDurableDecision(lease, new AbortController().signal, decisionWait)
        if (scenario === 'receipt-rollback') {
          vi.spyOn(runtimeOperations, 'commitOperationEffectInTransaction').mockImplementationOnce(async (tx, token, operationId, hash, work) => {
            await runtimeOperations.commitOperationEffectInTransaction(tx, token, operationId, hash, work)
            throw new Error('fixture question receipt rollback')
          })
          await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('fixture question receipt rollback')
          const request = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: waiting.requestId } })
          expect(await prisma.agentEffectReceipt.count({ where: { operationId: request.operationId! } })).toBe(0)
          expect(await prisma.agentExecutionOutbox.count({ where: { eventKey: `question-answer:${waiting.requestId}` } })).toBe(1)
        }
        if (scenario === 'changed-answer-type') {
          await prisma.agentExecutionOutbox.update({ where: { eventKey: `question-answer:${waiting.requestId}` }, data: { type: 'unrelated.event' } })
          await expect(resolveDurableQuestion(answer)).rejects.toThrow()
          await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow()
          return
        }
        if (scenario === 'replay') expect(await resolveDurableQuestion(answer)).toEqual({ resolved: true })
        if (scenario === 'different-answer') await expect(resolveDurableQuestion({ ...answer, answer: '方向二' })).rejects.toThrow()
        expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { output: '作者的回答：方向一' } })
        expect((await loadExecutionState(f.userId, lease.runId)).frame.state.messages.at(-1)).toMatchObject({ role: 'tool' })
      }
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'question.requested' } })).toBe(1)
    })
  })
})

describe.runIf(available)('durable novel metadata', () => {
  it.each(['rename', 'summary', 'cover', 'unread', 'stale', 'denied', 'invalid-tags'] as const)('%s requires the original metadata observation', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tool = scenario === 'summary' || scenario === 'invalid-tags' ? novelUpdateMetaTool : scenario === 'cover' ? coverPromptSetTool : novelRenameTool
      const args = scenario === 'summary' ? { summary: '已经确认的新简介' } : scenario === 'invalid-tags' ? { tags: ['not-a-real-tag'] } : scenario === 'cover' ? { prompt: '古代城墙，书名清晰的竖版封面' } : { title: '更新后的作品名' }
      const tools = [novelGetContextTool, tool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: z.toJSONSchema(item.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(item => ({ name: item.name, permission: scenario === 'denied' && item.name === tool.name ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '更新作品设置' }, { role: 'assistant', content: null, toolCalls: [
            ...(scenario === 'unread' ? [] : [{ id: 'context', name: 'novel_get_context', arguments: '{}' }]),
            { id: 'metadata', name: tool.name, arguments: JSON.stringify(args) },
          ] }], successfulToolSignatures: [] } })
      if (scenario !== 'unread') await executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'stale') await prisma.novel.update({ where: { id: f.novelId }, data: { summary: '作者刚修改简介' } })
      const before = await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })
      const result = await executeDurableToolStep(lease, new AbortController().signal)
      const after = await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })
      if (['unread', 'stale', 'denied', 'invalid-tags'].includes(scenario)) {
        expect(result).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect({ title: after.title, summary: after.summary, tags: after.tagNames, cover: after.coverPrompt }).toEqual({ title: before.title, summary: before.summary, tags: before.tagNames, cover: before.coverPrompt })
      } else {
        expect(result).toMatchObject({ kind: 'tool', result: { observedState: { kind: 'novel', id: f.novelId } } })
        if (scenario === 'rename') expect(after.title).toBe('更新后的作品名')
        if (scenario === 'summary') expect(after.summary).toBe('已经确认的新简介')
        if (scenario === 'cover') expect(after.coverPrompt).toContain('古代城墙')
      }
    })
  })
})
