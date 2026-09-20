import { collectDurableCompletionEvidence } from '../../api/lib/agent/runtime-completion-evidence.js'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DataAccessError, prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { initializeDurableTask, attachRunToDurableTask, assertLegacyRuntimeCompatible, startLegacyRuntimeRun } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease, renewRunLease, revokeRunLease, releaseRunLease, withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { prepareOperation, commitOperationEffect, prepareProviderAttempt, markProviderDispatched, recordProviderResult, recordProviderUsage, type ProviderUsageObservation } from '../../api/lib/agent/runtime-operations.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { setAdminUsersSuspended } from '../../api/lib/admin-credit-model.js'
import { preparePricedProviderOperation, settleProviderOperation, type DurableTokenPrice } from '../../api/lib/agent/runtime-settlement.js'
import { chatWithTools } from '../../api/lib/ai-service.js'
import { readTaskBudget, taskTurnLimit } from '../../api/lib/agent/runtime-budget.js'
import { env } from '../../api/config/env.js'
import { commitRuntimeCheckpoint } from '../../api/lib/agent/runtime-checkpoint.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readObservedBaseline } from '../../api/lib/agent/runtime-observed-baseline.js'
import { chapterWriteTool, chapterAppendTool, chapterEditRangeTool, chapterCreateTool, chapterRenameTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { planSaveTool, planRenameTool, planDeleteTool, memorySaveTool } from '../../api/lib/agent/tools/write-tools.js'
import { chapterReadTool, planReadTool, novelGetContextTool, chapterListSummariesTool, memorySearchTool } from '../../api/lib/agent/tools/read-tools.js'
import { planTargetHash } from '../../api/lib/agent/tools/durable-plan.js'
import type { AgentTool, ToolContext } from '../../api/lib/agent/tools/types.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { fenceLocallyStoppedLegacyRun, pauseDurableTask, pauseLegacyOrphanRun, recoverLegacyOrphanRun, finalizeDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { stopLoopRun, streamLoopRun, executePersistedLoopRun, initializePersistedLoopRun, recoverDurableLoopRuns, continueLoopRun, deleteAgentSessionData } from '../../api/lib/agent/run-service.js'
import * as contextAssembler from '../../api/lib/agent/context.js'
import * as agentDefinitions from '../../api/lib/agent/agents.js'
import { getActiveRun, countActiveRunsByUser, registerActiveRun, deregisterActiveRun } from '../../api/lib/agent/active-runs.js'
import * as runtimeExecutor from '../../api/lib/agent/runtime-executor.js'
import * as runtimeLease from '../../api/lib/agent/runtime-lease.js'
import { publishDurableEvents, loadDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { rejectToolCursorCall, prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { requestToolApproval, resolveDurableApproval, pollToolApproval } from '../../api/lib/agent/runtime-approval.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { resolveDurableTokenPrice } from '../../api/lib/billing/resolve-token-price.js'
import { createRateCard, transitionRateCard } from '../../api/lib/billing/rate-cards.js'
import { runDurableExecution, runReviewedDurableExecution, waitForDurableDecision, executeDurableStep } from '../../api/lib/agent/runtime-executor.js'
import { advanceDurableCheckpoint, advanceDurableContext } from '../../api/lib/agent/runtime-checkpoint-step.js'
import * as credits from '../../api/lib/credits.js'
import * as tokenPrices from '../../api/lib/billing/resolve-token-price.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { volumeCreateTool, volumeListTool, structureOutlineTool, volumeUpdateTool, volumeMoveTool, volumeDeleteTool, chapterMoveTool, chapterMoveToVolumeTool, chapterSplitTool, chapterMergeTool } from '../../api/lib/agent/tools/structure-tools.js'
import { getStructureReportObservation } from '../../api/lib/data-access.js'
import { taskContextListTool, taskContextReadTool, executionContextReadTool } from '../../api/lib/agent/tools/task-context-tools.js'
import { sessionHistorySearchTool, sessionMessageReadTool } from '../../api/lib/agent/tools/session-history-tools.js'
import { executeDurableRead } from '../../api/lib/agent/tools/durable-read.js'
import { todoWriteTool, withTodoIds } from '../../api/lib/agent/tools/todo-tools.js'
import { executeDurableTodo } from '../../api/lib/agent/tools/durable-todo.js'
import { prepareStoryCompilation, saveSceneTasks, recordStoryCompilerWrite, validateStoryContinuity, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { storyCompilerPrepareTool, sceneTaskBuildTool, chapterBridgeGetTool, continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import * as aiService from '../../api/lib/ai-service.js'
import { executeDurableCompiler } from '../../api/lib/agent/tools/durable-compiler.js'
import { applyContinuityPatches } from '../../api/lib/agent/tools/durable-continuity.js'
import { persistHumanityQualityReport, applyQualityRepair, getQualityReport, buildHumanityQualityContext } from '../../api/lib/agent/humanity-quality.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import * as writingExperiments from '../../api/lib/agent/writing-experiments.js'
import { evaluateTaskPostconditions } from '../../api/lib/agent/runtime-postconditions.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { collectDurableDeliverables } from '../../api/lib/agent/runtime-deliverables.js'
import { advanceDurableMemory } from '../../api/lib/agent/runtime-memory.js'
import { advanceDurableCompletionObligations } from '../../api/lib/agent/runtime-continuation.js'
import { novelRenameTool, novelUpdateMetaTool, coverPromptSetTool } from '../../api/lib/agent/tools/novel-tools.js'
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import { resolveDurableQuestion } from '../../api/lib/agent/runtime-question.js'
import { projectSearchTool, entityResolveTool, impactAnalyzeTool, structureValidateTool } from '../../api/lib/agent/tools/changeset-tools.js'
import { storyCharterGetTool, storyCharterSaveTool, readerPromiseSaveTool, readerPromiseUpdateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { upsertStoryCharter, saveReaderPromise, updateReaderPromise } from '../../api/lib/agent/story-compiler.js'
import { qualityReportGetTool, characterVoiceGetTool, experienceAnchorGetTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { memoryReviewListTool, memoryEventSaveTool, memoryRelationSaveTool } from '../../api/lib/agent/tools/memory-tools.js'
import { listActiveDirectives, captureUserDirectives } from '../../api/lib/agent/context-engine.js'
import { directiveListTool, directiveSaveTool, directiveSupersedeTool } from '../../api/lib/agent/tools/directive-tools.js'
import { styleProfileGetTool, retrievalTraceReadTool } from '../../api/lib/agent/tools/craft-library-tools.js'
import { researchDossierGetTool, firstThreePrototypeGetTool } from '../../api/lib/agent/tools/research-dossier-tools.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function fixture(work: (f: {
  userId: string; novelId: string; sessionId: string; chapterId: string; runId: string; sourceMessageId: string;
  spec: ReturnType<typeof buildTaskSpec>; rootId: string;
}) => Promise<void>, tokenBudget?: number, prompt = '修改本章') {
  const user = await prisma.user.create({ data: { nickname: 'durable-runtime-fixture', passwordHash: 'test-only-unusable' } })
  const userId = user.id
  try {
    const novel = await prisma.novel.create({ data: { authorId: userId, title: '持久执行测试', slug: randomUUID(), summary: '' } })
    // Most protocol cases deliberately admit all tools; policy narrowing has
    // separate cases below and must not rely on an implicit default approval.
    const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '测试',
      toolPolicy: { network: 'allow', contentWrite: 'allow', bulkWrite: 'allow', publish: 'allow', destructive: 'allow' } } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: userId, novelId: novel.id, volumeId: volume.id, title: '原章', content: '原文', orderIndex: 1, orderInVolume: 1, wordCount: 2 } })
    const runId = randomUUID(), sourceMessageId = randomUUID()
    const spec = buildTaskSpec({ runId, novelId: novel.id, chapterId: chapter.id, prompt })
    await prisma.agentRun.create({ data: {
      id: runId, userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, status: 'queued',
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)),
    } })
    await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    const root = await initializeDurableTask({ userId, runId, sourceMessageId, tokenBudget })
    await work({ userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, runId, sourceMessageId, spec, rootId: root.id })
  } finally {
    // Exact fixture ownership only. New roots cascade after their original runs are removed.
    await prisma.creditRateCardEvent.deleteMany({ where: { card: { createdBy: userId } } })
    await prisma.creditRateCard.deleteMany({ where: { createdBy: userId } })
    await prisma.agentArtifact.deleteMany({ where: { run: { userId } } })
    await prisma.projectMemoryEntry.deleteMany({ where: { novel: { authorId: userId } } })
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.chapter.deleteMany({ where: { authorId: userId } })
    await prisma.novel.deleteMany({ where: { authorId: userId } })
    await prisma.user.delete({ where: { id: userId } })
  }
}

const claim = (f: { userId: string; runId: string }, ownerId = 'worker-a') => acquireRunLease({ ...f, ownerId, claimId: randomUUID() })
const reported: ProviderUsageObservation = { source: 'reported', promptTokens: 10, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 10 }

describe.runIf(available)('administrator credit suspension fences durable runs', () => {
  it('pauses a non-local execution and revokes its previously acquired lease', async () => {
    await fixture(async f => {
      const lease = await claim(f)
      expect(getActiveRun(f.runId)).toBeUndefined()
      expect(await setAdminUsersSuspended([f.userId], true)).toMatchObject({ users: 1, paused: true, stoppedRuns: 1 })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('paused')
      const effect = vi.fn(async () => 'must not execute')
      await expect(withRunLease(lease, effect)).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      expect(effect).not.toHaveBeenCalled()
      await setAdminUsersSuspended([f.userId], false)
      // Restoring account access is not permission to restart a stopped task.
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
    })
  })
})

describe.runIf(available)('durable chapter rename', () => {
  it.each(['deny', 'read-only', 'ask', 'replay'] as const)('rechecks current session permission before a new effect: %s', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tool = chapterRenameTool
      const args = { chapterId: f.chapterId, title: '新标题' }
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: '', parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改标题' }, { role: 'assistant', content: null, toolCalls: [{ id: 'rename', name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const { operation } = await prepareToolCursorOperation(lease, { expectedRevision: 0, expectedHash: initial.frame.snapshotHash }, {
        key: 'exec:0', action: tool.name, callId: 'rename', targetId: f.chapterId,
        operationInput: { callId: 'rename', args }, effectiveArgs: args, normalize: parsed => tool.parameters.parse(parsed),
      })
      const work = vi.fn(async (tx: Parameters<Parameters<typeof commitOperationEffect>[3]>[0]) => {
        await tx.chapter.update({ where: { id: f.chapterId }, data: { title: args.title } })
        return { title: args.title }
      })
      if (scenario === 'replay') await commitOperationEffect(lease, operation.id, operation.inputHash, work)
      await prisma.agentSession.update({ where: { id: f.sessionId }, data: scenario === 'read-only'
        ? { sandboxMode: 'read_only' } : { toolPolicy: { contentWrite: scenario === 'ask' ? 'ask' : 'deny' } } })
      if (scenario === 'replay') {
        await expect(commitOperationEffect(lease, operation.id, operation.inputHash, work)).resolves.toMatchObject({ operationId: operation.id })
        expect(work).toHaveBeenCalledOnce()
      } else {
        await expect(commitOperationEffect(lease, operation.id, operation.inputHash, work)).rejects.toMatchObject({ code: scenario === 'ask' ? 'RUNTIME_APPROVAL_REQUIRED' : 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(work).not.toHaveBeenCalled()
        expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(0)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).title).toBe('原章')
      }
    })
  })
  it.each(['rename', 'unread', 'stale', 'protected'] as const)('%s preserves the chapter body', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tools = [chapterReadTool, chapterRenameTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改章节标题' }, { role: 'assistant', content: null, toolCalls: [
            ...(scenario === 'unread' ? [] : [{ id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) }]),
            { id: 'rename', name: 'chapter_rename', arguments: JSON.stringify({ chapterId: f.chapterId, title: '新的章节标题' }) },
          ] }], successfulToolSignatures: [] } })
      if (scenario !== 'unread') await executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, title: '作者已改标题' } })
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      if (scenario === 'protected') await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow()
      else {
        const result = await executeDurableToolStep(lease, new AbortController().signal)
        expect(result).toMatchObject({ kind: 'tool', result: scenario === 'rename' ? { observedState: { kind: 'chapter', revision: before.revision + 1 } } : { outcome: 'failed' } })
      }
      const after = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(after.content).toBe(before.content)
      expect(after.title).toBe(scenario === 'rename' ? '新的章节标题' : before.title)
      expect(await prisma.memoryExtractionJob.count({ where: { novelId: f.novelId } })).toBe(0)
    })
  })
})

describe.runIf(available)('task-scoped author directives', () => {
  it('does not promote a temporary instruction into a permanent novel constraint', async () => {
    await fixture(async f => {
      const prompt = '本次必须在不同窗口处理。以后必须保持第三人称。'
      const capture = (taskSpec: typeof f.spec) => captureUserDirectives({ userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        chapterId: null, sourceMessageId: f.sourceMessageId, taskSpec, prompt })
      const first = await capture(f.spec)
      expect(first.find(item => item.text.includes('本次'))).toMatchObject({ scope: 'task', taskSpecId: f.spec.id })
      expect(first.find(item => item.text.includes('以后'))).toMatchObject({ scope: 'global' })
      const next = buildTaskSpec({ runId: randomUUID(), novelId: f.novelId, chapterId: null, prompt: '新的任务' })
      const applicable = await listActiveDirectives(f.userId, f.novelId, { sessionId: f.sessionId, taskSpecId: next.id })
      expect(applicable.map(item => item.text)).toEqual(['以后必须保持第三人称'])
      const second = await capture(next)
      expect(second.find(item => item.scope === 'task')?.id).not.toBe(first.find(item => item.scope === 'task')?.id)
      expect(second.find(item => item.scope === 'global')?.id).toBe(first.find(item => item.scope === 'global')?.id)
    })
  })
  it('retains global/current directives but excludes older tasks and other chapters in the same work', async () => {
    await fixture(async f => {
      const base = { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, kind: 'must' as const, sourceMessageId: f.runId }
      await prisma.userDirective.createMany({ data: [
        { ...base, scope: 'global', text: '全书长期要求' },
        { ...base, scope: 'chapter', chapterId: f.chapterId, text: '本章要求' },
        { ...base, scope: 'chapter', chapterId: randomUUID(), text: '旧第13章要求' },
        { ...base, scope: 'task', taskSpecId: f.spec.id, text: '本任务要求' },
        { ...base, scope: 'task', taskSpecId: randomUUID(), text: '旧任务多窗口要求' },
        { ...base, scope: 'task', text: '本run兼容要求' },
        { ...base, scope: 'task', sourceMessageId: randomUUID(), text: '旧run兼容要求' },
      ] })
      const scope = { sessionId: f.sessionId, chapterId: f.chapterId, runId: f.runId }
      const visible = await listActiveDirectives(f.userId, f.novelId, scope)
      expect(visible.map(item => item.text).sort()).toEqual(['全书长期要求', '本章要求', '本任务要求', '本run兼容要求'].sort())
      expect(await listActiveDirectives(f.userId, f.novelId)).toHaveLength(7)
      const nextTask = await listActiveDirectives(f.userId, f.novelId, { ...scope, runId: randomUUID(), taskSpecId: randomUUID(), chapterId: null })
      expect(nextTask.map(item => item.text)).toEqual(['全书长期要求'])
    })
  })
})

describe.runIf(available)('story memory graph transaction boundary', () => {
  it.each(['event', 'relation', 'unread-source', 'revision-without-source'] as const)('%s uses a durable receipt without duplicate graph writes', async scenario => {
    await fixture(async f => {
      const lease = await claim(f), tool = scenario === 'relation' ? memoryRelationSaveTool : memoryEventSaveTool
      const args = scenario === 'relation' ? { fromName: '甲', toName: '乙', relationType: '同袍', confidence: 0.8 }
        : { title: '夜巡', description: '发现火光', confidence: 0.8,
          ...(scenario === 'unread-source' ? { sourceChapterId: f.chapterId } : scenario === 'revision-without-source' ? { revision: 1 } : {}) }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '保存本次确认的事件与关系' }, { role: 'assistant', content: null,
            toolCalls: [{ id: 'save-memory-graph', name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const failed = scenario === 'unread-source' || scenario === 'revision-without-source'
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: failed ? { outcome: 'failed' } : { savedMemoryId: expect.any(String) } })
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'idle' })
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(failed ? 0 : 1)
      expect(await prisma.storyEvent.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.storyEntity.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(1)
      if (!failed) {
        const memory = await prisma.projectMemoryEntry.findFirstOrThrow({ where: { novelId: f.novelId } })
        expect(memory.reviewStatus).toBe('pending')
        await storyMemory.resolveMemoryReview(f.userId, memory.id, true)
        expect(await prisma.storyEvent.count({ where: { novelId: f.novelId, status: 'confirmed' } })).toBe(scenario === 'event' ? 1 : 0)
        expect(await prisma.storyEntity.count({ where: { novelId: f.novelId } })).toBe(scenario === 'relation' ? 2 : 0)
        expect(await prisma.entityRelation.count({ where: { sourceId: memory.id } })).toBe(scenario === 'relation' ? 1 : 0)
        await expect(storyMemory.resolveMemoryReview(f.userId, memory.id, true)).rejects.toMatchObject({ code: 'MEMORY_REVIEW_STALE' })
        // Editing prose must not leave previously projected structured facts active.
        const edited = await storyMemory.updateStoryMemoryEntry(f.userId, memory.id, { content: '作者修改了原事实', expectedVersion: 2 })
        expect(await prisma.storyEvent.count({ where: { novelId: f.novelId, status: 'confirmed' } })).toBe(0)
        expect(await prisma.entityRelation.count({ where: { sourceId: memory.id } })).toBe(0)
        await storyMemory.deleteStoryMemoryEntry(f.userId, memory.id, edited.version)
        expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ status: 'invalid' })
      }
    })
  })

  it.each(['event', 'relation'] as const)('%s rolls back graph and memory together', async kind => {
    await fixture(async f => {
      const invoke = (tx?: Prisma.TransactionClient) => kind === 'event'
        ? storyMemory.saveStoryEvent({ userId: f.userId, novelId: f.novelId, sourceId: f.runId, title: '夜巡', description: '发现异常火光', participants: [], causes: [], effects: [], confidence: 0.8 }, tx)
        : storyMemory.saveEntityRelation({ userId: f.userId, novelId: f.novelId, sourceId: f.runId, fromName: '陈砚', toName: '赵得胜', relationType: '同袍', confidence: 0.8 }, tx)
      await expect(prisma.$transaction(async tx => {
        await invoke(tx)
        throw new Error('fixture graph rollback')
      })).rejects.toThrow('fixture graph rollback')
      expect(await prisma.storyEvent.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.storyEntity.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      const saved = await invoke()
      expect(await prisma.projectMemoryEntry.findUnique({ where: { id: saved.savedMemoryId } })).toMatchObject({ novelId: f.novelId })
    })
  })
})

describe.runIf(available)('reader promise transaction boundary', () => {
  it.each(['save', 'update', 'stale', 'unread', 'rollback'] as const)('%s uses the observed charter and promise bundle', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const input = { title: '揭示内鬼', promise: '公布证据链', payoffHorizon: '本卷末', priority: 50 }
      const promise = scenario === 'save' ? null : await saveReaderPromise(f.userId, f.novelId, input)
      const tool = promise ? readerPromiseUpdateTool : readerPromiseSaveTool
      const args = promise ? { promiseId: promise.id, status: 'deferred' } : input
      const tools = [storyCharterGetTool, tool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'plan', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: z.toJSONSchema(item.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(item => ({ name: item.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '整理承诺' }, { role: 'assistant', content: null, toolCalls: [
            ...(scenario === 'unread' ? [] : [{ id: 'read', name: storyCharterGetTool.name, arguments: '{}' }]),
            { id: 'write', name: tool.name, arguments: JSON.stringify(args) },
          ] }], successfulToolSignatures: [] } })
      const invoke = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario !== 'unread') await invoke()
      if (scenario === 'stale') await prisma.readerPromise.update({ where: { id: promise!.id }, data: { promise: '作者刚修改的承诺' } })
      if (scenario === 'rollback') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => {
          await work(tx); throw new Error('fixture promise effect rollback')
        }))
        await expect(invoke()).rejects.toThrow('fixture promise effect rollback')
        expect((await prisma.readerPromise.findUniqueOrThrow({ where: { id: promise!.id } })).status).toBe('open')
      }
      expect(await invoke()).toMatchObject({ kind: 'tool', result: ['stale', 'unread'].includes(scenario) ? { outcome: 'failed' } : { observedState: { kind: 'charter' } } })
      expect(await invoke()).toMatchObject({ kind: 'idle' })
      const records = await prisma.readerPromise.findMany({ where: { novelId: f.novelId } })
      expect(records).toHaveLength(1)
      expect(records[0].status).toBe(['update', 'rollback'].includes(scenario) ? 'deferred' : 'open')
      if (scenario === 'stale') expect(records[0].promise).toBe('作者刚修改的承诺')
    })
  })

  it('rolls back with its caller and rejects payoff without a saved chapter', async () => {
    await fixture(async f => {
      const input = { title: '揭示内鬼', promise: '公布证据链', payoffHorizon: '本卷末', priority: 50 }
      await expect(prisma.$transaction(async tx => {
        await saveReaderPromise(f.userId, f.novelId, input, tx)
        throw new Error('fixture promise rollback')
      })).rejects.toThrow('fixture promise rollback')
      expect(await prisma.readerPromise.count({ where: { novelId: f.novelId } })).toBe(0)
      const promise = await saveReaderPromise(f.userId, f.novelId, input)
      const update = { userId: f.userId, novelId: f.novelId, promiseId: promise.id, status: 'paid' as const }
      await expect(updateReaderPromise({ ...update, paidAtChapter: 999 })).rejects.toMatchObject({ code: 'PAYOFF_CHAPTER_REQUIRED' })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const paid = await updateReaderPromise({ ...update, paidAtChapter: chapter.orderIndex })
      expect(await updateReaderPromise({ ...update, paidAtChapter: chapter.orderIndex })).toEqual(paid)
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '' } })
      await expect(updateReaderPromise({ ...update, paidAtChapter: chapter.orderIndex })).rejects.toMatchObject({ code: 'PAYOFF_CHAPTER_REQUIRED' })
    })
  })
})

describe.runIf(available)('saved task directive identity', () => {
  it.each(['save', 'rollback', 'denied', 'replace', 'cancel', 'old-scope', 'replace-rollback'] as const)('%s commits the directive and receipt together', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const replacing = ['replace', 'cancel', 'old-scope', 'replace-rollback'].includes(scenario)
      const tool = replacing ? directiveSupersedeTool : directiveSaveTool
      const originalDirective = replacing ? await prisma.userDirective.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        taskSpecId: scenario === 'old-scope' ? randomUUID() : f.rootId, sourceMessageId: f.runId, scope: 'task', kind: 'must', text: '旧约束' } }) : null
      const args = originalDirective ? { directiveId: originalDirective.id, ...(scenario === 'cancel' ? {} : { replacementText: '新约束' }) }
        : { text: '本次只处理第19章', kind: 'must', scope: 'task' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'plan', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: scenario === 'denied' ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '本次只处理第19章' }, { role: 'assistant', content: null, toolCalls: [{ id: 'save-directive', name: tool.name,
            arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const original = runtimeOperations.commitOperationEffect
      if (scenario === 'rollback' || scenario === 'replace-rollback') vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce(async (token, operationId, hash, work) => original(token, operationId, hash, async tx => {
        await work(tx)
        throw new Error('fixture directive rollback')
      }))
      const invoke = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'rollback' || scenario === 'replace-rollback') {
        await expect(invoke()).rejects.toThrow('fixture directive rollback')
        expect(await prisma.userDirective.count({ where: { userId: f.userId } })).toBe(originalDirective ? 1 : 0)
        if (originalDirective) expect((await prisma.userDirective.findUniqueOrThrow({ where: { id: originalDirective.id } })).status).toBe('active')
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      }
      expect(await invoke()).toMatchObject({ kind: 'tool', result: scenario === 'denied' || scenario === 'old-scope' ? { outcome: 'failed' }
        : { summary: replacing ? scenario === 'cancel' ? '取消旧指令' : '替代旧指令' : '保存must指令' } })
      expect(await invoke()).toMatchObject({ kind: 'idle' })
      expect(await prisma.userDirective.count({ where: { userId: f.userId, taskSpecId: f.rootId } })).toBe(scenario === 'denied' || scenario === 'old-scope' ? 0 : replacing && scenario !== 'cancel' ? 2 : 1)
      if (originalDirective) expect((await prisma.userDirective.findUniqueOrThrow({ where: { id: originalDirective.id } })).status)
        .toBe(scenario === 'old-scope' ? 'active' : scenario === 'cancel' ? 'cancelled' : 'superseded')
      expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(1)
    })
  })

  it('keeps an explicit task directive across run replacement but not a later task', async () => {
    await fixture(async f => {
      const ctx: ToolContext = { ...f, callId: 'save-directive', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
        signal: new AbortController().signal, emit: () => {} }
      const first = await directiveSaveTool.execute(ctx, { text: '本次只处理第19章', kind: 'must', scope: 'task' })
      expect(await directiveSaveTool.execute(ctx, { text: '本次只处理第19章', kind: 'must', scope: 'task' })).toEqual(first)
      const saved = await prisma.userDirective.findFirstOrThrow({ where: { userId: f.userId, sourceMessageId: f.runId } })
      expect(saved.taskSpecId).toBe(f.rootId)
      const resumed = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'queued', taskRootId: f.rootId, runtimeProtocolVersion: 1 } })
      expect(await directiveSaveTool.execute({ ...ctx, runId: resumed.id }, { text: '本次只处理第19章', kind: 'must', scope: 'task' })).toEqual(first)
      expect((await listActiveDirectives(f.userId, f.novelId, { sessionId: f.sessionId, runId: resumed.id })).map(item => item.id)).toContain(saved.id)
      expect(await listActiveDirectives(f.userId, f.novelId, { sessionId: f.sessionId, taskSpecId: randomUUID() })).toEqual([])
      expect(await directiveSaveTool.execute({ ...ctx, chapterId: null }, { text: '章节约束', kind: 'must', scope: 'chapter' })).toMatchObject({ outcome: 'failed' })
      expect(await prisma.userDirective.count({ where: { userId: f.userId } })).toBe(1)
    })
  })
})

describe.runIf(available)('durable plan metadata', () => {
  it.each(['plan_rename', 'plan_delete'] as const)('%s commits with a verified baseline and preserves stored content', async action => {
    await fixture(async f => {
      const plan = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '原计划', content: '计划正文不得丢失', metadata: { savedAsPlan: true } } })
      const lease = await claim(f), tools = [planReadTool, planRenameTool, planDeleteTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'plan', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '调整这份计划' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'read-plan', name: 'plan_read', arguments: JSON.stringify({ planId: plan.id }) },
            { id: 'change-plan', name: action, arguments: JSON.stringify({ planId: plan.id, ...(action === 'plan_rename' ? { title: '新的计划' } : {}) }) },
          ] }], successfulToolSignatures: [] } })
      await executeDurableToolStep(lease, new AbortController().signal)
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { observedState: { kind: 'plan', id: plan.id } } })
      const saved = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: plan.id } })
      expect(saved.content).toBe(plan.content)
      expect(saved.title).toBe(action === 'plan_rename' ? '新的计划' : plan.title)
      expect(saved.metadata).toMatchObject({ savedAsPlan: action !== 'plan_delete' })
      const state = await loadExecutionState(f.userId, f.runId)
      const deliverables = await withRunLease(lease, async tx => {
        const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
        return collectDurableDeliverables(tx, root, (await collectDurableToolEvidence(tx, root.id, state.frame.revision)).effects)
      })
      expect(deliverables).toEqual([expect.objectContaining({ kind: 'plan', id: plan.id, status: action === 'plan_delete' ? 'removed' : 'current' })])
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'idle' })
      expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: plan.id } })).updatedAt).toEqual(saved.updatedAt)
    })
  })
})

describe.runIf(available)('durable charter save', () => {
  it.each(['create', 'plan', 'stale', 'unread', 'rollback', 'same-content'] as const)('%s preserves observed charter and commits once', async scenario => {
    await fixture(async f => {
      const args = storyCharterSaveTool.parameters.parse({ oneLinePromise: '寻找失落证据', targetAudience: '悬疑读者', protagonistDesire: '寻找真相',
        protagonistFear: '失去亲人', protagonistMisbelief: '证据不会骗人', protagonistNonNegotiable: '不伤害无辜者',
        conflictEngine: '证据互相矛盾', relationshipEngine: '互不信任的同伴', emotionalBaseline: '克制', emotionalRange: '从怀疑到信任' })
      const lease = await claim(f), tools = [storyCharterGetTool, storyCharterSaveTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: scenario === 'plan' ? 'plan' : 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '建立创作宪章' }, { role: 'assistant', content: null, toolCalls: [
            ...(scenario === 'unread' ? [] : [{ id: 'read', name: 'story_charter_get', arguments: '{}' }]),
            { id: 'save', name: 'story_charter_save', arguments: JSON.stringify(args) },
            ...(scenario === 'same-content' ? [{ id: 'save-again', name: 'story_charter_save', arguments: JSON.stringify(args) }] : []),
          ] }], successfulToolSignatures: [] } })
      if (scenario !== 'unread') await executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'stale') await upsertStoryCharter(f.userId, f.novelId, { ...args, oneLinePromise: '作者刚刚修改的承诺' })
      if (scenario === 'rollback') {
        const original = storyCharterSaveTool.execute
        vi.spyOn(storyCharterSaveTool, 'execute').mockImplementationOnce(async (ctx, input) => {
          await original(ctx, input)
          throw new Error('fixture after charter write')
        })
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('fixture after charter write')
        expect(await prisma.storyCharter.count({ where: { novelId: f.novelId } })).toBe(0)
      }
      const result = await executeDurableToolStep(lease, new AbortController().signal)
      expect(result).toMatchObject({ kind: 'tool', result: ['stale', 'unread'].includes(scenario)
        ? { outcome: 'failed' } : { observedState: { kind: 'charter', id: f.novelId } } })
      const saved = await prisma.storyCharter.findUnique({ where: { novelId: f.novelId } })
      if (scenario === 'unread') expect(saved).toBeNull()
      else {
        expect(saved?.oneLinePromise).toBe(scenario === 'stale' ? '作者刚刚修改的承诺' : args.oneLinePromise)
        expect(saved?.revision).toBe(1)
      }
      if (!['stale', 'unread'].includes(scenario)) {
        const state = await loadExecutionState(f.userId, f.runId)
        expect(await withRunLease(lease, tx => readObservedBaseline(tx, f.rootId, state.frame.revision, { kind: 'charter', id: f.novelId })))
          .toMatchObject({ kind: 'charter', id: f.novelId })
      }
      if (scenario === 'same-content') {
        expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool' })
        const repeated = await prisma.storyCharter.findUniqueOrThrow({ where: { novelId: f.novelId } })
        expect(repeated.revision).toBe(saved!.revision)
        expect(repeated.updatedAt).toEqual(saved!.updatedAt)
      }
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'idle' })
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'story_charter_save' } })).toBe(scenario === 'same-content' ? 2 : 1)
    })
  })
})


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
      expect(evidence.progressSequence === '0').toBe(missing)
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

