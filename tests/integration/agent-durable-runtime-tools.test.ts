import { createHash,randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { markProviderDispatched,prepareProviderAttempt,recordProviderResult,recordProviderUsage } from '../../api/lib/agent/runtime-operations.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { preparePricedProviderOperation } from '../../api/lib/agent/runtime-settlement.js'
import { initializeExecutionState,loadExecutionState,saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { rejectToolCursorCall } from '../../api/lib/agent/runtime-tool-cursor.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { chapterCreateTool,chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { planTargetHash } from '../../api/lib/agent/tools/durable-plan.js'
import { chapterListSummariesTool,chapterReadTool,memorySearchTool,novelGetContextTool,planReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { sceneTaskBuildTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { structureOutlineTool,volumeCreateTool,volumeListTool } from '../../api/lib/agent/tools/structure-tools.js'
import type { AgentTool,ToolContext } from '../../api/lib/agent/tools/types.js'
import { planSaveTool } from '../../api/lib/agent/tools/write-tools.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { getStructureReportObservation } from '../../api/lib/data-access.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture,novelFixture,reported } from '../support/agent-durable-runtime-fixture.js'

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
    await novelFixture(async f => {
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
    await novelFixture(async f => {
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

