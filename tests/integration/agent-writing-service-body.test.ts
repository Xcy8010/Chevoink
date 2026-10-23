import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest } from '../../api/lib/agent/coordinated-writing-input.js'
import { executeCoordinatedWritingServices } from '../../api/lib/agent/writing-service-coordination.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as continuity from '../../api/lib/agent/tools/durable-continuity.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { collectDurableMemoryWork } from '../../api/lib/agent/runtime-memory.js'
import { processMemoryExtractionJob } from '../../api/lib/agent/story-memory.js'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { storyCompilerPrepareTool, sceneTaskBuildTool, continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import type { ToolContext, AgentTool } from '../../api/lib/agent/tools/types.js'

describe.runIf(available)('coordinated writer actual PG body and parent cursor', () => {
  it.each(['draft', 'rollback-body', 'stale-body', 'narrowed-policy', 'resume-after-body'] as const)('%s preserves the real body transaction and task identity', async scenario => {
    await fixture(async f => {
      let lease = await claim(f)
      const complete = scenario === 'resume-after-body'
      if (complete) {
        const originalFlag = featureFlags.isAgent2FeatureEnabled
        vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation((key, userId) => key === 'memory2' || originalFlag(key, userId))
      }
      const writing = coordinatedWritingInputSchema.parse({ draftComplete: complete, scenes: [{ purpose: '当班检查', goal: '核查记录', obstacle: '记录不全',
        choice: '留下缺项', cost: '核查延后', turn: '请人复核' }], ...(complete ? { actualOutcomes: { exitState: {} }, chapterSummary: '核查尚未结束', hookDecision: '',
        delayedHookReason: '', openingStructure: '核查开始', endingStructure: '等待复核' } : {}) })
      const args = { chapterId: f.chapterId, content: '他看过记录，留下缺项，等待另一人复核。', writing }
      const writerSchema = chapterWriteTool.parameters.safeExtend({ writing: coordinatedWritingInputSchema })
      const tools: AgentTool[] = [chapterReadTool, { ...chapterWriteTool, parameters: writerSchema }, storyCompilerPrepareTool,
        sceneTaskBuildTool, continuityValidateTool, qualityAnalyzeTool, chapterBridgeCommitTool]
      const authority = tools.map(tool => ({ name: tool.name, permission: 'allow' as const, alwaysConfirm: false, dangerous: false }))
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: authority, protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
        phase: 'idle', pendingOperationId: null, successfulToolSignatures: [], messages: [{ role: 'user', content: '完整重写当前章节' },
          { role: 'assistant', content: null, toolCalls: [{ id: 'read-body', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
            { id: 'real-writer', name: 'chapter_write', arguments: JSON.stringify(args) }] }] } })
      await executeDurableToolStep(lease, new AbortController().signal) // A real reduced read, not a fresh DB read used as model observation.
      const before = await loadExecutionState(f.userId, lease.runId)
      const prepared = await prepareToolCursorOperation(lease, { expectedRevision: before.frame.revision, expectedHash: before.frame.snapshotHash }, {
        key: `exec:${before.frame.state.nextOperationSequence}`, action: 'chapter_write', callId: 'real-writer', targetId: f.chapterId,
        effectiveArgs: args, normalize: value => writerSchema.parse(value), operationInput: runtimeJson({ novelId: f.novelId, callId: 'real-writer',
          args, expectedRevision: 1, writingManifest: coordinatedWritingManifest({ spec: f.spec, prompt: '完整重写当前章节' }, 'chapter_write', f.chapterId, writing) }).value })
      let context: ToolContext = { userId: f.userId, novelId: f.novelId, runId: lease.runId, sessionId: f.sessionId, chapterId: f.chapterId,
        callId: 'real-writer', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', protectedChapterIds: new Set(),
        toolAuthority: new Map(authority.map(grant => [grant.name, grant])), signal: new AbortController().signal, emit: () => {} }
      const execute = () => executeCoordinatedWritingServices(context, lease, prepared.operation.id, 'chapter_write')
      if (scenario === 'rollback-body') {
        const original = operations.commitOperationEffect
        vi.spyOn(operations, 'commitOperationEffect').mockImplementationOnce((token, id, hash, work) => original(token, id, hash, async tx => {
          await work(tx); throw Error('interrupted before body transaction committed')
        }))
        await expect(execute()).rejects.toThrow('interrupted before body transaction committed')
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 1, content: '原文' })
        expect(await prisma.storyCompilation.count({ where: { userId: f.userId } })).toBe(0)
        expect(await prisma.sceneTask.count({ where: { userId: f.userId } })).toBe(0)
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, kind: 'internal' } } })).toBe(0)
      }
      if (scenario === 'stale-body') {
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者新文', revision: { increment: 1 } } })
        expect((await execute()).result).toMatchObject({ outcome: 'failed', effectApplied: false, code: 'CHAPTER_REVISION_CONFLICT' })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '作者新文', revision: 2 })
        expect(await prisma.storyCompilation.count({ where: { userId: f.userId } })).toBe(0)
        return
      }
      if (scenario === 'narrowed-policy') {
        await prisma.agentSession.update({ where: { id: f.sessionId }, data: { toolPolicy: { contentWrite: 'deny' } } })
        await expect(execute()).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 1, content: '原文' })
        expect(await prisma.storyCompilation.count({ where: { userId: f.userId } })).toBe(0)
        expect(await prisma.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } })).toBeNull()
        return
      }
      if (scenario === 'resume-after-body') {
        const prepare = vi.spyOn(continuity, 'prepareContinuityWork').mockRejectedValueOnce(Error('interrupted after committed body'))
        await expect(execute()).rejects.toThrow('interrupted after committed body')
        expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: prepared.operation.id } })).toMatchObject({ status: 'prepared' })
        expect((await loadExecutionState(f.userId, lease.runId)).frame.state).toMatchObject({ phase: 'awaiting_operation', pendingOperationId: prepared.operation.id })
        const job = await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { idempotencyKey: `${f.chapterId}:2` } })
        expect(job.diff).toMatchObject({ durableTaskRootId: f.rootId, durableOperationId: prepared.operation.id })
        await processMemoryExtractionJob(job.id) // The legacy processor cannot claim a still-pending service body.
        expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'pending', attempts: 0 })
        await pauseDurableTask(f.userId, lease.runId)
        const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
        const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
        lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'writer-resume')
        context = { ...context, runId: lease.runId }
        prepare.mockResolvedValue({ kind: 'rejected', code: 'CONTINUITY_INPUT_STALE', message: 'Original bounded refusal, no model request' })
      }
      const receipt = await execute()
      expect(receipt.result).toMatchObject({ writingCompletion: { status: complete ? 'blocked' : 'draft_saved' },
        toolResult: { display: { kind: 'chapterDiff', chapterId: f.chapterId, after: args.content, revision: 2 } } })
      expect(receipt.result).not.toHaveProperty('effectApplied', false)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: args.content, revision: 2 })
      expect(await prisma.storyCompilation.count({ where: { userId: f.userId } })).toBe(1)
      expect(await prisma.sceneTask.count({ where: { userId: f.userId } })).toBe(1)
      const unchanged = await loadExecutionState(f.userId, lease.runId)
      expect(unchanged.frame.state).toMatchObject({ phase: 'awaiting_operation', pendingOperationId: prepared.operation.id })
      await reduceExecutionReceipt(lease, { expectedRevision: unchanged.frame.revision, expectedHash: unchanged.frame.snapshotHash, operationId: prepared.operation.id })
      const result = await loadExecutionState(f.userId, lease.runId)
      expect(result.frame.state.messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['read-body', 'real-writer'])
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      if (complete) {
        const effects = await withRunLease(lease, tx => collectDurableToolEvidence(tx, f.rootId, result.frame.revision))
        const parentEvent = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `effect:${prepared.operation.id}` } })
        expect(effects.progressSequence).toBe(String(parentEvent.sequence))
        expect(effects.effects.find(effect => effect.operationId === prepared.operation.id)).toMatchObject({ outcome: 'failed' })
        const memory = await withRunLease(lease, tx => collectDurableMemoryWork(tx, { id: f.rootId, novelId: f.novelId }, effects.effects))
        expect(memory).toHaveLength(1)
        expect(memory[0].source.operationId).toBe(prepared.operation.id)
      }
    }, undefined, '完整重写当前章节', { freezeWriting: true, writingCoordinationProtocol: 1 })
  })
})
