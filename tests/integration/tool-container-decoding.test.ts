import { describe, expect, it, vi } from 'vitest'
import { fixture, claim } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import { toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'

// Mandatory real PostgreSQL cases: deliberately no runIf/skip gate. Local DB
// unavailability is not release evidence; these belong to whole same-SHA CI.
describe('container wire decoding with native frozen operation recovery', () => {
  it.each(['fresh', 'prepared', 'succeeded', 'rejected-old', 'unknown'] as const)('%s preserves raw call identity, scope and recorded outcomes', async scenario => fixture(async f => {
    const lease = await claim(f)
    const decision = { kind: 'continue', reason: '合成卷的原目标尚未收束，继续推进下一章' }
    const canonical = { intentSummary: '承接合成前章，推进下一章', volumeDecision: decision }
    // A known previously prepared operation was necessarily schema-valid.
    const wire = scenario === 'prepared' ? canonical : { ...canonical, volumeDecision: JSON.stringify(decision) }
    const rawArguments = JSON.stringify(wire)
    const configuration = { version: 1 as const, mode: 'build' as const, agentType: 'orchestrator', creativeFreedom: 'balanced' as const,
      qualityMode: 'balanced' as const, model: { tier: 'standard', provider: 'fixture', modelName: 'fixture', customModelId: null,
        reasoningEffort: 'medium', routeRevision: 'a'.repeat(64) }, tools: toOpenAITools([storyCompilerPrepareTool], f.spec.scope),
      toolAuthority: [{ name: storyCompilerPrepareTool.name, permission: 'allow' as const, alwaysConfirm: false, dangerous: false }],
      protectedChapterIds: [], pinnedSkillVersions: [] }
    const initialized = await initializeExecutionState(lease, { configuration, snapshot: { version: 1, turn: 0, nextOperationSequence: 0,
      checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
      messages: [{ role: 'user', content: '写下一章' }, { role: 'assistant', content: null,
        toolCalls: [{ id: 'prepare', name: storyCompilerPrepareTool.name, arguments: rawArguments }] }] } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
    const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })
    const source = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const step = () => executeDurableToolStep(lease, new AbortController().signal)
    let frozen: Awaited<ReturnType<typeof prisma.agentOperation.findFirstOrThrow>> | null = null
    if (scenario === 'prepared') {
      vi.spyOn(operations, 'commitOperationEffect').mockRejectedValueOnce(new Error('synthetic interruption before DB effect'))
      await expect(step()).rejects.toThrow('synthetic interruption before DB effect')
      frozen = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, operationKey: 'exec:0' } })
      expect(frozen.status).toBe('prepared')
      expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(0)
    }
    if (scenario === 'succeeded') {
      vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(new Error('synthetic interruption after actual receipt'))
      await expect(step()).rejects.toThrow('synthetic interruption after actual receipt')
      frozen = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, operationKey: 'exec:0' } })
      expect(frozen.status).toBe('succeeded')
      expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(1)
    }
    if (scenario === 'rejected-old' || scenario === 'unknown') {
      // Freeze genuine v1 historical observation shape. Its raw decision was
      // rejected by the pre-decoder validator; current decoding must not turn
      // that recorded failure into a success or execute an unknown operation.
      expect(storyCompilerPrepareTool.parameters.safeParse(wire).success).toBe(false)
      const rejection = { version: 1, rawArguments, incomplete: false, code: 'TOOL_SCHEMA_INVALID',
        validation: { version: 1, schemaHash: runtimeJson(configuration.tools[0].function.parameters).hash },
        sourceRevision: initialized.frame.revision, sourceSnapshotHash: initialized.frame.snapshotHash }
      const operation = await operations.prepareOperation(lease, { key: 'exec:0', kind: 'tool', action: storyCompilerPrepareTool.name,
        input: runtimeJson({ callId: 'prepare', args: {}, rejection }).value })
      await saveExecutionState(lease, { expectedRevision: initialized.frame.revision, expectedHash: initialized.frame.snapshotHash,
        snapshot: { ...initialized.frame.state, phase: 'awaiting_operation', pendingOperationId: operation.id, nextOperationSequence: 1 } })
      if (scenario === 'rejected-old') await operations.recordToolFailure(lease, { operationId: operation.id, inputHash: operation.inputHash,
        code: 'TOOL_SCHEMA_INVALID', output: '旧版本已确认未执行：volumeDecision要求对象。', summary: '参数校验失败' })
      else await prisma.agentOperation.update({ where: { id: operation.id }, data: { status: 'unknown' } })
      frozen = await prisma.agentOperation.findFirstOrThrow({ where: { id: operation.id } })
    }
    const receiptBefore = frozen ? await prisma.agentEffectReceipt.findUnique({ where: { operationId: frozen.id } }) : null
    if (scenario === 'unknown') {
      const frameBefore = (await loadExecutionState(f.userId, f.runId)).frame
      await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect((await loadExecutionState(f.userId, f.runId)).frame).toEqual(frameBefore)
      expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(0)
    } else {
      const result = await step()
      expect(result.kind).toBe(scenario === 'succeeded' || scenario === 'rejected-old' ? 'recovered' : 'tool')
      const saved = await loadExecutionState(f.userId, f.runId)
      expect(saved.configuration).toEqual(initialized.configuration)
      expect(saved.frame.state.messages[1].toolCalls![0].arguments).toBe(rawArguments)
      expect(saved.frame.state.messages.at(-1)?.role).toBe('tool')
      if (scenario === 'rejected-old') {
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(0)
        expect(saved.frame.state.messages.at(-1)?.content).toContain('volumeDecision要求对象')
        // A new proposal may now decode the same wire representation, without
        // rewriting or resurrecting the old failed operation.
        await saveExecutionState(lease, { expectedRevision: saved.frame.revision, expectedHash: saved.frame.snapshotHash,
          snapshot: { ...saved.frame.state, messages: [...saved.frame.state.messages, { role: 'assistant', content: null,
            toolCalls: [{ id: 'new-prepare', name: storyCompilerPrepareTool.name, arguments: rawArguments }] }] } })
        expect((await step()).kind).toBe('tool')
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(1)
      } else {
        expect(await prisma.storyCompilation.count({ where: { runId: f.runId } })).toBe(1)
        const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, operationKey: 'exec:0' } })
        expect(operation.inputSnapshot).toMatchObject({ input: { args: canonical,
          normalization: { version: 1, rawArguments, normalizedArgsHash: runtimeJson(canonical).hash } } })
      }
    }
    if (frozen) {
      const after = await prisma.agentOperation.findUniqueOrThrow({ where: { id: frozen.id } })
      expect(after.inputSnapshot).toEqual(frozen.inputSnapshot)
      expect(after.inputHash).toBe(frozen.inputHash)
      if (scenario !== 'prepared') expect(await prisma.agentEffectReceipt.findUnique({ where: { operationId: frozen.id } })).toEqual(receiptBefore)
    }
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(source)
    expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).specSnapshot).toEqual(root.specSnapshot)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(budget)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
    expect(normalizeToolInput(storyCompilerPrepareTool, wire)).toEqual(canonical)
  }, undefined, '写下一章', { freezeWriting: true }))
})
