import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { FIXED_NOVEL_COVER_SIZE } from '../../shared/contracts/index.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as coverData from '../../api/lib/data-access.js'
import * as novelData from '../../api/lib/data/novel.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as leases from '../../api/lib/agent/runtime-lease.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import { prisma } from '../../api/lib/prisma.js'
import { getCreditWindow, getTaskCreditUsage } from '../../api/lib/credits.js'
import { adoptCoverGoalAccounting, readCoverAdmission, readCoverUnit } from '../../api/lib/agent/runtime-cover-accounting.js'
import { coverGenerateTool } from '../../api/lib/agent/tools/cover-tools.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep, getDurableToolAdapterNames } from '../../api/lib/agent/runtime-tool-step.js'
import { readTaskBudget, readTaskBudgetInTransaction } from '../../api/lib/agent/runtime-budget.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { readToolOperationSource } from '../../api/lib/agent/runtime-tool-cursor.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { lockOwnedGoal } from '../../api/lib/agent/goal-store.js'
import { runtimeTransaction } from '../../api/lib/agent/runtime-common.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

const runtime = { apiKey: 'isolated-cover-fake', route: { provider: 'fixture', modelName: 'cover-fixture', baseUrl: 'https://images.invalid/generate', providerMode: 'mock' } }
const controller = () => new AbortController()
async function resumeOriginalPause(lease: Awaited<ReturnType<typeof claim>>) {
  await pauseDurableTask(lease.userId, lease.runId)
  const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: lease.taskRootId, runId: lease.runId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
  const resumed = await resumeDurableTask({ userId: lease.userId, runId: lease.runId, pauseEventId: pause.id })
  return claim({ userId: lease.userId, runId: resumed.run.id }, 'cover-resume-worker')
}

