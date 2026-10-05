import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { env } from '../../api/config/env.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { advanceDurableCheckpoint } from '../../api/lib/agent/runtime-checkpoint-step.js'
import { collectDurableDeliverables } from '../../api/lib/agent/runtime-deliverables.js'
import { collectDurableToolEvidence } from '../../api/lib/agent/runtime-evidence.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import * as runtimeOperations from '../../api/lib/agent/runtime-operations.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { initializeExecutionState,loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterMergeTool,chapterMoveTool,chapterMoveToVolumeTool,chapterSplitTool,structureOutlineTool,volumeDeleteTool,volumeListTool,volumeMoveTool,volumeUpdateTool } from '../../api/lib/agent/tools/structure-tools.js'
import { chatWithTools } from '../../api/lib/ai-service.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,novelFixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('durable structural mutation batch', () => {
  it.each(['volume_update', 'volume_move', 'volume_delete', 'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge',
    'missing-baseline', 'missing-content', 'stale', 'protected', 'effect-gap', 'nonempty-delete', 'approval', 'structure-checkpoint', 'structure-noop'] as const)('%s preserves original structure decisions and receipts', async scenario => {
    const originalTurns = env.agentMaxTurns
    const checkpoints = scenario.startsWith('structure-')
    if (checkpoints) env.agentMaxTurns = 1
    try { await novelFixture(async f => {
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
        expect(await advanceDurableCheckpoint(lease)).toBeNull()
        expect((await readTaskBudget(lease)).budget.checkpointCount).toBe(0)
        expect(await advanceDurableCheckpoint(lease)).toBeNull()
      } else if (scenario === 'structure-noop') {
        expect(await advanceDurableCheckpoint(lease)).toBeNull()
        expect((await prisma.volume.findUniqueOrThrow({ where: { id: secondVolume.id } })).revision).toBe(secondVolume.revision)
      }
    }) } finally { env.agentMaxTurns = originalTurns }
  }, 30_000)
})

