import type { Prisma } from '@prisma/client'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState as initialize, saveExecutionState as save, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executionSnapshotSchema } from '../../api/lib/agent/runtime-state.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { prepareModelCursorOperation } from '../../api/lib/agent/runtime-model-cursor.js'
import { prepareProviderAttempt, markProviderDispatched, recordProviderUsage, recordProviderResult } from '../../api/lib/agent/runtime-operations.js'
import { settleProviderOperation } from '../../api/lib/agent/runtime-settlement.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'

/** Ordinary-tool fixtures supply a synthetic model result through the real DB
 * journal. It is a zero-token, zero-price test adapter, with no HTTP. Source,
 * initialization and deliberately missing-source negative tests use originals. */
async function appendModelResult(lease: RunLeaseToken, assistant: NonNullable<ReturnType<typeof assistantTail>>) {
  const current = await loadExecutionState(lease.userId, lease.runId), { frame, configuration } = current
  const model = configuration.model
  const request = { endpoint: 'https://provider.invalid/v1', body: { model: model.modelName, messages: frame.state.messages, tools: configuration.tools } }
  const price = { version: 'credits-v1-exact' as const, modelTier: model.tier, multiplierBps: 0 }
  const prepared = await prepareModelCursorOperation(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash },
    { key: 'exec:' + frame.state.nextOperationSequence, action: 'fixture_model_turn', request, price })
  const attempt = await prepareProviderAttempt(lease, { operationId: prepared.operation.id, attemptKey: '1', provider: model.provider, model: model.modelName, request })
  await markProviderDispatched(lease, attempt.id)
  const identity = { userId: lease.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
  await recordProviderUsage({ ...identity, revision: 1, usage: { source: 'reported', promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 } })
  await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: assistant.content ?? '', reasoning: assistant.reasoning ?? '',
    finishReason: 'tool_calls', toolCalls: assistant.toolCalls ?? [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0,
      promptCacheHitTokens: 0, promptCacheMissTokens: 0 } } })
  await settleProviderOperation({ ...identity, lease })
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return loadExecutionState(lease.userId, lease.runId)
}
function assistantTail(snapshot: ReturnType<typeof executionSnapshotSchema.parse>) {
  const tail = snapshot.messages.at(-1)
  return snapshot.phase === 'idle' && tail?.role === 'assistant' && tail.toolCalls?.length ? tail : null
}
export async function initializeExecutionState(lease: RunLeaseToken, input: Parameters<typeof initialize>[1]) {
  const snapshot = executionSnapshotSchema.parse(input.snapshot), assistant = assistantTail(snapshot)
  if (!assistant) return initialize(lease, input)
  const initial = await initialize(lease, { ...input, snapshot: { ...snapshot, messages: snapshot.messages.slice(0, -1) } })
  if (initial.frame.revision !== 0) return initial
  return appendModelResult(lease, assistant)
}
export async function saveExecutionState(lease: RunLeaseToken, input: Parameters<typeof save>[1]) {
  const snapshot = executionSnapshotSchema.parse(input.snapshot), assistant = assistantTail(snapshot)
  if (!assistant) return save(lease, input)
  const current = await loadExecutionState(lease.userId, lease.runId)
  if (runtimeJson(current.frame.state.messages).hash === runtimeJson(snapshot.messages).hash) return save(lease, input)
  await save(lease, { ...input, snapshot: { ...snapshot, turn: current.frame.state.turn,
    nextOperationSequence: current.frame.state.nextOperationSequence, messages: snapshot.messages.slice(0, -1) } })
  return (await appendModelResult(lease, assistant)).frame
}
/** The synthetic source creates a zero-charge account before some fixtures set
 * their own balances. Preserve their explicit values using the same real row. */
export async function createToolFixtureCreditAccount(input: { data: Prisma.CreditAccountUncheckedCreateInput }) {
  const { userId, ...values } = input.data
  return prisma.creditAccount.upsert({ where: { userId }, create: input.data, update: values })
}
