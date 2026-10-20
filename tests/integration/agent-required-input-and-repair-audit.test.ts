import { describe, expect, it, vi } from 'vitest'
const execution = vi.hoisted(() => vi.fn(async () => {}))
const creditAccess = vi.hoisted(() => vi.fn(async () => {}))
const modelRuntime = vi.hoisted(() => vi.fn(async () => ({ reasoningEffort: 'high' })))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: execution }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: creditAccess, getModelTierRuntime: modelRuntime }))
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { persistQualityRepairAttemptAudit, type QualityRepairAttemptAudit } from '../../api/lib/agent/quality-repair-audit.js'

describe.runIf(available)('required legacy input and repair audit with real PostgreSQL ownership', () => {
  it.each(['frozen', 'checkpoint', 'bounded'] as const)('preserves the original contract and counters on Continue: %s', async scenario => fixture(async f => {
    execution.mockClear(); creditAccess.mockClear(); modelRuntime.mockClear()
    const spec = { ...f.spec, scope: { ...f.spec.scope, writing: { version: 1 as const, kind: scenario === 'frozen' ? 'needs_input' as const : 'bounded' as const,
      targets: scenario === 'frozen' ? [] : [{ chapterId: f.chapterId, orderIndex: 1 }], repairAuthorized: true, titleAndBodyOnly: false } } }
    delete spec.scope.writingClarificationProtocol
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'unknown_legacy', runStartedAt: Date.now() - 100,
      activeExecutionMs: 50, stagnantBatches: 0, resumeCount: 0, compactionCount: 0, maxTurns: 50, tokenBudget: 1000,
      writeProgress: 0, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [],
      ...(scenario === 'checkpoint' ? { authorInputRequired: { version: 1, kind: 'writing_scope', callId: 'original-question' } } : {}) }
    const original = await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', runtimeProtocolVersion: 0, taskRootId: null,
      taskSpec: JSON.parse(JSON.stringify(spec)), usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, checkpoint } } })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.paused', payload: { reason: 'needs_input' } } })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    if (scenario === 'bounded') {
      expect(await continueLoopRun(f.userId, f.runId)).toMatchObject({ runId: f.runId, status: 'running' })
      expect(execution).toHaveBeenCalledOnce(); expect(creditAccess).toHaveBeenCalledOnce()
    } else {
      await expect(continueLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'AUTHOR_INPUT_REQUIRED' })
      expect(execution).not.toHaveBeenCalled(); expect(creditAccess).not.toHaveBeenCalled(); expect(modelRuntime).not.toHaveBeenCalled()
    }
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(after.taskSpec).toEqual(original.taskSpec); expect(after.usage).toEqual(original.usage)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
  }, undefined, '修改第一章正文'))

  it('persists two distinct sanitized attempts without modifying manuscript, report verdict or usage ownership', async () => fixture(async f => {
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const report = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
      chapterId: f.chapterId, chapterRevision: chapter.revision, status: 'needs_repair', deterministicMetrics: { independentCheck: 'complete' } } })
    const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, agentRunId: f.runId,
      targetType: 'quality_report', targetId: report.id, providerType: 'text', providerMode: 'system', modelName: 'anonymous-fixture',
      action: 'agent3HumanityRevision', durationMs: 5, usageSource: 'reported', billingStatus: 'settled', requestTokens: 10, responseTokens: 2 } })
    try {
      const first: QualityRepairAttemptAudit = { version: 1, kind: 'quality_repair_attempt', runId: f.runId, callId: 'repair-call', reportId: report.id,
        chapterId: f.chapterId, sourceRevision: chapter.revision, contextHash: 'a'.repeat(64), attempt: 1,
        action: 'agent3HumanityRevision', trigger: 'initial', state: 'prepared', classifications: [], requests: [] }
      await persistQualityRepairAttemptAudit(f, first)
      await expect(persistQualityRepairAttemptAudit(f, first)).rejects.toMatchObject({ code: 'QUALITY_REPAIR_RECONCILIATION_REQUIRED' })
      await persistQualityRepairAttemptAudit(f, { ...first, state: 'returned', classifications: ['parse_error'],
        response: { contentHash: 'b'.repeat(64), characterCount: 10 }, requests: [{ usageId: usage.id, status: 'terminal', billingKnown: true }] })
      const second: QualityRepairAttemptAudit = { ...first, attempt: 2, action: 'agent3HumanityRevisionRetry', trigger: 'parse_error' }
      await persistQualityRepairAttemptAudit(f, second)
      await persistQualityRepairAttemptAudit(f, { ...second, state: 'request_error', classifications: ['transport_unknown'], errorCode: 'AI_PROVIDER_TIMEOUT', requests: [] })
      const rows = await prisma.agentArtifact.findMany({ where: { runId: f.runId, title: '局部质量修订诊断' } })
      expect(rows).toHaveLength(2); expect(rows.every(row => row.content === '')).toBe(true)
      expect(rows.map(row => (row.metadata as { state: string }).state).sort()).toEqual(['request_error', 'returned'])
      expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toEqual(usage)
      expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: report.id } })).toEqual(report)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
      await expect(persistQualityRepairAttemptAudit({ userId: 'foreign', novelId: f.novelId }, { ...second, callId: 'foreign' })).rejects.toMatchObject({ code: 'QUALITY_RUN_SCOPE_INVALID' })
    } finally { await prisma.aiUsageLog.delete({ where: { id: usage.id } }) }
  }))
})
