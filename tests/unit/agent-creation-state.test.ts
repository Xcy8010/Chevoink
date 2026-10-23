import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectAgentCreationState } from '../../api/lib/agent/creation-state.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as writing from '../../api/lib/agent/writing-scope.js'
import * as lineage from '../../api/lib/agent/original-request.js'
import * as reviews from '../../api/lib/agent/chapter-review-guard.js'
import * as frames from '../../api/lib/agent/runtime-state.js'
import * as evidence from '../../api/lib/agent/runtime-evidence.js'

afterEach(() => vi.restoreAllMocks())
function fixture() {
  const spec = buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'c1', prompt: '修改第1至2章，逐项处理检查意见。' })
  const targets = [{ chapterId: 'c1', orderIndex: 1 }, { chapterId: 'c2', orderIndex: 2 }]
  const original = { taskId: spec.id, sourceRunId: 'r', parentRunId: null, prompt: '原始作者要求', spec,
    writing: { version: 1 as const, kind: 'bounded' as const, targets, titleAndBodyOnly: false, repairAuthorized: true }, bindings: null }
  original.spec = JSON.parse(JSON.stringify(spec)) // Match persisted JSON, which has no undefined properties.
  vi.spyOn(writing, 'readWritingScope').mockResolvedValue(original)
  vi.spyOn(lineage, 'originalTaskRunIds').mockResolvedValue(['r'])
  const chapters = targets.map(target => ({ id: target.chapterId, orderIndex: target.orderIndex, revision: 4, content: `本章原文${target.orderIndex}` }))
  const compilations = chapters.map(chapter => ({ id: `comp-${chapter.id}`, chapterId: chapter.id, targetOrderIndex: chapter.orderIndex,
    status: 'active', stage: 'check', bridge: { targetRevision: 3 } }))
  const readiness = vi.spyOn(reviews, 'readChapterReviewReadiness').mockImplementation(async (_tx, _subject, compilationId) => {
    const chapter = chapters.find(item => compilationId === `comp-${item.id}`)!
    return { compilationId: compilationId!, chapterId: chapter.id, revision: chapter.revision, ready: false, checksRequired: true,
      continuity: 'complete', quality: 'stale', continuityErrorCount: 0, qualityErrorCount: 0,
      qualityReportId: null, requiredTools: [{ name: 'quality_analyze', args: { compilationId: compilationId! } }],
      decisionPending: false, requiredDecisions: [], retainedDecisions: [], decisionDetails: [],
      decisionBinding: { contentHash: runtimeJson({ content: chapter.content }).hash, continuityBinding: 'binding', qualityReportId: null, qualityReportHash: null } }
  })
  const run = { id: 'r', userId: 'u', novelId: 'n', runtimeProtocolVersion: 0, taskRootId: null as string | null, status: 'paused', usage: null as unknown }
  const db = {
    agentRun: { findFirst: vi.fn().mockResolvedValue(run), findMany: vi.fn().mockResolvedValue([{ id: 'r', taskRootId: null as string | null }]) },
    chapter: { findFirst: vi.fn(async ({ where }) => chapters.find(item => item.id === where.id) ?? null) },
    storyCompilation: { findMany: vi.fn().mockResolvedValue(compilations) },
    agentExecutionState: { findUnique: vi.fn().mockResolvedValue(null) },
    agentExecutionOutbox: { findUnique: vi.fn().mockResolvedValue(null) },
    agentOperation: { findMany: vi.fn().mockResolvedValue([]) },
    aiUsageLog: { findMany: vi.fn().mockResolvedValue([]) },
    agentProviderAttempt: { findMany: vi.fn().mockResolvedValue([]) },
  }
  return { db, tx: db as unknown as Prisma.TransactionClient, run, original, chapters, compilations, readiness }
}

