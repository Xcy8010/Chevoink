import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe,expect,it,vi } from 'vitest'
import { stopLoopRun,streamLoopRun } from '../../api/lib/agent/run-service.js'
import { pollToolApproval,requestToolApproval,resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { loadDurableEvents,publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { initializeExecutionState,loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { chapterAppendTool,chapterEditRangeTool,chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { chatWithTools } from '../../api/lib/ai-service.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture } from '../support/agent-durable-runtime-fixture.js'

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
  it.each(['normal', 'v2-price', 'byok-v1', 'concurrent', 'prepare-state-gap', 'result-state-gap', 'unknown', 'context', 'route', 'tool-list', 'pending-tools', 'mutated-input', 'stop-resume'] as const)('%s', async scenario => {
    await fixture(async f => {
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 1, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      let lease = await claim(f)
      const byok = scenario === 'byok-v1'
      const route = { provider: byok ? 'fixture-byok' : 'fixture', model: byok ? 'fixture-byok' : 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      const configuration = { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: byok ? 'custom' : 'speed', provider: route.provider, modelName: route.model, customModelId: byok ? 'fixture-byok-model' : null, reasoningEffort: route.reasoningEffort, routeRevision: modelRouteRevision(route) },
        tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] }
      const messages: import('../../api/lib/ai-service.js').ChatMessage[] = [{ role: 'user', content: '修改本章' }]
      if (scenario === 'pending-tools') messages.push({ role: 'assistant', content: null, toolCalls: [{ id: 'unanswered', name: 'chapter_read', arguments: '{}' }] })
      const initial = await initializeExecutionState(lease, { configuration, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
        phase: 'idle', pendingOperationId: null, messages, successfulToolSignatures: [] } })
      const request = { messages, tools: [] as import('../../api/lib/ai-service.js').OpenAIToolDefinition[], model: route.model, provider: route.provider,
        reasoningEffort: 'high' as const, providerApiKey: 'fixture-not-real', providerBaseUrl: 'https://provider.invalid/v1',
        durableExecution: { lease, operationKey: 'exec:0', attemptKey: '1', cursor: { expectedRevision: 0, expectedHash: initial.frame.snapshotHash },
          ...(scenario === 'v2-price' ? { price: { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000, rateCardId: 'fixture-model-v2', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } } } : {}) },
        usageLog: { userId: f.userId, agentRunId: f.runId, action: 'fixture', modelTier: byok ? 'custom' as const : 'speed' as const } }
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
      } else expect(await running).toMatchObject({ content: '完整结果', billing: { status: 'settled', chargedMilli: byok ? 0 : 1, exhausted: byok ? false : true } })
      request.messages = [{ role: 'user', content: '修改本章' }]
      expect(await chatWithTools(request)).toMatchObject({ content: '完整结果', billing: { chargedMilli: byok ? 0 : 1 } })
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