describe.runIf(available)('durable explicit memory save', () => {
  it.each(['create', 'update', 'unread', 'stale', 'missing', 'rollback', 'stopped'] as const)('%s fences explicit card writes', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const title = '原角色卡'
      const seeded = scenario !== 'create' ? await storyMemory.saveStoryMemory({ userId: f.userId, novelId: f.novelId, runId: f.runId,
        sourceChapterId: null, memoryType: 'characterCard', layer: 'L1', title, content: '原角色事实', importance: 70, confidence: 1, status: 'confirmed',
        evidence: { sourceType: 'author_input', sourceId: f.runId, confidence: 1 } }) : null
      const read = !['create', 'unread'].includes(scenario)
      const tools = [memorySearchTool, memorySaveTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '更新角色事实' }, { role: 'assistant', content: null, toolCalls: [
            ...(read ? [{ id: 'memory-read', name: 'memory_search', arguments: JSON.stringify({ query: title }) }] : []),
            { id: 'memory-write', name: 'memory_save', arguments: JSON.stringify({ memoryType: 'characterCard', title, content: '新的角色事实', importance: 80, ...(seeded ? { memoryId: seeded.id } : {}) }) },
          ] }], successfulToolSignatures: [] } })
      if (read) {
        const result = await executeDurableToolStep(lease, new AbortController().signal)
        expect(result).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining(seeded!.id) } })
      }
      if (scenario === 'stale') await prisma.projectMemoryEntry.update({ where: { id: seeded!.id }, data: { content: '作者刚更新' } })
      if (scenario === 'missing') await prisma.projectMemoryEntry.delete({ where: { id: seeded!.id } })
      if (scenario === 'stopped') await pauseDurableTask(f.userId, f.runId)
      if (scenario === 'rollback') vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce(async (token, operationId, hash, work) =>
        runtimeOperations.commitOperationEffect(token, operationId, hash, async tx => { await work(tx); throw new Error('fixture memory rollback') }))
      const invoke = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'stopped' || scenario === 'rollback') await expect(invoke()).rejects.toThrow()
      else {
        const result = await invoke()
        expect(result).toMatchObject({ kind: 'tool', result: ['unread', 'stale', 'missing'].includes(scenario) ? { outcome: 'failed' } : { savedMemoryId: expect.any(String) } })
      }
      const cards = await prisma.projectMemoryEntry.findMany({ where: { novelId: f.novelId, title } })
      expect(cards).toHaveLength(scenario === 'missing' ? 0 : scenario === 'update' ? 2 : 1)
      if (scenario === 'create' || scenario === 'update') {
        expect(cards).toEqual(expect.arrayContaining([expect.objectContaining({ content: '新的角色事实', status: 'inferred', reviewStatus: 'pending' })]))
        if (scenario === 'update') expect(cards).toEqual(expect.arrayContaining([expect.objectContaining({ id: seeded!.id, content: '原角色事实' })]))
      } else if (cards.length) expect(cards[0].content).toBe(scenario === 'stale' ? '作者刚更新' : '原角色事实')
    })
  })
})

describe.runIf(available)('durable domain continuation', () => {
  it.each(['own', 'old-task', 'denied', 'unknown-operation', 'stale-cursor', 'rollback', 'stagnant-resume'] as const)('%s keeps domain follow-up inside the original scope', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const tool = chapterBridgeCommitTool
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: scenario === 'denied' ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }, { role: 'assistant', content: '正文已保存' }], successfulToolSignatures: [] } })
      const other = scenario === 'old-task' ? await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'failed', engine: 'loop' } }) : null
      const compilation = await prepareStoryCompilation({ ...f, runId: other?.id ?? f.runId, chapterId: f.chapterId, mode: 'balanced', intentSummary: '尚未提交章节' })
      if (scenario === 'unknown-operation') await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: f.rootId, originRunId: f.runId,
        operationKey: 'unknown-test', kind: 'provider', action: 'fixture', inputHash: runtimeJson({}).hash, inputSnapshot: {}, status: 'unknown' } })
      if (scenario === 'rollback') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId,
        eventKey: `state:${f.rootId}:1`, type: 'fixture.conflict', payload: {} } })
      const invoke = () => advanceDurableCompletionObligations(lease, { expectedRevision: 0, expectedHash: scenario === 'stale-cursor' ? 'f'.repeat(64) : initialized.frame.snapshotHash })
      if (scenario === 'rollback' || scenario === 'stale-cursor') {
        await expect(invoke()).rejects.toThrow()
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.continuation' } })).toBe(0)
      } else if (scenario === 'old-task') expect(await invoke()).toBeNull()
      else if (scenario === 'denied' || scenario === 'unknown-operation') {
        expect(await invoke()).toMatchObject({ kind: 'reconciliation_required' })
        expect(await runReviewedDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'needs_attention', blockers: expect.any(Array) })
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
        expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(initialized.frame.snapshotHash)
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      }
      else {
        const result = await invoke()
        expect(result).toMatchObject({ kind: 'continued' })
        const event = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'execution.continuation' } })
        expect(event.payload).toMatchObject({ reason: 'domain_incomplete', reminderIndex: 1, blockers: [{ code: 'uncommitted_compilation', reference: compilation.compilation.id }] })
        const state = await loadExecutionState(f.userId, f.runId)
        expect(state.frame.state.messages.filter(item => item.role === 'user')).toHaveLength(1)
        expect(state.frame.state.turn).toBe(0)
        if (scenario === 'stagnant-resume') {
          for (let index = 2; index <= 5; index++) {
            const previous = await loadExecutionState(f.userId, lease.runId)
            const candidate = await saveExecutionState(lease, { expectedRevision: previous.frame.revision, expectedHash: previous.frame.snapshotHash,
              snapshot: { ...previous.frame.state, messages: [...previous.frame.state.messages, { role: 'assistant', content: '正文已保存' }] } })
            if (index === 3) {
              await pauseDurableTask(f.userId, lease.runId)
              const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
              const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
              lease = await claim({ userId: f.userId, runId: resumed.run.id })
            }
            expect(await advanceDurableCompletionObligations(lease, { expectedRevision: candidate.revision, expectedHash: candidate.snapshotHash }))
              .toMatchObject({ kind: index === 5 ? 'needs_attention' : 'continued' })
          }
          const events = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: f.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'asc' } })
          expect(events.map(item => (item.payload as { reminderIndex: number }).reminderIndex)).toEqual([1, 2, 3, 4])
        }
      }
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
    })
  })
})

describe.runIf(available)('durable completion without an extra model call', () => {
  it.each(['complete', 'stopped', 'stale-cursor', 'changed-body', 'pending', 'rollback', 'empty', 'promise'] as const)(
    '%s keeps existing checks and commits the terminal receipt atomically', async scenario => {
      await fixture(async f => {
        const lease = await claim(f)
        const candidate = scenario === 'empty' ? '' : scenario === 'promise' ? '现在读取章节。' : '你好'
        const initialized = await initializeExecutionState(lease, {
          configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
            model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
            tools: [], toolAuthority: [], protectedChapterIds: [f.chapterId], pinnedSkillVersions: [] },
          snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
            messages: [{ role: 'user', content: '不要修改已有章节，回答你好' }, { role: 'assistant', content: candidate }], successfulToolSignatures: [] },
        })
        const cursor = { expectedRevision: initialized.frame.revision, expectedHash: initialized.frame.snapshotHash }
        const fetch = vi.fn(async () => { throw new Error('completion must not make a paid request') })
        vi.stubGlobal('fetch', fetch)
        const route = vi.spyOn(credits, 'getModelTierRuntime')
        if (scenario === 'stopped') await pauseDurableTask(f.userId, f.runId)
        if (scenario === 'changed-body') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者已修改正文' } })
        if (scenario === 'stale-cursor') await saveExecutionState(lease, { ...cursor,
          snapshot: { ...initialized.frame.state, messages: [...initialized.frame.state.messages, { role: 'assistant', content: '新的答复' }] } })
        if (scenario === 'pending') await prepareOperation(lease, { key: 'still-pending', kind: 'internal', action: 'fixture_pending', input: {} })
        if (scenario === 'rollback') {
          const commit = runtimeOperations.commitOperationEffectInTransaction
          vi.spyOn(runtimeOperations, 'commitOperationEffectInTransaction').mockImplementationOnce(async (...args) => {
            await commit(...args)
            throw new Error('fixture terminal transaction rollback')
          })
        }
        if (scenario === 'complete') {
          expect(await runReviewedDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'completed' })
          expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('completed')
          expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('completed')
          expect(await prisma.agentRunLease.count({ where: { runId: f.runId, enabled: true } })).toBe(0)
          const events = await publishDurableEvents(f.userId, f.runId)
          expect(events.find(event => event.type === 'run.finished')).toMatchObject({
            status: 'succeeded', outputSummary: '你好', usage: { totalTokens: 0 },
          })
          expect((await publishDurableEvents(f.userId, f.runId)).filter(event => event.type === 'run.finished')).toHaveLength(0)
          await expect(finalizeDurableTask(lease, cursor)).rejects.toThrow()
          expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.completion.decided' } })).toBe(1)
        } else {
          await expect(finalizeDurableTask(lease, cursor)).rejects.toThrow()
          expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe(scenario === 'stopped' ? 'paused' : 'active')
          expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.completion.decided' } })).toBe(0)
          expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'completion_finalize' } } })).toBe(0)
          if (scenario === 'rollback') {
            expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'completion_finalize' } })).toBe(0)
            expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(cursor.expectedRevision)
          }
        }
        expect(fetch).not.toHaveBeenCalled()
        expect(route).not.toHaveBeenCalled()
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      }, undefined, '不要修改已有章节，回答你好')
    })
})

describe.runIf(available)('fenced derivative memory', () => {
  it.each(['complete', 'concurrent', 'rollback', 'stopped-resume', 'stale', 'body-tamper', 'job-tamper', 'owner-tamper', 'missing-job', 'missing-event', 'processing', 'legacy-worker', 'legacy-completed', 'unowned-job'] as const)('%s binds memory writes and receipt to the original effect', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const tools = [chapterReadTool, chapterWriteTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
            { id: 'write', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '已保存的正文' }) },
          ] }], successfulToolSignatures: [] } })
      await executeDurableToolStep(lease, new AbortController().signal)
      await executeDurableToolStep(lease, new AbortController().signal)
      const job = await prisma.memoryExtractionJob.findFirstOrThrow({ where: { novelId: f.novelId } })
      expect(job.status).toBe('pending')
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, content: '更新的正文' } })
      if (scenario === 'body-tamper') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '同版本正文已变' } })
      if (scenario === 'job-tamper') await prisma.memoryExtractionJob.update({ where: { id: job.id }, data: { diff: { after: '不是原始来源' } } })
      if (scenario === 'owner-tamper') await prisma.memoryExtractionJob.update({ where: { id: job.id }, data: { diff: { ...(job.diff as object), durableTaskRootId: 'wrong-root' } } })
      if (scenario === 'missing-job') await prisma.memoryExtractionJob.delete({ where: { id: job.id } })
      if (scenario === 'processing') await prisma.memoryExtractionJob.update({ where: { id: job.id }, data: { status: 'processing' } })
      if (scenario === 'legacy-completed') await prisma.memoryExtractionJob.update({ where: { id: job.id }, data: { status: 'completed' } })
      if (scenario === 'unowned-job') await prisma.$transaction(tx => storyMemory.enqueueChapterMemoryExtraction({ novelId: f.novelId, chapterId: f.chapterId, chapterRevision: 99, before: '', after: '不属于本任务的排队工作' }, tx))
      if (scenario === 'legacy-worker') {
        await storyMemory.processMemoryExtractionJob(job.id)
        expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('pending')
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      }
      if (['body-tamper', 'job-tamper', 'owner-tamper', 'missing-job', 'processing'].includes(scenario)) {
        await expect(advanceDurableMemory(lease)).rejects.toMatchObject({ code: scenario === 'body-tamper' ? 'MEMORY_JOB_SOURCE_MISMATCH' : scenario === 'processing' ? 'RUNTIME_RECONCILIATION_REQUIRED' : 'RUNTIME_RECEIPT_INVALID' })
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'memory_extract' } })).toBe(0)
        return
      }
      if (scenario === 'rollback') {
        const original = storyMemory.applyMemoryExtractionJob
        const mock = vi.spyOn(storyMemory, 'applyMemoryExtractionJob').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('fixture memory transaction rollback') })
        await expect(advanceDurableMemory(lease)).rejects.toThrow('fixture memory transaction rollback')
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
        expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('pending')
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'memory_extract' } })).toBe(0)
        mock.mockRestore()
      }
      if (scenario === 'stopped-resume') {
        await pauseDurableTask(f.userId, f.runId)
        await expect(advanceDurableMemory(lease)).rejects.toThrow()
        expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('pending')
        const event = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: event.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'memory-resumed')
      }
      const results = scenario === 'concurrent' ? await Promise.all([advanceDurableMemory(lease), advanceDurableMemory(lease)]) : [await advanceDurableMemory(lease)]
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(results.find(Boolean)?.result).toMatchObject({ jobId: job.id, status: scenario === 'stale' ? 'stale' : 'applied' })
      const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'memory_extract' } })
      expect((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('completed')
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(scenario === 'stale' ? 0 : 2)
      if (scenario === 'missing-event') {
        await prisma.agentExecutionOutbox.delete({ where: { eventKey: `effect:${operation.id}` } })
        await expect(advanceDurableMemory(lease)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      } else expect(await advanceDurableMemory(lease)).toBeNull()
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'memory_extract' } })).toBe(1)
      if (scenario === 'unowned-job') expect(await prisma.memoryExtractionJob.count({ where: { novelId: f.novelId, status: 'pending' } })).toBe(1)
    })
  })
})

describe.runIf(available)('durable deliverable facts', () => {
  it.each(['chapter', 'changed', 'title-changed', 'deleted', 'revision-only', 'no-op', 'second-write', 'read-only', 'plan', 'plan-changed', 'plan-deleted', 'empty-create', 'create-write-retry'] as const)('%s checks latest authored output against actual scoped storage', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      const lease = await claim(f)
      const tools = [chapterReadTool, chapterWriteTool, chapterCreateTool, planSaveTool]
      const calls: { id: string; name: string; arguments: string }[] = []
      const add = (name: string, args: object) => calls.push({ id: `call-${calls.length}`, name, arguments: JSON.stringify(args) })
      if (scenario.startsWith('plan')) add('plan_save', { title: '交付计划', content: '计划正文' })
      else if (scenario === 'empty-create') add('chapter_create', { title: '新空章' })
      else if (scenario === 'create-write-retry') {
        add('chapter_create', { title: '新章', content: '新正文' })
      } else {
        add('chapter_read', { chapterId: f.chapterId })
        if (scenario !== 'read-only') add('chapter_write', { chapterId: f.chapterId, content: scenario === 'no-op' ? '原文' : '交付正文' })
        if (scenario === 'second-write') add('chapter_write', { chapterId: f.chapterId, content: '最后交付正文' })
      }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '交付正文和计划' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      for (const _ of calls) await executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'create-write-retry') {
        const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: f.novelId, title: '新章' } })
        const frame = (await loadExecutionState(f.userId, f.runId)).frame
        await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: null, toolCalls: [
            { id: 'later-write', name: 'chapter_write', arguments: JSON.stringify({ chapterId: chapter.id, content: '实际最终正文' }) },
            { id: 'retry-create', name: 'chapter_create', arguments: JSON.stringify({ title: '新章', content: '新正文' }) },
          ] }] } })
        await executeDurableToolStep(lease, new AbortController().signal)
        await executeDurableToolStep(lease, new AbortController().signal)
      }
      if (scenario === 'changed') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '外部改动' } })
      if (scenario === 'title-changed') await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: '外部改名' } })
      if (scenario === 'deleted') await prisma.chapter.delete({ where: { id: f.chapterId } })
      if (scenario === 'revision-only') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
      if (scenario === 'plan-changed') await prisma.agentArtifact.updateMany({ where: { runId: f.runId, artifactType: 'chapterPlan' }, data: { content: '外部计划' } })
      if (scenario === 'plan-deleted') await prisma.agentArtifact.deleteMany({ where: { runId: f.runId, artifactType: 'chapterPlan' } })
      const frame = (await loadExecutionState(f.userId, f.runId)).frame
      const result = await withRunLease(lease, async tx => {
        const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
        const evidence = await collectDurableToolEvidence(tx, root.id, frame.revision)
        return collectDurableDeliverables(tx, root, evidence.effects)
      })
      expect(result).toHaveLength(scenario === 'read-only' ? 0 : 1)
      if (scenario === 'read-only') return
      expect(result[0].status).toBe(['changed', 'title-changed', 'plan-changed'].includes(scenario) ? 'changed' : ['deleted', 'plan-deleted'].includes(scenario) ? 'missing' : 'current')
      if (scenario === 'empty-create') expect(result[0].characters).toBe(0)
      if (scenario === 'second-write') expect(result[0].characters).toBe('最后交付正文'.length)
      if (scenario === 'create-write-retry') expect(result[0].characters).toBe('实际最终正文'.length)
      if (scenario === 'revision-only') expect(result[0].currentRevision).not.toBe(result[0].expectedRevision)
      expect(storyMemory.processMemoryExtractionJob).not.toHaveBeenCalled()
      if (scenario === 'chapter') expect(await prisma.memoryExtractionJob.count({ where: { novelId: f.novelId, status: 'pending' } })).toBe(1)
    })
  })
})

describe.runIf(available)('durable domain postconditions', () => {
  it.each(['unchanged', 'changed', 'revision-only', 'deleted', 'missing-baseline', 'corrupt-baseline', 'resume', 'new-chapter'] as const)('%s checks original body facts without re-baselining', async scenario => {
    await fixture(async f => {
      const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
      expect(root.specSnapshot).toMatchObject({ postconditions: expect.arrayContaining([expect.objectContaining({ code: 'EARLIER_CONTENT_UNCHANGED' })]) })
      const event = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `baseline:${root.id}` } })
      if (scenario === 'changed' || scenario === 'resume') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '已被改动' } })
      if (scenario === 'revision-only') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
      if (scenario === 'deleted') await prisma.chapter.delete({ where: { id: f.chapterId } })
      if (scenario === 'missing-baseline') await prisma.agentExecutionOutbox.delete({ where: { id: event.id } })
      if (scenario === 'corrupt-baseline') await prisma.agentExecutionOutbox.update({ where: { id: event.id }, data: { payload: { ...(event.payload as object), snapshotHash: 'broken' } } })
      if (scenario === 'resume') {
        await initializeDurableTask(f)
        expect((await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: event.id } })).payload).toEqual(event.payload)
      }
      if (scenario === 'new-chapter') {
        const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: '新增', content: '新增正文', orderIndex: 2, orderInVolume: 2 } })
      }
      const check = prisma.$transaction(tx => evaluateTaskPostconditions(tx, root))
      if (scenario === 'corrupt-baseline') { await expect(check).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' }); return }
      const result = (await check).find(item => item.code === 'EARLIER_CONTENT_UNCHANGED')
      expect(result?.status).toBe(scenario === 'missing-baseline' ? 'unverified' : ['changed', 'deleted', 'resume'].includes(scenario) ? 'failed' : 'passed')
    }, undefined, '不要修改已有章节，继续写新章')
  })
  it.each(['order', 'chapter-title', 'volume-title', 'foreign-volume'] as const)('%s rechecks current structure rather than trusting an earlier successful observation', async scenario => {
    await fixture(async f => {
      const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
      expect(await prisma.$transaction(tx => evaluateTaskPostconditions(tx, root))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STRUCTURE_VALIDATED', status: 'passed' })]))
      const before = await getStructureReportObservation(f.userId, f.novelId)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      if (scenario === 'order') await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 9 } })
      if (scenario === 'chapter-title') await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: ' ' } })
      if (scenario === 'volume-title') await prisma.volume.update({ where: { id: chapter.volumeId }, data: { title: ' ' } })
      if (scenario === 'foreign-volume') {
        const other = await prisma.novel.create({ data: { authorId: f.userId, title: '另一本', slug: randomUUID(), summary: '' } })
        const volume = await prisma.volume.create({ data: { novelId: other.id, title: '其他卷', orderIndex: 1 } })
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { volumeId: volume.id } })
      }
      const results = await prisma.$transaction(tx => evaluateTaskPostconditions(tx, root))
      expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STRUCTURE_VALIDATED', status: 'failed' })]))
      expect((await getStructureReportObservation(f.userId, f.novelId)).stateHash).not.toBe(before.stateHash)
    }, undefined, '调整章节顺序')
  })
})

describe.runIf(available)('quality report integrity and atomic repair', () => {
  it.each(['complete', 'unavailable', 'unlocated', 'ambiguous', 'report-rollback', 'stale-source', 'repair', 'repair-rollback', 'no-op', 'empty', 'concurrent', 'wrong-compilation', 'tool-fallback', 'foreign-run', 'legacy-report', 'hash-mismatch', 'outer-transaction', 'outer-rollback', 'evidence-corrected', 'evidence-unresolved', 'evidence-ambiguous', 'evidence-credit-failure', 'quality-provider-failure', 'quality-timeout-fallback', 'continuity-provider-failure'] as const)('%s cannot promote unverified reports or partially repair', async scenario => {
    await fixture(async f => {
      const compilation = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '质量检查' })
      const compilationId = compilation.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进', entryState: state, goal: '找线索', obstacle: '锁门', choice: '绕路', cost: '时间', turn: '脚印', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      await recordStoryCompilerWrite({ ...f, chapterId: f.chapterId, chapterOrderIndex: 1, chapterRevision: 1 })
      await validateStoryContinuity({ ...f, compilationId, findings: [], expectedChapterRevision: 1, independentCheck: 'complete' })
      const ctx: ToolContext = { ...f, callId: 'quality', mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
      if (scenario === 'quality-provider-failure' || scenario === 'continuity-provider-failure') {
        const error = new DataAccessError(402, 'CREDITS_EXHAUSTED', 'fixture credit gate')
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockRejectedValue(error)
        // An explicit focus requests an independent check instead of reusing the fixture's valid baseline.
        const action = scenario === 'quality-provider-failure'
          ? qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })
          : continuityValidateTool.execute(ctx, { compilationId, focus: '额外检查' })
        await expect(action).rejects.toBe(error)
        expect(model).toHaveBeenCalledTimes(1)
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(0)
        return
      }
      if (scenario === 'quality-timeout-fallback') {
        // 每次调用硬超时(env.aiTextTimeoutMs)触发时 AbortSignal.timeout 抛 TimeoutError(非 DataAccessError)：
        // critic 不能让整次检查失败，而应降级为确定性兜底并交付报告(count=1)，根治“挂起→分析不出”。
        const timeout = new DOMException('The operation timed out.', 'TimeoutError')
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockRejectedValue(timeout)
        expect(await qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })).toMatchObject({ outcome: 'failed' })
        expect(model).toHaveBeenCalledTimes(1)
        expect((await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId } })).status).toBe('failed')
        return
      }
      if (scenario.startsWith('evidence-')) {
        if (scenario === 'evidence-ambiguous') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '原文原文' } })
        const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        const finding = { signal: 'emotion_grounding', severity: 'warning', quote: '原...文', explanation: '缺少动作', suggestion: '局部调整', confidence: 0.9 }
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockResolvedValueOnce(JSON.stringify({ findings: [finding] }))
        if (scenario === 'evidence-credit-failure') model.mockRejectedValueOnce(new DataAccessError(402, 'CREDITS_EXHAUSTED', 'fixture credit gate'))
        else model.mockResolvedValueOnce(JSON.stringify({ corrections: scenario === 'evidence-unresolved' ? [] : [{ index: 0, quote: '原文' }] }))
        const action = qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })
        if (scenario === 'evidence-credit-failure') await expect(action).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
        else if (scenario === 'evidence-corrected') expect(await action).not.toHaveProperty('outcome')
        else expect(await action).toMatchObject({ outcome: 'failed', summary: '质量证据定位未完成' })
        expect(model).toHaveBeenCalledTimes(2)
        expect(model.mock.calls[1][2].action).toBe('agent3HumanityEvidenceCorrection')
        const saved = await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId }, include: { findings: true } })
        expect(saved.status).toBe(scenario === 'evidence-corrected' ? 'needs_repair' : 'failed')
        if (scenario === 'evidence-corrected') expect(saved.findings[0]).toMatchObject({ evidenceExcerpt: '原文', explanation: finding.explanation, suggestion: finding.suggestion })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: before.content, revision: before.revision })
        return
      }
      if (scenario === 'tool-fallback') {
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockResolvedValueOnce('{}').mockResolvedValueOnce('{"findings":[]}')
        expect(await qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })).toMatchObject({ outcome: 'failed' })
        expect((await prisma.chapterQualityReport.findFirstOrThrow({ where: { chapterId: f.chapterId } })).status).toBe('failed')
        expect(await qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId })).not.toHaveProperty('outcome')
        expect(model).toHaveBeenCalledTimes(2)
        return
      }
      const repairs = ['repair', 'repair-rollback', 'no-op', 'empty', 'concurrent', 'outer-transaction', 'outer-rollback'].includes(scenario)
      if (scenario === 'ambiguous') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '原文原文' } })
      const input = { ...f, compilationId, chapterId: f.chapterId, chapterRevision: 1, mode: 'balanced' as const, deterministicMetrics: {}, deterministicFindings: [],
        criticComplete: scenario !== 'unavailable', criticFindings: repairs || scenario === 'unlocated' || scenario === 'ambiguous'
          ? [{ signal: 'emotion_grounding' as const, severity: 'warning' as const, quote: scenario === 'unlocated' ? '不在正文里' : '原文', explanation: '缺少具体动作', suggestion: '局部调整', confidence: 0.9 }] : [] }
      if (scenario === 'report-rollback') {
        await expect(prisma.$transaction(async tx => { await persistHumanityQualityReport(input, tx); throw new Error('fixture report rollback') })).rejects.toThrow('fixture report rollback')
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(0)
        return
      }
      if (scenario === 'stale-source') {
        await expect(prisma.$transaction(async tx => {
          await tx.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, content: '新正文' } })
          await persistHumanityQualityReport(input, tx)
        })).rejects.toMatchObject({ code: 'QUALITY_SOURCE_STALE' })
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(0)
        return
      }
      if (scenario === 'wrong-compilation') {
        const model = vi.spyOn(aiService, 'generateTextCompletion').mockResolvedValue('{"findings":[]}')
        expect(await qualityAnalyzeTool.execute(ctx, { chapterId: f.chapterId, compilationId: randomUUID() })).toMatchObject({ outcome: 'failed' })
        expect(model).not.toHaveBeenCalled()
        expect(await chapterBridgeCommitTool.execute(ctx, { compilationId: randomUUID() })).toMatchObject({ outcome: 'failed' })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('active')
        return
      }
      if (scenario === 'foreign-run') {
        const other = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', engine: 'loop' } })
        expect((await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, other.id)).compilation).toBeNull()
        await expect(persistHumanityQualityReport({ ...input, runId: other.id })).rejects.toMatchObject({ code: 'QUALITY_COMPILATION_SCOPE_INVALID' })
        expect(await chapterBridgeCommitTool.execute({ ...ctx, runId: other.id }, { compilationId })).toMatchObject({ outcome: 'failed' })
        return
      }
      if (scenario === 'outer-transaction' || scenario === 'outer-rollback') {
        const write = prisma.$transaction(async tx => {
          const report = await persistHumanityQualityReport(input, tx)
          await applyQualityRepair({ ...f, reportId: report.id, replacements: [{ findingId: report.findings[0].id, replacement: '安全改写'.repeat(30) }] }, tx)
          if (scenario === 'outer-rollback') throw new Error('outer effect receipt failed')
        })
        if (scenario === 'outer-rollback') await expect(write).rejects.toThrow('outer effect receipt failed')
        else await write
        const expected = scenario === 'outer-rollback' ? 0 : 1
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId } })).toBe(expected)
        expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'rewriteSelection' } })).toBe(expected)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision).toBe(1 + expected)
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBe(1 + expected)
        if (!expected) expect(await prisma.leakageCheck.count({ where: { runId: f.runId } })).toBe(0)
        return
      }
      const report = await persistHumanityQualityReport(input)
      const terminal = { userId: f.userId, novelId: f.novelId, compilationId, chapterSummary: '摘要', exitState: state, lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '脚印', requireQuality: true, qualityReportId: report.id }
      if (scenario === 'legacy-report' || scenario === 'hash-mismatch') {
        if (scenario === 'legacy-report') await prisma.chapterQualityReport.update({ where: { id: report.id }, data: { deterministicMetrics: {} } })
        else await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '内容变化但旧版本号未更新' } })
        await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
        return
      }
      if (['unavailable', 'unlocated', 'ambiguous'].includes(scenario)) {
        expect(report.status).toBe('failed')
        await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
        return
      }
      if (scenario === 'complete') {
        expect(report.status).toBe('passed')
        expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 1 })
        return
      }
      const replacement = { findingId: report.findings[0].id, replacement: scenario === 'no-op' ? '原文' : '新文' }
      const repairInput = { userId: f.userId, novelId: f.novelId, runId: f.runId, reportId: report.id, replacements: scenario === 'empty' ? [] : [replacement] }
      if (['repair-rollback', 'no-op', 'empty'].includes(scenario)) {
        if (scenario === 'repair-rollback') {
          vi.spyOn(writingExperiments, 'recordWritingSignal').mockRejectedValueOnce(new Error('fixture quality rollback after effects'))
          await expect(applyQualityRepair(repairInput)).rejects.toThrow('fixture quality rollback after effects')
          expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'rewriteSelection' } })).toBe(0)
        } else await expect(applyQualityRepair(repairInput)).rejects.toMatchObject({ code: 'QUALITY_REPAIR_NO_CHANGE' })
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
        expect(await getQualityReport(f.userId, f.novelId, report.id)).toMatchObject({ repairRound: 0, chapterRevision: 1, findings: [{ disposition: 'pending' }] })
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBe(1)
        return
      }
      if (scenario === 'concurrent') {
        const results = await Promise.allSettled([applyQualityRepair(repairInput), applyQualityRepair(repairInput)])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      } else await applyQualityRepair(repairInput)
      expect(await getQualityReport(f.userId, f.novelId, report.id)).toMatchObject({ repairRound: 1, chapterRevision: 2, status: 'repaired' })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toMatchObject({ checkedRevision: 1 })
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBe(2)
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'rewriteSelection' } })).toBe(1)
      await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
      await validateStoryContinuity({ ...f, compilationId, findings: [], expectedChapterRevision: 2, independentCheck: 'complete' })
      expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 2 })
    })
  })
})

