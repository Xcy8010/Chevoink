import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import { runtimeTransaction, runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep, getDurableToolAdapterNames } from '../../api/lib/agent/runtime-tool-step.js'
import { commitNovelDeletion } from '../../api/lib/agent/runtime-novel-delete.js'
import * as deletionRuntime from '../../api/lib/agent/runtime-novel-delete.js'
import { runReviewedDurableExecution } from '../../api/lib/agent/runtime-executor.js'
import { executePersistedLoopRun } from '../../api/lib/agent/run-service.js'
import { releaseRunLease } from '../../api/lib/agent/runtime-lease.js'
import { getActiveRun } from '../../api/lib/agent/active-runs.js'
import { readVerifiedNovelDeletion } from '../../api/lib/agent/runtime-novel-delete-read.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { loadDurableEvents, publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { readAgentCreationState } from '../../api/lib/agent/creation-state.js'
import { novelDeleteTool as tool } from '../../api/lib/agent/tools/novel-tools.js'
import { consumeCreditsInTransaction, getCreditWindow, getCreditUsage, getTaskCreditUsage, refundCreditCharge } from '../../api/lib/credits.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { FALLBACK_USAGE_POLICY } from '../../api/lib/billing/reservation-policy.js'

describe.runIf(available)('native deletion commits real effects outside the heartbeat and retains historical truth', () => {
  it.each(['delete', 'heartbeat', 'worker', 'lost-response', 'replay', 'rollback', 'billing', 'not-dispatched', 'historical-failure', 'foreign', 'cursor', 'rename-before', 'rename-after', 'denied',
    'current-deny', 'cancel', 'cancel-during', 'other-run', 'queued', 'held', 'legacy-child', 'style-processing', 'reserved', 'unknown-web', 'goal', 'child', 'expired'] as const)('%s', scenario =>
    fixture(async f => {
      const fetch = vi.fn(async () => { throw Error('Deletion must never dispatch a provider') }); vi.stubGlobal('fetch', fetch)
      const controller = new AbortController(), lease = await claim(f)
      await prisma.user.update({ where: { id: f.userId }, data: { novelCount: 1 } })
      await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
      const args = { confirmTitle: '持久执行测试' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
        model: { tier: 'speed', provider: 'synthetic', modelName: 'synthetic', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: 'ask', dangerous: true, alwaysConfirm: true }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
          messages: [{ role: 'user', content: '永久删除当前作品及全部章节。' }, { role: 'assistant', content: null, toolCalls: [{ id: 'delete-call', name: tool.name, arguments: JSON.stringify(args) }] }] } })
      expect(getDurableToolAdapterNames()).toContain('novel_delete')
      const step = () => executeDurableToolStep(lease, controller.signal)
      const waiting = await step()
      if (waiting.kind !== 'waiting_approval') throw Error('Expected exact original deletion approval')
      expect(await prisma.novel.findUnique({ where: { id: f.novelId } })).not.toBeNull()
      expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(0)
      await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId,
        callId: 'delete-call', approved: scenario !== 'denied', alwaysAllow: false })
      if (scenario === 'denied') {
        expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(await prisma.novel.findUnique({ where: { id: f.novelId } })).not.toBeNull()
        expect(fetch).not.toHaveBeenCalled(); return
      }
      if (scenario === 'rename-before') {
        await prisma.novel.update({ where: { id: f.novelId }, data: { title: '变更后的合成名称' } })
        await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_DELETE_TITLE_MISMATCH' })
        expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId } })).toBe(0); return
      }
      if (scenario === 'cursor') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 17, type: 'fixture', payload: { originalSequence: 17 } } })
      let historicalRunId: string | undefined
      if (scenario === 'not-dispatched' || scenario === 'historical-failure') {
        const old = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
          mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: scenario === 'historical-failure' ? 'failed' : 'paused' } })
        historicalRunId = old.id
        if (scenario === 'not-dispatched') await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: old.id,
          providerType: 'text', providerMode: 'default', modelName: 'original-model', modelTier: 'speed', action: 'workspaceAgent', targetType: 'agentRun', targetId: old.id,
          durationMs: 0, billingStatus: 'not_dispatched', usageSource: 'unknown', billingSnapshot: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 },
          billingEvidence: { policy: FALLBACK_USAGE_POLICY, inputEstimate: 100, outputEstimate: 0, responseObserved: false } } })
      }
      if (scenario === 'billing') {
        const window = getCreditWindow()
        await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
        const log = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, agentRunId: f.runId,
          providerType: 'text', providerMode: 'default', modelName: 'original-model', action: 'workspaceAgent', targetType: 'agentRun', targetId: f.runId,
          requestTokens: 100, responseTokens: 10, promptCacheHitTokens: 40, promptCacheMissTokens: 60, creditChargeMilli: 1000, durationMs: 1, billingStatus: 'settled' } })
        await prisma.$transaction(tx => consumeCreditsInTransaction(tx, { userId: f.userId, amountMilli: 1000, kind: 'usage', sourceType: 'agent_tokens',
          idempotencyKey: `usage:${log.id}`, referenceId: f.runId, requestTokens: 100, responseTokens: 10, modelTier: 'speed', multiplierBps: 10000 }))
      }
      const ready = await step()
      if (ready.kind !== 'deletion_ready') throw Error('Expected prepare-only deletion boundary')
      expect(await prisma.agentRunLease.findUnique({ where: { runId: f.runId } })).not.toBeNull()
      expect(await prisma.novel.findUnique({ where: { id: f.novelId } })).not.toBeNull()
      let childId: string | undefined
      try {
        if (scenario === 'rename-after') await prisma.novel.update({ where: { id: f.novelId }, data: { title: '变更后的合成名称' } })
        if (scenario === 'current-deny') await prisma.agentSession.update({ where: { id: f.sessionId }, data: { toolPolicy: { destructive: 'deny' } } })
        if (scenario === 'other-run' || scenario === 'child') {
          const other = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
            mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: scenario === 'child' ? 'completed' : 'queued' } })
          if (scenario === 'child') {
            const grant = await prisma.agentChildExecutionGrant.create({ data: { id: randomUUID(), parentRootId: f.rootId, parentOperationId: ready.operationId, childIndex: 0,
              admissionRunId: f.runId, admissionEpoch: lease.epoch, currentParentRunId: f.runId, generation: 1, childRunId: other.id,
              kind: 'spawned', tokenCeiling: 500, snapshot: {}, snapshotHash: runtimeJson({}).hash, status: 'completed' } })
            childId = grant.id
          }
        }
        if (scenario === 'reserved') await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId,
          providerType: 'text', providerMode: 'default', modelName: 'synthetic', action: 'workspaceAgent', targetType: 'agentRun', targetId: f.runId,
          durationMs: 1, reservedCreditMilli: 1000, billingStatus: 'reserved' } })
        if (scenario === 'unknown-web') await prisma.webToolCall.create({ data: { id: randomUUID(), runId: f.runId, kind: 'fetch', requestHash: 'b'.repeat(64), amountMilli: 2000, multiplierBps: 10000 } })
        if (scenario === 'goal') await prisma.agentGoal.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, status: 'completed', executionOptions: {} } })
        if (scenario === 'legacy-child') {
          const subtask = await prisma.agentSubtask.create({ data: { userId: f.userId, novelId: f.novelId, role: 'synthetic', prompt: 'synthetic' } })
          await prisma.agentSubtaskRun.create({ data: { subtaskId: subtask.id, parentRunId: f.runId, userId: f.userId, novelId: f.novelId, task: 'synthetic', status: 'running' } })
        }
        if (scenario === 'style-processing') {
          const profile = await prisma.styleProfile.create({ data: { userId: f.userId, novelId: f.novelId, kind: 'author', name: 'synthetic', stats: {}, sampleCount: 0, sampleChars: 0, contentHash: 'a'.repeat(64) } })
          await prisma.styleLearningJob.create({ data: { requestId: randomUUID(), profileId: profile.id, selection: {}, modelIdentity: {}, chunks: [], status: 'processing' } })
        }
        if (scenario === 'queued' || scenario === 'held') await prisma.agentQueuedRequest.create({ data: { id: randomUUID(), userId: f.userId, sessionId: f.sessionId, status: scenario === 'queued' ? 'pending' : 'held', payload: { syntheticAuthorRequest: 'must survive' } } })
        if (scenario === 'expired') await prisma.agentRunLease.update({ where: { runId: f.runId }, data: { expiresAt: new Date(0) } })
        if (scenario === 'cancel') controller.abort(Error('Synthetic author cancellation'))
        if (scenario === 'rollback') vi.spyOn(operations, 'commitOperationEffectInTransaction').mockRejectedValueOnce(Error('Synthetic effect write unavailable'))
        if (scenario === 'cancel-during') {
          const original = operations.commitOperationEffectInTransaction
          vi.spyOn(operations, 'commitOperationEffectInTransaction').mockImplementationOnce(async (...input) => {
            const receipt = await original(...input); controller.abort(Error('Synthetic cancellation before purge commit')); return receipt
          })
        }
        const blocked = ['rename-after', 'current-deny', 'cancel', 'cancel-during', 'other-run', 'queued', 'held', 'legacy-child', 'style-processing', 'reserved', 'unknown-web', 'goal', 'child', 'expired', 'rollback'].includes(scenario)
        if (scenario === 'worker' || scenario === 'lost-response') {
          await releaseRunLease(lease)
          if (scenario === 'lost-response') {
            const write = deletionRuntime.commitNovelDeletion
            vi.spyOn(deletionRuntime, 'commitNovelDeletion').mockImplementationOnce(async (...input) => {
              await write(...input); throw Error('Synthetic response lost after committed deletion')
            })
          }
        }
        const execute = () => scenario === 'worker' || scenario === 'lost-response' ? executePersistedLoopRun(f.userId, f.runId)
          : scenario === 'heartbeat' ? runReviewedDurableExecution(lease, controller.signal) : commitNovelDeletion(lease, ready, controller.signal)
        if (blocked) {
          if (scenario === 'cancel' || scenario === 'cancel-during') await expect(execute()).rejects.toThrow(/Synthetic.*cancellation/)
          else if (scenario === 'rollback') await expect(execute()).rejects.toThrow('Synthetic effect write unavailable')
          else await expect(execute()).rejects.toMatchObject({ code: scenario === 'rename-after' ? 'RUNTIME_DELETE_TITLE_MISMATCH'
            : scenario === 'current-deny' ? 'RUNTIME_EFFECT_NOT_AUTHORIZED' : scenario === 'expired' ? 'RUNTIME_LEASE_LOST' : 'RUNTIME_DELETE_RECONCILIATION_REQUIRED' })
          expect(await prisma.novel.findUnique({ where: { id: f.novelId } })).not.toBeNull()
          expect(await prisma.agentRun.findUnique({ where: { id: f.runId } })).not.toBeNull()
          expect(await prisma.agentEffectReceipt.findUnique({ where: { operationId: ready.operationId } })).toBeNull()
          expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: { in: ['novel.deletion.committed', 'novel.deletion.accounting'] } } })).toBe(0)
          expect((await prisma.user.findUniqueOrThrow({ where: { id: f.userId } })).novelCount).toBe(1)
          if (scenario === 'queued' || scenario === 'held') expect(await prisma.agentQueuedRequest.count({ where: { sessionId: f.sessionId } })).toBe(1)
          if (childId) expect(await prisma.agentChildExecutionGrant.findUnique({ where: { id: childId } })).not.toBeNull()
          expect(fetch).not.toHaveBeenCalled(); return
        }
        const result = await execute()
        expect(result.kind).toBe('novel_deleted')
        if (scenario === 'worker' || scenario === 'lost-response') expect(getActiveRun(f.runId)).toBeUndefined()
        expect(await prisma.novel.findUnique({ where: { id: f.novelId } })).toBeNull()
        expect(await prisma.agentRun.findUnique({ where: { id: f.runId } })).toBeNull()
        expect(await prisma.agentRunLease.findUnique({ where: { runId: f.runId } })).toBeNull()
        expect((await prisma.user.findUniqueOrThrow({ where: { id: f.userId } })).novelCount).toBe(0)
        expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('completed')
        const proof = await runtimeTransaction(tx => readVerifiedNovelDeletion(tx, f.userId, f.runId))
        expect(proof?.deletion.operationId).toBe(ready.operationId)
        const events = await loadDurableEvents(f.userId, f.runId, 0)
        expect(events.map(event => event.type)).toEqual(['tool.result', 'message.start', 'text.final', 'run.finished'])
        expect(events.at(-1)).toMatchObject({ status: 'succeeded', deletedNovelId: f.novelId })
        expect(await publishDurableEvents(f.userId, f.runId)).toEqual(events)
        expect((await readAgentCreationState(f.userId, f.runId)).delivery).toMatchObject({ source: 'deletion_receipt', status: 'completed', verified: false })
        if (scenario === 'replay') {
          expect(await commitNovelDeletion(lease, ready, controller.signal)).toEqual(result)
          expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'novel.deletion.committed' } })).toBe(1)
        }
        if (historicalRunId) {
          const oldState = await readAgentCreationState(f.userId, historicalRunId)
          expect(oldState.execution.status).toBe(scenario === 'historical-failure' ? 'failed' : 'paused')
          expect((await loadDurableEvents(f.userId, historicalRunId, 0))[0]).toMatchObject({ type: 'error', code: 'NOVEL_DELETED' })
          expect(oldState.obligations).toBeNull()
          if (scenario === 'not-dispatched') {
            expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
            expect(await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId } })).toMatchObject({ billingStatus: 'not_dispatched', creditChargeMilli: 0, novelId: null, agentRunId: historicalRunId })
          }
        }
        if (scenario === 'foreign') {
          expect(await runtimeTransaction(tx => readVerifiedNovelDeletion(tx, 'other-user', f.runId))).toBeNull()
          await expect(getTaskCreditUsage('other-user', f.runId)).rejects.toMatchObject({ code: 'AGENT_RUN_NOT_FOUND' })
        }
        if (scenario === 'cursor') {
          expect(events.map(event => event.seq)).toEqual([18, 19, 20, 21])
          expect(await loadDurableEvents(f.userId, f.runId, 19)).toEqual(events.slice(2))
          expect(await loadDurableEvents(f.userId, f.runId, 21)).toEqual([])
          await expect(loadDurableEvents(f.userId, f.runId, 22)).rejects.toMatchObject({ code: 'RUNTIME_EVENT_CURSOR_AHEAD' })
        }
        if (scenario === 'billing') {
          const log = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId } })
          expect(log).toMatchObject({ novelId: null, chapterId: null, agentRunId: f.runId, creditChargeMilli: 1000, requestTokens: 100, responseTokens: 10, promptCacheHitTokens: 40 })
          expect(await getTaskCreditUsage(f.userId, f.runId)).toMatchObject({ charged: 1, refunded: 0, netCharged: 1 })
          expect((await getCreditUsage(f.userId)).ledger[0]).toMatchObject({ taskRunId: f.runId, promptCacheHitTokens: 40 })
          await refundCreditCharge(f.userId, `usage:${log.id}`, 'synthetic-after-deletion')
          expect(await getTaskCreditUsage(f.userId, f.runId)).toMatchObject({ charged: 1, refunded: 1, netCharged: 0 })
        }
        expect(fetch).not.toHaveBeenCalled()
      } finally {
        // A failed setup/negative assertion must remain the reported failure;
        // cleanup must not replace it with "record not found".
        if (childId) await prisma.agentChildExecutionGrant.deleteMany({ where: { id: childId } })
      }
    }, undefined, '永久删除当前作品及全部章节。'))
})
