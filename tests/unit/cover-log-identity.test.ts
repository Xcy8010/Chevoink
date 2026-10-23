import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FIXED_NOVEL_COVER_SIZE } from '../../shared/contracts/index.js'
import { readCoverAdmission } from '../../api/lib/agent/runtime-cover-accounting.js'
import { coverRequest, coverWorkSchema } from '../../api/lib/agent/runtime-cover-contract.js'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { enforceCoverTitleInPrompt } from '../../api/lib/agent/tools/cover-prompt.js'

describe('fixed cover accounting log authenticates original ownership, including before dispatch', () => {
  it.each(['pending', 'observed', 'foreign-key', 'foreign-owner', 'resumed-run', 'wrong-operation', 'wrong-model', 'wrong-action'] as const)('%s', async scenario => {
    const args = { prompt: '雪原上的小屋', count: 1 }, parentId = 'parent-operation', childId = 'image-operation', rootId = 'original-root'
    const source = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
      successfulToolSignatures: [], messages: [{ role: 'user', content: '请生成封面' }, { role: 'assistant', content: null,
        toolCalls: [{ id: 'cover-call', name: 'cover_generate', arguments: JSON.stringify(args) }] }] }
    const sourceHash = runtimeJson(source).hash
    const work = coverWorkSchema.parse({ version: 1, novelId: 'novel', title: '书名', displayTitle: null,
      prompt: enforceCoverTitleInPrompt(args.prompt, '书名', null), count: 1, assetIds: [randomUUID()], size: FIXED_NOVEL_COVER_SIZE,
      tariff: 'image_call_6000_v1', amountMilli: 6000, route: { provider: 'fixture', modelName: 'image-model', baseUrl: 'https://images.invalid/generate', providerMode: 'mock' } })
    const parentInput = runtimeJson({ kind: 'tool', action: 'cover_generate', parentOperationId: null, input: { novelId: 'novel', callId: 'cover-call', args, work,
      normalization: { version: 1, rawArguments: JSON.stringify(args), normalizedArgsHash: runtimeJson(args).hash, sourceRevision: 0, sourceSnapshotHash: sourceHash } } })
    const parent = { id: parentId, kind: 'tool', action: 'cover_generate', taskRootId: rootId, operationKey: 'exec:0', originRunId: 'original-run', inputSnapshot: parentInput.value, inputHash: parentInput.hash }
    const logId = createHash('sha256').update(`cover:${parentId}:0`).digest('hex'), chargeKey = `image:${parentId}`, request = coverRequest(work)
    const childInput = runtimeJson({ kind: 'provider', action: 'cover_generate_image', parentOperationId: parentId,
      input: { version: 1, parentInputHash: parent.inputHash, workHash: runtimeJson(work).hash, usageLogId: scenario === 'foreign-key' ? 'foreign-log' : logId, chargeKey, request } })
    const requestSnapshot = runtimeJson({ provider: 'fixture', model: 'image-model', request })
    const attempt = { id: randomUUID(), attemptKey: '1', provider: 'fixture', model: 'image-model', requestSnapshot: requestSnapshot.value, requestHash: requestSnapshot.hash,
      runId: 'resumed-run', operation: { id: childId, kind: 'provider', action: 'cover_generate_image', operationKey: `cover:${parentId}:0`, parentOperationId: parentId,
        taskRootId: rootId, taskRoot: { userId: 'owner', novelId: 'novel' }, parent, attempts: [{ id: 'single-attempt' }], inputSnapshot: childInput.value, inputHash: childInput.hash } }
    const log = { id: logId, userId: scenario === 'foreign-owner' ? 'other-owner' : 'owner', novelId: 'novel', agentRunId: scenario === 'resumed-run' ? 'resumed-run' : 'original-run',
      providerType: 'image', modelName: scenario === 'wrong-model' ? 'different-model' : 'image-model', providerMode: 'mock',
      action: scenario === 'wrong-action' ? 'another-image-task' : 'generateCoverImage', targetType: 'imageCharge', targetId: chargeKey, creditChargeMilli: 6000,
      usageSource: scenario === 'observed' ? 'fixed_unit' : 'unknown', billingStatus: scenario === 'observed' ? 'observed' : 'pending_usage',
      billingEvidence: { taskRootId: rootId, operationId: scenario === 'wrong-operation' ? 'other-operation' : childId } }
    const debit = { id: 'actual-debit', userId: 'owner', sourceType: 'image_generation', kind: 'usage', deltaMilli: -6000, referenceId: childId,
      metadata: { agentCover: { version: 1, taskRootId: rootId, parentOperationId: parentId, parentInputHash: parent.inputHash, operationId: childId,
        requestHash: attempt.requestHash, workHash: runtimeJson(work).hash, tariff: work.tariff, amountMilli: 6000, chargeKey } } }
    const tx = { agentProviderAttempt: { findUnique: vi.fn().mockResolvedValue(attempt) }, aiUsageLog: { findUnique: vi.fn().mockResolvedValue(log) }, creditLedgerEntry: { findUnique: vi.fn().mockResolvedValue(debit) },
      agentExecutionFrame: { findUnique: vi.fn().mockResolvedValue({ revision: 0, snapshot: source, snapshotHash: sourceHash, previousHash: null }) },
      agentExecutionOutbox: { findUnique: vi.fn().mockResolvedValue({ taskRootId: rootId, type: 'execution.state.saved', payload: { revision: 0, snapshotHash: sourceHash, previousHash: null } }) } }
    const admitted = await readCoverAdmission(tx as unknown as RuntimeTx, attempt.id)
    if (scenario === 'pending' || scenario === 'observed') expect(admitted).toMatchObject({ input: { usageLogId: logId }, parent: { originRunId: 'original-run' } })
    else expect(admitted).toBeNull()
  })
})