describe.runIf(available)('durable quality actual tool chain', () => {
  it.each(['success', 'repair', 'evidence-corrected', 'evidence-unresolved', 'format', 'truncated', 'format-retry', 'unknown', 'stale-chapter', 'stale-compiler', 'rollback-resume', 'late-resume', 'protected', 'missing', 'long', 'repair-stale', 'stale-source', 'approval-denied', 'standalone', 'context-change', 'full-chain'] as const)('%s preserves paid results and atomic business effects', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      let lease = await claim(f)
      const before = scenario === 'long' ? '开头锚点' + '长正文'.repeat(6000) + '末尾锚点' : '原文'
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: before, wordCount: before.length } })
      let sourceId: string | undefined
      if (scenario === 'stale-source') {
        const current = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2 } })
        sourceId = (await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: current.volumeId, title: '前章', content: '前文', wordCount: 2, orderIndex: 1, orderInVolume: 1 } })).id
      }
      const compilation = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查本章' })
      const compilationId = compilation.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const tools = [chapterBridgeGetTool, chapterReadTool, qualityAnalyzeTool, continuityValidateTool, chapterBridgeCommitTool]
      const calls = [{ id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) }, { id: 'check', name: 'quality_analyze', arguments: JSON.stringify({ compilationId }) }]
      if (scenario === 'success' || scenario === 'repair' || scenario === 'context-change') calls.push({ id: 'cached', name: 'quality_analyze', arguments: JSON.stringify({ compilationId }) })
      if (scenario === 'standalone') {
        await prisma.storyCompilation.delete({ where: { id: compilationId } })
        calls[0] = { id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) }
        calls[1].arguments = JSON.stringify({ chapterId: f.chapterId })
      }
      if (scenario === 'full-chain') calls.push({ id: 'continuity', name: 'continuity_validate', arguments: JSON.stringify({ compilationId }) }, { id: 'commit', name: 'chapter_bridge_commit', arguments: JSON.stringify({ compilationId }) })
      if (scenario === 'missing') calls.shift()
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval-denied' && tool.name === 'quality_analyze' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '完整检查本章' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'low', reasoningEfforts: ['low'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'quality-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      const repairing = ['repair', 'format-retry', 'rollback-resume', 'repair-stale'].includes(scenario)
      let requests = 0
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        const body = JSON.parse(String(init.body))
        expect(body.max_tokens).toBe(16_384)
        expect(body.tools).toBeUndefined()
        expect(body.messages.map((item: { role: string }) => item.role)).toEqual(['system', 'user'])
        if (scenario === 'long') { expect(body.messages[1].content).toContain('开头锚点'); expect(body.messages[1].content).toContain('末尾锚点'); expect(body.messages[1].content).toContain(before) }
        if (scenario === 'unknown') throw new Error('fixture unknown critic')
        if (scenario === 'stale-chapter' || scenario === 'repair-stale' && requests === 2) await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户新文', revision: { increment: 1 } } })
        if (sourceId) await prisma.chapter.update({ where: { id: sourceId }, data: { content: '新的前文', revision: { increment: 1 } } })
        if (scenario === 'stale-compiler') await prisma.storyCompilation.update({ where: { id: compilationId }, data: { preparedContext: { changed: true } } })
        if (scenario === 'late-resume') await pauseDurableTask(f.userId, lease.runId)
        const content = scenario === 'evidence-corrected' || scenario === 'evidence-unresolved'
          ? requests === 1
            ? JSON.stringify({ findings: [{ signal: 'emotion_grounding', severity: 'advisory', quote: '错误引用', explanation: '需要更具体动作', suggestion: '保留待审', confidence: 0.9 }] })
            : JSON.stringify({ corrections: [{ index: 0, quote: scenario === 'evidence-corrected' ? '原文' : '仍不存在' }] })
          : scenario === 'context-change' || scenario === 'full-chain' ? '{"findings":[]}' : scenario === 'format' || scenario === 'format-retry' && requests === 2 ? 'broken JSON'
          : requests === 1 ? JSON.stringify({ findings: repairing || scenario === 'protected' ? [{ signal: 'emotion_grounding', severity: 'warning', quote: '原文', explanation: '缺少动作', suggestion: '改成新文', confidence: 0.9 }] : [] })
          : '{"patches":[{"key":"emotion_grounding:0:2","replacement":"新文"}]}'
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: scenario === 'truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario !== 'missing') await step()
      if (scenario === 'approval-denied') {
        const waiting = await step()
        if (waiting.kind !== 'waiting_approval') throw new Error('Expected approval')
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'check', approved: false, alwaysAllow: false })
        runtime.mockRejectedValue(new Error('Denied tool must not resolve model configuration'))
        expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(fetchMock).not.toHaveBeenCalled()
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      if (scenario === 'rollback-resume') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, digest, work) => original(token, id, digest, async tx => { await work(tx); throw new Error('fixture quality rollback') }))
        await expect(step()).rejects.toThrow('fixture quality rollback')
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(before)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'quality_analyze' } } })).toBe(0)
        await pauseDurableTask(f.userId, lease.runId)
      }
      if (scenario === 'late-resume') await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      if (scenario === 'late-resume' || scenario === 'rollback-resume') {
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'quality-resume')
        runtime.mockRejectedValue(new Error('Must replay without resolving current model configuration'))
      }
      if (scenario === 'unknown') {
        await expect(step()).rejects.toThrow('fixture unknown critic')
        await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      const result = await step()
      const failed = ['evidence-unresolved', 'format', 'truncated', 'stale-chapter', 'stale-compiler', 'missing', 'repair-stale', 'stale-source'].includes(scenario)
      expect(result).toMatchObject({ kind: 'tool', result: failed ? { outcome: 'failed' } : { summary: expect.stringContaining('质量检查') } })
      if (scenario === 'context-change') { await prisma.novel.update({ where: { id: f.novelId }, data: { categoryName: '新的题材边界' } }); expect(await step()).toMatchObject({ result: { summary: '人类感质量检查' } }) }
      if (scenario === 'success' || scenario === 'repair') expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('复用') } })
      if (scenario === 'full-chain') {
        expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('连续性检查') } })
        expect(await step()).toMatchObject({ result: { summary: '提交章节桥与故事终态' } })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('completed')
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(2)
      }
      const expectedRequests = scenario === 'missing' ? 0 : scenario === 'format-retry' ? 3 : ['context-change', 'full-chain', 'evidence-corrected', 'evidence-unresolved'].includes(scenario) ? 2 : repairing ? 2 : 1
      expect(fetchMock).toHaveBeenCalledTimes(expectedRequests)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(expectedRequests)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(chapter.content).toBe(scenario === 'stale-chapter' || scenario === 'repair-stale' ? '用户新文' : repairing ? '新文' : before)
      if (scenario === 'standalone') {
        expect(await prisma.chapterQualityReport.count({ where: { chapterId: f.chapterId, compilationId: null } })).toBe(1)
        return
      }
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
      const reports = await prisma.chapterQualityReport.findMany({ where: { chapterId: f.chapterId } })
      if (['missing', 'stale-chapter', 'stale-compiler', 'repair-stale', 'stale-source'].includes(scenario)) expect(reports).toHaveLength(0)
      else {
        expect(reports).toHaveLength(scenario === 'context-change' ? 2 : 1)
        expect(reports[0]).toMatchObject({ chapterRevision: repairing ? 2 : 1, status: failed ? 'failed' : repairing ? 'repaired' : scenario === 'protected' ? 'needs_repair' : 'passed' })
      }
      if (repairing && scenario !== 'repair-stale') {
        expect(chapter.revision).toBe(2)
        expect(saved.stage).toBe('repair')
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBe(2)
      }
      const events = await publishDurableEvents(f.userId, lease.runId)
      expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'quality_analyze')).toMatchObject(['success', 'repair', 'context-change'].includes(scenario) ? [{ ok: true }, { ok: true }] : [{ ok: !failed }])
    })
  })
})

describe.runIf(available)('durable continuity actual tool chain', () => {
  it.each(['success', 'repair', 'fused-repair', 'format', 'truncated', 'format-retry', 'unknown', 'stale-chapter', 'stale-compiler', 'rollback-resume', 'late-resume', 'protected', 'missing', 'long', 'repair-stale', 'stale-source', 'approval-denied'] as const)('%s preserves paid results and atomic business effects', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      let lease = await claim(f)
      const before = scenario === 'long' ? '开头锚点' + '长正文'.repeat(6000) + '末尾锚点' : '原文'
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: before, wordCount: before.length } })
      let sourceId: string | undefined
      if (scenario === 'stale-source') {
        const current = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 2, orderInVolume: 2 } })
        sourceId = (await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: current.volumeId, title: '前章', content: '前文', wordCount: 2, orderIndex: 1, orderInVolume: 1 } })).id
      }
      const compilation = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查本章' })
      const compilationId = compilation.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const tools = [chapterBridgeGetTool, continuityValidateTool]
      const calls = [{ id: 'bridge', name: 'chapter_bridge_get', arguments: JSON.stringify({ compilationId }) }, { id: 'check', name: 'continuity_validate', arguments: JSON.stringify({ compilationId }) }]
      if (scenario === 'success') calls.push({ id: 'cached', name: 'continuity_validate', arguments: JSON.stringify({ compilationId }) })
      if (scenario === 'missing') calls.shift()
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval-denied' && tool.name === 'continuity_validate' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '完整检查本章' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'low', reasoningEfforts: ['low'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'continuity-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      const repairing = ['repair', 'fused-repair', 'format-retry', 'rollback-resume', 'repair-stale'].includes(scenario)
      let requests = 0
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        const body = JSON.parse(String(init.body))
        expect(body.max_tokens).toBe(16_384)
        expect(body.tools).toBeUndefined()
        expect(body.messages.map((item: { role: string }) => item.role)).toEqual(['system', 'user'])
        if (scenario === 'long') { expect(body.messages[1].content).toContain('开头锚点'); expect(body.messages[1].content).toContain('末尾锚点'); expect(body.messages[1].content).toContain(before) }
        if (scenario === 'unknown') throw new Error('fixture unknown critic')
        if (scenario === 'stale-chapter' || scenario === 'repair-stale' && requests === 2) await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户新文', revision: { increment: 1 } } })
        if (sourceId) await prisma.chapter.update({ where: { id: sourceId }, data: { content: '新的前文', revision: { increment: 1 } } })
        if (scenario === 'stale-compiler') await prisma.storyCompilation.update({ where: { id: compilationId }, data: { preparedContext: { changed: true } } })
        if (scenario === 'late-resume') await pauseDurableTask(f.userId, lease.runId)
        const content = scenario === 'fused-repair' ? '{"findings":[{"signal":"body","severity":"error","evidence":"原文存在冲突","suggestion":"局部修订"}],"patches":[{"oldText":"原文","newText":"新文"}]}'
          : scenario === 'format' || scenario === 'format-retry' && requests === 2 ? 'broken JSON'
          : requests === 1 ? JSON.stringify({ findings: repairing || scenario === 'protected' ? [{ signal: 'body', severity: 'error', evidence: '原文有身体状态冲突', suggestion: '改成新文' }] : [] })
          : '{"patches":[{"oldText":"原文","newText":"新文"}]}'
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: scenario === 'truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario !== 'missing') await step()
      if (scenario === 'approval-denied') {
        const waiting = await step()
        if (waiting.kind !== 'waiting_approval') throw new Error('Expected approval')
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'check', approved: false, alwaysAllow: false })
        runtime.mockRejectedValue(new Error('Denied tool must not resolve model configuration'))
        expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(fetchMock).not.toHaveBeenCalled()
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      if (scenario === 'rollback-resume') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, digest, work) => original(token, id, digest, async tx => { await work(tx); throw new Error('fixture continuity rollback') }))
        await expect(step()).rejects.toThrow('fixture continuity rollback')
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(before)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'continuity_validate' } } })).toBe(0)
        await pauseDurableTask(f.userId, lease.runId)
      }
      if (scenario === 'late-resume') await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      if (scenario === 'late-resume' || scenario === 'rollback-resume') {
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'continuity-resume')
        runtime.mockRejectedValue(new Error('Must replay without resolving current model configuration'))
      }
      if (scenario === 'unknown') {
        await expect(step()).rejects.toThrow('fixture unknown critic')
        await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      const result = await step()
      const failed = ['format', 'truncated', 'stale-chapter', 'stale-compiler', 'missing', 'repair-stale', 'stale-source'].includes(scenario)
      expect(result).toMatchObject({ kind: 'tool', result: failed ? { outcome: 'failed' } : { summary: expect.stringContaining('连续性检查') } })
      if (scenario === 'success') expect(await step()).toMatchObject({ result: { summary: expect.stringContaining('复用') } })
      const expectedRequests = scenario === 'missing' ? 0 : scenario === 'fused-repair' ? 1 : scenario === 'format-retry' ? 3 : repairing ? 2 : 1
      expect(fetchMock).toHaveBeenCalledTimes(expectedRequests)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(expectedRequests)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(chapter.content).toBe(scenario === 'stale-chapter' || scenario === 'repair-stale' ? '用户新文' : repairing ? '新文' : before)
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
      if (['missing', 'stale-chapter', 'stale-compiler', 'repair-stale', 'stale-source'].includes(scenario)) expect(saved.validation).toBeNull()
      else expect(saved.validation).toMatchObject({ checkedRevision: 1, independentCheck: failed ? 'unavailable' : 'complete', coverage: { charCount: before.length, contentHash: runtimeJson({ content: before }).hash } })
      if (repairing && scenario !== 'repair-stale') {
        expect(chapter.revision).toBe(2)
        expect(saved.stage).toBe('repair')
        expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).targetRevision).toBe(2)
      }
      const events = await publishDurableEvents(f.userId, lease.runId)
      expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'continuity_validate')).toMatchObject(scenario === 'success' ? [{ ok: true }, { ok: true }] : [{ ok: !failed }])
    })
  })
  it('applies only unique nonoverlapping anchors from original content', () => {
    expect(applyContinuityPatches('原文尾部', [{ oldText: '原文', newText: '新文' }, { oldText: '新文', newText: '注入文本' }, { oldText: '文尾', newText: '重叠' }, { oldText: '尾部', newText: '结尾' }])).toEqual({ after: '新文结尾', applied: 2 })
    expect(applyContinuityPatches('aaaa', [{ oldText: 'aaa', newText: 'x' }])).toEqual({ after: 'aaaa', applied: 0 })
  })
})

describe.runIf(available).each(['continuity', 'quality', 'quality-evidence'] as const)('auxiliary model durable admission %s', family => {
  const tool = family !== 'continuity' ? qualityAnalyzeTool : continuityValidateTool
  const criticStep = family !== 'continuity' ? 'quality_critic' : 'continuity_critic'
  const repairStep = family === 'quality-evidence' ? 'quality_evidence_correction' : family !== 'continuity' ? 'quality_repair' : 'continuity_repair'
  const retryStep = family === 'quality-evidence' ? 'quality_evidence_correction' : family !== 'continuity' ? 'quality_repair_retry' : 'continuity_repair_retry'
  it.each(['replay', 'policy-denied', 'stop-resume', 'unknown', 'changed-input', 'wrong-attempt', 'wrong-step', 'skip-critic', 'damaged-prerequisite', 'ordered-repair', 'tools-leak', 'history-leak', 'late-result', 'concurrent', 'missing-result-event', 'cross-family'] as const)('%s binds paid work to the original pending tool', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: '', parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '检查本章' }, { role: 'assistant', content: null, toolCalls: [{ id: 'critic-call', name: tool.name, arguments: '{}' }] }], successfulToolSignatures: [] } })
      const parent = await prepareToolCursorOperation(lease, { expectedRevision: 0, expectedHash: initial.frame.snapshotHash }, {
        key: 'exec:0', action: tool.name, callId: 'critic-call', targetId: f.chapterId, effectDomain: 'chapter',
        operationInput: { callId: 'critic-call', args: {} }, effectiveArgs: {}, normalize: parsed => tool.parameters.parse(parsed),
      })
      const price: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'aux-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
      const request = (step: import('../../api/lib/agent/runtime-auxiliary-model.js').AuxiliaryModelStep = criticStep) => ({
        messages: [{ role: 'user' as const, content: '独立检查原文' }] as import('../../api/lib/ai-service.js').ChatMessage[], tools: [] as import('../../api/lib/ai-service.js').OpenAIToolDefinition[], model: 'fixture', provider: 'fixture',
        providerApiKey: 'fixture-not-real', providerBaseUrl: 'https://provider.invalid/v1',
        durableExecution: { lease, operationKey: `aux:${parent.operation.id}:${step}`, parentOperationId: parent.operation.id, auxiliaryStep: step, attemptKey: '1', price },
        usageLog: { userId: f.userId, agentRunId: lease.runId, action: step, modelTier: 'speed' as const },
      })
      const fetchMock = vi.fn(async () => {
        if (scenario === 'unknown') throw new Error('fixture lost response')
        if (scenario === 'late-result') await pauseDurableTask(f.userId, lease.runId)
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      if (scenario === 'policy-denied') {
        await prisma.agentSession.update({ where: { id: f.sessionId }, data: { sandboxMode: 'read_only' } })
        await expect(chatWithTools(request())).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { parentOperationId: parent.operation.id }, dispatchedAt: { not: null } } })).toBe(0)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
        return
      }
      if (scenario === 'wrong-attempt' || scenario === 'wrong-step' || scenario === 'skip-critic' || scenario === 'tools-leak' || scenario === 'history-leak' || scenario === 'cross-family') {
        const invalid = request(scenario === 'cross-family' ? (family !== 'continuity' ? 'continuity_critic' : 'quality_critic') : scenario === 'skip-critic' ? repairStep : criticStep)
        if (scenario === 'wrong-attempt') invalid.durableExecution.attemptKey = '2'
        if (scenario === 'wrong-step') invalid.durableExecution.operationKey += '-other'
        if (scenario === 'tools-leak') invalid.tools = [{ type: 'function', function: { name: 'chapter_write', description: '', parameters: {} } }]
        if (scenario === 'history-leak') invalid.messages.push({ role: 'assistant', content: '从旧章节继续' })
        await expect(chatWithTools(invalid)).rejects.toMatchObject({ code: scenario === 'skip-critic' ? 'RUNTIME_RECONCILIATION_REQUIRED' : 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await prisma.agentOperation.count({ where: { parentOperationId: parent.operation.id } })).toBe(0)
        return
      }
      if (scenario === 'unknown') {
        await expect(chatWithTools(request())).rejects.toThrow('fixture lost response')
        await expect(chatWithTools(request())).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        await expect(chatWithTools(request(repairStep))).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
        return
      }
      if (scenario === 'concurrent') {
        const results = await Promise.allSettled([chatWithTools(request()), chatWithTools(request())])
        expect(results.some(item => item.status === 'fulfilled')).toBe(true)
        for (const item of results) if (item.status === 'rejected') expect(item.reason).toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      } else if (scenario === 'late-result') {
        await expect(chatWithTools(request())).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
        expect(await prisma.agentProviderAttempt.findFirst({ where: { operation: { parentOperationId: parent.operation.id } } })).toMatchObject({ status: 'succeeded' })
      } else expect(await chatWithTools(request())).toMatchObject({ content: '{"findings":[]}', billing: { status: 'settled', chargedMilli: 1 } })
      if (scenario === 'stop-resume' || scenario === 'late-result') {
        const oldRequest = request()
        if (scenario === 'stop-resume') await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'worker-b')
        await expect(chatWithTools(oldRequest)).rejects.toThrow()
      }
      if (scenario === 'changed-input') {
        const changed = request(); changed.messages[0].content = '改用另一章'
        await expect(chatWithTools(changed)).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      }
      if (scenario === 'damaged-prerequisite' || scenario === 'missing-result-event') {
        const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { parentOperationId: parent.operation.id } } })
        if (scenario === 'damaged-prerequisite') await prisma.agentProviderAttempt.update({ where: { id: attempt.id }, data: { resultHash: '0'.repeat(64) } })
        else {
          await prisma.agentExecutionOutbox.delete({ where: { eventKey: `result:${attempt.id}:${attempt.resultHash}` } })
          await expect(chatWithTools(request())).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        }
        await expect(chatWithTools(request(repairStep))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      } else {
        expect(await chatWithTools(request())).toMatchObject({ content: '{"findings":[]}', billing: { chargedMilli: 1 } })
        if (scenario === 'ordered-repair') {
          await chatWithTools(request(repairStep))
          await chatWithTools(request(retryStep))
          await chatWithTools(request(retryStep))
        }
      }
      const count = scenario === 'ordered-repair' ? (family === 'quality-evidence' ? 2 : 3) : 1
      expect(fetchMock).toHaveBeenCalledTimes(count)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(count)
      expect(await readTaskBudget(lease)).toMatchObject({ usedTokens: BigInt(10 * count), attempts: BigInt(count), unresolvedAttempts: 0n })
      expect((await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId: f.userId } })).metadata).toMatchObject({ pricingVersion: 'credits-v2-itemized', rateCardId: 'aux-fixture' })
      const saved = await loadExecutionState(f.userId, lease.runId)
      expect(saved.frame.revision).toBe(parent.pending.revision)
      expect(saved.frame.state).toMatchObject({ phase: 'awaiting_operation', pendingOperationId: parent.operation.id, turn: 0 })
    })
  })
})

describe.runIf(available)('continuity validation and atomic commit', () => {
  it('fuses safe repairs into one critic request, still requires full revised-text verification, and reuses that result', async () => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      const prepared = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '检查当前章节' })
      const compilationId = prepared.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const completion = vi.spyOn(aiService, 'generateTextCompletion').mockResolvedValueOnce('{"findings":[{"signal":"body","severity":"error","evidence":"原文存在冲突","suggestion":"局部修订"}],"patches":[{"oldText":"原文","newText":"修订正文"}]}')
        .mockResolvedValueOnce('{"findings":[]}')
      const ctx: ToolContext = { ...f, callId: 'critic', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
      expect(await continuityValidateTool.execute(ctx, { compilationId })).toMatchObject({ summary: '连续性检查 · 自动修订 1 处' })
      expect(completion).toHaveBeenCalledTimes(1)
      expect(completion.mock.calls[0][2]).toMatchObject({ maxOutputTokens: 16_384, reasoningEffort: 'low' })
      const updated = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
      expect(saved.validation).toMatchObject({ checkedRevision: updated.revision - 1 })
      expect(await continuityValidateTool.execute(ctx, { compilationId })).toMatchObject({ summary: '连续性检查 · 0 错误 0 警告' })
      expect(completion.mock.calls[1][2]).toMatchObject({ maxOutputTokens: 16_384, reasoningEffort: 'low' })
      expect(completion).toHaveBeenCalledTimes(2)
      expect(completion.mock.calls[1][1]).toContain(updated.content)
      expect(completion.mock.calls[1][1]).toContain('本次只读复核')
      expect(completion.mock.calls[1][2].reasoningEffort).toBe('low')
      await continuityValidateTool.execute(ctx, { compilationId })
      expect(completion).toHaveBeenCalledTimes(2)
    })
  })
  it.each(['unavailable', 'stale-critic', 'stale-commit', 'source-commit', 'commit-rollback', 'commit', 'tool-unavailable', 'tool-stale', 'repair-race'] as const)('%s never certifies another revision or partially commits memory', async scenario => {
    await fixture(async f => {
      const first = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const targetId = scenario === 'source-commit' ? (await prisma.chapter.create({ data: { novelId: f.novelId, authorId: f.userId, volumeId: first.volumeId,
        orderIndex: 2, orderInVolume: 2, title: '待提交的新章', content: '原文', wordCount: 2 } })).id : f.chapterId
      const prepared = await prepareStoryCompilation({ ...f, chapterId: targetId, mode: 'balanced', intentSummary: '检查当前章节' })
      const compilationId = prepared.compilation.id
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f, compilationId, tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const terminal = { userId: f.userId, novelId: f.novelId, compilationId, chapterSummary: '章节摘要', exitState: state,
        lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '发现线索' }
      const changeChapter = () => prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户修改', revision: { increment: 1 } } })
      if (scenario.startsWith('tool-') || scenario === 'repair-race') {
        let calls = 0
        vi.spyOn(aiService, 'generateTextCompletion').mockImplementation(async () => {
          calls++
          if (scenario === 'tool-unavailable') return 'not JSON'
          if (scenario === 'tool-stale') { await changeChapter(); return '{"findings":[]}' }
          if (calls === 1) return '{"findings":[{"signal":"body","severity":"error","evidence":"原文存在冲突","suggestion":"局部修订"}]}'
          await changeChapter()
          return '{"patches":[{"oldText":"原文","newText":"模型修改"}]}'
        })
        const ctx: ToolContext = { ...f, callId: 'critic', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
        const check = continuityValidateTool.execute(ctx, { compilationId })
        if (scenario === 'tool-unavailable') expect(await check).toMatchObject({ outcome: 'failed', summary: '独立连续性复核未完成' })
        else {
          await expect(check).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
          expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('用户修改')
        }
        await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
        return
      }
      if (scenario === 'stale-critic') await changeChapter()
      const check = validateStoryContinuity({ ...f, compilationId, findings: [], expectedChapterRevision: 1, independentCheck: scenario === 'unavailable' ? 'unavailable' : 'complete' })
      if (scenario === 'stale-critic') {
        await expect(check).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).validation).toBeNull()
        return
      }
      await check
      if (scenario === 'stale-commit') await changeChapter()
      if (scenario === 'source-commit') await changeChapter()
      if (scenario === 'unavailable' || scenario === 'stale-commit' || scenario === 'source-commit') {
        await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
      } else if (scenario === 'commit-rollback') {
        await expect(prisma.$transaction(async tx => { await commitChapterBridge(terminal, tx); throw new Error('fixture-commit-rollback') })).rejects.toThrow('fixture-commit-rollback')
      } else {
        expect(await commitChapterBridge(terminal)).toMatchObject({ compilationId, chapterRevision: 1 })
        expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(2)
        expect(await prisma.memoryEvidence.count({ where: { memory: { novelId: f.novelId } } })).toBe(2)
        return
      }
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })).status).toBe('active')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId } })).committedAt).toBeNull()
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
      expect(await prisma.sceneTask.count({ where: { compilationId, status: 'completed' } })).toBe(0)
    })
  })
})

