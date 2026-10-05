import { Prisma } from '@prisma/client'
import { randomBytes,randomUUID } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { deregisterActiveRun,registerActiveRun } from '../../api/lib/agent/active-runs.js'
import { recoverStaleLoopRuns,stopLoopRun } from '../../api/lib/agent/run-service.js'
import { readTaskBudget,taskTurnLimit } from '../../api/lib/agent/runtime-budget.js'
import { commitRuntimeCheckpoint } from '../../api/lib/agent/runtime-checkpoint.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { assertLegacyRuntimeCompatible,attachRunToDurableTask,initializeDurableTask,startLegacyRuntimeRun } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease,renewRunLease,revokeRunLease,withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { fenceLocallyStoppedLegacyRun,pauseDurableTask,pauseLegacyOrphanRun,recoverLegacyOrphanRun } from '../../api/lib/agent/runtime-lifecycle.js'
import { commitOperationEffect,markProviderDispatched,prepareOperation,prepareProviderAttempt,recordProviderResult,recordProviderUsage,type ProviderUsageObservation } from '../../api/lib/agent/runtime-operations.js'
import { preparePricedProviderOperation,settleProviderOperation,type DurableTokenPrice } from '../../api/lib/agent/runtime-settlement.js'
import { initializeExecutionState,loadExecutionState,saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { chapterAppendTool,chapterEditRangeTool,chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { chatWithTools } from '../../api/lib/ai-service.js'
import { createRateCard,transitionRateCard } from '../../api/lib/billing/rate-cards.js'
import { resolveDurableTokenPrice } from '../../api/lib/billing/resolve-token-price.js'
import * as credits from '../../api/lib/credits.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { encryptSecret } from '../../api/lib/secret-box.js'
import type { DynamicBuiltInModelTier } from '../../shared/contracts/model-tier.js'
import { available,claim,fixture,reported } from '../support/agent-durable-runtime-fixture.js'

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
      const tier = ('builtin_' + randomBytes(8).toString('hex')) as DynamicBuiltInModelTier
      const model = await prisma.aiModelConfig.create({ data: { key: tier, tier, provider: 'fixture', displayName: '持久费率测试', modelName: 'isolated-rate-replay',
        baseUrl: 'https://fixture.invalid/v1', apiKeyCiphertext: encryptSecret('isolated-never-dispatched'), enabled: true, selectable: true, multiplierBps: 11000 } })
      try {
        const price: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: tier, multiplierBps: 11000,
          rateCardId: randomUUID(), rates: { inputNano: 110000, cacheNano: 110000, outputNano: 1100000 } }
        await createRateCard(f.userId, price)
        await transitionRateCard(f.userId, { id: price.rateCardId, expectedRevision: 0, status: 'shadow', evidence: { note: 'fixture' } })
        await transitionRateCard(f.userId, { id: price.rateCardId, expectedRevision: 1, status: 'approved', evidence: { note: 'synthetic test only', reportHash: 'b'.repeat(64), shadowDays: 7,
          totalFeeDeviationPercent: 0, userTaskP95AbsoluteDeviationPercent: 0, cashCostIncreasePercent: 0, allGroupsReviewed: true, qualityPassed: true } })
        await transitionRateCard(f.userId, { id: price.rateCardId, expectedRevision: 2, status: 'active', evidence: { note: 'fixture', publicNoticeRef: 'fixture' } })
        expect(await resolveDurableTokenPrice(lease, 'v2:model', tier, 99999)).toEqual(price)
        await preparePricedProviderOperation(lease, { key: 'v2:model', action: 'chat', request: {}, price })
        await transitionRateCard(f.userId, { id: price.rateCardId, expectedRevision: 3, status: 'retired', evidence: { note: 'fixture retirement' } })
        expect(await resolveDurableTokenPrice(lease, 'v2:model', tier, 99999)).toEqual(price)
        await expect(resolveDurableTokenPrice(lease, 'new:model', tier, 99999)).rejects.toMatchObject({ code: 'RUNTIME_PRICE_REQUIRED' })
        await prisma.aiModelConfig.update({ where: { id: model.id }, data: { enabled: false } })
        expect(await resolveDurableTokenPrice(lease, 'v2:model', tier, 99999)).toEqual(price)
        await expect(credits.getModelTierRuntime(tier, f.userId)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
        await expect(credits.assertCreditAccess(f.userId, tier)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
      } finally { await prisma.aiModelConfig.delete({ where: { id: model.id } }) }
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
        expect(taskTurnLimit(budget.policy, 0)).toBeNull()
        if (scenario === 'legacy-policy') {
          const saved = runtimeJson({ version: 1, initialTokens: 500, tokenCeiling: 5000000, budgetSlice: 2000000,
            maxCheckpoints: 4, maxCompactions: 6, wallClockMs: 1, longWallClockMs: 1 })
          await prisma.agentTaskBudget.update({ where: { taskRootId: f.rootId }, data: { policy: saved.value, policyHash: saved.hash } })
          expect((await readTaskBudget(token)).policy.version).toBe(1)
          expect((await initializeExecutionState(token, { configuration, snapshot })).frame.state.turn).toBe(0)
          expect((await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).policyHash).toBe(saved.hash)
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
          await expect(commitRuntimeCheckpoint(token, { expectedCheckpointCount: 0, progressOperationId: first.id, snapshot: checkpointSnapshot })).rejects.toMatchObject({ code: 'RUNTIME_CHECKPOINT_NOT_DUE' })
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
        const input = { expectedCheckpointCount: 0, progressOperationId: write.id, snapshot: checkpointSnapshot }
        await expect(commitRuntimeCheckpoint(token, input)).rejects.toMatchObject({ code: 'RUNTIME_CHECKPOINT_NOT_DUE' })
        const advanced = await readTaskBudget(token)
        expect(taskTurnLimit(advanced.policy, advanced.budget.checkpointCount)).toBeNull()
        expect(advanced.usedTokens).toBe(10n)
        frame = await saveExecutionState(token, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: nextState })
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

  it('sweeps executor-less stale protocol-zero runs while protecting a locally registered executor', async () => {
    await fixture(async f => {
      const quiet = new Date(Date.now() - 30 * 60_000)
      const zombie = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator' } })
      const registered = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator' } })
      await prisma.agentRun.updateMany({ where: { id: { in: [zombie.id, registered.id] } }, data: { updatedAt: quiet } })
      registerActiveRun(registered.id, { controller: new AbortController(), sessionId: f.sessionId, userId: f.userId })
      try {
        await recoverStaleLoopRuns()
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: zombie.id } })).status).toBe('failed')
        expect(await prisma.agentMessage.count({ where: { runId: zombie.id } })).toBe(1)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: registered.id } })).status).toBe('running')
        // 幂等重扫：已收敛的行不再入选，仍在内存注册的 run 不受打扰
        await recoverStaleLoopRuns()
        expect(await prisma.agentMessage.count({ where: { runId: zombie.id } })).toBe(1)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: registered.id } })).status).toBe('running')
      } finally {
        deregisterActiveRun(registered.id)
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
      await expect(commitRuntimeCheckpoint(token, checkpoint)).rejects.toMatchObject({ code: 'RUNTIME_CHECKPOINT_NOT_DUE' })
      expect((await readTaskBudget(token)).budget.checkpointCount).toBe(0)
    }, 500)
  })

  it.each(['replay', 'corrupt', 'revoked', 'old-progress', 'outbox-gap', 'resume'] as const)('historical checkpoint evidence %s stays immutable without new budget slices', async fault => {
    await fixture(async f => {
      const { token, identity } = await pricedCall(f)
      await recordProviderUsage({ ...identity, revision: 1, usage: { ...reported, promptTokens: 500, cacheMissTokens: 500 } })
      const operation = await prepareOperation(token, { key: 'revision:1', kind: 'tool', action: 'chapter_write', input: { chapterId: f.chapterId } })
      await commitOperationEffect(token, operation.id, operation.inputHash, async tx => {
        await tx.chapter.update({ where: { id: f.chapterId }, data: { content: '历史真实修订内容' } })
        return { progress: { kind: 'content_revision', targetId: f.chapterId, beforeHash: runtimeJson({ content: '原文' }).hash,
          afterHash: runtimeJson({ content: '历史真实修订内容' }).hash } }
      })
      const input = { expectedCheckpointCount: 0, progressOperationId: operation.id,
        snapshot: { version: 1, taskRootId: f.rootId, context: '历史已保存内容', remainingWork: ['校验本章'] } }
      const snapshot = runtimeJson(input.snapshot), request = runtimeJson({ ...input, snapshot: snapshot.value })
      const policy = runtimeJson({ version: 2, initialTokens: 500, tokenCeiling: 5000000, budgetSlice: 2000000,
        maxCheckpoints: 1, maxCompactions: 1, initialTurns: 1, turnSlice: 1, wallClockMs: 1, longWallClockMs: 1 })
      // Construct an owned pre-upgrade receipt, not a new executor allocation.
      await prisma.$transaction(async tx => {
        await tx.agentTaskBudget.update({ where: { taskRootId: f.rootId }, data: { policy: policy.value, policyHash: policy.hash,
          tokenLimit: 2000500, checkpointCount: 1, compactionCount: 1 } })
        await tx.agentRuntimeCheckpoint.create({ data: { taskRootId: f.rootId, checkpointIndex: 1, originRunId: f.runId,
          progressOperationId: operation.id, requestHash: request.hash, snapshot: snapshot.value, snapshotHash: snapshot.hash } })
        await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId,
          eventKey: `checkpoint:${f.rootId}:1`, type: 'checkpoint.committed', payload: { checkpointIndex: 1, snapshotHash: snapshot.hash, progressOperationId: operation.id } } })
      })
      if (fault === 'revoked') {
        await revokeRunLease(f.userId, f.runId)
        await expect(commitRuntimeCheckpoint(token, input)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
        return
      }
      if (fault === 'corrupt' || fault === 'outbox-gap') {
        if (fault === 'corrupt') await prisma.agentRuntimeCheckpoint.update({ where: { taskRootId_checkpointIndex: { taskRootId: f.rootId, checkpointIndex: 1 } }, data: { snapshot: { damaged: true } } })
        else await prisma.agentExecutionOutbox.delete({ where: { eventKey: `checkpoint:${f.rootId}:1` } })
        await expect(commitRuntimeCheckpoint(token, input)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        await expect(readTaskBudget(token)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        return
      }
      const original = await commitRuntimeCheckpoint(token, input)
      expect((await commitRuntimeCheckpoint(token, input)).snapshotHash).toBe(original.snapshotHash)
      expect(await prisma.agentRuntimeCheckpoint.count({ where: { taskRootId: f.rootId } })).toBe(1)
      expect((await readTaskBudget(token)).control.origin).toBe('unknown_legacy')
      await expect(commitRuntimeCheckpoint(token, { ...input, snapshot: { ...input.snapshot, context: '换成另一个任务' } })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      if (fault === 'resume') {
        const resumedRun = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
          status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: JSON.parse(JSON.stringify(f.spec)) } })
        await attachRunToDurableTask({ userId: f.userId, runId: resumedRun.id, taskRootId: f.rootId })
        await revokeRunLease(f.userId, f.runId)
        const resumed = await claim({ userId: f.userId, runId: resumedRun.id }, 'resumed-worker')
        expect((await commitRuntimeCheckpoint(resumed, input)).originRunId).toBe(f.runId)
      }
      if (fault === 'old-progress') {
        await recordProviderUsage({ ...identity, revision: 2, usage: { ...reported, promptTokens: 6000000, cacheMissTokens: 6000000 } })
        await expect(commitRuntimeCheckpoint(token, { ...input, expectedCheckpointCount: 1 })).rejects.toMatchObject({ code: 'RUNTIME_CHECKPOINT_NOT_DUE' })
      }
      const after = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
      expect(after).toMatchObject({ policyHash: policy.hash, tokenLimit: 2000500, checkpointCount: 1, compactionCount: 1 })
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
      expect((await markProviderDispatched(resumed, nextAttempt.id)).dispatchGranted).toBe(true)
      expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: nextAttempt.id } })).dispatchedAt).not.toBeNull()
      expect((await initializeDurableTask({ ...f, tokenBudget: 1000 })).id).toBe(f.rootId)
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
      const ceiling = 6000000
      const operation = await prepareOperation(token, { key: 'first', kind: 'provider', action: 'chat', input: {} })
      const attempt = await prepareProviderAttempt(token, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      await markProviderDispatched(token, attempt.id)
      const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
      await recordProviderUsage({ ...identity, revision: 1, usage: { source: 'reported', promptTokens: ceiling, completionTokens: 0, cacheHitTokens: null, cacheMissTokens: null } })
      await recordProviderResult({ ...identity, outcome: 'succeeded', result: {} })
      if (fault === 'corrupt-usage') await prisma.agentProviderUsageReceipt.update({ where: { attemptId: attempt.id }, data: { promptTokens: 0 } })
      const next = await prepareOperation(token, { key: 'second', kind: 'provider', action: 'chat', input: {} })
      const second = await prepareProviderAttempt(token, { operationId: next.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: {} })
      if (fault === 'ceiling') {
        expect((await markProviderDispatched(token, second.id)).dispatchGranted).toBe(true)
        expect((await readTaskBudget(token)).usedTokens).toBe(BigInt(ceiling))
      } else {
        await expect(markProviderDispatched(token, second.id)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: second.id } })).dispatchedAt).toBeNull()
      }
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
      if (fault === 'expired') expect((await markProviderDispatched(token, attempt.id)).dispatchGranted).toBe(true)
      else {
        await expect(markProviderDispatched(token, attempt.id)).rejects.toMatchObject({ code: fault === 'missing' ? 'RUNTIME_BUDGET_REQUIRED' : 'RUNTIME_BUDGET_INVALID' })
        expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).dispatchedAt).toBeNull()
      }
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
