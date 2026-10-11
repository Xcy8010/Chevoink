import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('F15 actual body adapter recovery', () => {
  it.each(['receipt-return', 'before-reduction', 'reduction-return', 'projection-return'] as const)(
    '%s interruption preserves one body CAS and its original evidence', async fault => {
      vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      await fixture(async f => {
        const lease = await claim(f)
        const tools = [chapterReadTool, chapterEditRangeTool]
        await initializeExecutionState(lease, {
          configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
            model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
            tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description,
              parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
            toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })),
            protectedChapterIds: [], pinnedSkillVersions: [] },
          snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
            messages: [{ role: 'user', content: '修改本章' }, { role: 'assistant', content: null, toolCalls: [
              { id: 'read', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: f.chapterId }) },
              { id: 'edit', name: chapterEditRangeTool.name, arguments: JSON.stringify({ chapterId: f.chapterId,
                oldText: '原文', newText: '已核验的新正文' }) },
            ] }], successfulToolSignatures: [] },
        })
        const signal = new AbortController().signal
        await executeDurableToolStep(lease, signal)
        const interruption = new Error(`fixture ${fault}`)
        if (fault === 'receipt-return') {
          const original = operations.commitOperationEffect
          vi.spyOn(operations, 'commitOperationEffect').mockImplementationOnce(async (...args) => {
            await original(...args)
            throw interruption
          })
        } else if (fault === 'before-reduction') {
          vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(interruption)
        } else if (fault === 'reduction-return') {
          const original = reducer.reduceExecutionReceipt
          vi.spyOn(reducer, 'reduceExecutionReceipt').mockImplementationOnce(async (...args) => {
            await original(...args)
            throw interruption
          })
        }
        if (fault === 'projection-return') await executeDurableToolStep(lease, signal)
        else await expect(executeDurableToolStep(lease, signal)).rejects.toThrow(interruption.message)

        const saved = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        expect(saved).toMatchObject({ content: '已核验的新正文', revision: 2 })
        const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: chapterEditRangeTool.name },
          include: { effectReceipt: true } })
        expect(operation.status).toBe('succeeded')
        expect(operation.effectReceipt).not.toBeNull()
        const identity = { id: operation.id, inputHash: operation.inputHash, resultHash: operation.effectReceipt!.resultHash }
        const effectsBefore = await prisma.agentExecutionOutbox.count({ where: { operationId: operation.id, type: 'effect.committed' } })
        expect(effectsBefore).toBe(1)

        if (fault === 'receipt-return' || fault === 'before-reduction') {
          expect((await loadExecutionState(f.userId, f.runId)).frame.state.phase).toBe('awaiting_operation')
          expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'recovered' })
        }
        expect(await executeDurableToolStep(lease, signal)).toEqual({ kind: 'idle' })
        const frame = (await loadExecutionState(f.userId, f.runId)).frame
        expect(frame.state.messages.filter(message => message.role === 'tool' && message.toolCallId === 'edit')).toHaveLength(1)
        expect(frame.state.phase).toBe('idle')
        if (fault === 'projection-return') {
          await expect((async () => { await publishDurableEvents(f.userId, f.runId); throw interruption })()).rejects.toThrow(interruption.message)
        } else await publishDurableEvents(f.userId, f.runId)
        const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
        const resultEvents = events.filter(event => {
          const payload = event.payload as { type?: string; callId?: string }
          return payload.type === 'tool.result' && payload.callId === 'edit'
        })
        expect(resultEvents).toHaveLength(1)
        expect(await publishDurableEvents(f.userId, f.runId)).toEqual([])
        expect(await prisma.agentRunEvent.count({ where: { runId: f.runId } })).toBe(events.length)
        const restored = await prisma.agentOperation.findUniqueOrThrow({ where: { id: operation.id }, include: { effectReceipt: true } })
        expect({ id: restored.id, inputHash: restored.inputHash, resultHash: restored.effectReceipt!.resultHash }).toEqual(identity)
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: chapterEditRangeTool.name } })).toBe(1)
        expect(await prisma.agentExecutionOutbox.count({ where: { operationId: operation.id, type: 'effect.committed' } })).toBe(effectsBefore)
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(saved)
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      })
    }, 30_000,
  )
})