describe.runIf(available)('fixed-price cover generation genuine PG admission and recovery', () => {
  it.each(['success', 'raw-recovery', 'blob-recovery', 'asset-recovery', 'receipt-recovery', 'unknown', 'unknown-refund-recovery', 'dispatch-crash', 'debit-rollback',
    'exhausted', 'changed-route', 'cancel-after-response', 'deleted-asset', 'storage-pending', 'empty', 'rejected', 'partial', 'ask-resume', 'denied', 'current-deny', 'adopt-cover', 'adopt-empty-late-refund', 'adopt-refund-race'] as const)('%s retains the original paid request and owned candidates', scenario => fixture(async f => {
    const parentDirectory = path.resolve(os.tmpdir()), directory = await mkdtemp(path.join(parentDirectory, 'chevoink-cover-pg-'))
    if (path.dirname(directory) !== parentDirectory || !path.basename(directory).startsWith('chevoink-cover-pg-')) throw Error('Unexpected fixture cleanup target')
    vi.stubEnv('AGENT_IMAGE_RESPONSE_DIR', directory)
    try {
      expect(getDurableToolAdapterNames()).toContain('cover_generate')
      let lease = await claim(f)
      const signal = controller(), tool = coverGenerateTool, args = { prompt: '冷色调，主角站在车站门口', count: 2 }
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: scenario === 'exhausted' ? 5000 : 20000,
        dailyUsedMilli: 0, bonusBalanceMilli: 0, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: ['ask-resume', 'denied'].includes(scenario) ? 'ask' : 'allow', dangerous: false, alwaysConfirm: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
        messages: [{ role: 'user', content: '生成封面候选供我选择，不应用。' }, { role: 'assistant', content: null, toolCalls: [{ id: 'original-cover', name: tool.name, arguments: JSON.stringify(args) }] }] } })
      const route = vi.spyOn(ai, 'resolveCoverImageRuntime').mockResolvedValue(runtime)
      if (scenario === 'changed-route') route.mockResolvedValueOnce(runtime).mockResolvedValue({ ...runtime, route: { ...runtime.route, modelName: 'other' } })
      vi.spyOn(novelData, 'normalizeCoverImageUrl').mockResolvedValue('/api/uploads/novel-covers/fixture.png')
      if (scenario === 'storage-pending') vi.spyOn(novelData, 'normalizeCoverImageUrl').mockImplementation(async input => String(input))
      const transport = vi.spyOn(ai, 'requestCoverImages').mockImplementation(async (_runtime, input) => {
        expect(input).toMatchObject({ count: 2, size: FIXED_NOVEL_COVER_SIZE })
        expect(input.prompt).toContain('持久执行测试')
        if (scenario === 'unknown' || scenario === 'unknown-refund-recovery') throw Error('lost image response')
        if (scenario === 'cancel-after-response') signal.abort(Error('author cancelled'))
        const data = ['empty', 'adopt-empty-late-refund', 'adopt-refund-race'].includes(scenario) ? [] : scenario === 'storage-pending' ? [{ b64_json: 'a'.repeat(3 * 1024 * 1024) }]
          : [{ url: 'https://images.invalid/one.png' }, ...(scenario === 'partial' ? [] : [{ url: 'https://images.invalid/two.png' }])]
        return new Response(JSON.stringify({ data }), { status: scenario === 'rejected' ? 429 : 200 }) as unknown as Awaited<ReturnType<typeof ai.requestCoverImages>>
      })
      const step = () => executeDurableToolStep(lease, signal.signal)
      if (scenario === 'ask-resume' || scenario === 'denied') {
        const waiting = await step()
        if (waiting.kind !== 'waiting_approval') throw Error('Expected exact original approval')
        expect(transport).not.toHaveBeenCalled()
        await resolveDurableApproval({ userId: f.userId, runId: lease.runId, requestId: waiting.approvalId, callId: 'original-cover', approved: scenario !== 'denied', alwaysAllow: false })
        if (scenario === 'denied') {
          expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
          expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
          expect(transport).not.toHaveBeenCalled(); return
        }
      }
      const commit = vi.spyOn(operations, 'commitOperationEffect')
      if (['raw-recovery', 'ask-resume', 'deleted-asset', 'current-deny'].includes(scenario)) commit.mockRejectedValueOnce(Error('projection interrupted'))
      if (scenario === 'blob-recovery') vi.spyOn(operations, 'recordProviderResult').mockRejectedValueOnce(Error('result DB reply lost'))
      if (scenario === 'asset-recovery') vi.spyOn(coverData, 'createCoverAssetsInTransaction').mockRejectedValueOnce(Error('assets not committed'))
      if (scenario === 'receipt-recovery') vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('receipt committed'))
      if (scenario === 'debit-rollback') vi.spyOn(operations, 'markProviderDispatchedInTransaction').mockRejectedValueOnce(Error('dispatch TX rolled back'))
      if (scenario === 'dispatch-crash') {
        const originalLease = leases.withManuscriptRunLease
        vi.spyOn(leases, 'withManuscriptRunLease').mockImplementationOnce(async (token, work) => {
          await originalLease(token, work) // Real committed debit+marker, no HTTP.
          throw Error('process died after dispatch commit')
        })
      }
      if (scenario === 'unknown-refund-recovery') vi.spyOn(credits, 'recordImageRefundIntentInTransaction').mockRejectedValueOnce(Error('refund intent write interrupted'))
      if (scenario === 'adopt-empty-late-refund' || scenario === 'adopt-refund-race') vi.spyOn(credits, 'reconcileCreditRefunds').mockRejectedValueOnce(Error('wallet reconciliation deferred'))
      const interrupted = ['raw-recovery', 'blob-recovery', 'asset-recovery', 'receipt-recovery', 'ask-resume', 'deleted-asset', 'current-deny'].includes(scenario)
      if (interrupted) {
        await expect(step()).rejects.toThrow()
        if (scenario === 'deleted-asset') await prisma.coverAsset.deleteMany({ where: { ownerUserId: f.userId } })
        if (scenario === 'current-deny') await prisma.agentSession.update({ where: { id: f.sessionId }, data: { toolPolicy: { network: 'allow', contentWrite: 'deny', bulkWrite: 'deny' } } })
        lease = await resumeOriginalPause(lease)
        if (scenario === 'deleted-asset' || scenario === 'current-deny') {
          await expect(step()).rejects.toMatchObject({ code: scenario === 'deleted-asset' ? 'RUNTIME_RECONCILIATION_REQUIRED' : 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
          expect(transport).toHaveBeenCalledOnce(); return
        }
      }
      if (scenario === 'debit-rollback' || scenario === 'exhausted' || scenario === 'changed-route') {
        await expect(step()).rejects.toThrow()
        expect(transport).not.toHaveBeenCalled()
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId }, dispatchedAt: { not: null } } })).toBe(0)
        return
      }
      if (scenario === 'unknown' || scenario === 'dispatch-crash' || scenario === 'unknown-refund-recovery') {
        await expect(step()).rejects.toThrow()
        if (scenario !== 'unknown') {
          expect(await prisma.creditRefundIntent.count({ where: { originalEntry: { userId: f.userId } } })).toBe(0)
          lease = await resumeOriginalPause(lease)
        }
        await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
        expect((await readTaskBudget(lease)).unresolvedAttempts).toBe(1n)
        expect(await prisma.creditRefundIntent.count({ where: { originalEntry: { userId: f.userId } } })).toBe(1)
        expect(transport).toHaveBeenCalledTimes(scenario === 'dispatch-crash' ? 0 : 1); return
      }
      if (scenario === 'cancel-after-response') {
        await expect(step()).rejects.toThrow()
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId }, status: 'succeeded' } })).toBe(1)
        expect(await prisma.coverAsset.count({ where: { ownerUserId: f.userId } })).toBe(0)
        expect(transport).toHaveBeenCalledOnce(); return
      }
      const result = await step()
      if (scenario === 'receipt-recovery') expect(result).toMatchObject({ kind: 'recovered' })
      else expect(result).toMatchObject({ kind: 'tool', result: ['empty', 'rejected', 'storage-pending', 'adopt-empty-late-refund', 'adopt-refund-race'].includes(scenario) ? { outcome: 'failed' } : { display: { kind: 'coverImages' } } })
      expect(transport).toHaveBeenCalledOnce()
      expect((await loadExecutionState(f.userId, lease.runId)).frame.state.phase).toBe('idle')
      expect((await readTaskBudget(lease)).unresolvedAttempts).toBe(0n)
      const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true } })
      expect(attempt.usageReceipt).toMatchObject({ source: 'fixed_unit', promptTokens: null, completionTokens: null, settlementStatus: 'fixed_unit' })
      expect(await prisma.$transaction(tx => readCoverUnit(tx, attempt.id))).not.toBeNull()
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage', deltaMilli: -6000 } })).toBe(1)
      const bill = await getTaskCreditUsage(f.userId, lease.runId)
      expect(bill.charged).toBe(6)
      expect(bill.unresolvedProviderAttempts).toBe(0)
      const noImages = ['empty', 'rejected', 'adopt-empty-late-refund', 'adopt-refund-race'].includes(scenario)
      expect(await prisma.coverAsset.count({ where: { ownerUserId: f.userId } })).toBe(noImages ? 0 : scenario === 'partial' || scenario === 'storage-pending' ? 1 : 2)
      expect(await prisma.creditRefundIntent.count({ where: { originalEntry: { userId: f.userId } } })).toBe(noImages ? 1 : 0)
      expect((await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })).coverAssetId).toBeNull()
      if (scenario === 'success') {
        const parent = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'cover_generate' } })
        const envelope = JSON.parse(JSON.stringify(parent.inputSnapshot))
        envelope.input.normalization.sourceSnapshotHash = 'b'.repeat(64)
        const forged = runtimeJson(envelope)
        await expect(prisma.$transaction(tx => readToolOperationSource(tx, { ...parent, inputSnapshot: forged.value, inputHash: forged.hash }))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
        const rollback = Error('synthetic corruption rolled back')
        await expect(prisma.$transaction(async tx => {
          const counts = { source: 'fixed_unit', promptTokens: 0, completionTokens: 0, cacheHitTokens: null, cacheMissTokens: null }
          await tx.agentProviderUsageReceipt.update({ where: { attemptId: attempt.id }, data: { ...counts, observationHash: runtimeJson(counts).hash } })
          expect(await readCoverUnit(tx, attempt.id)).toBeNull()
          expect((await readTaskBudgetInTransaction(tx, f.rootId)).unresolvedAttempts).toBe(1n)
          throw rollback
        })).rejects.toBe(rollback)
        expect((await readTaskBudget(lease)).unresolvedAttempts).toBe(0n)
        for (const corruption of ['log-key', 'log-action'] as const) {
          await expect(prisma.$transaction(async tx => {
            const child = await tx.agentOperation.findUniqueOrThrow({ where: { id: attempt.operationId } })
            const snapshot = JSON.parse(JSON.stringify(child.inputSnapshot))
            if (corruption === 'log-key') {
              snapshot.input.usageLogId = 'other-owner-or-operation-log'
              const changed = runtimeJson(snapshot)
              await tx.agentOperation.update({ where: { id: child.id }, data: { inputSnapshot: changed.value, inputHash: changed.hash } })
            } else await tx.aiUsageLog.update({ where: { id: snapshot.input.usageLogId }, data: { action: 'unrelated-image-operation' } })
            expect(await readCoverAdmission(tx, attempt.id)).toBeNull()
            expect((await readTaskBudgetInTransaction(tx, f.rootId)).unresolvedAttempts).toBe(1n)
            throw rollback
          })).rejects.toBe(rollback)
        }
      }
      if (scenario === 'adopt-cover' || scenario === 'adopt-empty-late-refund' || scenario === 'rejected' || scenario === 'adopt-refund-race') {
        // Internal accounting contract under an isolated goal. Public human
        // activation/consent remains covered by agent-goal-activation tests.
        const goal = await prisma.agentGoal.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, executionOptions: {},
          revisions: { create: { revision: 1, objective: '采用原封面任务', request: {}, authorityHash: 'a'.repeat(64), sourceActionId: 'fixture-author-adoption' } },
          budget: { create: { tokenLimit: 1000000n, platformTokenCap: 1000000n, activeTimeLimitMs: 1000000n, platformTimeCapMs: 1000000n } } } })
        const log = await prisma.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, action: 'generateCoverImage' } })
        const adopt = () => runtimeTransaction(async tx => {
          await lockOwnedGoal(tx, f.userId, f.sessionId, goal.id)
          return adoptCoverGoalAccounting(tx, goal.id, log)
        })
        if (scenario === 'adopt-refund-race') {
          const [adopted] = await Promise.all([adopt(), credits.reconcileCreditRefunds({ userId: f.userId, limit: 10 })])
          expect(adopted).toEqual({ mirror: true, seeded: true })
        } else expect(await adopt()).toEqual({ mirror: true, seeded: true })
        expect(await adopt()).toEqual({ mirror: true, seeded: false })
        expect((await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: goal.id } })).creditsUsedMicros).toBe(scenario === 'rejected' || scenario === 'adopt-refund-race' ? 0n : 6000000n)
        expect(await prisma.agentGoalUsage.count({ where: { goalId: goal.id } })).toBe(1)
        expect(await prisma.agentGoalUsage.count({ where: { goalId: goal.id, sourceKey: { startsWith: 'legacy:' } } })).toBe(0)
        if (scenario === 'adopt-empty-late-refund') {
          await credits.reconcileCreditRefunds({ userId: f.userId, limit: 10 })
          expect((await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: goal.id } })).creditsUsedMicros).toBe(0n)
          expect((await getTaskCreditUsage(f.userId, lease.runId)).refunded).toBe(6)
        }
        expect(transport).toHaveBeenCalledOnce()
      }
    } finally {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  }))
})
