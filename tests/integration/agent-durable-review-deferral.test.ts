import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import * as chapterTools from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { projectExecutionFrame } from '../../api/lib/agent/runtime-frame-events.js'
import { claim, fixture } from '../support/agent-durable-runtime-fixture.js'

// Actual cursor/lease/PG/projection behavior. The shared manuscript admission is
// exercised separately with real persisted review cycles; this isolates its
// adapter outcome so a denied proposal cannot masquerade as an executed tool.
describe('native review proposal deferral', () => {
  it.each(['chapter_write', 'chapter_append', 'chapter_edit_range'] as const)('%s preserves effects and counters, appends only guidance and cannot forge its projection', async name => fixture(async f => {
    const lease = await claim(f)
    const writer = name === 'chapter_write' ? chapterTools.chapterWriteTool : name === 'chapter_append' ? chapterTools.chapterAppendTool : chapterTools.chapterEditRangeTool
    const tools = [chapterReadTool, writer]
    const args = name === 'chapter_edit_range' ? { chapterId: f.chapterId, oldText: '原文', newText: '另一种说法' }
      : { chapterId: f.chapterId, content: '另一种说法' }
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }, { role: 'assistant', content: null, toolCalls: [
          { id: 'read', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
          { id: 'edit-1', name, arguments: JSON.stringify(args) }, { id: 'edit-2', name, arguments: JSON.stringify(args) },
        ] }], successfulToolSignatures: [] } })
    await executeDurableToolStep(lease, new AbortController().signal)
    const before = (await loadExecutionState(f.userId, f.runId)).frame
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const operations = await prisma.agentOperation.findMany({ where: { taskRootId: f.rootId } })
    const receipts = await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })
    const reason = '当前核验没有事实错误；请逐项说明保留理由并保存章节进度。'
    const admission = vi.spyOn(chapterTools, 'preflightChapterReviewWrite').mockResolvedValue({
      kind: 'decision_required', code: 'REVIEW_CYCLE_DECISION_REQUIRED', guidance: reason,
    } as Awaited<ReturnType<typeof chapterTools.preflightChapterReviewWrite>>)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    for (const [offset, callId] of ['edit-1', 'edit-2'].entries()) {
      expect(await executeDurableToolStep(lease, new AbortController().signal)).toMatchObject({ kind: 'context' })
      const current = (await loadExecutionState(f.userId, f.runId)).frame
      expect(current.revision).toBe(before.revision + offset + 1)
      expect(current.state).toMatchObject({ turn: before.state.turn, nextOperationSequence: before.state.nextOperationSequence,
        checkpointIndex: before.state.checkpointIndex, successfulToolSignatures: before.state.successfulToolSignatures,
        phase: 'idle', pendingOperationId: null })
      expect(current.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: callId, content: expect.stringContaining(reason) })
      const source = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `state:${f.rootId}:${current.revision}` } })
      expect(await prisma.$transaction(tx => projectExecutionFrame(tx, source))).toEqual([expect.objectContaining({
        type: 'tool.deferred', callId, toolName: name, execution: 'not_dispatched', reason,
      })])
    }
    expect(admission).toHaveBeenCalledTimes(2)
    expect(admission.mock.calls.every(([ctx]) => !!ctx.transaction && ctx.durableContent?.expectedRevision === chapter.revision)).toBe(true)
    expect(await executeDurableToolStep(lease, new AbortController().signal)).toEqual({ kind: 'idle' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
    expect(await prisma.agentOperation.findMany({ where: { taskRootId: f.rootId } })).toEqual(operations)
    expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(receipts)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    const current = (await loadExecutionState(f.userId, f.runId)).frame
    const eventKey = `review-deferred:${f.rootId}:${current.revision}`
    const witness = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey } })
    const payload = witness.payload as Record<string, unknown>
    await prisma.agentExecutionOutbox.update({ where: { eventKey }, data: { payload: { ...payload, reason: '伪造成功' } } })
    const source = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `state:${f.rootId}:${current.revision}` } })
    await expect(prisma.$transaction(tx => projectExecutionFrame(tx, source))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  }))
})
