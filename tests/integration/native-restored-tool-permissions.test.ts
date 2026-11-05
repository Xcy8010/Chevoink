import { expectToolDenied } from '../support/expect-tool-denied.js'
import { randomUUID } from 'node:crypto'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fixture, claim, reported } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { modelRouteRevision, prepareModelCursorOperation, validateModelCursor } from '../../api/lib/agent/runtime-model-cursor.js'
import { readEffectiveNativeTooling } from '../../api/lib/agent/native-tool-policy.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { prepareProviderAttempt, markProviderDispatched, recordProviderUsage, recordProviderResult } from '../../api/lib/agent/runtime-operations.js'
import { settleProviderOperation } from '../../api/lib/agent/runtime-settlement.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { chapterSplitTool, chapterMergeTool, chapterMoveTool, volumeCreateTool } from '../../api/lib/agent/tools/structure-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'

describe('actual native permissions after a clipped historical catalog', () => {
  it.each(['allow', 'ask'] as const)('%s restores volume creation, preserves approval and resumes the exact prepared operation', async permission => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await fixture(async f => {
      const lease = await claim(f), signal = new AbortController().signal, window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, dailyUsedMilli: 0,
        bonusBalanceMilli: 0, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      await prisma.agentSession.update({ where: { id: f.sessionId }, data: { toolPolicy: { network: 'allow', contentWrite: permission,
        bulkWrite: permission, publish: 'allow', destructive: 'allow' } } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1', reasoningEffort: 'high' }
      const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: [{ type: 'function', function: { name: 'chapter_read', description: chapterReadTool.description,
          parameters: z.toJSONSchema(chapterReadTool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: 'chapter_read', permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0,
        checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '请创建第二卷' }], successfulToolSignatures: [] } })
      const tooling = await withRunLease(lease, tx => readEffectiveNativeTooling(tx, lease, initial.configuration, f.spec))
      const tools = tooling.tools.filter(tool => tool.function.name === 'volume_create')
      expect(tools).toHaveLength(1)
      const frame = initial.frame, cursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, key = `exec:${frame.state.nextOperationSequence}`
      await validateModelCursor(lease, cursor, { operationKey: key, messages: frame.state.messages, tools, tier: 'speed', route })
      const request = { endpoint: route.endpoint, body: { tools } }
      const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 10000,
        rateCardId: 'restored-tool-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }
      const model = await prepareModelCursorOperation(lease, cursor, { key, action: 'model_request', request: runtimeJson(request).value, price })
      const attempt = await prepareProviderAttempt(lease, { operationId: model.operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request })
      await markProviderDispatched(lease, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      const args = { title: '第二卷' }, call = { id: 'create-volume', name: 'volume_create', arguments: JSON.stringify(args) }
      await recordProviderUsage({ ...identity, revision: 1, usage: reported })
      await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [
        { id: 'unpublished-old-reader', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) }, call],
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } } })
      await settleProviderOperation({ ...identity, lease })
      await reduceExecutionReceipt(lease, { expectedRevision: model.pending.revision, expectedHash: model.pending.snapshotHash, operationId: model.operation.id })
      expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
      expect(await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'chapter_read' }, include: { effectReceipt: true } }))
        .toMatchObject({ effectReceipt: { result: { code: 'TOOL_NOT_AUTHORIZED', effectApplied: false } } })
      if (permission === 'ask') {
        const waiting = await executeDurableToolStep(lease, signal)
        expect(waiting.kind).toBe('waiting_approval')
        if (waiting.kind !== 'waiting_approval') throw new Error('Missing actual restored-tool approval')
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: call.id, approved: true, alwaysAllow: false })
      }
      const source = await loadExecutionState(f.userId, f.runId)
      const prepared = await prepareToolCursorOperation(lease, { expectedRevision: source.frame.revision, expectedHash: source.frame.snapshotHash }, {
        key: `exec:${source.frame.state.nextOperationSequence}`, action: call.name, callId: call.id, targetId: f.novelId, effectDomain: 'structure', effectiveArgs: args,
        normalize: raw => volumeCreateTool.parameters.parse(raw), operationInput: runtimeJson({ callId: call.id, novelId: f.novelId, args }).value })
      expect(prepared.operation.inputSnapshot).toMatchObject({ input: { toolAdmission: { grant: { name: 'volume_create', permission } } } })
      expect((await loadExecutionState(f.userId, f.runId)).configuration).toEqual(initial.configuration)
      expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'tool' })
      expect(await prisma.volume.count({ where: { novelId: f.novelId, title: args.title } })).toBe(1)
      const saved = await prisma.agentOperation.findUniqueOrThrow({ where: { id: prepared.operation.id } })
      expect(saved.inputHash).toBe(prepared.operation.inputHash)
      expect(await executeDurableToolStep(lease, signal)).toMatchObject({ kind: 'idle' })
      expect(await prisma.volume.count({ where: { novelId: f.novelId, title: args.title } })).toBe(1)
      expect((await loadExecutionState(f.userId, f.runId)).head.configurationHash).toBe(initial.head.configurationHash)
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(1)
      expect(fetch).not.toHaveBeenCalled()
    }, undefined, '请创建第二卷', { agentWritingProtocol: 1 })
  })
})