describe('consistent creation-state diagnostics', () => {
  it('binds each report to its own current chapter, with obligations still unverified', async () => {
    const f = fixture(), state = await collectAgentCreationState(f.tx, 'u', 'r')
    expect(f.readiness.mock.calls.map(call => call[2])).toEqual(['comp-c1', 'comp-c2'])
    expect(state.targets.map(item => [item.chapterId, item.revision, item.review?.quality])).toEqual([['c1', 4, 'stale'], ['c2', 4, 'stale']])
    expect(state.effects.legacy).toBe('unknown')
    expect(state.delivery.verified).toBe(false)
    expect(state.obligations?.verification).toBe('unverified')
    expect(state).not.toHaveProperty('ready')
    expect(f.db.agentRun.findFirst).toHaveBeenCalledWith({ where: { id: 'r', userId: 'u' } })
    expect(f.db.storyCompilation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'u', novelId: 'n', runId: { in: ['r'] } }) }))
  })
  it('never substitutes another chapter report or stale source for a usable assessment', async () => {
    const f = fixture()
    f.readiness.mockRejectedValueOnce(new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '来源已改'))
    expect((await collectAgentCreationState(f.tx, 'u', 'r')).targets[0]).toMatchObject({ review: null, unknownReason: 'CONTINUITY_INPUT_STALE' })
    f.readiness.mockResolvedValueOnce({ ...(await f.readiness(f.tx, { userId: 'u', novelId: 'n', runId: 'r' }, 'comp-c2'))!, chapterId: 'c2' })
    await expect(collectAgentCreationState(f.tx, 'u', 'r')).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
  })
  it.each(['target_unbound', 'target_missing', 'review_unavailable'] as const)('preserves %s without inventing success', async reason => {
    const f = fixture()
    if (reason === 'target_unbound') f.original.writing.targets[0].chapterId = null as unknown as string
    if (reason === 'target_missing') f.db.chapter.findFirst.mockResolvedValueOnce(null)
    if (reason === 'review_unavailable') f.readiness.mockResolvedValueOnce(null)
    expect((await collectAgentCreationState(f.tx, 'u', 'r')).targets[0]).toMatchObject({ review: null, unknownReason: reason })
  })
  it('keeps settled unknown usage separate from pending settlement and current operations', async () => {
    const f = fixture()
    f.db.aiUsageLog.findMany.mockResolvedValue([
      { id: 'historical-unknown', usageSource: 'unknown', billingStatus: 'settled', requestTokens: null, responseTokens: null },
      { id: 'current-unknown', usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null },
    ])
    const state = await collectAgentCreationState(f.tx, 'u', 'r')
    expect(state.pending.operations).toEqual([])
    expect(state.usage.observations).toMatchObject([
      { id: 'historical-unknown', tokensKnown: false, pendingSettlement: false, settlementStatus: 'settled' },
      { id: 'current-unknown', tokensKnown: false, pendingSettlement: true },
    ])
  })
  it('reports a committed unreduced receipt without calling it failed, unexecuted or retryable', async () => {
    const f = fixture(), result = runtimeJson({ toolResult: { output: '已保存', summary: '已保存' } })
    f.run.runtimeProtocolVersion = 1; f.run.taskRootId = 'root'
    f.db.agentRun.findMany.mockResolvedValue([{ id: 'r', taskRootId: 'root' }])
    f.db.agentOperation.findMany.mockResolvedValue([{ id: 'op', kind: 'tool', action: 'chapter_write', status: 'succeeded',
      effectReceipt: { result: result.value, resultHash: result.hash } }])
    const state = await collectAgentCreationState(f.tx, 'u', 'r')
    expect(state.execution.cursor).toEqual({ kind: 'unknown' })
    expect(state.effects.operations[0]).toMatchObject({ status: 'succeeded', receiptState: 'hash_verified', observation: 'not_verified', outcome: 'unknown' })
    expect(state.effects.operations[0]).not.toHaveProperty('retry')
    f.db.agentOperation.findMany.mockResolvedValue([{ id: 'op', kind: 'tool', action: 'chapter_write', status: 'succeeded',
      effectReceipt: { result: result.value, resultHash: '0'.repeat(64) } }])
    await expect(collectAgentCreationState(f.tx, 'u', 'r')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
  it('keeps a settled durable unknown unknown and refuses corrupt usage evidence', async () => {
    const f = fixture()
    const observed = { source: 'unknown', promptTokens: null, completionTokens: null, cacheHitTokens: null, cacheMissTokens: null }
    const receipt = { ...observed, observationHash: runtimeJson(observed).hash, settlementStatus: 'settled' }
    f.db.agentProviderAttempt.findMany.mockResolvedValue([{ id: 'attempt', status: 'unknown', dispatchedAt: new Date(), usageReceipt: receipt }])
    expect((await collectAgentCreationState(f.tx, 'u', 'r')).usage.observations[0]).toMatchObject({ status: 'unknown',
      settlementStatus: 'settled', usageSource: 'unknown', tokensKnown: false, pendingSettlement: false })
    receipt.observationHash = '0'.repeat(64)
    await expect(collectAgentCreationState(f.tx, 'u', 'r')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
  it('returns frame identity and validated effects while withholding raw messages and reasoning', async () => {
    const f = fixture(), result = runtimeJson({ toolResult: { output: '正文未变化', summary: '未变化' } })
    f.run.runtimeProtocolVersion = 1; f.run.taskRootId = 'root'
    f.db.agentRun.findMany.mockResolvedValue([{ id: 'r', taskRootId: 'root' }])
    f.db.agentExecutionState.findUnique.mockResolvedValue({ revision: 2 })
    vi.spyOn(frames, 'readExecutionStateInTransaction').mockResolvedValue({ frame: { revision: 2, snapshotHash: 'a'.repeat(64),
      state: { messages: [{ role: 'assistant', reasoning: 'SECRET_REASONING' }] } } } as never)
    vi.spyOn(evidence, 'collectDurableToolEvidence').mockResolvedValue({ progressSequence: '0', effects: [{ operationId: 'op', action: 'chapter_write',
      resultHash: result.hash, sequence: '1', sourceRevision: 0, outcome: 'succeeded', summary: 'SECRET_INTERNAL_SUMMARY' }] })
    f.db.agentOperation.findMany.mockResolvedValue([{ id: 'op', kind: 'tool', action: 'chapter_write', status: 'succeeded', effectReceipt: { result: result.value, resultHash: result.hash } }])
    const state = await collectAgentCreationState(f.tx, 'u', 'r')
    expect(state.execution.cursor).toEqual({ kind: 'durable_frame', revision: 2, hash: 'a'.repeat(64) })
    expect(state.effects.operations[0]).toMatchObject({ observation: 'reduced_verified', outcome: 'succeeded' })
    expect(JSON.stringify(state)).not.toMatch(/SECRET_REASONING|SECRET_INTERNAL_SUMMARY|messages|configuration/)
  })
  it.each(['owner', 'lineage', 'novel', 'protocol'] as const)('rejects an unproved %s identity', async kind => {
    const f = fixture()
    if (kind === 'owner') f.db.agentRun.findFirst.mockResolvedValue(null)
    if (kind === 'lineage') f.db.agentRun.findMany.mockResolvedValue([])
    if (kind === 'novel') f.original.spec.scope.novelId = 'other'
    if (kind === 'protocol') f.run.runtimeProtocolVersion = 2
    await expect(collectAgentCreationState(f.tx, 'u', 'r')).rejects.toMatchObject({ code: kind === 'owner' ? 'AGENT_RUN_NOT_FOUND' : 'RUNTIME_SCOPE_MISMATCH' })
  })
})