describe.runIf(available)('durable compiler dispatch', () => {
  it.each(['chain', 'resume', 'prepare-gap', 'scene-gap', 'replay', 'stale', 'foreign', 'missing', 'approval-denied', 'commit', 'commit-gap', 'commit-no-quality', 'commit-stale'] as const)('%s preserves compilation identity and atomic effects', async scenario => {
    await fixture(async f => {
      vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      let lease = await claim(f)
      const prepareArgs = { chapterId: f.chapterId, intentSummary: '先准备本章，然后构建场景并写入' }
      let foreignId: string | undefined
      if (scenario === 'foreign') {
        const otherSession = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '其他任务' } })
        const other = await prisma.agentRun.create({ data: { sessionId: otherSession.id, userId: f.userId, novelId: f.novelId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', engine: 'loop' } })
        foreignId = (await prepareStoryCompilation({ ...f, runId: other.id, mode: 'balanced', intentSummary: '其他任务' })).compilation.id
      }
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      const sceneArgs = { ...(foreignId ? { compilationId: foreignId } : {}), tasks: [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] }
      const tools = [storyCompilerPrepareTool, sceneTaskBuildTool, chapterBridgeGetTool, chapterReadTool, chapterWriteTool, chapterBridgeCommitTool]
      const calls = [...(scenario === 'missing' ? [] : [{ id: 'prepare', name: 'story_compiler_prepare', arguments: JSON.stringify(prepareArgs) }]),
        { id: 'scene', name: 'scene_task_build', arguments: JSON.stringify(sceneArgs) },
        { id: 'bridge', name: 'chapter_bridge_get', arguments: '{}' },
        ...(scenario === 'stale' ? [{ id: 'scene-after-read', name: 'scene_task_build', arguments: JSON.stringify(sceneArgs) }] : []),
        { id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
        { id: 'write', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '他绕过锁门，在墙根发现了脚印。' }) },
        ...(scenario.startsWith('commit') ? [{ id: 'refresh', name: 'chapter_bridge_get', arguments: '{}' }, { id: 'commit', name: 'chapter_bridge_commit', arguments: '{}' }, { id: 'commit-again', name: 'chapter_bridge_commit', arguments: '{}' }] : [])]
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval-denied' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '准备本章并写入' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      if (scenario === 'approval-denied') {
        const waiting = await step()
        if (waiting.kind !== 'waiting_approval') throw new Error('Expected approval')
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'prepare', approved: false, alwaysAllow: false })
        expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(0)
        return
      }
      const injectRollback = () => {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => { await work(tx); throw new Error('fixture-compiler-rollback') }))
      }
      if (scenario === 'prepare-gap') {
        injectRollback()
        await expect(step()).rejects.toThrow('fixture-compiler-rollback')
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(0)
      }
      const prepared = await step()
      if (scenario === 'missing') {
        expect(prepared).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(await prisma.sceneTask.count({ where: { novelId: f.novelId } })).toBe(0)
        return
      }
      if (prepared.kind !== 'tool' || prepared.result.display?.kind !== 'storyCompiler') throw new Error('Expected compilation')
      const id = prepared.result.display.compilationId!
      if (scenario === 'replay') {
        const tool: AgentTool = { ...storyCompilerPrepareTool, execute: (ctx, args) => storyCompilerPrepareTool.execute(ctx, storyCompilerPrepareTool.parameters.parse(args)) }
        const ctx: ToolContext = { ...f, mode: 'build', callId: 'prepare', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {},
          durableCompiler: { lease, cursor: { expectedRevision: 0, expectedHash: initialized.frame.snapshotHash }, operationKey: 'exec:0', baseline: null } }
        expect(await executeDurableCompiler(ctx, tool, prepareArgs)).toEqual(prepared.result)
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(1)
      }
      if (scenario === 'resume') {
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'scene-resume-worker')
      }
      if (scenario === 'stale') await prisma.storyCompilation.update({ where: { id }, data: { preparedContext: { changed: true } } })
      if (scenario === 'scene-gap') {
        injectRollback()
        await expect(step()).rejects.toThrow('fixture-compiler-rollback')
        expect(await prisma.sceneTask.count({ where: { compilationId: id } })).toBe(0)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id } })).stage).toBe('prepare')
      }
      const scenes = await step()
      if (scenario === 'stale' || scenario === 'foreign') {
        expect(scenes).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(await prisma.sceneTask.count({ where: { novelId: f.novelId } })).toBe(0)
        if (scenario === 'foreign') return
        await step() // Refresh the exact original compilation, not another task.
        expect(await step()).toMatchObject({ kind: 'tool', result: { display: { kind: 'storyCompiler', compilationId: id } } })
      } else {
        expect(scenes).toMatchObject({ kind: 'tool', result: { display: { kind: 'storyCompiler', compilationId: id } } })
        expect(await step()).toMatchObject({ kind: 'tool', result: { display: { kind: 'storyCompiler', compilationId: id } } })
      }
      await step(); await step()
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id } })).stage).toBe('write')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: id } })).targetRevision).toBe(2)
      expect(await prisma.sceneTask.count({ where: { compilationId: id, status: 'writing' } })).toBe(1)
      if (scenario.startsWith('commit')) {
        await validateStoryContinuity({ ...f, compilationId: id, findings: [], expectedChapterRevision: 2, independentCheck: 'complete' })
        if (scenario !== 'commit-no-quality') await persistHumanityQualityReport({ ...f, compilationId: id, chapterRevision: 2,
          mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
        await step() // Save the validated compilation observation before COMMIT.
        if (scenario === 'commit-stale') await prisma.storyCompilation.update({ where: { id }, data: { preparedContext: { changed: true } } })
        if (scenario === 'commit-gap') {
          injectRollback()
          await expect(step()).rejects.toThrow('fixture-compiler-rollback')
          expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id } })).status).toBe('active')
          expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
        }
        const committed = await step()
        if (scenario === 'commit-no-quality' || scenario === 'commit-stale') {
          expect(committed).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
          expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id } })).status).toBe('active')
          expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
        } else {
          expect(committed).toMatchObject({ kind: 'tool', result: { summary: '提交章节桥与故事终态' } })
          const count = await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })
          expect(count).toBe(2)
          expect(await step()).toMatchObject({ kind: 'tool', result: { summary: '章节终态已提交' } })
          expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(count)
        }
      }
      const events = await publishDurableEvents(f.userId, lease.runId)
      expect(events.filter(event => event.type === 'tool.result' && event.toolName === 'scene_task_build')).toMatchObject(scenario === 'stale' ? [{ ok: false }, { ok: true }] : [{ ok: true }])
    })
  })
})

describe.runIf(available)('compiler transaction and root continuity', () => {
  it.each(['prepare-rollback', 'scenes-rollback', 'resume'] as const)('%s keeps compilation, bridge and scenes consistent', async scenario => {
    await fixture(async f => {
      const initialLease = await claim(f)
      await initializeExecutionState(initialLease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '同一个章节任务' }], successfulToolSignatures: [] } })
      const input = { userId: f.userId, novelId: f.novelId, runId: f.runId, chapterId: f.chapterId, mode: 'balanced' as const, intentSummary: '同一个章节任务' }
      const original = await prepareStoryCompilation(input)
      if (scenario === 'prepare-rollback') {
        await expect(prisma.$transaction(async tx => { await prepareStoryCompilation(input, tx); throw new Error('fixture-prepare-rollback') })).rejects.toThrow('fixture-prepare-rollback')
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(1)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: original.compilation.id } })).status).toBe('active')
        expect(await prisma.chapterBridge.count({ where: { compilation: { runId: f.runId } } })).toBe(1)
        return
      }
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      const tasks = [{ purpose: '推进场景', entryState: state, goal: '寻找线索', obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
        styleBudget: { description: 'low' as const, dialogue: 'medium' as const, rhetoric: 'low' as const } }]
      if (scenario === 'scenes-rollback') {
        await expect(prisma.$transaction(async tx => { await saveSceneTasks({ ...input, compilationId: original.compilation.id, tasks }, tx); throw new Error('fixture-scenes-rollback') })).rejects.toThrow('fixture-scenes-rollback')
        expect(await prisma.sceneTask.count({ where: { compilationId: original.compilation.id } })).toBe(0)
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: original.compilation.id } })).stage).toBe('prepare')
        await saveSceneTasks({ ...input, compilationId: original.compilation.id, tasks })
        expect(await prisma.sceneTask.count({ where: { compilationId: original.compilation.id } })).toBe(1)
        return
      }
      await saveSceneTasks({ ...input, compilationId: original.compilation.id, tasks })
      const otherSession = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '同作品另一任务窗口' } })
      const other = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: otherSession.id, chapterId: f.chapterId,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', engine: 'loop' } })
      const otherCompilation = await prepareStoryCompilation({ ...input, runId: other.id })
      await pauseDurableTask(f.userId, f.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
      const lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'compiler-resume-worker')
      const result = await withRunLease(lease, tx => recordStoryCompilerWrite({ ...input, runId: resumed.run.id, chapterOrderIndex: 1, chapterRevision: 1 }, tx))
      expect(result).toEqual({ compilationId: original.compilation.id, stage: 'write' })
      expect((await prisma.sceneTask.findFirstOrThrow({ where: { compilationId: original.compilation.id } })).status).toBe('writing')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: original.compilation.id } })).targetRevision).toBe(1)
      await withRunLease(lease, tx => prepareStoryCompilation({ ...input, runId: resumed.run.id }, tx))
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: original.compilation.id } })).status).toBe('abandoned')
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: otherCompilation.compilation.id } })).status).toBe('active')
    })
  })
})

describe.runIf(available)('durable task todos', () => {
  it.each(['build', 'plan', 'review', 'late', 'empty', 'single', 'replay', 'corrupt', 'rollback', 'isolation', 'resume', 'cancelled'] as const)('%s keeps task progress in confirmed receipts', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const mode = scenario === 'plan' || scenario === 'review' ? scenario : 'build'
      const initial = withTodoIds([{ content: '步骤一', status: 'in_progress' }, { content: '步骤二', status: 'pending' }])
      // Creation has no server-issued IDs yet; subsequent calls use the receipt IDs.
      const creation = initial.map(({ content, status }) => ({ content, status }))
      const args = { items: scenario === 'late' ? creation.map(item => ({ ...item, status: 'completed' })) : scenario === 'empty' ? [] : scenario === 'single' ? creation.slice(0, 1) : creation }
      const ignored = ['late', 'empty', 'single'].includes(scenario)
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode, agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: 'todo_write', description: todoWriteTool.description, parameters: z.toJSONSchema(todoWriteTool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: 'todo_write', permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [f.chapterId], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '分两步处理本章' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'todo-first', name: 'todo_write', arguments: JSON.stringify(args) },
            { id: 'todo-next', name: 'todo_write', arguments: JSON.stringify({ items: scenario === 'cancelled' ? initial.map(item => ({ ...item, status: 'cancelled', reason: '重复清单，剩余项不再执行' })) : [{ ...initial[0], status: 'completed' }] }) },
          ] }], successfulToolSignatures: [] } })
      let otherArtifact: { id: string; content: string } | undefined
      if (scenario === 'isolation') {
        const runId = randomUUID(), sourceMessageId = randomUUID()
        const spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: f.chapterId, prompt: '另一个任务' })
        await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)) } })
        await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: '另一个任务' }] } })
        await initializeDurableTask({ userId: f.userId, runId, sourceMessageId })
        otherArtifact = await prisma.agentArtifact.create({ data: { runId, artifactType: 'chapterPlan', title: '旧清单', content: JSON.stringify([{ content: '旧任务已完成', status: 'completed' }]), metadata: { todoList: true } } })
      }
      if (scenario === 'rollback') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => { await work(tx); throw new Error('fixture-effect-rollback') }))
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('fixture-effect-rollback')
        expect(await prisma.agentArtifact.count({ where: { runId: f.runId } })).toBe(0)
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      }
      const first = await executeDurableToolStep(lease, new AbortController().signal)
      expect(first.kind).toBe('tool')
      const artifact = await prisma.agentArtifact.findFirst({ where: { runId: f.runId } })
      expect(Boolean(artifact)).toBe(!ignored)
      if (ignored) return
      expect(JSON.parse(artifact!.content)).toEqual(initial)
      if (scenario === 'replay') {
        const ctx: ToolContext = { ...f, mode, callId: 'todo-first', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {},
          durableTask: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: initialized.frame.snapshotHash } } }
        expect(await executeDurableTodo(ctx, args)).toEqual(first.kind === 'tool' ? first.result : undefined)
        expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: artifact!.id } })).updatedAt).toEqual(artifact!.updatedAt)
      }
      if (scenario === 'corrupt') {
        const receipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } } })
        await prisma.agentEffectReceipt.update({ where: { operationId: receipt.operationId }, data: { resultHash: '0'.repeat(64) } })
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        return
      }
      // A stale/corrupt display copy must not become the authoritative prior list.
      await prisma.agentArtifact.update({ where: { id: artifact!.id }, data: { content: 'stale UI copy' } })
      if (scenario === 'resume') {
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'todo-resume-worker')
      }
      await executeDurableToolStep(lease, new AbortController().signal)
      const expected = scenario === 'cancelled'
        ? initial.map(item => ({ ...item, status: 'cancelled', reason: '重复清单，剩余项不再执行' }))
        : [{ ...initial[0], status: 'completed' }, initial[1]]
      expect(JSON.parse((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: artifact!.id } })).content)).toEqual(expected)
      if (scenario === 'cancelled') {
        const own = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '正文终态仍未提交' })
        const frame = (await loadExecutionState(f.userId, lease.runId)).frame
        const saved = await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: '已取消剩余清单。' }] } })
        const evidence = await collectDurableCompletionEvidence(lease, { expectedRevision: saved.revision, expectedHash: saved.snapshotHash })
        expect(evidence.snapshot).toMatchObject({ todos: expected, blockers: [{ code: 'uncommitted_compilation', reference: own.compilation.id }] })
        expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('active')
      }
      if (otherArtifact) expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: otherArtifact.id } })).content).toBe(otherArtifact.content)
      const receipts = await prisma.agentEffectReceipt.findMany({ where: { operation: { taskRootId: f.rootId } } })
      for (const receipt of receipts) expect(receipt.result).not.toHaveProperty('progress')
      expect(await prisma.agentArtifact.count({ where: { runId: f.runId } })).toBe(1)
      if (scenario === 'build') {
        const events = await publishDurableEvents(f.userId, lease.runId)
        expect(events.filter(event => event.type === 'tool.call')).toHaveLength(2)
        const finished = events.filter(event => event.type === 'tool.result')
        expect(finished).toHaveLength(2)
        expect(finished.at(-1)).toMatchObject({ ok: true, display: { kind: 'todoList', items: expected } })
      }
    })
  })
})

describe.runIf(available)('durable history observations', () => {
  it.each(['session_history_search', 'session_message_read', 'task_context_list', 'task_context_read', 'missing-message', 'missing-task'] as const)('%s freezes historical observations without importing authority', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const action = scenario === 'missing-message' ? 'session_message_read' : scenario === 'missing-task' ? 'task_context_read' : scenario
      const checked = <T,>(tool: AgentTool<T>): AgentTool => ({ ...tool, execute: (ctx, args) => tool.execute(ctx, tool.parameters.parse(args)) })
      const tool = [checked(sessionHistorySearchTool), checked(sessionMessageReadTool), checked(taskContextListTool), checked(taskContextReadTool)].find(item => item.name === action)!
      const raw = action === 'session_history_search' ? { mode: 'first_user_prompt' } : action === 'session_message_read' ? { messageId: scenario === 'missing-message' ? 'missing' : f.sourceMessageId }
        : action === 'task_context_read' ? { sessionId: scenario === 'missing-task' ? 'missing' : f.sessionId } : {}
      const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(value) as Record<string, unknown>).filter(([, item]) => item !== undefined))
      const args = normalize(raw)
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'review', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: action, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: action, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '查阅历史记录，仅作为参考' }, { role: 'assistant', content: null, toolCalls: [{ id: 'history', name: action, arguments: JSON.stringify(raw) }] }], successfulToolSignatures: [] } })
      const result = await executeDurableToolStep(lease, new AbortController().signal)
      if (result.kind !== 'tool') throw new Error('Expected persisted history result')
      expect(result.result.outcome === 'failed').toBe(scenario.startsWith('missing'))
      await prisma.agentMessage.update({ where: { id: f.sourceMessageId }, data: { parts: [{ type: 'text', text: '改变了的历史消息' }] } })
      await prisma.agentSession.update({ where: { id: f.sessionId }, data: { title: '改变了的任务标题' } })
      const ctx: ToolContext = { ...f, callId: 'history', mode: 'review', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {},
        toolAuthority: new Map([[action, { permission: 'allow', alwaysConfirm: false, dangerous: false }]]),
        durableRead: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: initialized.frame.snapshotHash } } }
      const replay = await executeDurableRead(ctx, action, args, normalize, async () => { throw new Error('Replay must not read changed history') })
      expect(replay).toEqual(result.result)
      expect((await loadExecutionState(f.userId, f.runId)).configuration).toEqual(initialized.configuration)
    })
  })
})

describe.runIf(available)('durable structural mutation batch', () => {
  it.each(['volume_update', 'volume_move', 'volume_delete', 'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge',
    'missing-baseline', 'missing-content', 'stale', 'protected', 'effect-gap', 'nonempty-delete', 'approval', 'structure-checkpoint', 'structure-noop'] as const)('%s preserves original structure decisions and receipts', async scenario => {
    const originalTurns = env.agentMaxTurns
    const checkpoints = scenario.startsWith('structure-')
    if (checkpoints) env.agentMaxTurns = 1
    try { await fixture(async f => {
      vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      const lease = await claim(f)
      const secondVolume = await prisma.volume.create({ data: { novelId: f.novelId, title: '第二卷', orderIndex: 2 } })
      const original = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '前半后半', wordCount: 4 } })
      const source = scenario === 'chapter_merge' ? await prisma.chapter.create({ data: { novelId: f.novelId, authorId: f.userId,
        volumeId: original.volumeId, title: '合并来源', content: '后文', wordCount: 2, orderIndex: 2, orderInVolume: 2 } }) : null
      const actualName = ['missing-baseline', 'stale', 'protected', 'effect-gap', 'approval'].includes(scenario) ? 'volume_move'
        : checkpoints ? 'volume_update' : scenario === 'missing-content' ? 'chapter_split' : scenario === 'nonempty-delete' ? 'volume_delete' : scenario
      const args: Record<string, unknown> = actualName === 'volume_update' ? { volumeId: secondVolume.id, title: scenario === 'structure-noop' ? '第二卷' : '修改卷名' }
        : actualName === 'volume_move' ? { volumeId: secondVolume.id, position: 1 }
        : actualName === 'volume_delete' ? { volumeId: scenario === 'nonempty-delete' ? original.volumeId : secondVolume.id }
        : actualName === 'chapter_split' ? { chapterId: f.chapterId, splitOffset: 2, newChapterTitle: '后半章' }
        : actualName === 'chapter_merge' ? { targetChapterId: f.chapterId, sourceChapterId: source!.id, separator: '\n' }
        : { chapterId: f.chapterId, targetVolumeId: secondVolume.id, position: 1 }
      const tools = [volumeListTool, structureOutlineTool, chapterReadTool, volumeUpdateTool, volumeMoveTool, volumeDeleteTool,
        chapterMoveTool, chapterMoveToVolumeTool, chapterSplitTool, chapterMergeTool]
      const readCalls = scenario === 'missing-baseline' ? [] : [{ id: 'layout', name: 'volume_list', arguments: '{}' },
        ...(actualName === 'chapter_split' && scenario !== 'missing-content' || actualName === 'chapter_merge'
          ? [{ id: 'chapter', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) }] : []),
        ...(source ? [{ id: 'source', name: 'chapter_read', arguments: JSON.stringify({ chapterId: source.id }) }] : [])]
      const calls = [...readCalls, { id: 'mutate', name: actualName, arguments: JSON.stringify(args) }, { id: 'validate', name: 'structure_outline', arguments: '{}' }]
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval' && tool.name === actualName ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })),
        protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '调整卷章结构' }, ...(checkpoints ? [] : [{ role: 'assistant', content: null, toolCalls: calls }])], successfulToolSignatures: [] } })
      if (checkpoints) {
        const current = await loadExecutionState(f.userId, f.runId)
        const window = getCreditWindow()
        await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
        vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id,
          type: 'function', function: { name: call.name, arguments: call.arguments } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}

data: [DONE]