describe('ordinary structural tools preserve real manuscript boundaries', () => {
  it.each(['chapter_split', 'chapter_merge', 'chapter_move'] as const)('%s rejects an outside chapter in the same real transaction', async name => {
    await fixture(async f => {
      await claim(f)
      const original = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const outside = await prisma.chapter.create({ data: { novelId: f.novelId, authorId: f.userId, volumeId: original.volumeId,
        title: '范围外章节', orderIndex: 2, orderInVolume: 2, content: '范围外正文保持原样。' } })
      const tool = name === 'chapter_split' ? chapterSplitTool : name === 'chapter_merge' ? chapterMergeTool : chapterMoveTool
      const args = name === 'chapter_split' ? { chapterId: outside.id, splitOffset: 2, newChapterTitle: '新章' }
        : name === 'chapter_merge' ? { targetChapterId: f.chapterId, sourceChapterId: outside.id, separator: '\n' }
          : { chapterId: outside.id, targetVolumeId: original.volumeId, position: 1 }
      const context = { ...f, callId: 'real-structural-call', mode: 'build' as const, creativeFreedom: 'balanced' as const,
        qualityMode: 'balanced' as const, signal: new AbortController().signal, emit: () => {} }
      await expect(tool.execute(context, tool.parameters.parse(args) as never)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: outside.id } })).toEqual(outside)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original)
      expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(2)
    }, undefined, '修改本章', { freezeWriting: true })
  })
})

describe('split uses an actual new-chapter slot rather than a phase allowance', () => {
  it.each([true, false])('bound-only-source=%s preserves the actual chapter count', async bounded => fixture(async f => {
    await claim(f)
    const context = { ...f, callId: 'split', mode: 'build' as const, creativeFreedom: 'balanced' as const, qualityMode: 'balanced' as const, signal: new AbortController().signal, emit: () => {} }
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    if (bounded) {
      await expectToolDenied(chapterSplitTool.execute(context, { chapterId: f.chapterId, splitOffset: 1, newChapterTitle: '后半章' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
      expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    } else {
      expect(await chapterSplitTool.execute(context, { chapterId: f.chapterId, splitOffset: 1, newChapterTitle: '后半章' })).not.toHaveProperty('outcome', 'failed')
      expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(2)
    }
  }, undefined, bounded ? '修改本章' : '授权自主创作全书，并拆分已有章节。', { freezeWriting: bounded }))
  it('rejects splitting an actual frozen editor selection without changing body or structure', async () => fixture(async f => {
    const runId = randomUUID(), prompt = '仅修改第1章。将“原文”改为“修订文”。'
    const selection = { text: '原文', start: 0, end: 2 }
    const task = buildTaskSpec({ ...f, runId, prompt, selection, manuscriptProtocol: 1, authorWritingProtocol: 2, localEditProtocol: 1 })
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId, status: 'queued',
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: runtimeJson(JSON.parse(JSON.stringify(task))).value, startRequest: { prompt, selection } } })
    const source = await prisma.agentMessage.create({ data: { runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    const frozen = await prisma.$transaction(tx => freezeWritingScope(tx, { ...f, runId }, task, prompt, 2))
    expect(frozen.scope.selectionBoundary).toMatchObject({ chapterId: f.chapterId, start: 0, end: 2 })
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(frozen))).value } })
    const root = await initializeDurableTask({ userId: f.userId, runId, sourceMessageId: source.id })
    await claim({ ...f, runId, rootId: root.id })
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await expectToolDenied(chapterSplitTool.execute({ ...f, runId, callId: 'local-split', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      signal: new AbortController().signal, emit: () => {} }, { chapterId: f.chapterId, splitOffset: 1, newChapterTitle: '越界新章' }), { code: 'AUTHOR_SELECTION_SCOPE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
  }))
})

describe('split respects explicit volume placement of a new slot', () => {
  it('rolls back a split into the wrong volume even when the global chapter index matches', async () => fixture(async f => {
    const volume = await prisma.volume.create({ data: { novelId: f.novelId, title: '目标卷', orderIndex: 2 } })
    const runId = randomUUID(), prompt = '修改第1章，并写第2卷第1章。'
    const task = buildTaskSpec({ ...f, runId, prompt, authorWritingProtocol: 2 })
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId, status: 'queued',
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: runtimeJson(JSON.parse(JSON.stringify(task))).value, startRequest: { prompt } } })
    const source = await prisma.agentMessage.create({ data: { runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    const frozen = await prisma.$transaction(tx => freezeWritingScope(tx, { ...f, runId }, task, prompt, 2))
    expect(frozen.scope.writing).toMatchObject({ kind: 'bounded', targets: expect.arrayContaining([{ orderIndex: 2, chapterId: null, volumeId: volume.id, positionInVolume: 1 }]) })
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(frozen))).value } })
    const root = await initializeDurableTask({ userId: f.userId, runId, sourceMessageId: source.id })
    await claim({ ...f, runId, rootId: root.id })
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await expectToolDenied(chapterSplitTool.execute({ ...f, runId, callId: 'wrong-volume-split', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      signal: new AbortController().signal, emit: () => {} }, { chapterId: f.chapterId, splitOffset: 1, newChapterTitle: '错误位置新章' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).writingBindings).toBeNull()
  }))
})