`)))
        await chatWithTools({ messages: current.frame.state.messages, tools: current.configuration.tools, provider: 'fixture', model: 'fixture', providerBaseUrl: 'https://provider.invalid/v1', providerApiKey: 'fixture-not-real', reasoningEffort: 'high',
          durableExecution: { lease, operationKey: 'exec:0', attemptKey: '1', cursor: { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash },
            price: { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'structure-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } } },
          usageLog: { userId: f.userId, agentRunId: f.runId, action: 'workspaceAgent', modelTier: 'speed', multiplierBps: 10000, turn: 1 } })
      }
      const signal = new AbortController().signal
      for (const _read of readCalls) expect((await executeDurableToolStep(lease, signal)).kind).toBe('tool')
      if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, title: '外部变更' } })
      if (scenario === 'effect-gap') {
        const originalCommit = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, operationId, inputHash, apply) =>
          originalCommit(token, operationId, inputHash, async tx => { await apply(tx); throw new Error('fixture effect transaction interrupted') }))
        await expect(executeDurableToolStep(lease, signal)).rejects.toThrow('fixture effect transaction interrupted')
        expect((await prisma.volume.findUniqueOrThrow({ where: { id: secondVolume.id } })).orderIndex).toBe(2)
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: actualName } } })).toBe(0)
      }
      if (scenario === 'approval') {
        const waiting = await executeDurableToolStep(lease, signal)
        if (waiting.kind !== 'waiting_approval') throw new Error('Expected structure approval')
        expect((await prisma.volume.findUniqueOrThrow({ where: { id: secondVolume.id } })).orderIndex).toBe(2)
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'mutate', approved: true, alwaysAllow: false })
      }
      const result = await executeDurableToolStep(lease, signal)
      if (result.kind !== 'tool') throw new Error('Expected tool result')
      const rejected = ['missing-baseline', 'missing-content', 'stale', 'protected', 'nonempty-delete'].includes(scenario)
      expect(result.result.outcome).toBe(rejected ? 'failed' : undefined)
      if (rejected) {
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('前半后半')
        expect((await prisma.volume.findUniqueOrThrow({ where: { id: secondVolume.id } })).orderIndex).toBe(2)
      } else if (actualName === 'volume_move') expect((await prisma.volume.findUniqueOrThrow({ where: { id: secondVolume.id } })).orderIndex).toBe(1)
      else if (actualName === 'volume_update') expect((await prisma.volume.findUniqueOrThrow({ where: { id: secondVolume.id } })).title).toBe(scenario === 'structure-noop' ? '第二卷' : '修改卷名')
      else if (actualName === 'volume_delete') expect(await prisma.volume.findUnique({ where: { id: secondVolume.id } })).toBeNull()
      else if (actualName === 'chapter_split') {
        const chapters = await prisma.chapter.findMany({ where: { novelId: f.novelId }, orderBy: { orderIndex: 'asc' } })
        expect(chapters.map(chapter => chapter.content)).toEqual(['前半', '后半'])
      } else if (actualName === 'chapter_merge') {
        expect(await prisma.chapter.findUnique({ where: { id: source!.id } })).toBeNull()
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('前半后半\n后文')
      } else expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).volumeId).toBe(secondVolume.id)
      // Recover the already committed result at the exact pending frame: no second mutation.
      const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: actualName } })
      const beforeReplay = await prisma.volume.findMany({ where: { novelId: f.novelId }, orderBy: { id: 'asc' } })
      const pending = await prisma.agentExecutionFrame.findFirstOrThrow({ where: { taskRootId: f.rootId, snapshot: { path: ['pendingOperationId'], equals: operation.id } } })
      await reduceExecutionReceipt(lease, { expectedRevision: pending.revision, expectedHash: pending.snapshotHash, operationId: operation.id })
      expect(await prisma.volume.findMany({ where: { novelId: f.novelId }, orderBy: { id: 'asc' } })).toEqual(beforeReplay)
      const validation = await executeDurableToolStep(lease, signal)
      expect(validation.kind === 'tool' && validation.result.validationEvidence?.passed).toBe(true)
      if (scenario === 'chapter_split' || scenario === 'chapter_merge') {
        const frame = (await loadExecutionState(f.userId, f.runId)).frame
        const deliveries = await withRunLease(lease, async tx => {
          const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
          return collectDurableDeliverables(tx, root, (await collectDurableToolEvidence(tx, root.id, frame.revision)).effects)
        })
        expect(deliveries).toHaveLength(2)
        expect(deliveries.map(item => item.status).sort()).toEqual(scenario === 'chapter_merge' ? ['current', 'removed'] : ['current', 'current'])
      }
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: actualName } })).toBe(1)
      if (scenario === 'structure-checkpoint') {
        expect((await advanceDurableCheckpoint(lease))?.state.checkpointIndex).toBe(1)
        expect((await readTaskBudget(lease)).budget.checkpointCount).toBe(1)
        expect(await advanceDurableCheckpoint(lease)).toBeNull()
      } else if (scenario === 'structure-noop') {
        await expect(advanceDurableCheckpoint(lease)).rejects.toMatchObject({ code: 'RUNTIME_PROGRESS_REQUIRED' })
        expect((await prisma.volume.findUniqueOrThrow({ where: { id: secondVolume.id } })).revision).toBe(secondVolume.revision)
      }
    }) } finally { env.agentMaxTurns = originalTurns }
  }, 30_000)
})

describe.runIf(available)('durable worker orchestration', () => {
  it.each(['todo-finish', 'todo-noop-stall'] as const)('%s checks only the current task list without buying endless retries', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: [{ type: 'function', function: { name: 'todo_write', description: todoWriteTool.description, parameters: z.toJSONSchema(todoWriteTool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: 'todo_write', permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '完成两个步骤' }], successfulToolSignatures: [] } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
        rateCardId: 'worker-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      let requests = 0
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        if (requests > 10) throw new Error('Unbounded todo loop')
        const body = JSON.parse(String(init.body))
        expect(body.messages.filter((item: { role: string }) => item.role === 'user')).toHaveLength(1)
        const toolCall = requests % 2 === 1
        if (requests === 3) expect(body.messages.at(-1).content).toContain('本任务已建立的待办仍有未完成项')
        const items = ['步骤一', '步骤二'].map(content => ({ content, status: scenario === 'todo-finish' && requests > 1 ? 'completed' : 'pending' }))
        const delta = toolCall ? { tool_calls: [{ index: 0, id: `todo-${requests}`, type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ items }) } }] } : { content: '处理结果已生成。' }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      }))
      const result = await runDurableExecution(lease, new AbortController().signal)
      expect(result.kind).toBe(scenario === 'todo-finish' ? 'completion_review' : 'needs_attention')
      expect(requests).toBe(scenario === 'todo-finish' ? 4 : 10)
      expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(0)
      const reminders = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: f.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'asc' } })
      expect(reminders).toHaveLength(scenario === 'todo-finish' ? 1 : 4)
      reminders.forEach((event, index) => expect(event.payload).toMatchObject({ reason: 'unfinished_todos', reminderIndex: index + 1, progressSequence: '0' }))
      // A completed model-maintained list is only a review candidate, not a completion receipt.
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe(scenario === 'todo-finish' ? 'active' : 'paused')
    })
  }, 30_000) // Ten real-PG model/tool transactions, like the adjacent orchestration matrix.

  it.each(['complete', 'approval', 'unknown', 'route-change', 'v1-price', 'prepare-gap', 'attempt-gap', 'checkpoint', 'checkpoint-gap', 'checkpoint-no-progress', 'checkpoint-noop',
    'continuation-promise', 'continuation-empty', 'continuation-length', 'continuation-gap', 'continuation-stagnant'] as const)('%s drives saved model/tool steps', async scenario => {
    const previousTurns = env.agentMaxTurns
    const checkpointScenario = scenario.startsWith('checkpoint')
    if (checkpointScenario) env.agentMaxTurns = 1
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    try { await fixture(async f => {
      let lease = await claim(f)
      const continues = scenario.startsWith('continuation-')
      const completes = ['complete', 'prepare-gap', 'attempt-gap', 'checkpoint', 'checkpoint-gap', 'checkpoint-noop'].includes(scenario) || continues && scenario !== 'continuation-stagnant'
      const expectedRequests = continues ? scenario === 'continuation-stagnant' ? 6 : 3 : completes ? 2 : scenario === 'approval' || scenario === 'unknown' || scenario === 'checkpoint-no-progress' ? 1 : 0
      const writes = scenario === 'checkpoint' || scenario === 'checkpoint-gap' || scenario === 'checkpoint-noop'
      const tools = writes ? [chapterReadTool, chapterWriteTool] : [chapterReadTool]
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: scenario === 'approval' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '检查本章' }], successfulToolSignatures: [] } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
        baseUrl: scenario === 'route-change' ? 'https://changed.invalid/v1' : 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue(scenario === 'v1-price'
        ? { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }
        : { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'worker-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      let requests = 0
      const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        requests++
        if (scenario === 'unknown') throw new Error('fixture disconnected')
        const body = JSON.parse(String(init.body))
        expect(body.messages[0].content).toBe('检查本章')
        if (requests === 2) expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: scenario === 'checkpoint-noop' ? 'noop' : writes ? 'write' : 'read' })
        if (continues && requests > 2) {
          expect(body.messages.at(-1)).toMatchObject({ role: 'system' })
          expect(body.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1)
        }
        const delta = requests === 1 ? { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) } },
          ...(writes ? [{ index: 1, id: 'write', type: 'function', function: { name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '检查点前实际写入正文' }) } }] : []),
          ...(scenario === 'checkpoint-noop' ? [{ index: 2, id: 'noop', type: 'function', function: { name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '检查点前实际写入正文' }) } }] : []),
        ] } : { content: continues && (requests === 2 || scenario === 'continuation-stagnant') ? scenario === 'continuation-empty' ? '' : '接下来读取正文。' : '检查结果已生成' }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: requests === 1 ? 'tool_calls' : scenario === 'continuation-length' && requests === 2 ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetch)
      if (scenario === 'prepare-gap') vi.spyOn(runtimeOperations, 'prepareProviderAttempt').mockRejectedValueOnce(new Error('fixture before attempt'))
      if (scenario === 'attempt-gap') vi.spyOn(runtimeOperations, 'markProviderDispatched').mockRejectedValueOnce(new Error('fixture before dispatch'))
      if (scenario === 'checkpoint-gap') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId, eventKey: `state:${f.rootId}:7`, type: 'fixture.collision', payload: {} } })
      if (scenario === 'continuation-gap') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId, eventKey: `state:${f.rootId}:7`, type: 'fixture.collision', payload: {} } })
      let run = runDurableExecution(lease, new AbortController().signal)
      if (scenario === 'continuation-gap') {
        await expect(run).rejects.toMatchObject({ code: 'P2002' })
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.continuation' } })).toBe(0)
        expect(fetch).toHaveBeenCalledTimes(2)
        await prisma.agentExecutionOutbox.delete({ where: { eventKey: `state:${f.rootId}:7` } })
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'continuation-worker')
        run = runDurableExecution(lease, new AbortController().signal)
      }
      if (scenario === 'checkpoint-gap') {
        await expect(run).rejects.toMatchObject({ code: 'P2002' })
        expect((await readTaskBudget(lease)).budget.checkpointCount).toBe(0)
        expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(0)
        await prisma.agentExecutionOutbox.delete({ where: { eventKey: `state:${f.rootId}:7` } })
        run = runDurableExecution(lease, new AbortController().signal)
      }
      if (scenario === 'prepare-gap' || scenario === 'attempt-gap') {
        await expect(run).rejects.toThrow('fixture before')
        expect(fetch).not.toHaveBeenCalled()
        expect((await loadExecutionState(f.userId, f.runId)).frame.state.phase).toBe('awaiting_operation')
        await pauseDurableTask(f.userId, f.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'worker-b')
        run = runDurableExecution(lease, new AbortController().signal)
      }
      if (scenario === 'unknown') await expect(run).rejects.toThrow()
      else if (scenario === 'checkpoint-no-progress') await expect(run).rejects.toMatchObject({ code: 'RUNTIME_PROGRESS_REQUIRED' })
      else if (scenario === 'route-change' || scenario === 'v1-price') await expect(run).rejects.toMatchObject({ code: scenario === 'route-change' ? 'RUNTIME_IDENTITY_CONFLICT' : 'RUNTIME_PRICE_REQUIRED' })
      else expect(await run).toMatchObject({ kind: scenario === 'approval' ? 'waiting_approval' : scenario === 'continuation-stagnant' ? 'needs_attention' : 'completion_review' })
      expect(fetch).toHaveBeenCalledTimes(expectedRequests)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(scenario === 'unknown' ? 0 : expectedRequests)
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe(scenario === 'continuation-stagnant' ? 'paused' : 'active')
      if (scenario === 'approval') {
        const waiting = await runDurableExecution(lease, new AbortController().signal)
        if (waiting.kind !== 'waiting_approval') throw new Error('Expected original approval')
        expect(fetch).toHaveBeenCalledTimes(1)
        await resolveDurableApproval({ userId: f.userId, runId: lease.runId, requestId: waiting.approvalId, callId: 'read', approved: true, alwaysAllow: false })
        expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'completion_review' })
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(2)
      }
      if (completes) {
        const frame = (await loadExecutionState(f.userId, lease.runId)).frame
        expect(frame.state).toMatchObject({ turn: continues ? 3 : 2, nextOperationSequence: continues ? 4 : scenario === 'checkpoint-noop' ? 5 : writes ? 4 : 3, phase: 'idle', checkpointIndex: writes ? 1 : 0 })
        if (writes) expect((await readTaskBudget(lease)).budget.checkpointCount).toBe(1)
        if (scenario === 'checkpoint-noop') {
          const checkpoint = await prisma.agentRuntimeCheckpoint.findFirstOrThrow({ where: { taskRootId: f.rootId } })
          expect((await prisma.agentOperation.findUniqueOrThrow({ where: { id: checkpoint.progressOperationId } })).operationKey).toBe('exec:2')
        }
        const reviewed = await runDurableExecution(lease, new AbortController().signal)
        expect(reviewed).toMatchObject({ kind: 'completion_review', evidence: { snapshot: { taskRootId: f.rootId, verification: 'required', originalRequest: [{ type: 'text', text: '修改本章' }], postconditionChecks: [], obligations: { goals: f.spec.goals, expectedOutputs: f.spec.expectedOutputs } } } })
        if (reviewed.kind !== 'completion_review') throw new Error('Expected evidence review')
        expect(runtimeJson(reviewed.evidence.snapshot).hash).toBe(reviewed.evidence.snapshotHash)
        if (scenario === 'checkpoint') {
          expect(reviewed).toMatchObject({ evidence: { snapshot: { deliverables: [expect.objectContaining({ id: f.chapterId, status: 'current' })] } } })
          expect(reviewed).toMatchObject({ evidence: { snapshot: { memoryJobs: [expect.objectContaining({ chapterId: f.chapterId, verified: true })] } } })
          await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户之后改过正文' } })
          const changed = await runDurableExecution(lease, new AbortController().signal)
          expect(changed).toMatchObject({ evidence: { snapshot: { blockers: expect.arrayContaining([{ code: 'deliverable_changed', reference: f.chapterId }]) } } })
          expect(fetch).toHaveBeenCalledTimes(expectedRequests)
        }
        if (scenario === 'complete') {
          const otherRun = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'failed', engine: 'loop' } })
          await prepareStoryCompilation({ ...f, runId: otherRun.id, chapterId: f.chapterId, mode: 'balanced', intentSummary: '旧任务不属于本次交付' })
          expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ evidence: { snapshot: { blockers: [], compilations: [] } } })
          const own = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: '当前未提交章节' })
          expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ evidence: { snapshot: { blockers: [{ code: 'uncommitted_compilation', reference: own.compilation.id }] } } })
          const receipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId, action: 'chapter_read' } } })
          await prisma.agentEffectReceipt.update({ where: { operationId: receipt.operationId }, data: { resultHash: 'f'.repeat(64) } })
          await expect(runDurableExecution(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
          await prisma.agentEffectReceipt.update({ where: { operationId: receipt.operationId }, data: { resultHash: receipt.resultHash } })
          await prisma.agentExecutionOutbox.delete({ where: { eventKey: `effect:${receipt.operationId}` } })
          await expect(runDurableExecution(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        }
        expect(fetch).toHaveBeenCalledTimes(expectedRequests)
      }
      if (continues) expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'execution.continuation' } })).toBe(scenario === 'continuation-stagnant' ? 4 : 1)
      if (scenario === 'continuation-stagnant') {
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).status).toBe('paused')
        expect(await prisma.agentRunLease.count({ where: { run: { taskRootId: f.rootId }, enabled: true } })).toBe(0)
        const projected = await publishDurableEvents(f.userId, lease.runId)
        expect(projected.at(-1)).toMatchObject({ type: 'run.paused', reason: 'model_stalled' })
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'stagnation-worker')
        expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'needs_attention' })
        expect(fetch).toHaveBeenCalledTimes(6)
        const secondPause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: lease.runId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
        const third = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: secondPause.id })
        lease = await claim({ userId: f.userId, runId: third.run.id }, 'stagnation-integrity-worker')
        const lastDecision = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'desc' } })
        await prisma.agentExecutionOutbox.update({ where: { id: lastDecision.id }, data: { payload: { ...(lastDecision.payload as Prisma.JsonObject), reminderIndex: 1 } } })
        await expect(runDurableExecution(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        expect(fetch).toHaveBeenCalledTimes(6)
      }
    }) } finally { env.agentMaxTurns = previousTurns }
  }, 30_000)
})

describe.runIf(available)('durable stagnation evidence', () => {
  it.each(['repeat-read', 'changed-read', 'noop-write'] as const)('%s only resets on new evidence', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tools = [chapterReadTool, chapterWriteTool]
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '检查本章' }], successfulToolSignatures: [] } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'stagnation-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      let calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        if (calls > 14) throw new Error('Repeated observations must not extend stagnation forever')
        if (scenario === 'changed-read' && calls === 5) await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户提供的新证据', revision: { increment: 1 } } })
        const delta = calls % 2 ? { tool_calls: [{ index: 0, id: `read-${calls}`, type: 'function', function: { name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) } },
          ...(scenario === 'noop-write' ? [{ index: 1, id: `noop-${calls}`, type: 'function', function: { name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '原文' }) } }] : [])] }
          : { content: '接下来读取正文。' }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls % 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      }))
      expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'needs_attention' })
      expect(calls).toBe(scenario === 'changed-read' ? 14 : 10)
      const reminders = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: f.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'asc' } })
      expect(reminders.map(item => (item.payload as { reminderIndex: number }).reminderIndex)).toEqual(scenario === 'changed-read' ? [1, 2, 1, 2, 3, 4] : [1, 2, 3, 4])
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('paused')
    })
  }, 30000)
})

describe.runIf(available)('saved-cursor tool dispatch', () => {
  it.each(['settled', 'unknown-usage', 'unknown-result', 'stop-resume'] as const)('recovers pending provider %s without HTTP or a second charge', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, dailyUsedMilli: 0, bonusBalanceMilli: 0, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const initialized = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
        phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
      const operation = await preparePricedProviderOperation(lease, { key: 'exec:0', action: 'chat', request: {}, price: {
        version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'recovery-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } } })
      await saveExecutionState(lease, { expectedRevision: 0, expectedHash: initialized.frame.snapshotHash,
        snapshot: { ...initialized.frame.state, phase: 'awaiting_operation', pendingOperationId: operation.id, turn: 1, nextOperationSequence: 1 } })
      const attempt = await prepareProviderAttempt(lease, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(lease, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      if (scenario !== 'unknown-usage') await recordProviderUsage({ ...identity, revision: 1, usage: reported })
      if (scenario === 'unknown-result') {
        await recordProviderResult({ ...identity, outcome: 'unknown', result: { reason: 'transport_error' } })
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(1)
      } else {
        await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '已保存的模型回答', reasoning: '', finishReason: 'stop', toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } } })
        if (scenario === 'stop-resume') {
          const oldLease = lease
          await pauseDurableTask(f.userId, f.runId)
          const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
          const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
          lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'worker-b')
          await expect(executeDurableToolStep(oldLease, new AbortController().signal)).rejects.toThrow()
        }
        expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'recovered', billing: { status: scenario === 'unknown-usage' ? 'pending' : 'settled' } })
        expect(await executeDurableToolStep(lease, new AbortController().signal)).toEqual({ kind: 'idle' })
        expect((await loadExecutionState(f.userId, lease.runId)).frame.state.messages.at(-1)).toMatchObject({ role: 'assistant', content: '已保存的模型回答' })
      }
      expect(fetch).not.toHaveBeenCalled()
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(scenario === 'settled' || scenario === 'stop-resume' ? 1 : 0)
    })
  })
  it.each(['chapter', 'chapter-conflict', 'plan', 'plan-conflict', 'approved', 'denied', 'chapter-no-baseline', 'plan-no-baseline', 'plan-implicit'] as const)('%s selects read then write without caller-supplied baseline', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      const lease = await claim(f)
      const plan = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '计划', content: '原始计划正文', metadata: { savedAsPlan: true } } })
      const isPlan = scenario.startsWith('plan')
      const premature = scenario.endsWith('no-baseline') || scenario === 'plan-implicit'
      const reader = isPlan ? planReadTool : chapterReadTool
      const writer = isPlan ? planSaveTool : chapterWriteTool
      const tools = [reader, writer]
      const readArgs = isPlan ? { planId: plan.id } : { chapterId: f.chapterId }
      const writeArgs = isPlan ? { planId: plan.id, title: '计划', content: '已核验的新计划正文' } : { chapterId: f.chapterId, content: '已核验的新正文' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision({ provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1', reasoningEffort: 'high' }) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: ['approved', 'denied'].includes(scenario) && tool.name === writer.name ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '核对并修改' }, { role: 'assistant', content: null, toolCalls: [
            ...(premature ? [{ id: 'premature-write', name: writer.name, arguments: JSON.stringify(scenario === 'plan-implicit' ? { title: '计划', content: '试图凭标题覆盖' } : writeArgs) }] : []),
            { id: 'read', name: reader.name, arguments: JSON.stringify(readArgs) }, { id: 'write', name: writer.name, arguments: JSON.stringify(writeArgs) },
          ] }], successfulToolSignatures: [] } })
      const signal = new AbortController().signal
      if (premature) {
        expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed', summary: scenario === 'plan-implicit' ? '同名计划已存在，需要明确目标' : '需要先读取目标，未执行写入' } })
        const failed = await loadExecutionState(f.userId, f.runId)
        expect(failed.frame.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'premature-write', content: expect.stringContaining(reader.name) })
        expect((isPlan ? await prisma.agentArtifact.findUniqueOrThrow({ where: { id: plan.id } }) : await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(isPlan ? '原始计划正文' : '原文')
      }
      expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { observedState: { kind: isPlan ? 'plan' : 'chapter' } } })
      if (scenario.endsWith('conflict')) {
        if (isPlan) await prisma.agentArtifact.update({ where: { id: plan.id }, data: { content: '作者并发修改' } })
        else await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者并发修改', revision: { increment: 1 } } })
      }
      if (scenario === 'approved' || scenario === 'denied') {
        const waiting = await executeDurableToolStep(lease, signal)
        expect(waiting.kind).toBe('waiting_approval')
        expect(await executeDurableToolStep(lease, signal)).toEqual(waiting)
        if (waiting.kind !== 'waiting_approval') throw new Error('Missing approval')
        await expect(resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: undefined as unknown as string, callId: 'write', approved: true, alwaysAllow: false })).rejects.toMatchObject({ code: 'RUNTIME_INPUT_INVALID' })
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'write', approved: scenario === 'approved', alwaysAllow: false })
      }
      const written = await executeDurableToolStep(lease, signal)
      expect(written.kind).toBe('tool')
      if (written.kind === 'tool') expect(written.result.outcome === 'failed').toBe(scenario.endsWith('conflict') || scenario === 'denied')
      expect(await executeDurableToolStep(lease, signal)).toEqual({ kind: 'idle' })
      expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(premature ? 6 : 4)
      const saved = isPlan ? await prisma.agentArtifact.findUniqueOrThrow({ where: { id: plan.id } }) : await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(saved.content).toBe(scenario.endsWith('conflict') ? '作者并发修改' : scenario === 'denied' ? '原文' : writeArgs.content)
    })
  }, 30_000)
})

describe.runIf(available)('durable actual reads', () => {
  it.each(['novel', 'summaries', 'memory', 'structure'] as const)('%s dispatches and replays its original DB observation', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tool = scenario === 'structure' ? structureOutlineTool : scenario === 'novel' ? novelGetContextTool : scenario === 'memory' ? memorySearchTool : chapterListSummariesTool
      const args = scenario === 'novel' || scenario === 'structure' ? {} : scenario === 'memory' ? { query: '原章' } : { count: 2 }
      const memory = scenario === 'memory' ? await prisma.projectMemoryEntry.create({ data: { novelId: f.novelId, memoryType: 'chapterSummary', title: '原章', content: '原章的已保存记忆' } }) : null
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'review', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '读取原作品' }, { role: 'assistant', content: null, toolCalls: [{ id: 'read', name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const first = await executeDurableToolStep(lease, new AbortController().signal)
      if (first.kind !== 'tool') throw new Error('Expected tool result')
      expect(first.result.output).toContain(scenario === 'structure' ? '结构校验通过' : '原章')
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: '后来修改的章节', summary: '后来修改的摘要', ...(scenario === 'structure' ? { orderIndex: 3 } : {}) } })
      await prisma.novel.update({ where: { id: f.novelId }, data: { title: '后来修改的作品' } })
      if (memory) await prisma.projectMemoryEntry.update({ where: { id: memory.id }, data: { content: '后来修改的记忆' } })
      const ctx: ToolContext = { ...f, callId: 'read', mode: 'review', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {},
        toolAuthority: new Map([[tool.name, { permission: 'allow', alwaysConfirm: false, dangerous: false }]]),
        durableRead: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: initial.frame.snapshotHash } } }
      const replay = scenario === 'structure' ? await structureOutlineTool.execute(ctx, {}) : scenario === 'novel' ? await novelGetContextTool.execute(ctx, {}) : scenario === 'memory' ? await memorySearchTool.execute(ctx, { query: '原章' }) : await chapterListSummariesTool.execute(ctx, { count: 2 })
      expect(replay.output).toBe(first.result.output)
      if (scenario === 'structure') {
        expect(replay.validationEvidence).toEqual(first.result.validationEvidence)
        const fresh = await getStructureReportObservation(f.userId, f.novelId)
        expect(fresh.report.valid).toBe(false)
        expect(fresh.stateHash).not.toBe(replay.validationEvidence?.stateHash)
      }
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(1)
      expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(2)
    })
  })
  it.each(['chapter', 'plan', 'chapter-missing', 'plan-missing'] as const)('%s preserves the original observation on replay', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const plan = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '读取计划', content: '原计划正文', metadata: { savedAsPlan: true } } })
      const tool = scenario.startsWith('chapter') ? chapterReadTool : planReadTool
      const args = scenario.startsWith('chapter') ? { chapterId: scenario.endsWith('missing') ? 'missing' : f.chapterId } : { planId: scenario.endsWith('missing') ? 'missing' : plan.id }
      const state = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'review', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision({ provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1', reasoningEffort: 'high' }) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [f.chapterId], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '读取' }, { role: 'assistant', content: null, toolCalls: [{ id: 'read-call', name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
      const ctx: ToolContext = { ...f, callId: 'read-call', mode: 'review', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal,
        toolAuthority: new Map([[tool.name, { permission: 'allow', alwaysConfirm: false, dangerous: false }]]),
        durableRead: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: state.frame.snapshotHash } } }
      const result = await tool.execute(ctx, args)
      expect(result.outcome === 'failed').toBe(scenario.endsWith('missing'))
      if (scenario === 'chapter') expect(result.observedState).toMatchObject({ kind: 'chapter', id: f.chapterId })
      if (scenario === 'plan') expect(result.observedState).toEqual({ kind: 'plan', id: plan.id, hash: planTargetHash(plan) })
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者新正文', revision: { increment: 1 } } })
      await prisma.agentArtifact.update({ where: { id: plan.id }, data: { content: '作者新计划' } })
      expect(await tool.execute(ctx, args)).toEqual(result)
      expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(2)
      expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(1)
    })
  }, 30_000)
})

describe.runIf(available)('durable chapter creation', () => {
  it.each(['volume-chain', 'volume-protected'] as const)('%s creates once through the original structural path', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      const lease = await claim(f)
      const tools = [volumeCreateTool, volumeListTool, chapterCreateTool, chapterWriteTool]
      const args = { title: '新卷', ...(scenario === 'volume-protected' ? { position: 1 } : {}) }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'volume-protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '新卷写作' },
          { role: 'assistant', content: null, toolCalls: [{ id: 'create-volume', name: 'volume_create', arguments: JSON.stringify(args) }, { id: 'duplicate-volume', name: 'volume_create', arguments: JSON.stringify(args) }, { id: 'list', name: 'volume_list', arguments: '{}' }] }], successfulToolSignatures: [] } })
      const created = await executeDurableToolStep(lease, new AbortController().signal)
      if (created.kind !== 'tool') throw new Error('Expected volume result')
      if (scenario === 'volume-protected') {
        expect(created.result.outcome).toBe('failed')
        expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(1)
        return
      }
      const observed = created.result.observedState
      if (observed?.kind !== 'volume') throw new Error('Missing volume observation')
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { observedState: observed } })
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining('新卷') } })
      expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(2)
      let frame = (await loadExecutionState(f.userId, f.runId)).frame
      await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...frame.state, messages: [...frame.state.messages,
        { role: 'assistant', content: null, toolCalls: [{ id: 'chapter', name: 'chapter_create', arguments: JSON.stringify({ title: '新卷首章', volumeId: observed.id }) }] }] } })
      const chapterResult = await executeDurableToolStep(lease, new AbortController().signal)
      if (chapterResult.kind !== 'tool' || chapterResult.result.observedState?.kind !== 'chapter') throw new Error('Missing chapter')
      const chapterId = chapterResult.result.observedState.id
      frame = (await loadExecutionState(f.userId, f.runId)).frame
      await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...frame.state, messages: [...frame.state.messages,
        { role: 'assistant', content: null, toolCalls: [{ id: 'write', name: 'chapter_write', arguments: JSON.stringify({ chapterId, content: '新卷正文已写入' }) }] }] } })
      await executeDurableToolStep(lease, new AbortController().signal)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toMatchObject({ volumeId: observed.id, content: '新卷正文已写入', orderInVolume: 1 })
    })
  })
  it.each(['create', 'with-content', 'duplicate', 'protected', 'missing-volume', 'effect-gap'] as const)('%s uses atomic creation and original baseline', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      const lease = await claim(f)
      const args = { title: '新增章', ...(scenario === 'with-content' ? { content: '创建时已有正文' } : {}), ...(scenario === 'protected' ? { position: 1 } : {}), ...(scenario === 'missing-volume' ? { volumeOrder: 99 } : {}) }
      const tools = [chapterCreateTool, chapterWriteTool]
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: scenario === 'protected' ? [f.chapterId] : [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '新增章节' }, { role: 'assistant', content: null, toolCalls: [{ id: 'create', name: 'chapter_create', arguments: JSON.stringify(args) },
            ...(scenario === 'duplicate' ? [{ id: 'duplicate', name: 'chapter_create', arguments: JSON.stringify(args) }] : [])] }], successfulToolSignatures: [] } })
      if (scenario === 'effect-gap') {
        const original = runtimeOperations.commitOperationEffect
        vi.spyOn(runtimeOperations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => { await work(tx); throw new Error('fixture after creation') }))
        await expect(executeDurableToolStep(lease, new AbortController().signal)).rejects.toThrow('fixture after creation')
        expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      }
      const created = await executeDurableToolStep(lease, new AbortController().signal)
      if (created.kind !== 'tool') throw new Error('Expected creation observation')
      if (scenario === 'protected' || scenario === 'missing-volume') {
        expect(created.result.outcome).toBe('failed')
        expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).orderIndex).toBe(1)
        return
      }
      const observation = created.result.observedState
      if (observation?.kind !== 'chapter') throw new Error('Expected created chapter baseline')
      if (scenario === 'with-content') expect((await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId, action: 'chapter_create' } } })).result).toMatchObject({ progress: { kind: 'content_revision', targetId: observation.id } })
      if (scenario === 'duplicate') {
        const duplicate = await executeDurableToolStep(lease, new AbortController().signal)
        expect(duplicate).toMatchObject({ kind: 'tool', result: { observedState: observation } })
      }
      expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(2)
      const frame = (await loadExecutionState(f.userId, f.runId)).frame
      await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...frame.state, messages: [...frame.state.messages,
        { role: 'assistant', content: null, toolCalls: [{ id: 'write', name: 'chapter_write', arguments: JSON.stringify({ chapterId: observation.id, content: '新章实际正文' }) }] }] } })
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { display: { kind: 'chapterDiff', chapterId: observation.id, after: '新章实际正文' } } })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: observation.id } })).content).toBe('新章实际正文')
    })
  })
})

describe.runIf(available)('durable actual plan writes', () => {
  it.each(['create', 'update', 'conflict', 'missing', 'placeholder', 'review', 'append', 'append-stale'] as const)('%s', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const existing = ['update', 'conflict', 'append', 'append-stale'].includes(scenario) ? await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '原计划', content: '原始完整计划', metadata: { savedAsPlan: true } } }) : null
      const args = { title: '章节规划', content: scenario === 'placeholder' ? 'placeholder' : '第一场景审俘，第二场景核对口供，第三场景整理证据。',
        ...(existing ? { planId: existing.id } : scenario === 'missing' ? { planId: 'missing-plan' } : {}),
        ...(scenario.startsWith('append') ? { mode: 'append' as const, expectedContentHash: createHash('sha256').update(scenario === 'append-stale' ? '过期正文' : existing!.content).digest('hex') } : {}) }
      const mode = scenario === 'review' ? 'review' as const : 'plan' as const
      const state = await initializeExecutionState(lease, { configuration: { version: 1, mode, agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision({ provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1', reasoningEffort: 'high' }) },
        tools: [{ type: 'function', function: { name: 'plan_save', description: planSaveTool.description, parameters: z.toJSONSchema(planSaveTool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: 'plan_save', permission: mode === 'review' ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '规划' }, { role: 'assistant', content: null, toolCalls: [{ id: 'plan-call', name: 'plan_save', arguments: JSON.stringify({ arguments: args }) }] }], successfulToolSignatures: [] } })
      const ctx: ToolContext = { ...f, callId: 'plan-call', mode, creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal,
        toolAuthority: new Map([['plan_save', { permission: mode === 'review' ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false }]]),
        durablePlan: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: state.frame.snapshotHash }, expected: { id: existing?.id ?? null, hash: existing ? planTargetHash(existing) : null } } }
      if (scenario === 'conflict') await prisma.agentArtifact.update({ where: { id: existing!.id }, data: { content: '作者修改后的计划' } })
      if (scenario === 'review') {
        await expect(planSaveTool.execute(ctx, args)).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(0)
        return
      }
      const result = await planSaveTool.execute(ctx, args)
      expect(await planSaveTool.execute(ctx, args)).toEqual(result)
      const failed = ['conflict', 'missing', 'placeholder', 'append-stale'].includes(scenario)
      expect(result.outcome === 'failed').toBe(failed)
      expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(2)
      const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId } })
      expect(artifacts).toHaveLength(existing || !failed ? 1 : 0)
      if (!failed) {
        expect(artifacts[0].content).toBe(scenario === 'append' ? `${existing!.content}\n\n${args.content}` : args.content)
        const receipt = await prisma.agentEffectReceipt.findFirst({ where: { operation: { taskRootId: f.rootId } } })
        expect(receipt?.result).toMatchObject({ progress: { kind: 'content_revision', targetId: artifacts[0].id } })
      } else if (existing) expect(artifacts[0].content).toBe(scenario === 'conflict' ? '作者修改后的计划' : existing.content)
    })
  }, 30_000)
})

describe.runIf(available)('durable pre-execution rejection', () => {
  it.each(['incomplete', 'invalid', 'denied', 'unpublished', 'valid', 'approval', 'wrong-call', 'atomic-gap', 'schema-invalid', 'schema-changed', 'schema-coerced', 'coercion-fault', 'scene-overflow', 'scene-invalid'] as const)('%s', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const scene = scenario.startsWith('scene-')
      const name = scene ? 'scene_task_build' : 'chapter_read'
      const raw = scene ? JSON.stringify({ arguments: { tasks: scenario === 'scene-overflow'
        ? Array.from({ length: 5 }, (_, index) => ({ goal: `场景${index + 1}` })) : [{ goal: '守城' }, null] } }) : scenario === 'invalid' ? '{' : '{}'
      const parameters = scene ? sceneTaskBuildTool.parameters : z.object({ chapterId: z.string().min(1) })
      const candidate: AgentTool = { name, title: '读取', description: '', parameters, readOnly: !scene,
        permission: { build: 'allow', plan: 'allow', review: 'allow' }, execute: vi.fn(async () => ({ output: '不能执行' })),
        ...(scene ? { coerceArgs: sceneTaskBuildTool.coerceArgs } : {}),
        ...(scenario === 'schema-coerced' ? { coerceArgs: () => ({ chapterId: f.chapterId }) } : {}),
        ...(scenario === 'coercion-fault' ? { coerceArgs: () => { throw new Error('fixture normalizer failed') } } : {}) }
      const hasValidator = scene || scenario.startsWith('schema-') || scenario === 'coercion-fault'
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision({ provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }) },
        tools: scenario === 'unpublished' ? [] : [{ type: 'function', function: { name, description: '', parameters: hasValidator && scenario !== 'schema-changed' ? z.toJSONSchema(parameters, { io: 'input' }) : { type: 'object' } } }],
        toolAuthority: [{ name, permission: scenario === 'denied' || scenario === 'atomic-gap' ? 'deny' : scenario === 'approval' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '读取' }, { role: 'assistant', content: null, toolCalls: [{ id: 'call', name, arguments: raw, ...(scenario === 'incomplete' ? { incomplete: true } : {}) }] }], successfulToolSignatures: [] } })
      const cursor = { expectedRevision: 0, expectedHash: initial.frame.snapshotHash }
      if (scenario === 'atomic-gap') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId, eventKey: `state:${f.rootId}:1`, type: 'fixture-conflict', payload: {} } })
      const invoke = () => rejectToolCursorCall(lease, cursor, scenario === 'wrong-call' ? 'other' : 'call', hasValidator ? candidate : undefined)
      if (['valid', 'approval', 'wrong-call', 'atomic-gap', 'schema-changed', 'schema-coerced', 'coercion-fault'].includes(scenario)) {
        await expect(invoke()).rejects.toThrow()
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(0)
        expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(0)
        return
      }
      const rejected = await invoke()
      expect(candidate.execute).not.toHaveBeenCalled()
      expect(rejected.receipt.result).toMatchObject({ outcome: 'failed', effectApplied: false })
      const reduced = await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
      expect(reduced.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call' })
      if (scenario === 'schema-invalid') {
        expect(reduced.state.messages.at(-1)?.content).toContain('chapterId:')
        expect(reduced.state.messages.at(-1)?.content).toContain('参数字段校验失败')
      }
      if (scene) {
        expect(reduced.state.messages.at(-1)?.content).toContain(scenario === 'scene-overflow' ? 'tasks:' : 'tasks.1:')
        expect(reduced.state.messages.at(-1)?.content).toContain('参数字段校验失败')
      }
      expect(reduced.state).toMatchObject({ phase: 'idle', turn: 0, nextOperationSequence: 1 })
      const replay = await invoke()
      await reduceExecutionReceipt(lease, { expectedRevision: replay.pending.revision, expectedHash: replay.pending.snapshotHash, operationId: replay.operation.id })
      expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(2)
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(1)
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'effect.committed' } })).toBe(0)
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
    })
  }, 30_000)
})

describe.runIf(available)('model tool model durable execution chain', () => {
  it.each(['wrapped', 'default-target', 'syntax-repair', 'mismatch', 'incomplete', 'frozen-denied', 'stale', 'append', 'edit', 'approved', 'approval-denied', 'approval-expired', 'approval-scope', 'approval-stopped'] as const)('%s', async scenario => {
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const lease = await claim(f)
      const tool = scenario === 'append' ? chapterAppendTool : scenario === 'edit' ? chapterEditRangeTool : chapterWriteTool
      const needsApproval = scenario === 'frozen-denied' || scenario === 'approved' || scenario.startsWith('approval-')
      const content = '新正文\n下一段'
      const args = scenario === 'edit' ? { oldText: '原文', newText: content } : { content }
      let raw = JSON.stringify(args)
      if (scenario === 'wrapped') raw = JSON.stringify({ arguments: args })
      if (scenario === 'syntax-repair') raw = raw.replace('\\n', '\n')
      const tools: import('../../api/lib/ai-service.js').OpenAIToolDefinition[] = [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: { type: 'object' } } }]
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      let frame = (await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) }, tools,
        toolAuthority: [{ name: tool.name, permission: needsApproval ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })).frame
      let calls = 0
      const fetchMock = vi.fn(async () => {
        const response = calls++ === 0 ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-call', type: 'function', function: { name: tool.name, arguments: raw } }] },
          finish_reason: scenario === 'incomplete' ? 'length' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 0 } }
          : { choices: [{ delta: { content: scenario === 'stale' ? '版本冲突，需要重新读取' : '处理完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } }
        return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const invokeModel = () => chatWithTools({ messages: frame.state.messages, tools, provider: route.provider, model: route.model, reasoningEffort: 'high',
        providerBaseUrl: 'https://provider.invalid/v1', providerApiKey: 'fixture-not-real',
        durableExecution: { lease, operationKey: `exec:${frame.state.nextOperationSequence}`, attemptKey: '1', cursor: { expectedRevision: frame.revision, expectedHash: frame.snapshotHash } },
        usageLog: { userId: f.userId, agentRunId: f.runId, action: 'fixture' } })
      await invokeModel()
      frame = (await loadExecutionState(f.userId, f.runId)).frame
      expect(frame.revision).toBe(2)
      if (needsApproval && scenario !== 'frozen-denied') {
        const requestInput = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, callId: 'write-call', timeoutMs: scenario === 'approval-expired' ? 1 : 60_000,
          normalize: (raw: unknown) => ({ ...chapterWriteTool.parameters.parse(raw), chapterId: f.chapterId }) }
        const request = await requestToolApproval(lease, requestInput)
        expect((await requestToolApproval(lease, { ...requestInput, timeoutMs: 120_000 })).payload).toEqual(request.payload)
        if (scenario !== 'approval-expired') expect(await pollToolApproval(lease, requestInput)).toMatchObject({ status: 'pending', sourceEventId: request.id,
          event: { type: 'permission.ask', approvalId: request.id, args: { chapterId: f.chapterId }, allowAlways: false } })
        const decision = { userId: f.userId, runId: f.runId, requestId: request.id, callId: 'write-call', approved: scenario !== 'approval-denied', alwaysAllow: false }
        if (scenario === 'approval-expired') {
          await expect(resolveDurableApproval(decision)).rejects.toMatchObject({ code: 'RUNTIME_APPROVAL_EXPIRED' })
          expect(await pollToolApproval(lease, requestInput)).toMatchObject({ status: 'expired', event: { type: 'permission.resolved', approvalId: request.id, approved: false } })
          await expect(resolveDurableApproval(decision)).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
        } else if (scenario === 'approval-scope') {
          await expect(resolveDurableApproval({ ...decision, callId: 'another-call' })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
          await expect(resolveDurableApproval({ ...decision, alwaysAllow: true })).rejects.toMatchObject({ code: 'RUNTIME_APPROVAL_SCOPE_INVALID' })
        } else if (scenario === 'approval-stopped') {
          await stopLoopRun(f.userId, f.runId)
          await expect(resolveDurableApproval(decision)).rejects.toMatchObject({ code: 'RUNTIME_APPROVAL_NOT_PENDING' })
          expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
          const output: string[] = []
          const response = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, writeHead: vi.fn(),
            write: (chunk: string) => { output.push(chunk); return output.length !== 1 }, end: vi.fn() })
          const streaming = streamLoopRun(f.userId, f.runId, 0, response as unknown as import('express').Response)
          try {
            await vi.waitFor(() => expect(response.listenerCount('drain')).toBe(1))
            // A blocked client retains one write; durable replay remains usable
            // by another connection and does not depend on the stalled socket.
            const replay = await loadDurableEvents(f.userId, f.runId, 0, 2)
            expect(replay.map(event => event.seq)).toEqual([1, 2])
            expect(output).toHaveLength(1)
            expect(response.end).not.toHaveBeenCalled()
            response.emit('drain')
            await streaming
          } finally { response.emit('close'); await streaming }
          expect(response.end).toHaveBeenCalledOnce()
          expect(output.join('')).toContain('event: permission.ask')
          expect(output.join('')).toContain('event: run.paused')
          expect(output.join('')).not.toContain('event: run.finished')
          expect(response.listenerCount('close')).toBe(0)
          expect(response.listenerCount('drain')).toBe(0)
          return
        } else {
          expect(await resolveDurableApproval(decision)).toEqual({ resolved: true })
          expect(await resolveDurableApproval(decision)).toEqual({ resolved: true })
          expect(await pollToolApproval(lease, requestInput)).toMatchObject({ status: decision.approved ? 'approved' : 'denied', event: { type: 'permission.resolved', approvalId: request.id, approved: decision.approved } })
          await expect(resolveDurableApproval({ ...decision, approved: !decision.approved })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
          if (scenario === 'approved') {
            await Promise.all([publishDurableEvents(f.userId, f.runId), publishDurableEvents(f.userId, f.runId)])
            expect(await publishDurableEvents(f.userId, f.runId)).toEqual([])
            const replay = await loadDurableEvents(f.userId, f.runId, 0)
            expect(replay.filter(event => event.type.startsWith('permission.')).map(event => event.type)).toEqual(['permission.ask', 'permission.resolved'])
            expect(replay.map(event => event.seq)).toEqual(replay.map((_, index) => index + 1))
            expect(await loadDurableEvents(f.userId, f.runId, 1)).toEqual(replay.slice(1))
            await expect(loadDurableEvents(f.userId, f.runId, replay.length + 1)).rejects.toMatchObject({ code: 'RUNTIME_EVENT_CURSOR_AHEAD' })
            await expect(loadDurableEvents('another-user', f.runId, 0)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
            expect(await prisma.agentEventProjection.count({ where: { runId: f.runId } })).toBe(replay.length)
          }
        }
      }
      const ctx: ToolContext = { ...f, callId: 'write-call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal,
        toolAuthority: new Map([[tool.name, { permission: needsApproval ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false }]]), protectedChapterIds: new Set(),
        durableContent: { lease, operationKey: 'exec:1', chapterId: f.chapterId, expectedRevision: 1, cursor: { expectedRevision: frame.revision, expectedHash: frame.snapshotHash } } }
      if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者新修改', revision: 2 } })
      const execute = () => scenario === 'edit' ? chapterEditRangeTool.execute(ctx, { oldText: '原文', newText: content })
        : scenario === 'append' ? chapterAppendTool.execute(ctx, { content }) : chapterWriteTool.execute(ctx, { content: scenario === 'mismatch' ? '不同内容' : content })
      if (['mismatch', 'incomplete', 'frozen-denied', 'approval-scope'].includes(scenario)) {
        await expect(execute()).rejects.toMatchObject({ code: scenario === 'mismatch' ? 'RUNTIME_IDENTITY_CONFLICT' : scenario === 'incomplete' ? 'RUNTIME_STATE_CONFLICT' : 'RUNTIME_APPROVAL_REQUIRED' })
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision).toBe(1)
        expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(2)
        return
      }
      if (scenario === 'approval-denied' || scenario === 'approval-expired') {
        expect(await execute()).toMatchObject({ outcome: 'failed' })
        expect(await execute()).toMatchObject({ outcome: 'failed' })
        frame = (await loadExecutionState(f.userId, f.runId)).frame
        expect(frame.revision).toBe(4)
        expect(frame.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'write-call' })
        const operation = await prisma.agentOperation.findUniqueOrThrow({ where: { taskRootId_operationKey: { taskRootId: f.rootId, operationKey: 'exec:1' } } })
        expect(operation.status).toBe('failed')
        expect(operation.inputSnapshot).toMatchObject({ input: { rejection: { code: scenario === 'approval-expired' ? 'TOOL_APPROVAL_EXPIRED' : 'TOOL_APPROVAL_DENIED' } } })
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'effect.committed' } })).toBe(0)
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
        await invokeModel()
        expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(6)
        return
      }
      const result = await execute()
      if (scenario === 'stale') expect(result.outcome).toBe('failed')
      expect(await execute()).toEqual(result)
      frame = (await loadExecutionState(f.userId, f.runId)).frame
      expect(frame.revision).toBe(4)
      expect(frame.state.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'write-call' })
      const operation = await prisma.agentOperation.findUniqueOrThrow({ where: { taskRootId_operationKey: { taskRootId: f.rootId, operationKey: 'exec:1' } } })
      expect(operation.status).toBe(scenario === 'stale' ? 'failed' : 'succeeded')
      expect(operation.inputSnapshot).toMatchObject({ input: { args: { chapterId: f.chapterId }, normalization: { version: 1, rawArguments: raw, sourceRevision: 2 } } })
      await invokeModel()
      frame = (await loadExecutionState(f.userId, f.runId)).frame
      expect(frame.state).toMatchObject({ phase: 'idle', turn: 2, nextOperationSequence: 3 })
      expect(frame.revision).toBe(6)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(2)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(chapter.revision).toBe(2)
      expect(chapter.content).toBe(scenario === 'stale' ? '作者新修改' : scenario === 'append' ? `原文\n\n${content}` : content)
      if (scenario === 'default-target') {
        const { listLoopSessionMessages } = await import('../../api/lib/agent/session-messages.js')
        const history = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 20 })
        expect(history.messages.filter(message => message.role === 'assistant')).toHaveLength(2)
        expect(history.messages.flatMap(message => message.parts).some(part => part.type === 'tool-call' && part.snapshot !== undefined)).toBe(false)
      }
      await publishDurableEvents(f.userId, f.runId)
      const replay = await loadDurableEvents(f.userId, f.runId, 0)
      expect(replay.filter(event => event.type === 'message.start')).toHaveLength(2)
      expect(replay.filter(event => event.type === 'text.final')).toHaveLength(2)
      expect(replay.filter(event => event.type === 'tool.call')).toHaveLength(1)
      expect(replay.filter(event => event.type === 'tool.result')).toEqual([expect.objectContaining({ ok: scenario !== 'stale', callId: 'write-call' })])
      const historyBeforeReplay = await prisma.agentMessage.findMany({ where: { sessionId: f.sessionId, role: 'assistant' }, orderBy: { id: 'asc' } })
      expect(historyBeforeReplay).toHaveLength(2)
      if (scenario !== 'stale') expect(historyBeforeReplay.flatMap(message => message.parts as unknown[])).toContainEqual(expect.objectContaining({
        type: 'tool-call', callId: 'write-call', snapshot: { target: 'chapter', targetId: f.chapterId, field: 'content', previousValue: '原文' },
      }))
      expect(historyBeforeReplay.flatMap(message => message.parts as unknown[])).toContainEqual(expect.objectContaining({ type: 'tool-call', callId: 'write-call', status: scenario === 'stale' ? 'failed' : 'success' }))
      expect(await publishDurableEvents(f.userId, f.runId)).toEqual([])
      if (scenario === 'default-target') {
        await pauseDurableTask(f.userId, f.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
        await publishDurableEvents(f.userId, resumed.run.id)
      }
      expect(await prisma.agentMessage.findMany({ where: { sessionId: f.sessionId, role: 'assistant' }, orderBy: { id: 'asc' } })).toEqual(historyBeforeReplay)
    })
  }, 30_000)
})

describe.runIf(available)('actual model adapter execution cursor', () => {
  it.each(['normal', 'v2-price', 'concurrent', 'prepare-state-gap', 'result-state-gap', 'unknown', 'context', 'route', 'tool-list', 'pending-tools', 'mutated-input', 'stop-resume'] as const)('%s', async scenario => {
    await fixture(async f => {
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 1, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      let lease = await claim(f)
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: route.reasoningEffort, routeRevision: modelRouteRevision(route) },
        tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }
      const messages: import('../../api/lib/ai-service.js').ChatMessage[] = [{ role: 'user', content: '修改本章' }]
      if (scenario === 'pending-tools') messages.push({ role: 'assistant', content: null, toolCalls: [{ id: 'unanswered', name: 'chapter_read', arguments: '{}' }] })
      const initial = await initializeExecutionState(lease, { configuration, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
        phase: 'idle', pendingOperationId: null, messages, successfulToolSignatures: [] } })
      const request = { messages, tools: [] as import('../../api/lib/ai-service.js').OpenAIToolDefinition[], model: route.model, provider: route.provider,
        reasoningEffort: 'high' as const, providerApiKey: 'fixture-not-real', providerBaseUrl: 'https://provider.invalid/v1',
        durableExecution: { lease, operationKey: 'exec:0', attemptKey: '1', cursor: { expectedRevision: 0, expectedHash: initial.frame.snapshotHash },
          ...(scenario === 'v2-price' ? { price: { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'fixture-model-v2', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } } } : {}) },
        usageLog: { userId: f.userId, agentRunId: f.runId, action: 'fixture' } }
      if (scenario === 'context') request.messages = [{ role: 'user', content: '错误地恢复其他章节' }]
      if (scenario === 'route') request.providerBaseUrl = 'https://changed-provider.invalid/v1'
      if (scenario === 'tool-list') request.tools = [{ type: 'function', function: { name: 'unexpected', description: '', parameters: {} } }]
      const fetchMock = vi.fn(async () => {
        const pending = await loadExecutionState(f.userId, lease.runId)
        expect(pending.frame.state.phase).toBe('awaiting_operation')
        expect(pending.frame.state.turn).toBe(1)
        const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operationId: pending.frame.state.pendingOperationId! } })
        expect(attempt.status).toBe('dispatched')
        if (scenario === 'stop-resume') await pauseDurableTask(f.userId, lease.runId)
        if (scenario === 'result-state-gap') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId,
          runId: lease.runId, eventKey: `state:${f.rootId}:2`, type: 'fixture.collision', payload: {} } })
        if (scenario === 'unknown') throw new Error('fixture connection lost')
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '完整结果' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      })
      vi.stubGlobal('fetch', fetchMock)
      if (scenario === 'prepare-state-gap') {
        await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: lease.runId,
          eventKey: `state:${f.rootId}:1`, type: 'fixture.collision', payload: {} } })
        await expect(chatWithTools(request)).rejects.toMatchObject({ code: 'P2002' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(0)
        expect((await loadExecutionState(f.userId, f.runId)).frame.revision).toBe(0)
        await prisma.agentExecutionOutbox.delete({ where: { eventKey: `state:${f.rootId}:1` } })
      }
      if (['context', 'route', 'tool-list', 'pending-tools'].includes(scenario)) {
        await expect(chatWithTools(request)).rejects.toMatchObject({ code: scenario === 'pending-tools' ? 'RUNTIME_TOOL_RESULTS_REQUIRED' : 'RUNTIME_IDENTITY_CONFLICT' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(0)
        return
      }
      let running = chatWithTools(request)
      if (scenario === 'concurrent') running = Promise.allSettled([running, chatWithTools(request)]).then(results => {
        const completed = results.find(result => result.status === 'fulfilled')
        expect(completed).toBeDefined()
        for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        if (completed?.status !== 'fulfilled') throw new Error('Neither invocation completed')
        return completed.value
      })
      if (scenario === 'mutated-input') request.messages.push({ role: 'user', content: '调用后改动不应污染原请求' })
      if (['unknown', 'result-state-gap', 'stop-resume'].includes(scenario)) {
        await expect(running).rejects.toBeDefined()
        expect((await loadExecutionState(f.userId, f.runId)).frame.state.phase).toBe('awaiting_operation')
        if (scenario === 'unknown') {
          await expect(chatWithTools(request)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
          expect(fetchMock).toHaveBeenCalledOnce()
          return
        }
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
        if (scenario === 'result-state-gap') await prisma.agentExecutionOutbox.delete({ where: { eventKey: `state:${f.rootId}:2` } })
        else {
          const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
          const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
          lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'resumed')
          request.durableExecution.lease = lease
          request.usageLog.agentRunId = lease.runId
        }
      } else expect(await running).toMatchObject({ content: '完整结果', billing: { status: 'settled', chargedMilli: 1, exhausted: true } })
      request.messages = [{ role: 'user', content: '修改本章' }]
      expect(await chatWithTools(request)).toMatchObject({ content: '完整结果', billing: { chargedMilli: 1 } })
      expect(fetchMock).toHaveBeenCalledOnce()
      const restored = await loadExecutionState(f.userId, lease.runId)
      expect(restored.frame.revision).toBe(2)
      expect(restored.frame.state).toMatchObject({ phase: 'idle', turn: 1, nextOperationSequence: 1, pendingOperationId: null })
      expect(restored.frame.state.messages).toEqual([{ role: 'user', content: '修改本章' }, { role: 'assistant', content: '完整结果' }])
      if (scenario === 'v2-price') expect((await prisma.creditLedgerEntry.findFirstOrThrow({ where: { userId: f.userId } })).metadata).toMatchObject({ pricingVersion: 'credits-v2-itemized', rateCardId: 'fixture-model-v2' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
    })
  }, 30_000)
})

describe.runIf(available)('explicit durable resume admission', () => {
  it('checks session ownership before cancellation and revokes an owned task before deletion', async () => {
    await fixture(async f => {
      const lease = await claim(f)
      const controller = new AbortController()
      registerActiveRun(f.runId, { userId: f.userId, sessionId: f.sessionId, controller })
      try {
        await expect(deleteAgentSessionData('another-user', f.sessionId)).rejects.toMatchObject({ status: 403, code: 'AGENT_SESSION_FORBIDDEN' })
        expect(controller.signal.aborted).toBe(false)
        await withRunLease(lease, async () => {})
        await expect(deleteAgentSessionData(f.userId, f.sessionId)).resolves.toMatchObject({ deleted: true })
        expect(controller.signal.aborted).toBe(true)
        expect(await prisma.agentSession.findUnique({ where: { id: f.sessionId } })).toBeNull()
        await expect(withRunLease(lease, async () => {})).rejects.toThrow()
      } finally { deregisterActiveRun(f.runId) }
    })
  })

  it('dispatches the saved root from the continue API and replays a lost response without another executor', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const original = await initializeExecutionState(token, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] } })
      await pauseDurableTask(f.userId, f.runId)
      const creditGate = vi.spyOn(credits, 'assertCreditAccess').mockRejectedValue(new Error('fixture exhausted balance'))
      let release!: () => void
      const wait = new Promise<void>(resolve => { release = resolve })
      const execute = vi.spyOn(runtimeExecutor, 'runReviewedDurableExecution').mockImplementation(async lease => {
        expect(lease.taskRootId).toBe(f.rootId)
        expect((await loadExecutionState(f.userId, lease.runId)).frame).toEqual(original.frame)
        await wait
        return { kind: 'needs_attention', reason: 'fixture exit', frame: original.frame }
      })
      let resumedId: string | undefined
      try {
        const first = await continueLoopRun(f.userId, f.runId)
        resumedId = first.runId
        expect(first.runId).not.toBe(f.runId)
        expect(getActiveRun(first.runId)).toBeDefined()
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
        const replay = await continueLoopRun(f.userId, f.runId)
        expect(replay.runId).toBe(first.runId)
        expect(execute).toHaveBeenCalledOnce()
        expect(creditGate).not.toHaveBeenCalled()
        expect(await prisma.agentRun.count({ where: { taskRootId: f.rootId } })).toBe(2)
        expect(await prisma.agentMessage.count({ where: { runId: first.runId, role: 'user' } })).toBe(0)
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      } finally {
        release()
        if (resumedId) await vi.waitFor(() => expect(getActiveRun(resumedId!)).toBeUndefined(), { timeout: 5000 })
      }
    })
  }, 30_000)

  it('serializes two paused roots against the same account concurrency limit', async () => {
    await fixture(async f => {
      const previousLimit = env.agentUserMaxConcurrent
      try {
        env.agentUserMaxConcurrent = 1
        const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '第二个任务根' } })
        const runId = randomUUID(), sourceMessageId = randomUUID()
        const spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: f.chapterId, prompt: '只检查本章' })
        await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: session.id, chapterId: f.chapterId,
          mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)) } })
        await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: '只检查本章' }] } })
        await initializeDurableTask({ userId: f.userId, runId, sourceMessageId })
        const requests: Array<{ userId: string; runId: string; pauseEventId: string }> = []
        for (const target of [f.runId, runId]) {
          const token = await claim({ userId: f.userId, runId: target })
          await initializeExecutionState(token, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
            model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
          snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
            messages: [{ role: 'user', content: target === f.runId ? '修改本章' : '只检查本章' }], successfulToolSignatures: [] } })
          await pauseDurableTask(f.userId, target)
          const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: target, type: 'run.paused' } })
          requests.push({ userId: f.userId, runId: target, pauseEventId: pause.id })
        }
        const results = await Promise.allSettled(requests.map(request => resumeDurableTask(request)))
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find(result => result.status === 'rejected')
        expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ code: 'RUN_LIMIT' })
        expect(await prisma.agentRun.count({ where: { userId: f.userId, status: 'queued' } })).toBe(1)
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRoot: { userId: f.userId }, type: 'run.resume.queued' } })).toBe(1)
      } finally { env.agentUserMaxConcurrent = previousLimit }
    })
  }, 30_000)

  it.each(['replay', 'restop', 'stale', 'scope', 'missing-state', 'corrupt-state', 'incomplete-fence', 'limit', 'corrupt-resume', 'pending'] as const)('%s', async scenario => {
    await fixture(async f => {
      const token = await claim(f)
      const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }
      const snapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] }
      let original = scenario === 'missing-state' ? null : await initializeExecutionState(token, { configuration, snapshot })
      if (scenario === 'pending' && original) {
        const operation = await prepareOperation(token, { key: 'exec:0', kind: 'provider', action: 'chat', input: {} })
        await saveExecutionState(token, { expectedRevision: 0, expectedHash: original.frame.snapshotHash,
          snapshot: { ...snapshot, phase: 'awaiting_operation', pendingOperationId: operation.id, turn: 1, nextOperationSequence: 1 } })
        const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
        await markProviderDispatched(token, attempt.id)
        original = await loadExecutionState(f.userId, f.runId)
      }
      const originalBudget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
      const originalRoot = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
      const startRequest = { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, mode: 'build', prompt: '修改本章',
        selection: { text: '原选区', start: 0, end: 3 }, pinnedSkillIds: ['original-skill'], qualityMode: 'premium' }
      await prisma.agentRun.update({ where: { id: f.runId }, data: { startRequest } })
      await pauseDurableTask(f.userId, f.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
      const request = { userId: f.userId, runId: f.runId, pauseEventId: pause.id }
      const previousLimit = env.agentUserMaxConcurrent
      if (scenario === 'replay') {
        await prisma.agentMessage.create({ data: { id: randomUUID(), runId: f.runId, sessionId: f.sessionId, role: 'assistant',
          parts: [{ type: 'tool-call', callId: 'interrupted-history', toolName: 'chapter_read', title: '读取章节', args: {}, status: 'running' }] } })
        const { listLoopSessionMessages } = await import('../../api/lib/agent/session-messages.js')
        const stopped = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 20 })
        expect(stopped).toMatchObject({ activeRunId: null, resumeRunId: f.runId })
        expect(stopped.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ callId: 'interrupted-history', status: 'failed', summary: '已停止' }))
      }
      try {
        if (scenario === 'stale' || scenario === 'limit') {
          const sessionId = scenario === 'limit' ? (await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '并发任务' } })).id : f.sessionId
          await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued' } })
          if (scenario === 'limit') env.agentUserMaxConcurrent = 1
        }
        if (scenario === 'corrupt-state') await prisma.agentExecutionState.update({ where: { taskRootId: f.rootId }, data: { configurationHash: 'b'.repeat(64) } })
        if (scenario === 'incomplete-fence') await prisma.agentRunLease.update({ where: { runId: f.runId }, data: { enabled: true } })
        const errors: Record<string, string> = { stale: 'STALE_RESUME_TARGET', scope: 'RUNTIME_SCOPE_MISMATCH', 'missing-state': 'RUNTIME_STATE_REQUIRED',
          'corrupt-state': 'RUNTIME_RECEIPT_INVALID', 'incomplete-fence': 'RUNTIME_STATE_CONFLICT', limit: 'RUN_LIMIT' }
        if (errors[scenario]) {
          await expect(resumeDurableTask(scenario === 'scope' ? { ...request, userId: 'other-user' } : request)).rejects.toMatchObject({ code: errors[scenario] })
          expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('paused')
          expect(await prisma.agentRun.count({ where: { taskRootId: f.rootId } })).toBe(1)
          return
        }
        const [a, b] = await Promise.all([resumeDurableTask(request), resumeDurableTask(request)])
        expect(a.run.id).toBe(b.run.id)
        expect(a.replay === b.replay).toBe(false)
        expect(a.run.id).not.toBe(f.runId)
        expect(a.run.status).toBe('queued')
        if (scenario === 'replay') {
          const { listLoopSessionMessages } = await import('../../api/lib/agent/session-messages.js')
          const waiting = await listLoopSessionMessages(f.userId, f.sessionId, { runLimit: 1 })
          expect(waiting).toMatchObject({ activeRunId: a.run.id, resumeRunId: null })
          expect(waiting.messages.some(message => message.id === f.sourceMessageId)).toBe(true)
          const { deleteLoopSessionMessage, rollbackLoopSessionFromMessage } = await import('../../api/lib/agent/session-messages.js')
          await expect(deleteLoopSessionMessage(f.userId, f.sessionId, f.sourceMessageId)).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
          await expect(rollbackLoopSessionFromMessage(f.userId, f.sessionId, f.sourceMessageId)).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
          expect(waiting.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ callId: 'interrupted-history', status: 'running' }))
        }
        expect(a.run.startRequest).toEqual(startRequest)
        expect(await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: a.run.id } })).toMatchObject({ enabled: true, ownerId: null, expiresAt: null })
        expect(await prisma.agentRun.count({ where: { taskRootId: f.rootId } })).toBe(2)
        expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(originalBudget)
        const restored = await loadExecutionState(f.userId, a.run.id)
        expect(restored.frame).toEqual(original!.frame)
        expect(restored.originalRequest).toEqual(original!.originalRequest)
        expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).createdAt).toEqual(originalRoot.createdAt)
        await expect(withRunLease(token, async () => 'stale write')).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
        const resumed = await claim({ userId: f.userId, runId: a.run.id }, 'explicitly-resumed')
        if (scenario === 'pending') expect((await readTaskBudget(resumed)).unresolvedAttempts).toBe(1n)
        if (scenario === 'corrupt-resume') {
          const event = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `resume:${pause.id}` } })
          await prisma.agentExecutionOutbox.update({ where: { id: event.id }, data: { payload: { ...(event.payload as Record<string, Prisma.InputJsonValue>), snapshotHash: 'f'.repeat(64) } } })
          await expect(resumeDurableTask(request)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        } else if (scenario === 'restop') {
          await pauseDurableTask(f.userId, a.run.id)
          await expect(resumeDurableTask(request)).rejects.toMatchObject({ code: 'STALE_RESUME_TARGET' })
          const secondPause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
          const next = await resumeDurableTask({ userId: f.userId, runId: a.run.id, pauseEventId: secondPause.id })
          expect(next.run.id).not.toBe(a.run.id)
          expect((await loadExecutionState(f.userId, next.run.id)).frame.snapshotHash).toBe(original!.frame.snapshotHash)
        } else expect((await resumeDurableTask(request)).run.id).toBe(a.run.id)
      } finally { env.agentUserMaxConcurrent = previousLimit }
    })
  }, 30_000)
})

describe.runIf(available)('receipt context reduction', () => {
  it.each(['replay', 'unknown', 'corrupt', 'missing-event', 'wrong-cursor', 'tool', 'new-run', 'wrong-call', 'wrong-args', 'incomplete'] as const)('%s', async scenario => {
    await fixture(async f => {
      let token = await claim(f)
      const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }
      const snapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] }
      let frame = (await initializeExecutionState(token, { configuration, snapshot })).frame
      const op = await prepareOperation(token, { key: 'exec:0', kind: 'provider', action: 'chat', input: {} })
      frame = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
        snapshot: { ...frame.state, phase: 'awaiting_operation', pendingOperationId: op.id, turn: 1, nextOperationSequence: 1 } })
      const cursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, operationId: op.id }
      const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const args = { chapterId: f.chapterId, content: '新正文' }
      const toolCase = ['tool', 'new-run', 'wrong-call', 'wrong-args', 'incomplete'].includes(scenario)
      const result = { content: '现在写入', reasoning: '已核对原任务', finishReason: toolCase ? 'tool_calls' : 'stop',
        toolCalls: toolCase ? [{ id: 'call-1', name: 'chapter_write', arguments: JSON.stringify(args), ...(scenario === 'incomplete' ? { incomplete: true } : {}) }] : [],
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: 0, promptCacheMissTokens: 10 } }
      await recordProviderResult({ userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash,
        outcome: scenario === 'unknown' ? 'unknown' : 'succeeded', result })
      if (scenario === 'corrupt') await prisma.agentProviderAttempt.update({ where: { id: attempt.id }, data: { result: { content: '篡改' } } })
      if (scenario === 'missing-event') await prisma.agentExecutionOutbox.deleteMany({ where: { operationId: op.id, type: 'provider.result.recorded' } })
      if (['unknown', 'corrupt', 'missing-event', 'wrong-cursor'].includes(scenario)) {
        await expect(reduceExecutionReceipt(token, scenario === 'wrong-cursor' ? { ...cursor, operationId: randomUUID() } : cursor)).rejects.toMatchObject({ code:
          scenario === 'unknown' ? 'RUNTIME_RECONCILIATION_REQUIRED' : scenario === 'wrong-cursor' ? 'RUNTIME_STATE_CONFLICT' : 'RUNTIME_RECEIPT_INVALID' })
        expect((await loadExecutionState(f.userId, f.runId)).head.revision).toBe(1)
        return
      }
      const [a, b] = await Promise.all([reduceExecutionReceipt(token, cursor), reduceExecutionReceipt(token, cursor)])
      expect(a.snapshotHash).toBe(b.snapshotHash)
      expect(a.state.messages).toHaveLength(2)
      expect(a.state.messages[0]).toEqual(snapshot.messages[0])
      expect(a.state.messages[1]).toMatchObject({ role: 'assistant', content: result.content, reasoning: result.reasoning })
      expect(a.state.phase).toBe('idle') // stop is not task-completion proof
      if (!toolCase) return
      const write = await prepareOperation(token, { key: 'exec:1', kind: 'tool', action: 'chapter_write', input: {
        callId: scenario === 'wrong-call' ? 'old-call' : 'call-1', novelId: f.novelId, chapterId: f.chapterId, expectedRevision: 1,
        args: scenario === 'wrong-args' ? { ...args, content: '不同正文' } : args } })
      frame = await saveExecutionState(token, { expectedRevision: a.revision, expectedHash: a.snapshotHash,
        snapshot: { ...a.state, phase: 'awaiting_operation', pendingOperationId: write.id, nextOperationSequence: 2 } })
      let output = '正文已落库'
      if (scenario === 'tool' || scenario === 'new-run') {
        vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
        const ctx: ToolContext = { ...f, callId: 'call-1', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal,
          toolAuthority: new Map([['chapter_write', { permission: 'allow', alwaysConfirm: false, dangerous: false }]]), protectedChapterIds: new Set(),
          durableContent: { lease: token, operationKey: 'exec:1', chapterId: f.chapterId, expectedRevision: 1 } }
        output = (await chapterWriteTool.execute(ctx, args)).output
      } else await commitOperationEffect(token, write.id, write.inputHash, async () => ({ toolResult: { output } }))
      if (scenario === 'new-run') {
        const resumedRun = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
          status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: JSON.parse(JSON.stringify(f.spec)) } })
        await attachRunToDurableTask({ userId: f.userId, runId: resumedRun.id, taskRootId: f.rootId })
        await revokeRunLease(f.userId, f.runId)
        token = await claim({ userId: f.userId, runId: resumedRun.id }, 'resumed-owner')
      }
      const toolCursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, operationId: write.id }
      if (scenario !== 'tool' && scenario !== 'new-run') {
        await expect(reduceExecutionReceipt(token, toolCursor)).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
        expect((await loadExecutionState(f.userId, f.runId)).head.revision).toBe(3)
        return
      }
      const reduced = await reduceExecutionReceipt(token, toolCursor)
      expect(reduced.state.messages).toHaveLength(3)
      expect(reduced.state.messages[2]).toEqual({ role: 'tool', toolCallId: 'call-1', content: `<tool_output tool="chapter_write">\n${output}\n</tool_output>` })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision).toBe(2)
      expect((await reduceExecutionReceipt(token, toolCursor)).snapshotHash).toBe(reduced.snapshotHash)
      expect((await reduceExecutionReceipt(token, cursor)).revision).toBe(2)
      expect((await loadExecutionState(f.userId, f.runId)).head.revision).toBe(4)
      expect(await prisma.agentProviderAttempt.count({ where: { operationId: op.id } })).toBe(1)
    })
  }, 30_000) // Multiple real PG transactions, including cross-run recovery and CAS retries.
})

async function pricedCall(f: { userId: string; runId: string }, balance = 1, price: DurableTokenPrice = { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }) {
  const window = getCreditWindow()
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: balance, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
  const token = await claim(f)
  const operation = await preparePricedProviderOperation(token, { key: 'priced:model', action: 'chat', request: { prompt: '原请求' },
    price })
  const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: { prompt: '原请求' } })
  await markProviderDispatched(token, attempt.id)
  const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
  await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '本次已经生成的结果' } })
  return { token, operation, attempt, identity }
}

describe.skipIf(!available)('B0 durable runtime foundation (real isolated PG)', () => {
  it('V2 admission selects an active card but replay retains its price after retirement', async () => {
    await fixture(async f => {
      await prisma.user.update({ where: { id: f.userId }, data: { role: 'admin', isSuperAdmin: true } })
      const lease = await claim(f)
      const price: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: 'standard', multiplierBps: 11000,
        rateCardId: randomUUID(), rates: { inputNano: 110000, cacheNano: 110000, outputNano: 1100000 } }
      await createRateCard(f.userId, price)
      await transitionRateCard(f.userId, { id: price.rateCardId, expectedRevision: 0, status: 'shadow', evidence: { note: 'fixture' } })
      await transitionRateCard(f.userId, { id: price.rateCardId, expectedRevision: 1, status: 'approved', evidence: { note: 'synthetic test only', reportHash: 'b'.repeat(64), shadowDays: 7,
        totalFeeDeviationPercent: 0, userTaskP95AbsoluteDeviationPercent: 0, cashCostIncreasePercent: 0, allGroupsReviewed: true, qualityPassed: true } })
      await transitionRateCard(f.userId, { id: price.rateCardId, expectedRevision: 2, status: 'active', evidence: { note: 'fixture', publicNoticeRef: 'fixture' } })
      expect(await resolveDurableTokenPrice(lease, 'v2:model', 'standard', 99999)).toEqual(price)
      await preparePricedProviderOperation(lease, { key: 'v2:model', action: 'chat', request: {}, price })
      await transitionRateCard(f.userId, { id: price.rateCardId, expectedRevision: 3, status: 'retired', evidence: { note: 'fixture retirement' } })
      expect(await resolveDurableTokenPrice(lease, 'v2:model', 'standard', 99999)).toEqual(price)
      await expect(resolveDurableTokenPrice(lease, 'new:model', 'standard', 99999)).rejects.toMatchObject({ code: 'RUNTIME_PRICE_REQUIRED' })
    })
  })
  it.each(['known-cache', 'unknown-discount', 'unknown-equal'] as const)('V2 settlement %s', async scenario => {
    await fixture(async f => {
      const price: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 48000,
        rateCardId: 'fixture-v2-not-production', rates: { inputNano: 100000, cacheNano: scenario === 'unknown-equal' ? 100000 : 20000, outputNano: 1000000 } }
      const { identity, operation } = await pricedCall(f, 10000, price)
      const known = scenario === 'known-cache'
      await recordProviderUsage({ ...identity, revision: 1, usage: { source: 'reported', promptTokens: 10000, completionTokens: 1000, cacheHitTokens: known ? 5000 : null, cacheMissTokens: known ? 5000 : null } })
      if (scenario === 'unknown-discount') {
        expect(await settleProviderOperation(identity)).toEqual({ status: 'pending', reason: 'cache_usage_not_confirmed' })
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
        return
      }
      const amount = known ? 1600 : 2000
      const results = await Promise.all([settleProviderOperation(identity), settleProviderOperation(identity)])
      for (const result of results) expect(result).toMatchObject({ status: 'settled', amountMilli: amount, chargedMilli: amount })
      const rows = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId } })
      expect(rows).toHaveLength(1)
      expect(rows[0].metadata).toMatchObject({ pricingVersion: 'credits-v2-itemized', rateCardId: price.rateCardId, rates: price.rates })
      expect(await prisma.agentExecutionOutbox.count({ where: { operationId: operation.id, type: 'credit.settled' } })).toBe(1)
    })
  })
  it.each(['checkpoint', 'no-progress', 'legacy-policy', 'child-provider'] as const)('frozen turn budget %s', async scenario => {
    const previousTurns = env.agentMaxTurns
    env.agentMaxTurns = 1
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    try {
      await fixture(async f => {
        const token = await claim(f)
        const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
          model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }
        const snapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] }
        env.agentMaxTurns = 999
        const budget = await readTaskBudget(token)
        expect(taskTurnLimit(budget.policy, 0)).toBe(1)
        if (scenario === 'legacy-policy') {
          const legacy = Object.fromEntries(Object.entries(budget.policy).filter(([key]) => !['initialTurns', 'turnSlice'].includes(key)))
          legacy.version = 1
          const saved = runtimeJson(legacy)
          await prisma.agentTaskBudget.update({ where: { taskRootId: f.rootId }, data: { policy: saved.value, policyHash: saved.hash } })
          expect((await readTaskBudget(token)).policy.version).toBe(1)
          await expect(initializeExecutionState(token, { configuration, snapshot })).rejects.toMatchObject({ code: 'RUNTIME_TURN_POLICY_REQUIRED' })
          return
        }
        let frame = (await initializeExecutionState(token, { configuration, snapshot })).frame
        const first = await prepareOperation(token, { key: 'exec:0', kind: scenario === 'child-provider' ? 'tool' : 'provider', action: 'chat', input: {} })
        const provider = scenario === 'child-provider' ? await prepareOperation(token, { key: 'child:0', kind: 'provider', action: 'chat', parentOperationId: first.id, input: {} }) : first
        const attempt = await prepareProviderAttempt(token, { operationId: provider.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
        await expect(markProviderDispatched(token, attempt.id)).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
        frame = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...snapshot, phase: 'awaiting_operation', pendingOperationId: first.id, turn: scenario === 'child-provider' ? 0 : 1, nextOperationSequence: 1 } })
        await markProviderDispatched(token, attempt.id)
        const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
        await recordProviderUsage({ ...identity, revision: 1, usage: reported })
        await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '当前章节已读取' } })
        if (scenario === 'child-provider') {
          expect((await loadExecutionState(f.userId, f.runId)).frame.state.turn).toBe(0)
          expect((await readTaskBudget(token)).usedTokens).toBe(10n)
          const unrelated = await prepareOperation(token, { key: 'unrelated', kind: 'provider', action: 'chat', input: {} })
          const blocked = await prepareProviderAttempt(token, { operationId: unrelated.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
          await expect(markProviderDispatched(token, blocked.id)).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
          return
        }
        frame = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, phase: 'idle', pendingOperationId: null } })
        const checkpointSnapshot = { version: 1, taskRootId: f.rootId, context: '待校验', remainingWork: ['校验'], trigger: 'turns' }
        if (scenario === 'no-progress') {
          await expect(commitRuntimeCheckpoint(token, { expectedCheckpointCount: 0, progressOperationId: first.id, snapshot: checkpointSnapshot })).rejects.toMatchObject({ code: 'RUNTIME_PROGRESS_REQUIRED' })
          expect((await readTaskBudget(token)).budget.checkpointCount).toBe(0)
          return
        }
        const write = await prepareOperation(token, { key: 'exec:1', kind: 'tool', action: 'chapter_write',
          input: { callId: 'write', novelId: f.novelId, chapterId: f.chapterId, expectedRevision: 1, args: { chapterId: f.chapterId, content: '真实修订内容' } } })
        frame = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, phase: 'awaiting_operation', pendingOperationId: write.id, nextOperationSequence: 2 } })
        await chapterWriteTool.execute({ ...f, callId: 'write', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal,
          toolAuthority: new Map([['chapter_write', { permission: 'allow', alwaysConfirm: false, dangerous: false }]]),
          durableContent: { lease: token, operationKey: 'exec:1', chapterId: f.chapterId, expectedRevision: 1 } }, { chapterId: f.chapterId, content: '真实修订内容' })
        frame = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, phase: 'idle', pendingOperationId: null } })
        const next = await prepareOperation(token, { key: 'exec:2', kind: 'provider', action: 'chat', input: {} })
        const nextState = { ...frame.state, phase: 'awaiting_operation', pendingOperationId: next.id, turn: 2, nextOperationSequence: 3 }
        await expect(saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: nextState })).rejects.toMatchObject({ code: 'RUNTIME_TURN_CHECKPOINT_REQUIRED' })
        const input = { expectedCheckpointCount: 0, progressOperationId: write.id, snapshot: checkpointSnapshot }
        await commitRuntimeCheckpoint(token, input)
        await commitRuntimeCheckpoint(token, input)
        const advanced = await readTaskBudget(token)
        expect(taskTurnLimit(advanced.policy, advanced.budget.checkpointCount)).toBe(51)
        expect(advanced.usedTokens).toBe(10n)
        frame = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...nextState, checkpointIndex: 1 } })
        const nextAttempt = await prepareProviderAttempt(token, { operationId: next.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
        expect((await markProviderDispatched(token, nextAttempt.id)).dispatchGranted).toBe(true)
        expect(frame.state.turn).toBe(2)
      }, 500)
    } finally { env.agentMaxTurns = previousTurns }
  })

  it.each(['replay', 'paused', 'new-run', 'unknown', 'counter', 'configuration', 'frame-corrupt', 'head-corrupt', 'outbox-failure', 'late-bootstrap'] as const)('execution state preserves %s', async scenario => {
    await fixture(async f => {
      const token = await claim(f)
      const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'original-model', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }
      const snapshot = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] }
      if (scenario === 'late-bootstrap') {
        await prepareOperation(token, { key: 'already-executed', kind: 'tool', action: 'chapter_read', input: {} })
        await expect(initializeExecutionState(token, { configuration, snapshot })).rejects.toMatchObject({ code: 'RUNTIME_STATE_REQUIRED' })
        return
      }
      const initialized = await initializeExecutionState(token, { configuration, snapshot })
      expect((await initializeExecutionState(token, { configuration, snapshot })).frame.snapshotHash).toBe(initialized.frame.snapshotHash)
      if (scenario === 'configuration') {
        await expect(initializeExecutionState(token, { configuration: { ...configuration, model: { ...configuration.model, modelName: 'other-model' } }, snapshot })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
        await expect(initializeExecutionState(token, { configuration: { ...configuration, model: { ...configuration.model, apiKey: 'must-not-persist' } }, snapshot })).rejects.toMatchObject({ code: 'RUNTIME_STATE_INVALID' })
        expect((await loadExecutionState(f.userId, f.runId)).configuration.model.modelName).toBe('original-model')
        return
      }
      const operation = await prepareOperation(token, { key: 'exec:0', kind: 'provider', action: 'chat', input: {} })
      const pending = { ...snapshot, phase: 'awaiting_operation', pendingOperationId: operation.id, turn: 1, nextOperationSequence: 1 }
      const update = { expectedRevision: 0, expectedHash: initialized.frame.snapshotHash, snapshot: pending }
      if (scenario === 'outbox-failure') {
        await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId, eventKey: `state:${f.rootId}:1`, type: 'fixture.collision', payload: {} } })
        await expect(saveExecutionState(token, update)).rejects.toMatchObject({ code: 'P2002' })
        expect((await loadExecutionState(f.userId, f.runId)).head.revision).toBe(0)
        expect(await prisma.agentExecutionFrame.count({ where: { taskRootId: f.rootId } })).toBe(1)
        return
      }
      const [a, b] = await Promise.all([saveExecutionState(token, update), saveExecutionState(token, update)])
      expect(a.snapshotHash).toBe(b.snapshotHash)
      expect((await initializeExecutionState(token, { configuration, snapshot })).head.revision).toBe(1)
      await expect(saveExecutionState(token, { ...update, snapshot: { ...pending, messages: [{ role: 'user', content: '偷偷切换任务' }] } })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      if (scenario === 'counter') {
        await expect(saveExecutionState(token, { expectedRevision: 1, expectedHash: a.snapshotHash, snapshot })).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
      } else if (scenario === 'unknown') {
        await expect(saveExecutionState(token, { expectedRevision: 1, expectedHash: a.snapshotHash, snapshot: { ...pending, phase: 'idle', pendingOperationId: null } })).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      } else if (scenario === 'paused') {
        await pauseDurableTask(f.userId, f.runId)
        const restored = await loadExecutionState(f.userId, f.runId)
        expect(restored.frame.state).toEqual(pending)
        expect(restored.originalRequest).toEqual([{ type: 'text', text: '修改本章' }])
        await expect(saveExecutionState(token, update)).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
        await expect(loadExecutionState('other-user', f.runId)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
      } else if (scenario === 'new-run') {
        const resumedRun = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
          status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: JSON.parse(JSON.stringify(f.spec)) } })
        await attachRunToDurableTask({ userId: f.userId, runId: resumedRun.id, taskRootId: f.rootId })
        await revokeRunLease(f.userId, f.runId)
        const resumed = await claim({ userId: f.userId, runId: resumedRun.id }, 'resumed-owner')
        expect((await loadExecutionState(f.userId, resumedRun.id)).frame.state).toEqual(pending)
        expect((await saveExecutionState(resumed, update)).originRunId).toBe(f.runId)
        expect((await loadExecutionState(f.userId, resumedRun.id)).head.revision).toBe(1)
      } else if (scenario === 'frame-corrupt') {
        await prisma.agentExecutionFrame.update({ where: { taskRootId_revision: { taskRootId: f.rootId, revision: 1 } }, data: { snapshot } })
        await expect(loadExecutionState(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      } else if (scenario === 'head-corrupt') {
        await prisma.agentExecutionState.update({ where: { taskRootId: f.rootId }, data: { revision: 0 } })
        await expect(loadExecutionState(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      } else {
        const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
        await markProviderDispatched(token, attempt.id)
        await recordProviderResult({ userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash, outcome: 'succeeded', result: { content: '已读取当前状态' } })
        const final = await saveExecutionState(token, { expectedRevision: 1, expectedHash: a.snapshotHash,
          snapshot: { ...pending, phase: 'idle', pendingOperationId: null, messages: [...pending.messages, { role: 'assistant', content: '已读取当前状态' }] } })
        expect(final.revision).toBe(2)
        expect((await saveExecutionState(token, update)).revision).toBe(1)
        expect((await loadExecutionState(f.userId, f.runId)).head.revision).toBe(2)
      }
    })
  })

  it.each(['route', 'scope', 'max-epoch', 'late-receipt', 'legacy-cleanup'] as const)('durable stop fences %s', async scenario => {
    await fixture(async f => {
      const token = await claim(f)
      const effect = await prepareOperation(token, { key: 'write-after-stop', kind: 'tool', action: 'chapter_write', input: {} })
      const provider = await prepareOperation(token, { key: 'in-flight', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: provider.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const originalBudget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
      if (scenario === 'legacy-cleanup') {
        expect(await recoverLegacyOrphanRun(f.userId, f.runId)).toBe(false)
        expect(await pauseLegacyOrphanRun(f.userId, f.runId)).toBe(false)
        expect(await fenceLocallyStoppedLegacyRun(f.userId, f.runId)).toBe(false)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('queued')
        await renewRunLease(token)
        return
      }
      let otherRunId: string | undefined
      if (scenario === 'scope') {
        otherRunId = randomUUID()
        const spec = buildTaskSpec({ runId: otherRunId, novelId: f.novelId, chapterId: f.chapterId, prompt: '另一个独立任务' })
        await prisma.agentRun.create({ data: { id: otherRunId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, status: 'queued',
          mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)) } })
        const message = await prisma.agentMessage.create({ data: { runId: otherRunId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: '另一个独立任务' }] } })
        await initializeDurableTask({ userId: f.userId, runId: otherRunId, sourceMessageId: message.id })
      }
      if (scenario === 'max-epoch') await prisma.agentRunLease.update({ where: { runId: f.runId }, data: { epoch: 9223372036854775807n } })
      if (scenario === 'route') expect(await stopLoopRun(f.userId, f.runId)).toEqual({ stopped: true })
      else await pauseDurableTask(f.userId, f.runId)
      expect(await stopLoopRun(f.userId, f.runId)).toEqual({ stopped: true })
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('paused')
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })).enabled).toBe(false)
      expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(originalBudget)
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'run.paused' } })).toBe(1)
      await expect(commitOperationEffect(token, effect.id, effect.inputHash, async tx => {
        await tx.chapter.update({ where: { id: f.chapterId }, data: { content: '不应提交' } }); return {}
      })).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
      await expect(claim(f, 'new-worker')).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      if (otherRunId) await renewRunLease(await claim({ userId: f.userId, runId: otherRunId }, 'other-root-worker'))
      if (scenario === 'late-receipt') {
        const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
        await recordProviderUsage({ ...identity, revision: 1, usage: reported })
        await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '已发生调用的迟到结果' } })
        expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('succeeded')
        expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('paused')
      }
    })
  })


  it('recovers a legacy orphan atomically and does not duplicate its interruption message', async () => {
    await fixture(async f => {
      const old = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator' } })
      const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, agentRunId: old.id,
        targetType: 'agentRun', targetId: old.id, providerType: 'text', providerMode: 'live', modelName: 'fixture',
        action: 'workspaceAgent', modelTier: 'speed', durationMs: 0, billingStatus: 'prepared', usageSource: 'prepared' } })
      try {
        expect(await recoverLegacyOrphanRun(f.userId, old.id)).toBe(true)
        expect(await recoverLegacyOrphanRun(f.userId, old.id)).toBe(false)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('failed')
        expect(await prisma.agentMessage.count({ where: { runId: old.id } })).toBe(1)
        expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('active')
        expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } }))
          .toMatchObject({ billingStatus: 'pending_usage', usageSource: 'unknown', requestTokens: null, responseTokens: null, creditChargeMilli: 0 })
      } finally {
        await prisma.aiUsageLog.delete({ where: { id: usage.id } })
      }
    })
  })

  it('fences queued legacy admission after local stop, and rejects cross-user durable stops', async () => {
    await fixture(async f => {
      const queued = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        status: 'queued', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: JSON.parse(JSON.stringify(f.spec)) } })
      expect(await fenceLocallyStoppedLegacyRun(f.userId, queued.id)).toBe(true)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('paused')
      await expect(startLegacyRuntimeRun(f.userId, queued.id)).rejects.toMatchObject({ code: 'TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED' })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('paused')
      await expect(initializeDurableTask({ userId: f.userId, runId: queued.id, sourceMessageId: f.sourceMessageId })).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      await startLegacyRuntimeRun(f.userId, queued.id, true)
      await expect(startLegacyRuntimeRun(f.userId, queued.id, true)).rejects.toMatchObject({ code: 'TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED' })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('running')
      await expect(pauseDurableTask('not-the-owner', f.runId)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('active')
    })
  })

  it.each(['write', 'append', 'edit', 'noop', 'stale', 'denied', 'protected', 'cancelled', 'outbox-failure', 'target-mismatch'] as const)('actual durable chapter tool %s', async scenario => {
    // The extraction job is real and transactional; do not run its asynchronous consumer after fixture teardown.
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    await fixture(async f => {
      const { token, identity } = await pricedCall(f)
      await recordProviderUsage({ ...identity, revision: 1, usage: { ...reported, promptTokens: 500, cacheMissTokens: 500 } })
      const controller = new AbortController()
      const action = scenario === 'append' ? 'chapter_append' : scenario === 'edit' ? 'chapter_edit_range' : 'chapter_write'
      const ctx: ToolContext = { ...f, callId: 'call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: controller.signal,
        toolAuthority: new Map([[action, { permission: scenario === 'denied' ? 'ask' : 'allow', alwaysConfirm: false, dangerous: false }]]),
        durableContent: { lease: token, operationKey: 'actual:revision', chapterId: scenario === 'target-mismatch' ? 'other-chapter' : f.chapterId, expectedRevision: 1 },
        protectedChapterIds: new Set(scenario === 'protected' ? [f.chapterId] : []) }
      if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 2, content: '作者修改' } })
      if (scenario === 'cancelled') controller.abort()
      if (scenario === 'outbox-failure') {
        const operation = await prepareOperation(token, { key: 'actual:revision', kind: 'tool', action,
          input: { callId: 'call', novelId: f.novelId, chapterId: f.chapterId, expectedRevision: 1, args: { chapterId: f.chapterId, content: '新正文' } } })
        await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId,
          eventKey: `effect:${operation.id}`, type: 'fixture.collision', payload: {} } })
      }
      const execute = () => scenario === 'append' ? chapterAppendTool.execute(ctx, { chapterId: f.chapterId, content: '追加内容' })
        : scenario === 'edit' ? chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, oldText: '原文', newText: '片段修订' })
        : chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: scenario === 'noop' ? '原文' : '新正文' })
      if (['stale', 'denied', 'protected', 'cancelled', 'outbox-failure', 'target-mismatch'].includes(scenario)) {
        const expectedErrors: Record<string, string> = { stale: 'CHAPTER_REVISION_CONFLICT', denied: 'RUNTIME_EFFECT_NOT_AUTHORIZED',
          protected: 'AUTHOR_SCOPE_PROTECTED', 'outbox-failure': 'P2002', 'target-mismatch': 'RUNTIME_SCOPE_MISMATCH' }
        if (scenario === 'cancelled') await expect(execute()).rejects.toMatchObject({ name: 'AbortError' })
        else await expect(execute()).rejects.toMatchObject({ code: expectedErrors[scenario] })
        expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(scenario === 'stale' ? '作者修改' : '原文')
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
        expect(await prisma.memoryExtractionJob.count({ where: { chapterId: f.chapterId } })).toBe(0)
        if (scenario === 'outbox-failure') expect((await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })).wordCount).toBe(0)
        return
      }
      const [original, concurrentReplay] = await Promise.all([execute(), execute()])
      expect(concurrentReplay).toEqual(original)
      expect(await execute()).toEqual(original)
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      expect(chapter.revision).toBe(scenario === 'noop' ? 1 : 2)
      expect(chapter.content).toBe(scenario === 'noop' ? '原文' : scenario === 'append' ? '原文\n\n追加内容' : scenario === 'edit' ? '片段修订' : '新正文')
      if (scenario !== 'noop') expect((await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })).wordCount).toBe(chapter.content.length)
      const operation = await prisma.agentOperation.findUniqueOrThrow({ where: { taskRootId_operationKey: { taskRootId: f.rootId, operationKey: 'actual:revision' } } })
      const checkpoint = { expectedCheckpointCount: 0, progressOperationId: operation.id,
        snapshot: { version: 1, taskRootId: f.rootId, context: '正文已提交', remainingWork: ['校验'] } }
      if (scenario === 'noop') await expect(commitRuntimeCheckpoint(token, checkpoint)).rejects.toMatchObject({ code: 'RUNTIME_PROGRESS_REQUIRED' })
      else expect((await commitRuntimeCheckpoint(token, checkpoint)).checkpointIndex).toBe(1)
    }, 500)
  })

  it.each(['replay', 'noop', 'todo', 'early', 'corrupt', 'revoked', 'old-progress', 'outbox-failure', 'resume'] as const)('durable checkpoint guards %s', async fault => {
    await fixture(async f => {
      const { token, identity } = await pricedCall(f)
      await recordProviderUsage({ ...identity, revision: 1, usage: { ...reported, promptTokens: fault === 'early' ? 10 : 500, cacheMissTokens: fault === 'early' ? 10 : 500 } })
      const operation = await prepareOperation(token, { key: 'revision:1', kind: 'tool', action: fault === 'todo' ? 'todo_write' : 'chapter_write', input: { chapterId: f.chapterId } })
      const beforeHash = runtimeJson({ content: '原文' }).hash
      await commitOperationEffect(token, operation.id, operation.inputHash, async tx => {
        await tx.chapter.update({ where: { id: f.chapterId }, data: { content: fault === 'noop' ? '原文' : '修订内容' } })
        return { progress: { kind: 'content_revision', targetId: f.chapterId, beforeHash,
          afterHash: fault === 'noop' ? beforeHash : runtimeJson({ content: '修订内容' }).hash } }
      })
      const input = { expectedCheckpointCount: 0, progressOperationId: operation.id,
        snapshot: { version: 1, taskRootId: f.rootId, context: '本章修订已提交，接下来校验', remainingWork: ['校验本章'] } }
      if (fault === 'outbox-failure') {
        await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId,
          eventKey: `checkpoint:${f.rootId}:1`, type: 'fixture.collision', payload: {} } })
        await expect(commitRuntimeCheckpoint(token, input)).rejects.toMatchObject({ code: 'P2002' })
        expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(0)
        expect((await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } }))).toMatchObject({ checkpointCount: 0, compactionCount: 0, tokenLimit: 500 })
        return
      }
      if (fault === 'revoked') await revokeRunLease(f.userId, f.runId)
      if (['noop', 'todo', 'early', 'revoked'].includes(fault)) {
        await expect(commitRuntimeCheckpoint(token, input)).rejects.toMatchObject({ code:
          fault === 'early' ? 'RUNTIME_CHECKPOINT_NOT_DUE' : fault === 'revoked' ? 'RUNTIME_LEASE_LOST' : 'RUNTIME_PROGRESS_REQUIRED' })
        expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(0)
        expect((await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).checkpointCount).toBe(0)
        return
      }
      const [a, b] = await Promise.all([commitRuntimeCheckpoint(token, input), commitRuntimeCheckpoint(token, input)])
      expect(a.snapshotHash).toBe(b.snapshotHash)
      expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(1)
      expect((await readTaskBudget(token)).budget).toMatchObject({ checkpointCount: 1, compactionCount: 1, tokenLimit: 2000500 })
      await expect(commitRuntimeCheckpoint(token, { ...input, snapshot: { ...input.snapshot, context: '换成另一个任务' } })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      if (fault === 'corrupt') {
        await prisma.agentRuntimeCheckpoint.update({ where: { taskRootId_checkpointIndex: { taskRootId: f.rootId, checkpointIndex: 1 } }, data: { snapshot: { damaged: true } } })
        await expect(commitRuntimeCheckpoint(token, input)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        await expect(readTaskBudget(token)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      }
      if (fault === 'resume') {
        const resumedRun = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
          status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: JSON.parse(JSON.stringify(f.spec)) } })
        await attachRunToDurableTask({ userId: f.userId, runId: resumedRun.id, taskRootId: f.rootId })
        await revokeRunLease(f.userId, f.runId)
        const resumed = await claim({ userId: f.userId, runId: resumedRun.id }, 'resumed-worker')
        expect((await commitRuntimeCheckpoint(resumed, input)).originRunId).toBe(f.runId)
        expect((await readTaskBudget(resumed)).budget).toMatchObject({ checkpointCount: 1, compactionCount: 1, tokenLimit: 2000500 })
      }
      if (fault === 'old-progress') {
        await recordProviderUsage({ ...identity, revision: 2, usage: { ...reported, promptTokens: 2000500, cacheMissTokens: 2000500 } })
        await expect(commitRuntimeCheckpoint(token, { ...input, expectedCheckpointCount: 1 })).rejects.toMatchObject({ code: 'RUNTIME_PROGRESS_REQUIRED' })
        expect((await readTaskBudget(token)).budget.checkpointCount).toBe(1)
      }
    }, 500)
  })

  it('preserves the original budget across runs and counts cumulative usage revisions only once', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const operation = await prepareOperation(token, { key: 'model:1', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      await recordProviderUsage({ ...identity, revision: 1, usage: { source: 'reported', promptTokens: 200, completionTokens: 0, cacheHitTokens: null, cacheMissTokens: null } })
      await recordProviderUsage({ ...identity, revision: 2, usage: { source: 'reported', promptTokens: 300, completionTokens: 200, cacheHitTokens: null, cacheMissTokens: null } })
      await recordProviderResult({ ...identity, outcome: 'succeeded', result: { text: 'done' } })
      const original = await readTaskBudget(token)
      expect(original.usedTokens).toBe(500n)
      expect(original.budget.tokenLimit).toBe(500)
      const resumedRun = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: JSON.parse(JSON.stringify(f.spec)) } })
      await attachRunToDurableTask({ userId: f.userId, runId: resumedRun.id, taskRootId: f.rootId })
      await revokeRunLease(f.userId, f.runId)
      const resumed = await claim({ userId: f.userId, runId: resumedRun.id }, 'resumed-worker')
      expect((await readTaskBudget(resumed)).usedTokens).toBe(500n)
      expect((await readTaskBudget(resumed)).budget.createdAt).toEqual(original.budget.createdAt)
      const next = await prepareOperation(resumed, { key: 'model:2', kind: 'provider', action: 'chat', input: {} })
      const nextAttempt = await prepareProviderAttempt(resumed, { operationId: next.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await expect(markProviderDispatched(resumed, nextAttempt.id)).rejects.toMatchObject({ code: 'RUNTIME_CHECKPOINT_REQUIRED' })
      expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: nextAttempt.id } })).dispatchedAt).toBeNull()
      await expect(initializeDurableTask({ ...f, tokenBudget: 1000 })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    }, 500)
  })

  it('blocks a different operation while an earlier attempt has unknown usage instead of treating it as zero', async () => {
    await fixture(async f => {
      const token = await claim(f)
      for (const key of ['first', 'second']) {
        const operation = await prepareOperation(token, { key, kind: 'provider', action: 'chat', input: {} })
        const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
        if (key === 'first') await markProviderDispatched(token, attempt.id)
        else await expect(markProviderDispatched(token, attempt.id)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      }
      expect((await readTaskBudget(token)).unresolvedAttempts).toBe(1n)
    })
  })

  it.each(['ceiling', 'corrupt-usage'] as const)('blocks new dispatch on %s without resetting the original paid attempt', async fault => {
    await fixture(async f => {
      const token = await claim(f)
      const ceiling = (await readTaskBudget(token)).policy.tokenCeiling
      const operation = await prepareOperation(token, { key: 'first', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      await recordProviderUsage({ ...identity, revision: 1, usage: { source: 'reported', promptTokens: ceiling, completionTokens: 0, cacheHitTokens: null, cacheMissTokens: null } })
      await recordProviderResult({ ...identity, outcome: 'succeeded', result: {} })
      if (fault === 'corrupt-usage') await prisma.agentProviderUsageReceipt.update({ where: { attemptId: attempt.id }, data: { promptTokens: 0 } })
      const next = await prepareOperation(token, { key: 'second', kind: 'provider', action: 'chat', input: {} })
      const second = await prepareProviderAttempt(token, { operationId: next.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await expect(markProviderDispatched(token, second.id)).rejects.toMatchObject({ code: fault === 'ceiling' ? 'RUNTIME_TOKEN_CEILING' : 'RUNTIME_RECEIPT_INVALID' })
      expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: second.id } })).dispatchedAt).toBeNull()
      expect((await markProviderDispatched(token, attempt.id)).dispatchGranted).toBe(false)
    })
  })

  it.each(['missing', 'tampered', 'expired'] as const)('does not dispatch against a %s budget', async fault => {
    await fixture(async f => {
      const token = await claim(f)
      const operation = await prepareOperation(token, { key: 'model', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      if (fault === 'missing') await prisma.agentTaskBudget.delete({ where: { taskRootId: f.rootId } })
      if (fault === 'tampered') await prisma.agentTaskBudget.update({ where: { taskRootId: f.rootId }, data: { tokenLimit: 2147483647 } })
      if (fault === 'expired') await prisma.agentTaskRoot.update({ where: { id: f.rootId }, data: { createdAt: new Date(0) } })
      await expect(markProviderDispatched(token, attempt.id)).rejects.toMatchObject({ code: fault === 'missing' ? 'RUNTIME_BUDGET_REQUIRED' : fault === 'tampered' ? 'RUNTIME_BUDGET_INVALID' : 'RUNTIME_WALL_CLOCK_EXHAUSTED' })
      expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).dispatchedAt).toBeNull()
    })
  })
  it('uses the real streaming adapter with durable receipts, no legacy double charge, and no network on exhausted replay', async () => {
    await fixture(async f => {
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 1, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const lease = await claim(f)
      const request = { messages: [{ role: 'user' as const, content: '只处理第19章' }], tools: [], model: 'fixture', provider: 'fixture',
        providerApiKey: 'fixture-secret-not-real', providerBaseUrl: 'https://provider.invalid/v1',
        durableExecution: { lease, operationKey: 'model:1', attemptKey: '1' }, usageLog: { userId: f.userId, agentRunId: f.runId, action: 'fixture' } }
      const frame = { choices: [{ delta: { content: '完整结果' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } }
      const fetchMock = vi.fn(async () => new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`))
      vi.stubGlobal('fetch', fetchMock)
      const result = await chatWithTools(request)
      expect(result).toMatchObject({ content: '完整结果', billing: { status: 'settled', chargedMilli: 1, exhausted: true } })
      expect(await chatWithTools(request)).toEqual(result)
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
      const saved = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } } })
      expect(JSON.stringify(saved.requestSnapshot)).not.toContain('fixture-secret-not-real')
      await expect(chatWithTools({ ...request, durableExecution: { ...request.durableExecution, operationKey: 'model:2' } })).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  it('accepts the existing basic tier in a frozen price without treating price validity as model availability', async () => {
    await fixture(async f => {
      const lease = await claim(f)
      const operation = await preparePricedProviderOperation(lease, { key: 'basic', action: 'fixture', request: {}, price: { version: 'credits-v1-exact', modelTier: 'basic', multiplierBps: 11000 } })
      expect(operation.inputSnapshot).toMatchObject({ input: { billing: { modelTier: 'basic', multiplierBps: 11000 } } })
      expect(await prisma.agentProviderAttempt.count({ where: { operationId: operation.id } })).toBe(0)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    })
  })

  it('retains paid evidence but rejects executable return when the lease was revoked during the provider call', async () => {
    await fixture(async f => {
      const lease = await claim(f)
      vi.stubGlobal('fetch', vi.fn(async () => {
        await revokeRunLease(f.userId, f.runId)
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '已生成但不能继续执行工具' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\n`)
      }))
      await expect(chatWithTools({ messages: [{ role: 'user', content: 'test' }], tools: [], model: 'fixture', provider: 'fixture',
        providerApiKey: 'fixture-not-real', providerBaseUrl: 'https://provider.invalid/v1',
        durableExecution: { lease, operationKey: 'model:1', attemptKey: '1' }, usageLog: { userId: f.userId, agentRunId: f.runId, action: 'fixture' },
      })).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
      const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } } })
      expect(attempt.status).toBe('succeeded')
      expect(attempt.result).toMatchObject({ result: { content: '已生成但不能继续执行工具' } })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
      expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
    })
  })

  it.each(['malformed-frame', 'read-error', 'usage-regression', 'error-with-usage', 'invalid-cache'] as const)('preserves observed usage on %s and refuses blind network retry', async fault => {
    await fixture(async f => {
      const lease = await claim(f)
      const request = { messages: [{ role: 'user' as const, content: 'test' }], tools: [], model: 'fixture', provider: 'fixture',
        providerApiKey: 'fixture-not-real', providerBaseUrl: 'https://provider.invalid/v1',
        durableExecution: { lease, operationKey: 'model:1', attemptKey: '1' }, usageLog: { userId: f.userId, agentRunId: f.runId, action: 'fixture' } }
      const usageFrame = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\n`
      const fetchMock = vi.fn(async () => {
        if (fault === 'malformed-frame') return new Response(`${usageFrame}data: {bad-json}\n\n`)
        if (fault === 'usage-regression') return new Response(`${usageFrame}data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } })}\n\n`)
        if (fault === 'invalid-cache') return new Response(`${usageFrame}data: ${JSON.stringify({ usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 20 } })}\n\n`)
        if (fault === 'error-with-usage') return new Response(`data: ${JSON.stringify({ error: { message: 'fixture' }, usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\n`)
        let reads = 0
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
          if (reads++ === 0) controller.enqueue(new TextEncoder().encode(usageFrame))
          else controller.error(new Error('fixture network read failed'))
        } }))
      })
      vi.stubGlobal('fetch', fetchMock)
      await expect(chatWithTools(request)).rejects.toThrow()
      const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } } })
      expect(attempt.status).toBe('unknown')
      expect(await prisma.agentProviderUsageReceipt.findUnique({ where: { attemptId: attempt.id } })).toMatchObject({ source: 'reported', promptTokens: 10, completionTokens: 0, settlementStatus: 'pending' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      await expect(chatWithTools(request)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  it('preserves a complete response with missing usage as pending instead of charging estimated tokens', async () => {
    await fixture(async f => {
      const lease = await claim(f)
      const request = { messages: [{ role: 'user' as const, content: 'test' }], tools: [], model: 'fixture', provider: 'fixture',
        providerApiKey: 'fixture-not-real', providerBaseUrl: 'https://provider.invalid/v1',
        durableExecution: { lease, operationKey: 'model:1', attemptKey: '1' }, usageLog: { userId: f.userId, agentRunId: f.runId, action: 'fixture' } }
      const fetchMock = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '完整结果' }, finish_reason: 'stop' }] })}\n\n`))
      vi.stubGlobal('fetch', fetchMock)
      expect(await chatWithTools(request)).toMatchObject({ content: '完整结果', billing: { status: 'pending', reason: 'usage_not_confirmed' } })
      expect(await chatWithTools(request)).toMatchObject({ content: '完整结果', billing: { status: 'pending' } })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } } })
      expect(await prisma.agentProviderUsageReceipt.findUnique({ where: { attemptId: attempt.id } })).toMatchObject({ source: 'unknown', promptTokens: null, completionTokens: null, settlementStatus: 'pending' })
    })
  })
  it('settles an exactly exhausted call once without losing its saved result or requiring a live lease', async () => {
    await fixture(async f => {
      const { operation, attempt, identity } = await pricedCall(f)
      await recordProviderUsage({ ...identity, revision: 1, usage: reported })
      await revokeRunLease(f.userId, f.runId)
      const results = await Promise.all([settleProviderOperation(identity), settleProviderOperation(identity)])
      for (const result of results) expect(result).toMatchObject({ status: 'settled', amountMilli: 1, chargedMilli: 1, remainingMilli: 0, exhausted: true, shortfallMilli: 0 })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
      expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).result).toEqual({ outcome: 'succeeded', result: { content: '本次已经生成的结果' } })
      expect((await prisma.agentProviderUsageReceipt.findUniqueOrThrow({ where: { attemptId: attempt.id } })).settlementStatus).toBe('settled')
      expect(await prisma.agentExecutionOutbox.count({ where: { operationId: operation.id, type: 'credit.settled' } })).toBe(1)
      await expect(settleProviderOperation({ ...identity, userId: 'foreign' })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    })
  })

  it('records the actual debit and shortfall separately instead of throwing away an already-paid result', async () => {
    await fixture(async f => {
      const { identity } = await pricedCall(f, 1)
      await recordProviderUsage({ ...identity, revision: 1, usage: { ...reported, completionTokens: 10 } })
      expect(await settleProviderOperation(identity)).toMatchObject({ status: 'settled', amountMilli: 10, chargedMilli: 1, shortfallMilli: 9, exhausted: true })
      await prisma.creditAccount.update({ where: { userId: f.userId }, data: { bonusBalanceMilli: 100 } })
      expect(await settleProviderOperation(identity)).toMatchObject({ chargedMilli: 1, shortfallMilli: 9 })
      expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).bonusBalanceMilli).toBe(100)
    })
  })

  it('keeps missing or estimated usage pending and settles only after a confirmed measurement arrives', async () => {
    await fixture(async f => {
      const { identity } = await pricedCall(f)
      expect(await settleProviderOperation(identity)).toEqual({ status: 'pending', reason: 'usage_not_confirmed' })
      await recordProviderUsage({ ...identity, revision: 1, usage: { ...reported, source: 'estimated', cacheHitTokens: null, cacheMissTokens: null } })
      expect(await settleProviderOperation(identity)).toEqual({ status: 'pending', reason: 'usage_not_confirmed' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      await recordProviderUsage({ ...identity, revision: 2, usage: reported })
      expect(await settleProviderOperation(identity)).toMatchObject({ status: 'settled', chargedMilli: 1 })
    })
  })

  it('retains pending evidence on a paused wallet and settles it after unpause without re-requesting the provider', async () => {
    await fixture(async f => {
      const { attempt, identity } = await pricedCall(f)
      await recordProviderUsage({ ...identity, revision: 1, usage: reported })
      await prisma.creditAccount.update({ where: { userId: f.userId }, data: { suspendedAt: new Date() } })
      await expect(settleProviderOperation(identity)).rejects.toMatchObject({ status: 423 })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      expect((await prisma.agentProviderUsageReceipt.findUniqueOrThrow({ where: { attemptId: attempt.id } })).settlementStatus).toBe('pending')
      await prisma.creditAccount.update({ where: { userId: f.userId }, data: { suspendedAt: null } })
      expect(await settleProviderOperation(identity)).toMatchObject({ status: 'settled', chargedMilli: 1 })
      expect(await prisma.agentProviderAttempt.count({ where: { id: attempt.id } })).toBe(1)
    })
  })

  it('does not recreate a debit when a settled receipt has lost its ledger entry', async () => {
    await fixture(async f => {
      const { operation, identity } = await pricedCall(f)
      await recordProviderUsage({ ...identity, revision: 1, usage: reported })
      await settleProviderOperation(identity)
      await prisma.creditLedgerEntry.delete({ where: { idempotencyKey: `operation:${operation.id}` } })
      await expect(settleProviderOperation(identity)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    })
  })
  it('binds the original message/spec once and refuses to overwrite the root with changed input', async () => {
    await fixture(async f => {
      expect((await initializeDurableTask(f)).id).toBe(f.rootId)
      const stored = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      expect(stored).toMatchObject({ taskRootId: f.rootId, runtimeProtocolVersion: 1 })
      expect(() => assertLegacyRuntimeCompatible(stored)).toThrow()
      await expect(startLegacyRuntimeRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED' })
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(stored)
      await prisma.agentMessage.update({ where: { id: f.sourceMessageId }, data: { parts: [{ type: 'text', text: '不同需求' }] } })
      await expect(initializeDurableTask(f)).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).requestSnapshot).toEqual([{ type: 'text', text: '修改本章' }])
    })
  })

  it('does not attach an unrelated task or another session by reusing its root ID', async () => {
    await fixture(async f => {
      const otherRunId = randomUUID()
      const makeRun = async (sessionId: string, spec: Prisma.InputJsonValue) => prisma.agentRun.create({ data: { id: otherRunId, userId: f.userId, novelId: f.novelId, sessionId, status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: spec } })
      await makeRun(f.sessionId, { ...JSON.parse(JSON.stringify(f.spec)), id: randomUUID() })
      await expect(attachRunToDurableTask({ userId: f.userId, runId: otherRunId, taskRootId: f.rootId })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
      await prisma.agentRun.update({ where: { id: otherRunId }, data: { taskSpec: JSON.parse(JSON.stringify({ ...f.spec, runId: otherRunId })) } })
      expect((await attachRunToDurableTask({ userId: f.userId, runId: otherRunId, taskRootId: f.rootId })).id).toBe(f.rootId)
      await claim(f)
      await expect(claim({ userId: f.userId, runId: otherRunId })).rejects.toMatchObject({ code: 'RUNTIME_LEASE_BUSY' })
      const second = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '其他窗口' } })
      await prisma.agentRun.update({ where: { id: otherRunId }, data: { sessionId: second.id } })
      await expect(attachRunToDurableTask({ userId: f.userId, runId: otherRunId, taskRootId: f.rootId })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    })
  })

  it('allows only one concurrent owner and repeats the same claim without incrementing epoch', async () => {
    await fixture(async f => {
      const request = { ...f, ownerId: 'a', claimId: randomUUID() }
      const results = await Promise.allSettled([acquireRunLease(request), acquireRunLease({ ...request, ownerId: 'b', claimId: randomUUID() })])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const winner = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof claim>>>
      expect(await acquireRunLease(winner.value)).toEqual(winner.value)
      await renewRunLease(winner.value)
    })
  })

  it('fences the old owner after expiry/takeover and does not resurrect it by heartbeat', async () => {
    await fixture(async f => {
      const old = await claim(f)
      await prisma.agentRunLease.update({ where: { runId: f.runId }, data: { expiresAt: new Date(0) } })
      const current = await claim(f, 'worker-b')
      expect(current.epoch).toBe(old.epoch + 1n)
      const effect = vi.fn(async () => undefined)
      await expect(withRunLease(old, effect)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
      await expect(renewRunLease(old)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
      expect(effect).not.toHaveBeenCalled()
      await withRunLease(current, async () => {})
    })
  })

  it('persists cancellation and rejects old/foreign holders before work', async () => {
    await fixture(async f => {
      const token = await claim(f)
      await expect(withRunLease({ ...token, userId: 'foreign-user' }, async () => {})).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
      await revokeRunLease(f.userId, f.runId)
      await revokeRunLease(f.userId, f.runId)
      await expect(withRunLease(token, async () => {})).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
      await expect(claim(f)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_REVOKED' })
    })
  })

  it('commits chapter, effect receipt and outbox atomically; replay never calls the writer again', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const request = { key: 'chapter:edit:1', kind: 'tool' as const, action: 'chapter_write', input: { chapterId: f.chapterId, content: '新正文' } }
      const operation = await prepareOperation(token, request)
      expect((await prepareOperation(token, request)).id).toBe(operation.id)
      await expect(prepareOperation(token, { ...request, input: { content: '另一份正文' } })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      const write = vi.fn(async (tx: Prisma.TransactionClient) => {
        await tx.chapter.update({ where: { id: f.chapterId }, data: { content: '新正文' } })
        return { chapterId: f.chapterId }
      })
      const first = await commitOperationEffect(token, operation.id, operation.inputHash, write)
      const restored = await commitOperationEffect(token, operation.id, operation.inputHash, write)
      expect(restored).toEqual(first)
      expect(write).toHaveBeenCalledOnce()
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('新正文')
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(1)
      expect(await prisma.agentExecutionOutbox.count({ where: { operationId: operation.id, publishedAt: null } })).toBe(1)
    })
  })

  it.each(['writer-failure', 'expiry-before-commit'] as const)('rolls back business effects and receipts on %s', async mode => {
    await fixture(async f => {
      const token = await claim(f)
      const operation = await prepareOperation(token, { key: 'edit', kind: 'tool', action: 'chapter_write', input: {} })
      await expect(commitOperationEffect(token, operation.id, operation.inputHash, async tx => {
        await tx.chapter.update({ where: { id: f.chapterId }, data: { content: '必须回滚' } })
        if (mode === 'writer-failure') throw new Error('fixture writer failed')
        await tx.agentRunLease.update({ where: { runId: f.runId }, data: { expiresAt: new Date(0) } })
        return { written: true }
      })).rejects.toThrow()
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(0)
      expect(await prisma.agentExecutionOutbox.count({ where: { operationId: operation.id } })).toBe(0)
      expect((await prisma.agentOperation.findUniqueOrThrow({ where: { id: operation.id } })).status).toBe('prepared')
    })
  })

  it('grants dispatch once and never guesses that a lost response means a new provider request is safe', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const op = await prepareOperation(token, { key: 'model:1', kind: 'provider', action: 'chat', input: { prompt: 'test' } })
      const request = { operationId: op.id, attemptKey: 'attempt-1', provider: 'fixture', model: 'fixture', request: { prompt: 'test' } }
      const attempt = await prepareProviderAttempt(token, request)
      await expect(recordProviderUsage({ userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash, revision: 1, usage: reported })).rejects.toMatchObject({ code: 'RUNTIME_NOT_DISPATCHED' })
      expect((await markProviderDispatched(token, attempt.id)).dispatchGranted).toBe(true)
      expect((await markProviderDispatched(token, attempt.id)).dispatchGranted).toBe(false)
      expect((await prepareProviderAttempt(token, request)).id).toBe(attempt.id)
      await expect(prepareProviderAttempt(token, { ...request, attemptKey: 'attempt-2' })).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(await prisma.agentProviderAttempt.count({ where: { operationId: op.id } })).toBe(1)
    })
  })

  it('persists exact input/request snapshots independently of later caller mutation and owner recovery', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const input = { prompt: '原始正文', nested: { chapter: 19 } }
      const pendingOp = prepareOperation(token, { key: 'model', kind: 'provider', action: 'chat', input })
      input.nested.chapter = 13
      const op = await pendingOp
      expect(op.inputSnapshot).toEqual({ kind: 'provider', action: 'chat', parentOperationId: null, input: { prompt: '原始正文', nested: { chapter: 19 } } })
      const body = { messages: [{ role: 'user', content: '只写第19章' }], maxTokens: 8000 }
      const pending = prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: body })
      body.messages[0].content = '写13章'
      const attempt = await pending
      const saved = await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
      expect(saved.requestSnapshot).toEqual({ provider: 'fixture', model: 'fixture', request: { messages: [{ role: 'user', content: '只写第19章' }], maxTokens: 8000 } })
      await prisma.agentRunLease.update({ where: { runId: f.runId }, data: { expiresAt: new Date(0) } })
      const recoveredToken = await claim(f, 'worker-recovery')
      const snapshot = saved.requestSnapshot as { provider: string; model: string; request: Prisma.InputJsonValue }
      const recovered = await prepareProviderAttempt(recoveredToken, { ...snapshot, operationId: op.id, attemptKey: '1' })
      expect(recovered.id).toBe(saved.id)
      expect(recovered.requestHash).toBe(saved.requestHash)
      expect(recovered.ownerEpoch).toBe(recoveredToken.epoch)
      expect((await markProviderDispatched(recoveredToken, saved.id)).dispatchGranted).toBe(true)
      await expect(markProviderDispatched(token, saved.id)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    })
  })

  it.each(['missing', 'corrupt'] as const)('refuses %s operation/request snapshots without writing or dispatching', async fault => {
    await fixture(async f => {
      const token = await claim(f)
      const value = fault === 'missing' ? Prisma.DbNull : { tampered: true }
      const op = await prepareOperation(token, { key: 'write', kind: 'tool', action: 'chapter_write', input: {} })
      await prisma.agentOperation.update({ where: { id: op.id }, data: { inputSnapshot: value } })
      const writer = vi.fn(async () => ({ written: true }))
      await expect(commitOperationEffect(token, op.id, op.inputHash, writer)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(writer).not.toHaveBeenCalled()
      const modelOp = await prepareOperation(token, { key: 'model', kind: 'provider', action: 'chat', input: {} })
      const request = { operationId: modelOp.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} }
      const attempt = await prepareProviderAttempt(token, request)
      await prisma.agentProviderAttempt.update({ where: { id: attempt.id }, data: { requestSnapshot: value } })
      await expect(prepareProviderAttempt(token, request)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      await expect(markProviderDispatched(token, attempt.id)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).dispatchedAt).toBeNull()
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId } })).toBe(0)
    })
  })

  it('rejects corrupted stored results and usage even when the incoming replay identity matches', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const op = await prepareOperation(token, { key: 'model', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      await recordProviderUsage({ ...identity, revision: 2, usage: reported })
      await recordProviderResult({ ...identity, outcome: 'succeeded', result: { text: '完整结果' } })
      const eventCount = await prisma.agentExecutionOutbox.count({ where: { operationId: op.id } })
      await prisma.agentProviderUsageReceipt.update({ where: { attemptId: attempt.id }, data: { completionTokens: 999 } })
      await prisma.agentProviderAttempt.update({ where: { id: attempt.id }, data: { result: { text: '损坏结果' } } })
      for (const revision of [1, 2, 3]) {
        await expect(recordProviderUsage({ ...identity, revision, usage: reported })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      }
      await expect(recordProviderResult({ ...identity, outcome: 'succeeded', result: { text: '完整结果' } })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(await prisma.agentExecutionOutbox.count({ where: { operationId: op.id } })).toBe(eventCount)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    })
  })

  it('retains provider usage/results after revocation without granting another write or charge', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const op = await prepareOperation(token, { key: 'model:1', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      await revokeRunLease(f.userId, f.runId)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      expect(await recordProviderUsage({ ...identity, revision: 1, usage: reported })).toMatchObject({ promptTokens: 10, completionTokens: 0, source: 'reported', settlementStatus: 'pending' })
      await recordProviderResult({ ...identity, outcome: 'unknown', result: { reason: 'stream interrupted' } })
      const result = await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '已生成的完整结果' } })
      expect(await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '已生成的完整结果' } })).toEqual(result)
      await expect(recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '另一份' } })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      await expect(recordProviderResult({ ...identity, userId: 'foreign', outcome: 'succeeded', result: {} })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      await expect(prepareOperation(token, { key: 'write', kind: 'tool', action: 'chapter_write', input: {} })).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    })
  })

  it('treats usage as cumulative snapshots, rejects same-version conflicts and does not overwrite settled facts', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const op = await prepareOperation(token, { key: 'model', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      await recordProviderUsage({ ...identity, revision: 1, usage: reported })
      await expect(recordProviderUsage({ ...identity, revision: 1, usage: { ...reported, completionTokens: 2 } })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      const next = await recordProviderUsage({ ...identity, revision: 2, usage: { ...reported, completionTokens: 20 } })
      expect(await recordProviderUsage({ ...identity, revision: 1, usage: reported })).toEqual(next)
      expect(next.completionTokens).toBe(20)
      await expect(recordProviderUsage({ ...identity, revision: 3, usage: reported })).rejects.toMatchObject({ code: 'RUNTIME_USAGE_INVALID' })
      await prisma.agentProviderUsageReceipt.update({ where: { attemptId: attempt.id }, data: { settlementStatus: 'settled' } })
      await expect(recordProviderUsage({ ...identity, revision: 3, usage: { ...reported, completionTokens: 30 } })).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(await prisma.agentExecutionOutbox.count({ where: { operationId: op.id, type: 'provider.usage.recorded' } })).toBe(2)
    })
  })

  it('does not erase known partial usage on an unknown/aborted observation', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const op = await prepareOperation(token, { key: 'model', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: op.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      const partial: ProviderUsageObservation = { source: 'unknown', promptTokens: 10, completionTokens: null, cacheHitTokens: null, cacheMissTokens: null }
      await recordProviderUsage({ ...identity, revision: 1, usage: partial })
      await expect(recordProviderUsage({ ...identity, revision: 2, usage: { ...partial, promptTokens: null } })).rejects.toMatchObject({ code: 'RUNTIME_USAGE_INVALID' })
      await expect(recordProviderUsage({ ...identity, revision: 2, usage: { ...reported, promptTokens: 9, cacheMissTokens: 9 } })).rejects.toMatchObject({ code: 'RUNTIME_USAGE_INVALID' })
      expect(await recordProviderUsage({ ...identity, revision: 2, usage: reported })).toMatchObject({ source: 'reported', promptTokens: 10, completionTokens: 0 })
    })
  })

  it('rolls back the write when outbox insertion fails, rather than leaving an unjournaled business success', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const operation = await prepareOperation(token, { key: 'write', kind: 'tool', action: 'chapter_write', input: {} })
      // A deliberately conflicting event is an isolated fixture fault, not user data.
      await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId, operationId: operation.id, eventKey: `effect:${operation.id}`, type: 'fixture.conflict', payload: {} } })
      await expect(commitOperationEffect(token, operation.id, operation.inputHash, async tx => {
        await tx.chapter.update({ where: { id: f.chapterId }, data: { content: '不能提交' } })
        return { written: true }
      })).rejects.toMatchObject({ code: 'P2002' })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(0)
    })
  })

  it('snapshots the lease capability before awaiting the database', async () => {
    await fixture(async f => {
      const token = await claim(f)
      const originalRoot = token.taskRootId
      const pending = prepareOperation(token, { key: 'snapshot', kind: 'tool', action: 'chapter_read', input: {} })
      token.taskRootId = 'foreign-root'
      token.runId = 'foreign-run'
      const operation = await pending
      expect(operation.taskRootId).toBe(originalRoot)
      expect(operation.originRunId).toBe(f.runId)
    })
  })

  it.each([
    { ...reported, promptTokens: -1 }, { ...reported, completionTokens: 0.5 },
    { ...reported, completionTokens: Infinity }, { ...reported, completionTokens: 2147483648 },
    { ...reported, cacheHitTokens: 11 }, { ...reported, cacheMissTokens: 9 },
    { ...reported, source: 'estimated' as const }, { ...reported, promptTokens: null },
  ])('rejects invalid or contradictory measurement before any persistence: %j', async usage => {
    await expect(recordProviderUsage({ userId: 'test', attemptId: 'test', requestHash: 'test', revision: 1, usage })).rejects.toMatchObject({ code: 'RUNTIME_USAGE_INVALID' })
  })
})
